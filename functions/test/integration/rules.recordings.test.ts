import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { withAudio } from '../mediaFixtures';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import {
  LATEST_CLIENT_TIME,
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  assignmentId,
  enrollmentId,
} from '@sabeel/shared';
import { seedStaffRecords, seedStudentRecords } from './staffRecords';

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
/*
 * A FRESH SET OF RECORDING IDS PER TEST.
 *
 * `clearFirestore()` deletes this file's recordings, and each deletion fires
 * `onRecordingWritten` → `applyRecordingFanout`, which re-reads the recording,
 * finds it gone and deactivates every assignment pointing at that id. The
 * Functions emulator delivers that on its own schedule, so it could land AFTER
 * the next test had re-seeded `assignments/stu1_recPublished` with
 * `active: true` — and the student arm of `/recordings` needs an active grant,
 * so a test failed having done nothing wrong. Same shape as the flakes already
 * fixed in `rules.attendance.test.ts` and `assignments.integration.test.ts`, and
 * production never reuses an id either: recordings get auto-ids.
 *
 * `let`, not `const`, so the ids can be reassigned before each test — which is
 * why nothing at describe level may derive from them (see `listeningProgress`).
 */
let run = 0;
let PUBLISHED = '';
/** Published in the student's own course, but they were never excused for it. */
let UNGRANTED = '';
/** Published, but their grant was withdrawn (corrected to present, unpublished…). */
let WITHDRAWN = '';
let DRAFT = '';
let THEIR_REC = '';
/**
 * Published, granted, and its listen-by date is in the PAST — the state every
 * recording ends in. See the assertion that names it below.
 */
let CLOSED = '';

beforeEach(async () => {
  run += 1;
  PUBLISHED = `recPublished-run${run}`;
  UNGRANTED = `recUngranted-run${run}`;
  WITHDRAWN = `recWithdrawn-run${run}`;
  DRAFT = `recDraft-run${run}`;
  THEIR_REC = `recTheirs-run${run}`;
  CLOSED = `recClosed-run${run}`;
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager' });
  await seedStudentRecords(testEnv, [STUDENT, OUTSIDER]);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const cls = (id: string, managerUids: string[]) =>
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
    /*
     * EVERY RECORDING POINTS AT A SESSION, AND NO SESSION POINTS BACK.
     *
     * The Functions emulator runs against this same project, so every write here
     * fires `onRecordingWritten` → `applyRecordingFanout`. Its first branch is
     * `if (!rec?.sessionId) deactivateAssignmentsForRecording(...)` — so a
     * recording with no session, which is what this fixture used to write, told
     * the trigger to switch off every grant on it, INCLUDING the active one the
     * student-read cases depend on. It failed about one run in a hundred.
     *
     * A `sessionId` takes it past that branch and into
     * `reconcileSessionAssignments`, which returns immediately unless the SESSION
     * names a recording (`session.recordingId`). Leaving that null is what keeps
     * the reconcile off these grants entirely, and it is deliberate: this file
     * seeds an ACTIVE grant on a DRAFT recording, which is a defence-in-depth
     * case production cannot produce — the fan-out only ever grants a published
     * one — so a fully wired session would deactivate it and the test asserting
     * "not even with a grant" would start passing because there was no grant.
     *
     * The attendance below is therefore a description of the world, not a
     * mechanism: nothing reads it. It is written so the fixture says what it
     * means, not to make the trigger do anything.
     */
    const sess = (id: string, courseId: string, attendance: Record<string, string>) =>
      setDoc(doc(db, COLLECTIONS.sessions, id), {
        courseId,
        cohortId: 'c1',
        date: '2026-07-06',
        title: id,
        dueDate: '2099-01-01',
        notes: '',
        recordingId: null,
        attendance,
        attendanceSubmittedAt: 1,
        notRecorded: false,
        createdAt: 1,
        createdBy: ADMIN,
        updatedAt: 1,
      });
    const rec = (id: string, courseId: string, status: string, sessionId: string) =>
      setDoc(doc(db, COLLECTIONS.recordings, id), {
        sessionId,
        cohortId: 'c1',
        courseId,
        title: id,
        status,
        source: 'manual',
        recordedAt: 1,
        notes: '',
        ...withAudio(id, { durationSec: 60 }),
        createdAt: 1,
        createdBy: ADMIN,
        updatedAt: 1,
      });
    // The grant. A student reads a recording through this document and nothing
    // else, so every student-read case below is really a case about one of these.
    const grant = (
      recordingId: string,
      active: boolean,
      sessionId: string,
      dueDate = '2099-01-01',
    ) =>
      setDoc(doc(db, COLLECTIONS.assignments, assignmentId(STUDENT, recordingId)), {
        studentUid: STUDENT,
        recordingId,
        sessionId,
        courseId: CLASS_MINE,
        cohortId: 'c1',
        dueDate,
        active,
        assignedAt: 1,
        assignedBy: 'system',
      });
    // Excused where a grant is seeded, present where one is not — so the
    // attendance and the grants tell the same story. Neither drives anything;
    // see the note on `sess` above.
    const EXCUSED = { [STUDENT]: 'excused' };
    const PRESENT = { [STUDENT]: 'present' };
    await Promise.all([
      cls(CLASS_MINE, [MINE]),
      cls(CLASS_THEIRS, [THEIRS]),
      sess(`${PUBLISHED}-s`, CLASS_MINE, EXCUSED),
      sess(`${UNGRANTED}-s`, CLASS_MINE, PRESENT),
      sess(`${WITHDRAWN}-s`, CLASS_MINE, PRESENT),
      sess(`${DRAFT}-s`, CLASS_MINE, EXCUSED),
      sess(`${THEIR_REC}-s`, CLASS_THEIRS, {}),
      sess(`${CLOSED}-s`, CLASS_MINE, EXCUSED),
      rec(PUBLISHED, CLASS_MINE, 'published', `${PUBLISHED}-s`),
      rec(UNGRANTED, CLASS_MINE, 'published', `${UNGRANTED}-s`),
      rec(WITHDRAWN, CLASS_MINE, 'published', `${WITHDRAWN}-s`),
      rec(DRAFT, CLASS_MINE, 'draft', `${DRAFT}-s`),
      rec(THEIR_REC, CLASS_THEIRS, 'published', `${THEIR_REC}-s`),
      rec(CLOSED, CLASS_MINE, 'published', `${CLOSED}-s`),
      grant(PUBLISHED, true, `${PUBLISHED}-s`),
      grant(WITHDRAWN, false, `${WITHDRAWN}-s`),
      grant(DRAFT, true, `${DRAFT}-s`),
      // Active, and its deadline went by years ago. See the assertion below.
      grant(CLOSED, true, `${CLOSED}-s`, '2020-01-01'),
      setDoc(doc(db, COLLECTIONS.enrollments, enrollmentId(STUDENT, CLASS_MINE)), {
        studentUid: STUDENT,
        courseId: CLASS_MINE,
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
const outsider = () => ctx(OUTSIDER, 'student');

describe('recordings: staff reads', () => {
  it('let an admin list everything', async () => {
    await assertSucceeds(getDocs(collection(admin().firestore(), COLLECTIONS.recordings)));
  });

  it('let a scoped manager query their own class', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.recordings),
          where('courseId', '==', CLASS_MINE),
        ),
      ),
    );
  });

  it('do NOT let a manager list the whole library — that shape is the admin\'s alone', async () => {
    // `useAllRecordings` is gated by role on the client; this is what keeps a
    // read-free manager arm from being added to the rule unnoticed.
    await assertFails(getDocs(collection(mine().firestore(), COLLECTIONS.recordings)));
  });

  it('do NOT let a manager read another class\'s recordings', async () => {
    await assertFails(getDoc(doc(mine().firestore(), COLLECTIONS.recordings, THEIR_REC)));
    await assertFails(
      getDocs(
        query(
          collection(mine().firestore(), COLLECTIONS.recordings),
          where('courseId', '==', CLASS_THEIRS),
        ),
      ),
    );
  });

  it('let staff read a DRAFT, because they must verify it before publishing', async () => {
    await assertSucceeds(getDoc(doc(mine().firestore(), COLLECTIONS.recordings, DRAFT)));
  });
});

describe('recordings: student reads', () => {
  it('let a student read a published recording they were granted', async () => {
    await assertSucceeds(getDoc(doc(student().firestore(), COLLECTIONS.recordings, PUBLISHED)));
  });

  it('do NOT let an enrolled student read one they were never granted', async () => {
    // Same course, same active enrolment, published — and still refused. This is
    // the whole policy in one assertion: being in the class opens nothing, only
    // being excused does.
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.recordings, UNGRANTED)));
  });

  it('do NOT let a student read one whose grant was withdrawn', async () => {
    // active:false — corrected to present, unpublished, or unenrolled. The row
    // survives for the ledger; the access does not.
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.recordings, WITHDRAWN)));
  });

  it('do NOT let a student read an unpublished one even WITH a grant', async () => {
    // Drafts are staff working material; a student seeing one would be looking
    // at a recording nobody has checked yet. Both conditions must hold.
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.recordings, DRAFT)));
  });

  it('do NOT let a student read a class they are not enrolled in', async () => {
    await assertFails(getDoc(doc(student().firestore(), COLLECTIONS.recordings, THEIR_REC)));
    await assertFails(getDoc(doc(outsider().firestore(), COLLECTIONS.recordings, PUBLISHED)));
  });

  /*
   * THE DEADLINE IS ENFORCED AT THE AUDIO, NOT HERE — and this is the assertion
   * that holds the rules to it.
   *
   * Every other grant in this file is dated 2099, so the whole suite passes with
   * a date comparison added to the student arm, or with the fan-out flipping
   * `active:false` on expiry. Either would look like a tightening and neither
   * would be: the product promises a student a Missed card "rather than
   * disappearing — a student is owed the record of what closed and when", the
   * closed player promises "your listening record is kept", and both are built
   * out of exactly this read. `StudentHomeScreen` resolves each assignment with
   * `readIfPermitted` and skips what comes back empty, so a refusal here does
   * not raise an error anywhere — every closed recording simply vanishes from
   * every student's home, silently.
   *
   * The deadline lives in `getPlaybackUrl`, where it is one comparison in
   * `@sabeel/shared` rather than a second copy of the same maths written against
   * `request.time` in a rules file. This is the test that keeps it there.
   */
  it('STILL let a student read one whose listen-by date has passed', async () => {
    await assertSucceeds(getDoc(doc(student().firestore(), COLLECTIONS.recordings, CLOSED)));
  });

  it('deny a student ANY list of recordings, however constrained', async () => {
    // The student arm is get-only on purpose: resolving a grant per row would
    // cost two document-access calls each and blow the per-query cap. Students
    // list their own assignments — which needs no reads — and get from there.
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.recordings)));
    await assertFails(
      getDocs(
        query(
          collection(student().firestore(), COLLECTIONS.recordings),
          where('courseId', '==', CLASS_MINE),
          where('status', '==', 'published'),
        ),
      ),
    );
  });
});

/*
 * DISABLING A STUDENT SHUTS THE DOOR — the other half of "keeps their history".
 *
 * `isStudent()` is `isActive() && role() == 'student'`, and every student arm in
 * the rules is built on it. The staff side of `isActive()` is well covered — the
 * identity suite and the callable guards both prove a pending or disabled staff
 * account writes nothing — and the student side was covered nowhere: weakening
 * `isStudent()` to `isSignedIn() && role() == 'student'` left every rules suite
 * in this repo green while a disabled student kept reading recordings, and a
 * student still awaiting nothing in particular could read them before an admin
 * had ever seen the account.
 *
 * The token is the whole of the test, so the fixture is the SAME student with
 * the SAME grant: only `status` differs, which is exactly the mutation.
 */
describe('recordings: a student whose account is not active', () => {
  const suspended = (status: string) => testEnv.authenticatedContext(STUDENT, { role: 'student', status });

  it('cannot read the recording their active self could', async () => {
    await assertSucceeds(getDoc(doc(student().firestore(), COLLECTIONS.recordings, PUBLISHED)));
    await assertFails(getDoc(doc(suspended('disabled').firestore(), COLLECTIONS.recordings, PUBLISHED)));
    await assertFails(getDoc(doc(suspended('pending').firestore(), COLLECTIONS.recordings, PUBLISHED)));
  });

  it('cannot read their own assignments, progress or completions either', async () => {
    const db = suspended('disabled').firestore();
    await assertFails(
      getDocs(
        query(collection(db, COLLECTIONS.assignments), where('studentUid', '==', STUDENT)),
      ),
    );
    await assertFails(
      getDoc(doc(db, COLLECTIONS.listeningProgress, `${STUDENT}_${PUBLISHED}`)),
    );
    await assertFails(getDoc(doc(db, COLLECTIONS.completions, `${STUDENT}_${PUBLISHED}`)));
  });
});

describe('recordings: writes', () => {
  it('are denied to everyone, including an admin', async () => {
    await assertFails(
      updateDoc(doc(admin().firestore(), COLLECTIONS.recordings, DRAFT), { status: 'published' }),
    );
    await assertFails(
      updateDoc(doc(mine().firestore(), COLLECTIONS.recordings, DRAFT), { title: 'x' }),
    );
    await assertFails(
      updateDoc(doc(student().firestore(), COLLECTIONS.recordings, PUBLISHED), { title: 'x' }),
    );
  });
});

describe('listeningProgress', () => {
  // FUNCTIONS, not consts: the ids are reassigned in `beforeEach`, and a value
  // captured here would be the previous test's.
  const mineId = () => `${STUDENT}_${PUBLISHED}`;
  const theirsId = () => `${OUTSIDER}_${PUBLISHED}`;
  const row = (uid: string) => ({
    studentUid: uid,
    recordingId: PUBLISHED,
    courseId: CLASS_MINE,
    positionMs: 1000,
    listenedMs: 1000,
    updatedAt: 1,
  });

  it('lets a student read their own row EVEN WHEN IT DOES NOT EXIST', async () => {
    // The first-time resume path. Without a null guard this is not a denial but
    // a rules EVALUATION ERROR, which surfaces to the app as a broken player.
    await assertSucceeds(
      getDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId())),
    );
  });

  it('lets a student create and update their own row', async () => {
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId()), row(STUDENT)),
    );
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId()), {
        ...row(STUDENT),
        positionMs: 5000,
      }),
    );
  });

  it('does NOT let a student write a row carrying someone else\'s uid', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, theirsId()), row(OUTSIDER)),
    );
  });

  it('refuses progress once the grant has lapsed — a first row and a later update alike', async () => {
    const ref = doc(student().firestore(), COLLECTIONS.listeningProgress, mineId());
    await assertSucceeds(setDoc(ref, row(STUDENT)));
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), COLLECTIONS.assignments, assignmentId(STUDENT, PUBLISHED)), { active: false });
    });
    await assertFails(setDoc(ref, { ...row(STUDENT), positionMs: 9000 }));
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, `${STUDENT}_${PUBLISHED}`), row(STUDENT)),
    );
  });

  it('refuses a row whose numbers are not numbers, or that carries an extra key', async () => {
    // `updatedAt: 'x'` reached the ledger's date formatter, which throws on an
    // invalid date; with no error boundary the class's ledger went blank for
    // every staff member who opened it. The positive sibling above is what
    // proves the honest row still passes.
    const ref = doc(student().firestore(), COLLECTIONS.listeningProgress, mineId());
    await assertFails(setDoc(ref, { ...row(STUDENT), updatedAt: 'x' }));
    await assertFails(setDoc(ref, { ...row(STUDENT), listenedMs: 'lots' }));
    await assertFails(setDoc(ref, { ...row(STUDENT), positionMs: 1.5 }));
    await assertFails(setDoc(ref, { ...row(STUDENT), priority: 1 }));
    // And on update, once the honest row exists.
    await assertSucceeds(setDoc(ref, row(STUDENT)));
    await assertFails(setDoc(ref, { ...row(STUDENT), updatedAt: 'x' }));
  });

  /*
   * A TIME NO DATE CAN HOLD. An integer past what a JavaScript Date holds
   * passed `is int`, and from then on the class's progress page and its
   * workbook exports failed for every manager and admin. The bound is absolute
   * (the start of 2100), so a phone whose clock runs fast still saves.
   */
  it('refuses a time no date can hold, and takes any real one', async () => {
    const ref = doc(student().firestore(), COLLECTIONS.listeningProgress, mineId());
    for (const bad of [8640000000000001, 8640000000000000, LATEST_CLIENT_TIME, 0, -5]) {
      await assertFails(setDoc(ref, { ...row(STUDENT), updatedAt: bad }));
    }
    await assertSucceeds(setDoc(ref, { ...row(STUDENT), updatedAt: Date.now() + 365 * 24 * 3600 * 1000 }));
    await assertSucceeds(setDoc(ref, { ...row(STUDENT), updatedAt: LATEST_CLIENT_TIME - 1 }));
  });

  it('bounds times at LATEST_CLIENT_TIME, the number @sabeel/shared and check:documents use', () => {
    const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8');
    expect(rules).toContain(`v > 0 && v < ${LATEST_CLIENT_TIME}`);
  });

  /*
   * DISABLED, WITH A TOKEN THAT STILL SAYS ACTIVE. A token keeps its claims
   * for up to an hour; a student disabled a minute ago went on writing to
   * their class's ledger for the rest of it. The record decides.
   */
  it('a student disabled since their token was issued saves no more progress', async () => {
    const ref = doc(student().firestore(), COLLECTIONS.listeningProgress, mineId());
    await assertSucceeds(setDoc(ref, row(STUDENT)));
    await seedStudentRecords(testEnv, [STUDENT], 'disabled');
    await assertFails(setDoc(ref, { ...row(STUDENT), positionMs: 5000 }));
  });

  it('takes the part and version a student is in, and only real ones', async () => {
    const ref = doc(student().firestore(), COLLECTIONS.listeningProgress, mineId());
    await assertSucceeds(setDoc(ref, { ...row(STUDENT), part: 2, version: 'speaker' }));
    await assertFails(setDoc(ref, { ...row(STUDENT), part: '2', version: 'speaker' }));
    await assertFails(setDoc(ref, { ...row(STUDENT), part: 2, version: 'hd' }));
  });

  /*
   * THE ID IS PART OF THE ROW, and the lockout is why.
   *
   * A create carrying the writer's OWN uid under ANOTHER student's document id
   * passes every content check — the uid in the body is honestly theirs. The
   * victim's first write is then an update whose `resource.data.studentUid` is
   * somebody else, denied from every device for ever, with `delete: if false`
   * leaving no way back. The row grants the writer nothing; it is pure denial
   * of service against one student and one recording.
   */
  it('does NOT let a student plant an honest row under someone else\'s id', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, theirsId()), row(STUDENT)),
    );
    // And the victim can still write their own row afterwards — which is the
    // half that matters, since the plant grants the writer nothing and exists
    // only to lock somebody else out.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.assignments, assignmentId(OUTSIDER, PUBLISHED)), {
        studentUid: OUTSIDER,
        recordingId: PUBLISHED,
        sessionId: `${PUBLISHED}-s`,
        courseId: CLASS_MINE,
        cohortId: 'c1',
        dueDate: '2099-01-01',
        active: true,
        assignedAt: 1,
        assignedBy: 'system',
      });
    });
    await assertSucceeds(
      setDoc(doc(outsider().firestore(), COLLECTIONS.listeningProgress, theirsId()), row(OUTSIDER)),
    );
  });

  /*
   * THE CLASS IS THE GRANT'S. Every staff read of this collection is
   * `courseId == && recordingId ==` — the rules require it — so a row carrying
   * another class's id is a row the ledger never sees, while the student's own
   * screens, filtered on `studentUid` alone, go on showing their progress.
   */
  it('does NOT let a student file their progress under another class', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId()), {
        ...row(STUDENT),
        courseId: CLASS_THEIRS,
      }),
    );
  });

  it('does NOT let a student move an existing row to another class', async () => {
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId()), row(STUDENT)),
    );
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId()), {
        ...row(STUDENT),
        courseId: CLASS_THEIRS,
        positionMs: 9000,
      }),
    );
  });

  it('does NOT let a student write progress for a recording they were never granted', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, `${STUDENT}_somethingElse`), {
        ...row(STUDENT),
        recordingId: 'somethingElse',
      }),
    );
  });

  it('does NOT let a student overwrite a row that is already someone else\'s', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.listeningProgress, theirsId()), row(OUTSIDER));
    });
    // Even claiming their own uid in the payload must not let them clobber it.
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, theirsId()), row(STUDENT)),
    );
  });

  it('does not let a student LIST everyone\'s progress', async () => {
    // Added after a mutation test: widening `list` to any active student broke
    // no test at all, because every other case here uses a get. An unconstrained
    // list is the one shape that hands over the whole collection.
    await assertFails(getDocs(collection(student().firestore(), COLLECTIONS.listeningProgress)));
    await assertSucceeds(
      getDocs(
        query(
          collection(student().firestore(), COLLECTIONS.listeningProgress),
          where('studentUid', '==', STUDENT),
        ),
      ),
    );
  });

  it('does not let a student read another student\'s row', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.listeningProgress, theirsId()), row(OUTSIDER));
    });
    await assertFails(
      getDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, theirsId())),
    );
  });

  /*
   * Scoped staff reads of this collection are the ledger's, and they live in
   * `rules.ledger.test.ts` — including the `get`-versus-`list` distinction.
   * This asserts the two things that hold whatever the ledger may do: an
   * UNCONSTRAINED list is refused, and no client writes it at all.
   */
  it('does not let staff LIST it unscoped, and let NOBODY write it', async () => {
    await assertFails(getDocs(collection(mine().firestore(), COLLECTIONS.listeningProgress)));
    await assertFails(
      setDoc(doc(admin().firestore(), COLLECTIONS.listeningProgress, mineId()), row(STUDENT)),
    );
  });

  it('never allows deletion', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.listeningProgress, mineId()), row(STUDENT));
    });
    await assertFails(
      deleteDoc(doc(student().firestore(), COLLECTIONS.listeningProgress, mineId())),
    );
  });
});
