import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, assignmentId, completionId } from '@sabeel/shared';
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
const STUDENT = 'stu1';
const OUTSIDER = 'stu2';
const CLASS_MINE = 'classMine';
const CLASS_THEIRS = 'classTheirs';
const REC = 'rec1';
/** Granted, with NO completion seeded — so a write to it is a CREATE. */
const REC2 = 'rec2';
const THEIR_REC = 'recTheirs';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager', [THEIRS]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const cls = (id: string, managerUids: string[]) =>
      setDoc(doc(db, COLLECTIONS.courses, id), { cohortId: 'c1', managerUids });
    const assignment = (studentUid: string, recordingId: string, courseId: string) =>
      setDoc(doc(db, COLLECTIONS.assignments, assignmentId(studentUid, recordingId)), {
        studentUid,
        recordingId,
        courseId,
        cohortId: 'c1',
        // A REAL ASSIGNMENT SHAPE. `dueDate` was null and there was a `source`
        // field, and neither can exist: the due date is required — "a blank one
        // would mean permanent access" — and the reconcile from a session's
        // attendance is the only writer, so nothing ever sets a source. Nothing
        // here reads either field, which is exactly why they went unnoticed;
        // what a fixture asserts is that this is a document the system contains,
        // and the next person to need one copies it from here.
        dueDate: '2099-01-01',
        active: true,
        assignedAt: 1,
        assignedBy: 'system',
      });
    const completion = (studentUid: string, recordingId: string) =>
      setDoc(doc(db, COLLECTIONS.completions, completionId(studentUid, recordingId)), {
        studentUid,
        recordingId,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 1,
        updatedAt: 1,
      });
    await Promise.all([
      cls(CLASS_MINE, [MINE]),
      cls(CLASS_THEIRS, [THEIRS]),
      assignment(STUDENT, REC, CLASS_MINE),
      assignment(STUDENT, REC2, CLASS_MINE),
      assignment(OUTSIDER, THEIR_REC, CLASS_THEIRS),
      completion(STUDENT, REC),
    ]);
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin');
const mgrMine = () => ctx(MINE, 'manager');
const mgrTheirs = () => ctx(THEIRS, 'manager');
const student = () => ctx(STUDENT, 'student');
const outsider = () => ctx(OUTSIDER, 'student');

// ------------------------------------------------------------- assignments --

describe('assignments: reads', () => {
  it('a student lists their OWN obligations', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(student().firestore(), COLLECTIONS.assignments),
          where('studentUid', '==', STUDENT),
        ),
      ),
    );
  });

  it('a student cannot list assignments unconstrained (would expose others)', async () => {
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.assignments)));
  });

  it("a student cannot read another student's obligation", async () => {
    await assertFails(
      getDoc(doc(outsider().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, REC))),
    );
  });

  it('a student opening a recording they hold no grant for is told there is none', async () => {
    const none = await getDoc(doc(student().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, THEIR_REC)));
    expect(none.exists()).toBe(false);
  });

  it('nor can a student learn whether a classmate holds a grant', async () => {
    await assertFails(
      getDoc(doc(outsider().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, THEIR_REC))),
    );
  });

  it('an admin lists everything', async () => {
    await assertSucceeds(getDocs(collection(admin().firestore(), COLLECTIONS.assignments)));
  });

  it("a manager reads their class's assignments", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.assignments),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('a manager cannot read a class they do not run', async () => {
    await assertFails(
      getDoc(doc(mgrTheirs().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, REC))),
    );
  });

  // The recording ledger's own query shape. `recordingId ==` reads as
  // class-scoped to a human — one recording belongs to one class — but Firestore
  // evaluates a `list` rule against the query's CONSTRAINTS, and the manager arm
  // resolves get(/courses/$(resource.data.courseId)). Unless the query pins
  // courseId that path cannot be resolved and the listen is refused, whatever it
  // would have matched. See the same pair in rules.ledger.test.ts.
  it('a manager CANNOT list a recording’s assignments without pinning courseId', async () => {
    await assertFails(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.assignments),
          where('recordingId', '==', REC),
          where('active', '==', true),
        ),
      ),
    );
  });

  it('a manager CAN list a recording’s assignments scoped to their class', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mgrMine().firestore(), COLLECTIONS.assignments),
          where('courseId', '==', CLASS_MINE),
          where('recordingId', '==', REC),
          where('active', '==', true),
        ),
      ),
    );
  });
});

describe('assignments: writes are server-only', () => {
  it('a student cannot create their own obligation', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, 'new')), {
        studentUid: STUDENT,
        recordingId: 'new',
        courseId: CLASS_MINE,
        cohortId: 'c1',
        dueDate: '2099-01-01',
        active: true,
        assignedAt: 1,
        assignedBy: STUDENT,
      }),
    );
  });

  it('a student cannot flip their own obligation inactive to dodge accountability', async () => {
    await assertFails(
      updateDoc(doc(student().firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, REC)), {
        active: false,
      }),
    );
  });
});

// ------------------------------------------------------------- completions --

describe('completions: self-only client writes', () => {
  it('a student reads their own completion', async () => {
    await assertSucceeds(
      getDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC))),
    );
  });

  it("a student cannot read another student's completion", async () => {
    await assertFails(
      getDoc(doc(outsider().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC))),
    );
  });

  it('a student lists their own completions — the shapes the home and the player send', async () => {
    // `useMyCompletions` asks by studentUid alone; `useCompletion` adds the
    // recording. Nothing here asserted either was served, so the student arm
    // of `allow list` could have been deleted with every test still green.
    await assertSucceeds(
      getDocs(query(collection(student().firestore(), COLLECTIONS.completions), where('studentUid', '==', STUDENT))),
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(student().firestore(), COLLECTIONS.completions),
          where('studentUid', '==', STUDENT),
          where('recordingId', '==', REC),
        ),
      ),
    );
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.completions)));
    await assertFails(
      getDocs(query(collection(student().firestore(), COLLECTIONS.completions), where('studentUid', '==', OUTSIDER))),
    );
  });

  /*
   * A CREATE, NOT AN UPDATE — and the distinction is the whole test.
   *
   * `beforeEach` seeds `completions/stu1_rec1`, so a `setDoc` at that id
   * evaluates `allow update`. With every positive case pointed there, `allow
   * create: if false` passed the entire suite while no student could ever record
   * a first completion — the core student action, and the one that has to work
   * offline. So this uses a recording with a grant and NO completion yet.
   */
  it('a student creates their own completion', async () => {
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC2)), {
        studentUid: STUDENT,
        recordingId: REC2,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
  });

  it('a student cannot write a completion of the wrong shape', async () => {
    // Same reason as the progress row: `completedAt` is formatted on the ledger
    // and in the CSV export, and a string there throws in render.
    const honest = {
      studentUid: STUDENT,
      recordingId: REC2,
      courseId: CLASS_MINE,
      completed: true,
      completedAt: 2,
      updatedAt: 2,
    };
    const ref = doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC2));
    await assertFails(setDoc(ref, { ...honest, completed: 'yes' }));
    await assertFails(setDoc(ref, { ...honest, completedAt: 'x' }));
    await assertFails(setDoc(ref, { ...honest, updatedAt: 'now' }));
    await assertFails(setDoc(ref, { ...honest, note: 'extra' }));
    await assertSucceeds(setDoc(ref, honest));
    await assertFails(setDoc(ref, { ...honest, completedAt: 'x' }));
  });

  it('a student cannot record a completion once their grant has lapsed', async () => {
    /*
     * A grant is switched off, never deleted — corrected to present after
     * all, unenrolled, unpublished — so "the grant exists" was true of every
     * student who had ever held the recording. Their marks then showed on the
     * ledger as ticks for people the class was closed to. Both arms: a first
     * completion under a lapsed grant, and an update to one born under a live
     * grant after it lapsed.
     */
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, REC2)), { active: false });
      await updateDoc(doc(c.firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, REC)), { active: false });
    });
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC2)), {
        studentUid: STUDENT,
        recordingId: REC2,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: false,
        completedAt: null,
        updatedAt: 2,
      }),
    );
    await assertFails(
      addDoc(collection(student().firestore(), COLLECTIONS.completionEvents), {
        studentUid: STUDENT,
        recordingId: REC2,
        courseId: CLASS_MINE,
        action: 'complete',
        actor: 'student',
        at: 2,
      }),
    );
  });

  it('a student updates the completion they already have', async () => {
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: false,
        completedAt: null,
        updatedAt: 2,
      }),
    );
  });

  /*
   * THE ID IS PART OF THE ROW — see the matching case in
   * `rules.recordings.test.ts` for the shape of the attack. A create under
   * another student's id carrying the writer's OWN uid passes every content
   * check, and locks the rightful owner out of marking that recording complete
   * for ever: their write becomes an update, `resource.data.studentUid` is
   * somebody else, and `delete: if false` leaves no way back.
   */
  /*
   * THE CLASS IS THE GRANT'S — the completions half of the same rule. This is
   * the collection the ledger's completion column reads, `courseId ==` scoped,
   * so a row filed under another class shows the student complete on their own
   * home and NOT complete to the manager chasing them, with nothing reconciling
   * the two.
   */
  it('a student cannot file a completion under another class', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_THEIRS,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
  });

  it('a student cannot mark complete a recording they were never granted', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, 'rNever')), {
        studentUid: STUDENT,
        recordingId: 'rNever',
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
  });

  it('a student cannot plant an honest completion under someone else’s id', async () => {
    await assertFails(
      setDoc(doc(outsider().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: OUTSIDER,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
    // And the rightful owner can still write theirs.
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
  });

  it('a student cannot forge a completion in someone else’s name', async () => {
    await assertFails(
      setDoc(doc(outsider().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC)), {
        studentUid: STUDENT,
        recordingId: REC,
        courseId: CLASS_MINE,
        completed: true,
        completedAt: 2,
        updatedAt: 2,
      }),
    );
  });

  it('a student cannot delete a completion', async () => {
    // deletion denied outright — completion history is not erasable by the client
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(
      deleteDoc(doc(student().firestore(), COLLECTIONS.completions, completionId(STUDENT, REC))),
    );
  });
});

// -------------------------------------------------------- completion events --

describe('completionEvents: append-only', () => {
  const event = (actor: string, studentUid: string) => ({
    studentUid,
    recordingId: REC,
    courseId: CLASS_MINE,
    action: 'complete',
    actor,
    at: 5,
  });

  it('a student appends their own event', async () => {
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e1'), event('student', STUDENT)),
    );
  });

  it('a student cannot forge an event for someone else', async () => {
    await assertFails(
      setDoc(doc(outsider().firestore(), COLLECTIONS.completionEvents, 'e2'), event('student', STUDENT)),
    );
  });

  it('a student cannot masquerade as a staff actor', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e3'), event('staff', STUDENT)),
    );
  });

  /*
   * THE ROW IS TIED TO A REAL GRANT, and it has to be: nothing here can be
   * updated or deleted, so whatever a student writes is a permanent entry in
   * the collection this file calls the audit of every mark. Unchecked, that
   * accepted any class, any recording and any action from any student — a
   * forged row in a class the writer is not in, readable by that class's
   * managers.
   */
  it('a student cannot append an event for a class they have no grant in', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e4'), {
        ...event('student', STUDENT),
        courseId: CLASS_THEIRS,
      }),
    );
  });

  it('a student cannot append an event for a recording they were never granted', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e5'), {
        ...event('student', STUDENT),
        recordingId: THEIR_REC,
      }),
    );
  });

  it('a student cannot invent an action, or carry a field the shape has no room for', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e6'), {
        ...event('student', STUDENT),
        action: 'excused',
      }),
    );
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'e7'), {
        ...event('student', STUDENT),
        overrideReason: 'because I said so',
      }),
    );
  });

  it('an appended event cannot be updated or deleted (history is immutable)', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.completionEvents, 'seed'), event('student', STUDENT));
    });
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(
      updateDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'seed'), { action: 'uncomplete' }),
    );
    await assertFails(
      deleteDoc(doc(student().firestore(), COLLECTIONS.completionEvents, 'seed')),
    );
  });
});
