import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

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
const CLASS_MINE = 'classMine';
const CLASS_THEIRS = 'classTheirs';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const entry = (id: string, courseId: string | null) =>
      setDoc(doc(db, COLLECTIONS.auditLog, id), {
        at: 1,
        actorUid: ADMIN,
        actorRole: 'admin',
        action: 'setRecordingStatus',
        courseId,
        targets: {},
      });
    await Promise.all([
      setDoc(doc(db, COLLECTIONS.courses, CLASS_MINE), { cohortId: 'c1', managerUids: [MINE] }),
      setDoc(doc(db, COLLECTIONS.courses, CLASS_THEIRS), { cohortId: 'c1', managerUids: [THEIRS] }),
      entry('mine', CLASS_MINE),
      entry('theirs', CLASS_THEIRS),
      entry('global', null), // a class-less entry (cohort/staff change)
      // The same shape, but performed BY the manager: creating a student without
      // naming a course. See the "own actions" cases below.
      setDoc(doc(db, COLLECTIONS.auditLog, 'mineGlobal'), {
        at: 2,
        actorUid: MINE,
        actorRole: 'manager',
        action: 'createStudent',
        courseId: null,
        targets: { studentUid: 'newStudent' },
      }),
    ]);
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin');
const mgrMine = () => ctx(MINE, 'manager');
const student = () => ctx('stu', 'student');

describe('auditLog reads', () => {
  it('an admin lists everything, including class-less entries', async () => {
    await assertSucceeds(getDocs(collection(admin().firestore(), COLLECTIONS.auditLog)));
  });

  it("a manager reads their class's entries", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('a manager cannot read another class’s entry', async () => {
    await assertFails(
      getDoc(doc(mgrMine().firestore(), COLLECTIONS.auditLog, 'theirs')),
    );
  });

  it('a manager cannot read a class-less (admin-only) entry', async () => {
    await assertFails(getDoc(doc(mgrMine().firestore(), COLLECTIONS.auditLog, 'global')));
  });

  /*
   * WHAT THEY DID THEMSELVES — the other half, and the reason it exists.
   *
   * A manager may create a student account without naming a course, which is
   * deliberate: teachers do intake. That entry belongs to no class, so the
   * class-scoped arm hid the most privilege-adjacent action a manager has from
   * the manager who performed it. Reading your own actions discloses nothing you
   * did not do.
   */
  it('a manager reads a class-less entry they performed themselves', async () => {
    await assertSucceeds(getDoc(doc(mgrMine().firestore(), COLLECTIONS.auditLog, 'mineGlobal')));
  });

  it('…and can list them, constrained to their own uid', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('actorUid', '==', MINE),
        ),
      ),
    );
  });

  it('but not somebody else’s, which is what makes it their OWN actions', async () => {
    await assertFails(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('actorUid', '==', ADMIN),
        ),
      ),
    );
  });

  it('a manager cannot list unconstrained (would expose other courses + global)', async () => {
    await assertFails(getDocs(collection(mgrMine().firestore(), COLLECTIONS.auditLog)));
  });

  /*
   * A STUDENT'S HISTORY, as the student's page reads it.
   *
   * The admin asks by the student alone. A manager's read is pinned to the
   * courses they run with an `in` clause — the same shape the work queue sends —
   * and the rule judges the query, not the rows: pinned to their own class it
   * is served, and widened by one class that is not theirs it is refused
   * outright, whether or not that class has a row about the student.
   */
  it("an admin lists one student's history by the student alone", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(admin().firestore(), COLLECTIONS.auditLog),
          where('targets.studentUid', '==', 'newStudent'),
        ),
      ),
    );
  });

  it("a manager lists a student's history pinned to the courses they run", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('courseId', 'in', [CLASS_MINE]),
          where('targets.studentUid', '==', 'newStudent'),
        ),
      ),
    );
  });

  it('…and is refused the moment the pin reaches a course that is not theirs', async () => {
    await assertFails(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('courseId', 'in', [CLASS_MINE, CLASS_THEIRS]),
          where('targets.studentUid', '==', 'newStudent'),
        ),
      ),
    );
  });

  it('…and cannot ask by the student alone, which would reach class-less entries', async () => {
    await assertFails(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.auditLog),
          where('targets.studentUid', '==', 'newStudent'),
        ),
      ),
    );
  });

  it('a student cannot read the audit log at all', async () => {
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.auditLog, 'mine')));
  });
});

describe('auditLog is append-only from the server', () => {
  it('no client may write an entry', async () => {
    for (const c of [admin(), mgrMine(), student()]) {
      await assertFails(
        setDoc(doc(c.firestore(), COLLECTIONS.auditLog, 'forged'), {
          at: 1,
          actorUid: 'x',
          actorRole: 'admin',
          action: 'forged',
          courseId: null,
          targets: {},
        }),
      );
    }
  });
});
