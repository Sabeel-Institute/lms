import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { withAudio } from '../mediaFixtures';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  assignmentId,
  attendanceRecordId,
  enrollmentId,
  type AssignmentDoc,
  type AttendanceRecordDoc,
  type AttendanceStatus,
  type RecordingDoc,
  type SessionDoc,
  type StudentDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { applyEnrollmentActive, createEnrollmentRecord } from '../../src/enrollments';
import { playbackDenial } from '../../src/playback';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { applySubmitAttendance } from '../../src/sessions';
import {
  reconcileSessionAssignments,
  deactivateStudentAssignmentsInCourse,
} from '../../src/assignmentsFanout';
import { reconcileAttendanceRecords } from '../../src/attendanceMirror';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';
const db = () => getFirestore();

async function clearAll() {
  for (const c of [
    COLLECTIONS.students,
    COLLECTIONS.cohorts,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.sessions,
    COLLECTIONS.recordings,
    COLLECTIONS.assignments,
    COLLECTIONS.attendanceRecords,
  ]) {
    const snap = await db().collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const users = await getAuth().listUsers();
  await Promise.all(users.users.map((u) => getAuth().deleteUser(u.uid)));
}

async function seedStudent(uid: string) {
  const doc: StudentDoc = {
    displayName: uid,
    email: `${uid}@example.com`,
    role: 'student',
    status: 'active',
    createdAt: 1,
    createdBy: ADMIN,
  };
  await db().collection(COLLECTIONS.students).doc(uid).set(doc);
}

/** A session written straight to Firestore (attendance snapshot + submit flag). */
async function seedSession(
  id: string,
  fields: {
    dueDate?: string;
    attendance: Record<string, AttendanceStatus>;
    submitted: boolean;
    recordingId?: string | null;
  },
): Promise<SessionDoc> {
  const doc: SessionDoc = {
    courseId,
    cohortId,
    date: '2026-07-06',
    title: id,
    // OPEN, by a margin the calendar will not close: the reconcile now refuses
    // to mint a grant on a session whose listen-by date has gone, and a fixture
    // dated for "next month" when it was written became a closed session by
    // September and granted nobody. The closed cases below say `2020-01-01`.
    dueDate: fields.dueDate ?? '2099-08-01',
    notes: '',
    recordingId: fields.recordingId ?? null,
    attendance: fields.attendance,
    attendanceSubmittedAt: fields.submitted ? 1 : null,
    notRecorded: false,
    createdAt: 1,
    createdBy: ADMIN,
    updatedAt: 1,
  };
  await db().collection(COLLECTIONS.sessions).doc(ns(id)).set(doc);
  return doc;
}

/** A recording written straight to Firestore — reconcile only reads its status. */
async function seedRecording(id: string, sessionId: string, status: RecordingDoc['status']) {
  const doc: RecordingDoc = {
    // NAMESPACED, like the document it is written under. Left raw, the recording
    // pointed at a session id no document has — so the emulator's own
    // `onRecordingWritten` short-circuited on every write here, and the fixture
    // resembled the trigger path without exercising it.
    sessionId: ns(sessionId),
    courseId,
    cohortId,
    title: id,
    notes: '',
    date: '2026-07-06',
    status,
    source: 'manual',
    ...withAudio(ns(id), { durationSec: 60 }),
    createdAt: 1,
    createdBy: ADMIN,
    updatedAt: 1,
  };
  await db().collection(COLLECTIONS.recordings).doc(ns(id)).set(doc);
  await db().collection(COLLECTIONS.sessions).doc(ns(sessionId)).update({ recordingId: ns(id) });
  return doc;
}

const getAssignment = async (uid: string, recId: string) =>
  (await db().collection(COLLECTIONS.assignments).doc(assignmentId(uid, ns(recId))).get()).data() as
    | AssignmentDoc
    | undefined;

const countActive = async (recId: string) =>
  (
    await db()
      .collection(COLLECTIONS.assignments)
      .where('recordingId', '==', ns(recId))
      .where('active', '==', true)
      .get()
  ).size;

/** Reconcile a session by id, reading the current session + recording docs. */
async function reconcile(sessionId: string) {
  const session = (await db().collection(COLLECTIONS.sessions).doc(ns(sessionId)).get()).data() as
    | SessionDoc
    | undefined;
  const rec = session?.recordingId
    ? ((await db().collection(COLLECTIONS.recordings).doc(session.recordingId).get()).data() as
        | RecordingDoc
        | undefined)
    : undefined;
  await reconcileSessionAssignments(db(), ns(sessionId), session, rec);
}

let cohortId: string;
let courseId: string;

/*
 * A DOCUMENT ID IS NEVER REUSED ACROSS TESTS, and that is not tidiness.
 *
 * `clearAll` deletes this file's sessions and recordings, and each deletion
 * fires `onSessionWritten` / `onRecordingWritten` in the Functions emulator —
 * asynchronously, on its own schedule. With a fixed id like `sess`, the trigger
 * for the PREVIOUS test's deletion could land after the NEXT test had seeded a
 * session under the same id, and reconcile it against a session that no longer
 * exists: every grant deactivated, in a test that had done nothing wrong. It
 * failed a few runs in a hundred, in a different test each time.
 *
 * Production never reuses an id — sessions and recordings get auto-ids — so
 * this makes the fixture behave like the thing it is testing. The helpers below
 * namespace, so the test bodies keep reading `'sess'` and `'r1'`.
 */
let testRun = 0;
const ns = (id: string) => `${id}-run${testRun}`;

beforeEach(async () => {
  testRun += 1;
  await clearAll();
  ({ id: cohortId } = await createCohortRecord(ADMIN, 'Autumn 2026'));
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'Hikam' }));
  for (const s of ['s1', 's2', 's3']) {
    await seedStudent(s);
    await createEnrollmentRecord(ADMIN, { studentUid: s, courseId });
  }
});

describe('reconcileSessionAssignments', () => {
  it('grants the EXCUSED alone — present and absent get nothing', async () => {
    await seedSession('sess', {
      dueDate: '2099-08-01',
      attendance: { s1: 'absent', s2: 'present', s3: 'excused' },
      submitted: true,
    });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');

    expect(await getAssignment('s3', 'r1')).toMatchObject({ active: true, dueDate: '2099-08-01' });
    // An unexcused absence opens nothing: the student missed the class and has
    // no claim on the recording. This is the whole policy change in one line.
    expect(await getAssignment('s1', 'r1')).toBeUndefined();
    expect(await getAssignment('s2', 'r1')).toBeUndefined();
    expect(await countActive('r1')).toBe(1);
  });

  it('assigns nobody until BOTH published and attendance submitted', async () => {
    // Published recording, attendance not yet submitted.
    await seedSession('sess', { attendance: { s1: 'excused' }, submitted: false });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await countActive('r1')).toBe(0);

    // Submit attendance → now assigned.
    await db().collection(COLLECTIONS.sessions).doc(ns('sess')).update({ attendanceSubmittedAt: 1 });
    await reconcile('sess');
    expect(await getAssignment('s1', 'r1')).toMatchObject({ active: true });

    // A draft recording assigns nobody even with attendance submitted.
    await seedSession('sess2', { attendance: { s2: 'excused' }, submitted: true });
    await seedRecording('r2', 'sess2', 'draft');
    await reconcile('sess2');
    expect(await countActive('r2')).toBe(0);
  });

  it('re-submitting attendance withdraws a grant and keeps the history', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await countActive('r1')).toBe(2);

    // s2 was actually present after all — the grant goes, the row stays.
    await db()
      .collection(COLLECTIONS.sessions)
      .doc(ns('sess'))
      .update({ attendance: { s1: 'excused', s2: 'present' } });
    await reconcile('sess');
    expect(await getAssignment('s1', 'r1')).toMatchObject({ active: true });
    expect((await getAssignment('s2', 'r1'))?.active).toBe(false); // deactivated, row kept
    expect(await countActive('r1')).toBe(1);
  });

  it('correcting excused to ABSENT withdraws the grant too', async () => {
    // Worth its own case: under the old rule absent kept the obligation, so this
    // is the assertion that would have silently kept passing.
    await seedSession('sess', { attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await countActive('r1')).toBe(1);

    await db()
      .collection(COLLECTIONS.sessions)
      .doc(ns('sess'))
      .update({ attendance: { s1: 'absent' } });
    await reconcile('sess');
    expect((await getAssignment('s1', 'r1'))?.active).toBe(false);
    expect(await countActive('r1')).toBe(0);
  });

  it('a student not in the attendance snapshot is never assigned (enrollment-onward)', async () => {
    // s3 is enrolled but was NOT marked (e.g. enrolled after this session).
    await seedSession('sess', {
      attendance: { s1: 'excused', s2: 'excused' },
      submitted: true,
    });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await getAssignment('s3', 'r1')).toBeUndefined();
    expect(await countActive('r1')).toBe(2);
  });

  it('unpublishing deactivates the obligations but keeps the rows', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await countActive('r1')).toBe(2);

    await db().collection(COLLECTIONS.recordings).doc(ns('r1')).update({ status: 'unpublished' });
    await reconcile('sess');
    expect(await countActive('r1')).toBe(0);
    expect((await getAssignment('s1', 'r1'))?.active).toBe(false);
  });

  it('a due-date edit re-flows to the assignments', async () => {
    await seedSession('sess', {
      dueDate: '2099-08-01',
      attendance: { s1: 'excused' },
      submitted: true,
    });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect((await getAssignment('s1', 'r1'))?.dueDate).toBe('2099-08-01');

    await db().collection(COLLECTIONS.sessions).doc(ns('sess')).update({ dueDate: '2099-08-10' });
    await reconcile('sess');
    expect((await getAssignment('s1', 'r1'))?.dueDate).toBe('2099-08-10');
  });
});

/**
 * What a register PROMISES: it records what happened that day, and correcting
 * one person's mark does not erase anybody else's.
 *
 * `submitAttendance` rebuilds the stored map from the payload, and the payload
 * the app sends holds only the students currently enrolled — so a manager
 * fixing one student's mark deleted the record of every student who had left
 * the class since, and `reconcileAttendanceRecords` then deleted those students'
 * own copies as well. A permanent deletion of accountability history, done by a
 * manager, with no confirmation and nothing in the audit log naming what went.
 * The product rule is disable, archive, unpublish — don't delete.
 *
 * Driven through `applySubmitAttendance`, which is the validation, the
 * authorization and the merge together — the promise is about what survives a
 * submission, so a test of the merge alone would prove the wrong half.
 */
describe('submitting a register', () => {
  const submit = (sessionId: string, attendance: Record<string, string>) =>
    applySubmitAttendance(
      {
        auth: { uid: ADMIN, token: { role: 'admin', status: 'active' } },
        data: { sessionId: ns(sessionId), attendance },
      } as unknown as CallableRequest,
      { courseId: null, targets: {} },
    );
  const marks = async (sessionId: string) =>
    (await db().collection(COLLECTIONS.sessions).doc(ns(sessionId)).get()).data()?.attendance;

  it('keeps the mark of a student who has since left the class', async () => {
    // A LIVE session: excusing anyone new past the listen-by date is refused, so
    // a fixture with the default (past) due date would fail on that instead.
    await seedSession('sess', { dueDate: '2099-01-01', attendance: {}, submitted: false });
    await submit('sess', { s1: 'excused', s2: 'present' });
    expect(await marks('sess')).toEqual({ s1: 'excused', s2: 'present' });

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    // The correction a manager makes weeks later, about somebody else entirely.
    await submit('sess', { s2: 'excused', s3: 'present' });

    expect(await marks('sess')).toEqual({ s1: 'excused', s2: 'excused', s3: 'present' });
  });

  it('still refuses to record a mark for someone not in the class', async () => {
    // The filter's actual job, which the fix must not weaken: a student who was
    // never enrolled cannot be marked at all.
    await seedSession('sess', { dueDate: '2099-01-01', attendance: {}, submitted: false });
    await submit('sess', { s1: 'excused', outsider: 'present' });
    expect(await marks('sess')).toEqual({ s1: 'excused' });
  });

  /*
   * WHAT THE CONFIRMATION SAYS. The screen renders this number verbatim —
   * "Attendance submitted for N students" — over the roster the person just
   * marked. Counting the stored map instead reported the departed students too,
   * so a register of ten confirmed thirteen.
   */
  it('reports the size of the register that was submitted', async () => {
    await seedSession('sess', { dueDate: '2099-01-01', attendance: {}, submitted: false });
    await submit('sess', { s1: 'excused', s2: 'present' });
    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });

    const res = await submit('sess', { s2: 'present', s3: 'present' });
    expect(res.marked).toBe(2);
    // …while the mark it preserved is still there.
    expect(await marks('sess')).toEqual({ s1: 'excused', s2: 'present', s3: 'present' });
  });

  it('lets a correction change a current student’s own mark', async () => {
    await seedSession('sess', { dueDate: '2099-01-01', attendance: {}, submitted: false });
    await submit('sess', { s1: 'excused' });
    await submit('sess', { s1: 'present' });
    expect(await marks('sess')).toEqual({ s1: 'present' });
  });

  /*
   * A SUBMISSION THAT DOES NOT MENTION SOMEBODY SAYS NOTHING ABOUT THEM. The
   * app sends every roster member who has a mark, so its own payloads are
   * complete — but a register opened before a student was re-enrolled (their
   * old mark still stored) lists them nowhere, and the correction it sends
   * omits them. Rebuilding the roster's marks from the payload alone deleted
   * that mark, and `reconcileAttendanceRecords` then deleted the student's own
   * copy: the same permanent deletion the case above closes, through the other
   * door. Nothing in the app unmarks a student, so there is no mark a
   * submission may legitimately remove.
   */
  it('keeps the mark of a current student the submission does not mention', async () => {
    await seedSession('sess', { dueDate: '2099-01-01', attendance: {}, submitted: false });
    await submit('sess', { s1: 'excused', s2: 'present' });
    await submit('sess', { s2: 'excused' });
    expect(await marks('sess')).toEqual({ s1: 'excused', s2: 'excused' });
  });
});

describe('unenrolment', () => {
  it('deactivates a student obligations in the course, keeping history', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect(await countActive('r1')).toBe(2);

    await deactivateStudentAssignmentsInCourse(db(), courseId, 's1');
    expect((await getAssignment('s1', 'r1'))?.active).toBe(false);
    expect((await getAssignment('s2', 'r1'))?.active).toBe(true);
  });

  /*
   * THE PROMISE THE LEDGER AND THE MANUAL BOTH MAKE, in their own words:
   * "re-enrolling them or republishing restores it". Asserted through
   * `playbackDenial`, which is what actually hands the audio over.
   *
   * Nothing did this. There is no trigger on enrolments and
   * `setEnrollmentActive` wrote one field, so a student unenrolled in October
   * and re-enrolled in November came back to an empty home screen — every
   * recording refused — unless staff happened to edit each session or republish
   * each recording afterwards. Two documents and a comment described a behaviour
   * the code did not have.
   */
  /*
   * THROUGH THE PATH THE APP TAKES.
   *
   * The previous version of this drove `applyEnrollmentActive({active:true})`
   * and passed — while the app has no button that calls it. Staff re-enrol by
   * tapping "Add a student", which lists anyone not currently enrolled and calls
   * `createEnrollment`; that reactivated the row and reconciled nothing, so the
   * fix was green in the test and absent in the product. A test that exercises a
   * path nobody can reach is the worst kind: it reports the promise as kept.
   */
  it('gives the audio back when staff re-add the student, as the app does', async () => {
    await seedSession('sess', { dueDate: '2099-01-01', attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    const canPlay = async () =>
      playbackDenial({
        claims: { role: 'student', status: 'active' },
        recording: { status: 'published' },
        item: { status: 'ready', hidden: false },
        cls: { effectiveActive: true, archivedAccess: false, managerUids: [] },
        uid: 's1',
        assignment: (await getAssignment('s1', 'r1')) ?? null,
        today: '2026-07-10',
      });

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    expect(await canPlay()).toBe('not-assigned');

    await createEnrollmentRecord(ADMIN, { studentUid: 's1', courseId });
    expect(await canPlay()).toBeNull();
  });

  /*
   * A REMOVAL THAT HALF-LANDED IS FINISHED BY PRESSING AGAIN. The flag commits
   * in a transaction and the grants are switched off after it; a failure in
   * between — an instance drained mid-call — left the roster reading
   * "removed" while every grant stayed active, and the retry the error
   * message asks for found nothing to change and switched nothing off. There
   * is no trigger on enrolments to converge it later. The intermediate state
   * is planted directly: the flag written, the grants untouched.
   */
  it('finishes a removal whose grants were never switched off, on the next press', async () => {
    await seedSession('sess', { dueDate: '2099-01-01', attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    expect((await getAssignment('s1', 'r1'))?.active).toBe(true);
    await db()
      .collection(COLLECTIONS.enrollments)
      .doc(enrollmentId('s1', courseId))
      .update({ active: false, unenrolledAt: Date.now() });

    const again = await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    expect(again.changed).toBe(false); // nothing to change on the roster…
    expect((await getAssignment('s1', 'r1'))?.active).toBe(false); // …and the grant is off anyway
  });

  /*
   * AND NOT AN OBLIGATION THAT IS ALREADY OVER.
   *
   * A session whose listen-by date went while the student was out of the class
   * must not come back as a fresh grant: "nothing is ever born expired", and a
   * new active assignment is a false→true edge that pushes "a recording is
   * ready… listen by <a date last term>" at them over audio the server then
   * refuses. Their record of it survives in the deactivated assignment, which is
   * what the ledger's "Excused, access closed" group reads.
   */
  /**
   * Let the emulator's own triggers land. Every session write here also fires
   * `onSessionWritten` out of band, and one that read the session BEFORE a
   * date change can write its answer after the test has moved on — which is
   * how a test that flips a due date twice became a coin toss. Production has
   * the same window and converges on the next write; a test cannot wait for
   * "the next write", so it waits for the queue to drain instead.
   */
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  it('does not hand back an obligation whose deadline passed while they were away', async () => {
    await seedSession('closed', { dueDate: '2099-01-01', attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('rClosed', 'closed', 'published');
    await reconcile('closed');
    expect((await getAssignment('s1', 'rClosed'))?.active).toBe(true);
    // The listen-by date goes by.
    await db().collection(COLLECTIONS.sessions).doc(ns('closed')).update({ dueDate: '2020-01-01' });
    await settle();
    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });

    await createEnrollmentRecord(ADMIN, { studentUid: 's1', courseId });
    expect((await getAssignment('s1', 'rClosed'))?.active).toBe(false);

    /*
     * AND NOT ON THE NEXT EDIT EITHER. Re-enrolment skipped the closed session
     * deliberately; then a staff member fixed a typo in its title, the session
     * trigger reconciled it like any other, and the grant came back — a
     * false→true edge that pushed "ready to listen… by <a date long gone>" and
     * moved the student from "Excused, access closed" to Missed. One rule, in
     * the one reconcile: a closed session never mints or revives a grant.
     */
    await db().collection(COLLECTIONS.sessions).doc(ns('closed')).update({ title: 'Renamed' });
    await reconcile('closed');
    expect((await getAssignment('s1', 'rClosed'))?.active).toBe(false);
  });

  it('keeps a Missed grant active on a closed session, and reopens it when the date moves', async () => {
    // s1 was excused, never left, and did not listen: the ledger's Missed row.
    // A reconcile after the date must not switch that grant off — it is the
    // record — and moving the due date forward (the documented reopen valve)
    // must reach anybody excused, including a student whose grant lapsed while
    // they were out of the class.
    await seedSession('late', { dueDate: '2099-01-01', attendance: { s1: 'excused', s2: 'excused' }, submitted: true });
    await seedRecording('rLate', 'late', 'published');
    await reconcile('late');
    await db().collection(COLLECTIONS.sessions).doc(ns('late')).update({ dueDate: '2020-01-01' });
    await settle();
    await reconcile('late');
    expect((await getAssignment('s1', 'rLate'))?.active).toBe(true); // Missed stays Missed
    expect((await getAssignment('s2', 'rLate'))?.active).toBe(true);

    await applyEnrollmentActive({ studentUid: 's2', courseId, active: false });
    await createEnrollmentRecord(ADMIN, { studentUid: 's2', courseId });
    expect((await getAssignment('s2', 'rLate'))?.active).toBe(false); // came back after the date
    expect((await getAssignment('s1', 'rLate'))?.active).toBe(true);

    await db().collection(COLLECTIONS.sessions).doc(ns('late')).update({ dueDate: '2099-01-01' });
    await settle();
    await reconcile('late');
    expect((await getAssignment('s2', 'rLate'))?.active).toBe(true); // reopened for everyone excused
  });

  it('gives the audio back when the student is re-enrolled', async () => {
    // A LIVE session: a closed one deliberately does not come back — see the
    // case above.
    await seedSession('sess', { dueDate: '2099-01-01', attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    const canPlay = async () =>
      playbackDenial({
        claims: { role: 'student', status: 'active' },
        recording: { status: 'published' },
        item: { status: 'ready', hidden: false },
        cls: { effectiveActive: true, archivedAccess: false, managerUids: [] },
        uid: 's1',
        assignment: (await getAssignment('s1', 'r1')) ?? null,
        today: '2026-07-10',
      });

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    expect(await canPlay()).toBe('not-assigned');

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: true });
    expect(await canPlay()).toBeNull();
  });

  it('restores only what the register says, not everything they ever held', async () => {
    // Excused in one session, present in another: coming back must not turn the
    // second into an obligation. The grant is re-derived, never restored from a
    // copy.
    await seedSession('sess', { dueDate: '2099-01-01', attendance: { s1: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await seedSession('sess2', { dueDate: '2099-01-01', attendance: { s1: 'present' }, submitted: true });
    await seedRecording('r2', 'sess2', 'published');
    await reconcile('sess');
    await reconcile('sess2');

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    await applyEnrollmentActive({ studentUid: 's1', courseId, active: true });

    expect((await getAssignment('s1', 'r1'))?.active).toBe(true);
    expect(await getAssignment('s1', 'r2')).toBeUndefined();
  });

  /*
   * WHAT UNENROLMENT PROMISES: the student can no longer open the recording,
   * and it stays that way while ordinary work goes on in the class.
   *
   * Asserted through `playbackDenial`, which is what actually decides whether
   * audio is handed over, rather than through the `active` flag it reads. The
   * flag is the mechanism; being unable to listen is the promise, and a test
   * watching the flag would go on passing if the gate stopped consulting it.
   */
  it('leaves the student unable to play, through ordinary later edits', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'excused' }, submitted: true });
    await seedRecording('r1', 'sess', 'published');
    await reconcile('sess');
    const canPlay = async (uid: string) =>
      playbackDenial({
        claims: { role: 'student', status: 'active' },
        recording: { status: 'published' },
        item: { status: 'ready', hidden: false },
        cls: { effectiveActive: true, archivedAccess: false, managerUids: [] },
        uid,
        assignment: (await getAssignment(uid, 'r1')) ?? null,
        today: '2026-07-10',
      });
    expect(await canPlay('s1')).toBeNull(); // granted, before anything changes

    await applyEnrollmentActive({ studentUid: 's1', courseId, active: false });
    expect(await canPlay('s1')).toBe('not-assigned');

    // The kind of edit that happens all term — and used to hand the audio back.
    await db().collection(COLLECTIONS.sessions).doc(ns('sess')).update({ title: 'Renamed' });
    await reconcile('sess');
    expect(await canPlay('s1')).toBe('not-assigned');
    // And a classmate who is still enrolled is untouched throughout.
    expect(await canPlay('s2')).toBeNull();
  });
});

describe('reconcileAttendanceRecords — the student-visible projection', () => {
  const mirror = async (uid: string, sessionId: string) =>
    (
      await db()
        .collection(COLLECTIONS.attendanceRecords)
        .doc(attendanceRecordId(uid, ns(sessionId)))
        .get()
    ).data() as AttendanceRecordDoc | undefined;

  const project = async (sessionId: string) => {
    const session = (await db().collection(COLLECTIONS.sessions).doc(ns(sessionId)).get()).data() as
      | SessionDoc
      | undefined;
    await reconcileAttendanceRecords(db(), ns(sessionId), session);
  };

  it('projects EVERY mark, not just the granted ones', async () => {
    // A student needs to see that they were marked present just as much as
    // excused — the whole point of the screen is their own record.
    await seedSession('sess', {
      attendance: { s1: 'present', s2: 'absent', s3: 'excused' },
      submitted: true,
    });
    await project('sess');

    expect(await mirror('s1', 'sess')).toMatchObject({ status: 'present', courseId });
    expect(await mirror('s2', 'sess')).toMatchObject({ status: 'absent' });
    expect(await mirror('s3', 'sess')).toMatchObject({ status: 'excused' });
  });

  it('denormalises the date and title, because students cannot read the session', async () => {
    await seedSession('sess', { attendance: { s1: 'present' }, submitted: true });
    await project('sess');
    expect(await mirror('s1', 'sess')).toMatchObject({
      date: '2026-07-06',
      title: 'sess',
      submittedAt: 1,
    });
  });

  /*
   * THE PROMISE THIS COLLECTION EXISTS FOR: a student sees their own mark and
   * NOTHING about anybody else's. `app/src/attendance.ts` states it — a session
   * holds the whole roster's marks, Firestore has no field-level security, and
   * no rule can show one student their own key of that map.
   *
   * `toEqual`, NOT `toMatchObject`, and that is the entire point. Every other
   * document assertion in this repo checks fields it names; none says what must
   * NOT be there. So a plausible edit — `{ ...session, studentUid, status }`, to
   * denormalise one more thing for the student screen — puts the whole roster's
   * `attendance` map into every student's own row, readable by each of them,
   * and passes every one of those assertions. TypeScript does not catch it
   * either: excess-property checking does not apply to spread properties.
   */
  it('carries the student’s own mark and not one field more', async () => {
    await seedSession('sess', {
      attendance: { s1: 'excused', s2: 'present' },
      submitted: true,
    });
    await project('sess');

    expect(await mirror('s1', 'sess')).toEqual({
      studentUid: 's1',
      sessionId: ns('sess'),
      courseId,
      cohortId,
      date: '2026-07-06',
      title: 'sess',
      status: 'excused',
      submittedAt: 1,
    });
  });

  it('projects nothing until attendance is SUBMITTED', async () => {
    // Marks being edited are not a record yet; the same gate the fan-out uses.
    await seedSession('sess', { attendance: { s1: 'excused' }, submitted: false });
    await project('sess');
    expect(await mirror('s1', 'sess')).toBeUndefined();

    await db().collection(COLLECTIONS.sessions).doc(ns('sess')).update({ attendanceSubmittedAt: 1 });
    await project('sess');
    expect(await mirror('s1', 'sess')).toMatchObject({ status: 'excused' });
  });

  it('follows a correction, and DELETES a row dropped from the snapshot', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'present' }, submitted: true });
    await project('sess');
    expect(await mirror('s2', 'sess')).toMatchObject({ status: 'present' });

    await db()
      .collection(COLLECTIONS.sessions)
      .doc(ns('sess'))
      .update({ attendance: { s1: 'present' } });
    await project('sess');
    expect(await mirror('s1', 'sess')).toMatchObject({ status: 'present' });
    // Unlike an assignment, a mark carries no history worth keeping once the
    // session says it never happened — a stale row would contradict the report.
    expect(await mirror('s2', 'sess')).toBeUndefined();
  });

  it('drops every row when the session is deleted', async () => {
    await seedSession('sess', { attendance: { s1: 'excused' }, submitted: true });
    await project('sess');
    await db().collection(COLLECTIONS.sessions).doc(ns('sess')).delete();
    await project('sess');
    expect(await mirror('s1', 'sess')).toBeUndefined();
  });

  it('is idempotent — running twice changes nothing', async () => {
    await seedSession('sess', { attendance: { s1: 'excused', s2: 'absent' }, submitted: true });
    await project('sess');
    await project('sess');
    const all = await db()
      .collection(COLLECTIONS.attendanceRecords)
      .where('sessionId', '==', ns('sess'))
      .get();
    expect(all.size).toBe(2);
  });
});
