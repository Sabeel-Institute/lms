import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, attendanceRecordId } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

/**
 * `attendanceRecords` — each student's own copy of their attendance mark.
 *
 * The collection exists because `/sessions` cannot be opened to students: the
 * attendance map holds the whole roster, and Firestore has no field-level
 * security. So the assertions that matter are the ones proving a student sees
 * their own row and NOTHING about anyone else's — including that they cannot
 * simply drop the studentUid filter and read the class.
 */

let testEnv: RulesTestEnvironment;

/**
 * `host:port` from the emulator env var the CLI exports.
 *
 * NO fallback port, deliberately. `emulators:exec` always sets these
 * (`firebase-tools/lib/emulator/env.js`), so an unset var means the suite is
 * running outside the wrapper — and a hardcoded default does not rescue that,
 * it points at whatever happens to be on that port. On a machine where three
 * checkouts run emulators, that is a SIBLING's: it reads and writes happily and
 * turns a rules suite green against the wrong database. Failing loudly is the
 * only safe behaviour.
 */
function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  // Literal 127.0.0.1, never 'localhost': the emulators bind IPv4 only, while
  // 'localhost' can resolve to IPv6 ::1 first and fail at connect.
  return { host: host || '127.0.0.1', port: Number(port) };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      ...hostPort('FIRESTORE_EMULATOR_HOST'),
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

const ADMIN = 'admin1';
const MINE = 'mgrMine';
const THEIRS = 'mgrTheirs';
const STUDENT = 'stu1';
const CLASSMATE = 'stu2';
const CLASS_MINE = 'classMine';
const CLASS_THEIRS = 'classTheirs';
/*
 * IDS THIS FILE ALONE USES. The rules pass runs with no Functions emulator
 * (`npm run test:emulator`), so a session another file wipes fires no
 * reconcile into this file's attendance records.
 */
const SESS_MINE = 'attSessMine';
const SESS_THEIRS = 'attSessTheirs';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager', [THEIRS]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const cls = (id: string, managerUids: string[]) =>
      setDoc(doc(db, COLLECTIONS.courses, id), { cohortId: 'c1', managerUids });
    const mark = (studentUid: string, sessionId: string, courseId: string, status: string) =>
      setDoc(doc(db, COLLECTIONS.attendanceRecords, attendanceRecordId(studentUid, sessionId)), {
        studentUid,
        sessionId,
        courseId,
        cohortId: 'c1',
        date: '2026-07-10',
        title: 'Week 3',
        status,
        submittedAt: 1,
      });
    await Promise.all([
      cls(CLASS_MINE, [MINE]),
      cls(CLASS_THEIRS, [THEIRS]),
      mark(STUDENT, SESS_MINE, CLASS_MINE, 'excused'),
      mark(CLASSMATE, SESS_MINE, CLASS_MINE, 'absent'),
      mark(STUDENT, SESS_THEIRS, CLASS_THEIRS, 'present'),
    ]);
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin');
const mine = () => ctx(MINE, 'manager');
const theirs = () => ctx(THEIRS, 'manager');
const student = () => ctx(STUDENT, 'student');

describe('attendanceRecords: a student sees their own marks', () => {
  it('lets a student get their own row', async () => {
    await assertSucceeds(
      getDoc(
        doc(
          student().firestore(),
          COLLECTIONS.attendanceRecords,
          attendanceRecordId(STUDENT, SESS_MINE),
        ),
      ),
    );
  });

  it('lets a student list their own marks, and their own marks in one course', async () => {
    const db = student().firestore();
    await assertSucceeds(
      getDocs(
        query(collection(db, COLLECTIONS.attendanceRecords), where('studentUid', '==', STUDENT)),
      ),
    );
    // The per-class view: equality filters only, so no composite index.
    await assertSucceeds(
      getDocs(
        query(
          collection(db, COLLECTIONS.attendanceRecords),
          where('studentUid', '==', STUDENT),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('does NOT let a student read a classmate\'s mark', async () => {
    // The point of the whole collection: your own mark, never the roster's.
    await assertFails(
      getDoc(
        doc(
          student().firestore(),
          COLLECTIONS.attendanceRecords,
          attendanceRecordId(CLASSMATE, SESS_MINE),
        ),
      ),
    );
  });

  it('does NOT let a student list a whole session or course', async () => {
    const db = student().firestore();
    await assertFails(getDocs(collection(db, COLLECTIONS.attendanceRecords)));
    await assertFails(
      getDocs(
        query(collection(db, COLLECTIONS.attendanceRecords), where('sessionId', '==', SESS_MINE)),
      ),
    );
    // Dropping the studentUid filter is the obvious attempt; it must fail even
    // scoped to a course the student is genuinely in.
    await assertFails(
      getDocs(
        query(collection(db, COLLECTIONS.attendanceRecords), where('courseId', '==', CLASS_MINE)),
      ),
    );
  });
});

describe('attendanceRecords: staff reads', () => {
  it('lets an admin list everything', async () => {
    await assertSucceeds(getDocs(collection(admin().firestore(), COLLECTIONS.attendanceRecords)));
  });

  it('lets a scoped manager query their own course', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.attendanceRecords),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('does NOT let a manager read another course\'s marks', async () => {
    await assertFails(
      getDoc(
        doc(
          mine().firestore(),
          COLLECTIONS.attendanceRecords,
          attendanceRecordId(STUDENT, SESS_THEIRS),
        ),
      ),
    );
    await assertFails(
      getDocs(
        query(
          collection(theirs().firestore(), COLLECTIONS.attendanceRecords),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('does NOT let a manager list unconstrained — the per-row course get would blow the cap', async () => {
    await assertFails(getDocs(collection(mine().firestore(), COLLECTIONS.attendanceRecords)));
  });
});

describe('attendanceRecords: writes', () => {
  it('are denied to everyone — the session is canonical, this is derived', async () => {
    const id = attendanceRecordId(STUDENT, SESS_MINE);
    await assertFails(
      updateDoc(doc(student().firestore(), COLLECTIONS.attendanceRecords, id), {
        status: 'present',
      }),
    );
    await assertFails(
      updateDoc(doc(mine().firestore(), COLLECTIONS.attendanceRecords, id), { status: 'present' }),
    );
    await assertFails(
      updateDoc(doc(admin().firestore(), COLLECTIONS.attendanceRecords, id), { status: 'present' }),
    );
    // And a student cannot invent one that excuses them.
    await assertFails(
      setDoc(
        doc(
          student().firestore(),
          COLLECTIONS.attendanceRecords,
          attendanceRecordId(STUDENT, 'sessNew'),
        ),
        {
          studentUid: STUDENT,
          sessionId: 'sessNew',
          courseId: CLASS_MINE,
          cohortId: 'c1',
          date: '2026-07-17',
          title: 'Week 4',
          status: 'excused',
          submittedAt: 1,
        },
      ),
    );
  });
});
