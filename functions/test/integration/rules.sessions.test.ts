import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { NO_MEDIA } from '../mediaFixtures';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, QUEUE_SCOPE, enrollmentId } from '@sabeel/shared';

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
const COURSE_MINE = 'courseMine';
const COURSE_THEIRS = 'courseTheirs';
const SESS_MINE = 'sessMine';
const SESS_THEIRS = 'sessTheirs';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const course = (id: string, managerUids: string[]) =>
      setDoc(doc(db, COLLECTIONS.courses, id), {
        cohortId: 'c1',
        name: id,
        archived: false,
        effectiveActive: true,
        archivedAccess: false,
        managerUids,
        createdAt: 1,
        createdBy: ADMIN,
      });
    const session = (id: string, courseId: string) =>
      setDoc(doc(db, COLLECTIONS.sessions, id), {
        courseId,
        cohortId: 'c1',
        date: '2026-07-06',
        title: id,
        // Required, and never null: a session with no due date would be one
        // whose access never closes, and no writer in the product can make one.
        dueDate: '2099-01-01',
        notes: '',
        recordingId: null,
        // The whole roster's attendance — the thing students must never see.
        attendance: { [STUDENT]: 'absent' },
        attendanceSubmittedAt: 1,
        notRecorded: false,
        createdAt: 1,
        createdBy: ADMIN,
        updatedAt: 1,
      });
    await Promise.all([
      course(COURSE_MINE, [MINE]),
      course(COURSE_THEIRS, [THEIRS]),
      session(SESS_MINE, COURSE_MINE),
      session(SESS_THEIRS, COURSE_THEIRS),
      // A student enrolled in the course — still must NOT read the session.
      setDoc(doc(db, COLLECTIONS.enrollments, enrollmentId(STUDENT, COURSE_MINE)), {
        studentUid: STUDENT,
        courseId: COURSE_MINE,
        cohortId: 'c1',
        active: true,
        enrolledAt: 1,
        enrolledBy: ADMIN,
      }),
    ]);
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin');
const mine = () => ctx(MINE, 'manager');
const student = () => ctx(STUDENT, 'student');

describe('sessions rules', () => {
  it('lets an admin read any session', async () => {
    await assertSucceeds(getDocs(collection(admin().firestore(), COLLECTIONS.sessions)));
  });

  it('lets a scoped manager query their own course sessions', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.sessions),
          where('courseId', '==', COURSE_MINE),
        ),
      ),
    );
  });

  it('does NOT let a manager read another course session', async () => {
    await assertFails(getDoc(doc(mine().firestore(), COLLECTIONS.sessions, SESS_THEIRS)));
  });

  it('lets a manager GET one of their own sessions — what the session page reads', async () => {
    // Every manager positive above is a list; `useSessionState` on the session
    // page, the ledger and the Zoom import is a `get`, and splitting the rule's
    // `get, list` would have left this suite green with that page refused.
    await assertSucceeds(getDoc(doc(mine().firestore(), COLLECTIONS.sessions, SESS_MINE)));
  });

  /**
   * THE QUERY THE STAFF WORK QUEUE SENDS, at the widest scope it will ever send
   * it at.
   *
   * `Today` reads every course the reader can see in one `where('courseId','in',
   * [...])`. For an ADMIN that is free — their arm of the rule reads no
   * documents. For a MANAGER each returned document resolves a
   * `get(courses/{id})`, cached per distinct path — so the cost is one call per
   * COURSE however many sessions come back — and Firestore caps the
   * document-access calls in a single request. That cap is the real constraint
   * on how many courses the queue may span, and it is not the `in` clause's own
   * limit.
   *
   * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the rule's SHAPE — that
   * the manager arm serves the exact query the queue sends, with every row
   * returned, and that the same query at a wider scope is refused for a manager
   * and not for an admin. It does NOT establish the ceiling: the emulator does
   * not enforce Firestore's per-request document-access limit, and its own
   * ceiling is only BRACKETED by this pair, somewhere between the width served
   * here and the width refused below. A rule change that spent one more `get()`
   * per row could land inside that band with both halves still green, so treat
   * this as a guard on the rule's shape and read the ceiling off the docs.
   * `QUEUE_SCOPE.manager` comes from that documented limit; see the note on the
   * constant.
   *
   * If this ever goes red, lower `QUEUE_SCOPE.manager`; do not widen the rule.
   */
  it('serves the work queue query for a manager at the full scope it uses', async () => {
    const ids: string[] = [];
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (let i = 0; i < QUEUE_SCOPE.manager; i += 1) {
        const courseId = `qc${i}`;
        ids.push(courseId);
        await setDoc(doc(db, COLLECTIONS.courses, courseId), {
          cohortId: 'c1',
          name: courseId,
          archived: false,
          effectiveActive: true,
          archivedAccess: false,
          managerUids: [MINE],
          createdAt: 1,
          createdBy: ADMIN,
        });
        // TWO sessions and a recording per course, deliberately. With one row
        // per course the test cannot tell "one `get(courses/{id})` per distinct
        // path" from "one per document returned" — and a real term has
        // twenty-odd sessions in each. It has to vary the thing it claims to
        // pin, because the cache is what makes the ceiling a count of COURSES.
        for (const n of [0, 1]) {
          await setDoc(doc(db, COLLECTIONS.sessions, `qs${i}-${n}`), {
            courseId,
            cohortId: 'c1',
            date: '2026-07-06',
            title: `qs${i}-${n}`,
            dueDate: '2026-07-13',
            notes: '',
            recordingId: null,
            attendance: {},
            attendanceSubmittedAt: null,
            notRecorded: false,
            createdAt: 1,
            createdBy: ADMIN,
            updatedAt: 1,
          });
        }
        await setDoc(doc(db, COLLECTIONS.recordings, `qr${i}`), {
          sessionId: `qs${i}-0`,
          courseId,
          cohortId: 'c1',
          title: `qr${i}`,
          notes: '',
          date: '2026-07-06',
          status: 'published',
          source: 'manual',
          ...NO_MEDIA,
          createdAt: 1,
          createdBy: ADMIN,
          updatedAt: 1,
        });
      }
    });

    /*
     * THE ROW COUNT IS PART OF THE ASSERTION.
     *
     * The rule resolves its `get(courses/{id})` per RETURNED document, so a
     * query that matched nothing would succeed having exercised none of the cap
     * this test exists to pin — a green run proving only that an empty result
     * is cheap. Asserting the size is what makes it a measurement.
     */
    const sessions = await assertSucceeds(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.sessions),
          where('courseId', 'in', ids),
        ),
      ),
    );
    expect(sessions.size).toBe(QUEUE_SCOPE.manager * 2);
    const recordings = await assertSucceeds(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.recordings),
          where('courseId', 'in', ids),
        ),
      ),
    );
    expect(recordings.size).toBe(QUEUE_SCOPE.manager);
  });

  /**
   * THE OTHER HALF OF THE MEASUREMENT: the width that is actually refused.
   *
   * Without it "ten is safe" is a number in a comment. The rule's document-access
   * budget is what caps the queue, and a change to `firestore.rules` that spends
   * one more `get()` per row would move the ceiling silently — this is the test
   * that goes red when it does. `QUEUE_SCOPE.admin` is the width, because the
   * admin arm reads no documents and so is the query builder's own limit.
   */
  it('refuses the same query at a width the rule cannot afford', async () => {
    const ids: string[] = [];
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (let i = 0; i < QUEUE_SCOPE.admin; i += 1) {
        const courseId = `wc${i}`;
        ids.push(courseId);
        await setDoc(doc(db, COLLECTIONS.courses, courseId), {
          cohortId: 'c1',
          name: courseId,
          archived: false,
          effectiveActive: true,
          archivedAccess: false,
          managerUids: [MINE],
          createdAt: 1,
          createdBy: ADMIN,
        });
        for (const n of [0, 1]) {
          await setDoc(doc(db, COLLECTIONS.sessions, `ws${i}-${n}`), {
            courseId,
            cohortId: 'c1',
            date: '2026-07-06',
            title: `ws${i}-${n}`,
            dueDate: '2026-07-13',
            notes: '',
            recordingId: null,
            attendance: {},
            attendanceSubmittedAt: null,
            notRecorded: false,
            createdAt: 1,
            createdBy: ADMIN,
            updatedAt: 1,
          });
        }
      }
    });

    await assertFails(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.sessions),
          where('courseId', 'in', ids),
        ),
      ),
    );
    // And an ADMIN is served the same query at the same width, so the refusal
    // above is the manager arm's document budget and not the `in` clause.
    const asAdmin = await assertSucceeds(
      getDocs(
        query(
          collection(admin().firestore(), COLLECTIONS.sessions),
          where('courseId', 'in', ids),
        ),
      ),
    );
    expect(asAdmin.size).toBe(QUEUE_SCOPE.admin * 2);
  });

  it('does NOT let an enrolled student read a session (attendance is private)', async () => {
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.sessions, SESS_MINE)));
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.sessions)));
  });

  it('denies every client write (sessions are callable-only)', async () => {
    await assertFails(
      setDoc(doc(mine().firestore(), COLLECTIONS.sessions, 'x'), {
        courseId: COURSE_MINE,
        attendanceSubmittedAt: 1,
      }),
    );
    await assertFails(
      setDoc(doc(admin().firestore(), COLLECTIONS.sessions, SESS_MINE), { title: 'hacked' }),
    );
  });
});
