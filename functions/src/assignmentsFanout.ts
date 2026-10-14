import { type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  accountableUids,
  assignmentId,
  enrollmentId,
  isOverdue,
  todayInZone,
  type AssignmentDoc,
  type EnrollmentDoc,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';

/**
 * The one place assignment documents are written.
 *
 * Obligations are attendance-driven: a student owes a session's recording iff the
 * recording is published, attendance has been submitted, and they were marked
 * EXCUSED. That one document is both the access grant and the requirement, so
 * present and absent students are granted nothing. This module reconciles the
 * `assignments` collection to that truth. All of it runs in the Admin SDK, so it
 * bypasses security rules — assignments are server-owned and `firestore.rules`
 * denies every client write.
 *
 * The reconcile is one transaction, whose 500 writes a class's grants are far
 * inside. The bulk switch-offs (a recording gone, a student unenrolled) are
 * batches chunked at 400, so a pathologically large roster cannot throw.
 */

const CHUNK = 400;

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deactivate active obligations for a recording whose student is NOT in `keep`. */
async function deactivateExcept(
  db: Firestore,
  recordingId: string,
  keep: Set<string>,
): Promise<void> {
  const snap = await db
    .collection(COLLECTIONS.assignments)
    .where('recordingId', '==', recordingId)
    .where('active', '==', true)
    .get();
  const stale = snap.docs.filter((d) => !keep.has((d.data() as AssignmentDoc).studentUid));
  for (const group of chunked(stale)) {
    const batch = db.batch();
    for (const d of group) batch.update(d.ref, { active: false });
    await batch.commit();
  }
}

/** Turn accountability off for every assignment of a recording, keeping history. */
async function deactivateAssignmentsForRecording(
  db: Firestore,
  recordingId: string,
): Promise<void> {
  await deactivateExcept(db, recordingId, new Set());
}

/**
 * Reconcile a session's recording obligations to its attendance.
 *
 * The single decision point, shared by the recording trigger, the session
 * (attendance) trigger and re-enrolment. Target = the EXCUSED in the submitted
 * attendance, and only once the recording is published AND attendance has been
 * submitted; otherwise nobody is accountable and nobody may open it. `dueDate`
 * follows the session, so a due-date edit re-flows here. Idempotent —
 * deterministic ids plus a deactivate of the complement — so it is safe on
 * every write, and a grant already as it should be is not written again.
 *
 * ONE TRANSACTION, reading everything it decides from. Two reconciles of one
 * session at once — the recording trigger after a publish and the session
 * trigger after an attendance submit, a moment apart — each read the state
 * and then wrote, and the one that read first could write last: it switched
 * off the grants the other had just made, from a state that had already
 * passed, and an excused student lost the recording until the next write. In
 * a transaction a reconcile commits only what it read still holds. The session
 * and recording are read here for the same reason, never taken from a caller's
 * snapshot. A class's grants are far inside a transaction's 500 writes.
 *
 * STILL ENROLLED, not merely marked: the same rule `submitAttendance` applies,
 * re-applied at reconcile time. A mark records what happened on the day and
 * outlives the enrolment; enrolment is the separate fact of whether they are
 * still in the class, and only that one decides who is accountable now.
 * Without it, unenrolment did not stick: `setEnrollmentActive` switched the
 * grants off, and the next write to any session in the course rebuilt them
 * from the attendance snapshot alone.
 *
 * A CLOSED SESSION NEVER MINTS OR REVIVES A GRANT. Once the listen-by date has
 * gone, the only grants that may be active are the ones that already are — the
 * ledger's Missed rows, which are the record and must stand. "Nothing is ever
 * born expired": a new active grant is a false→true edge that pushes "ready to
 * listen… by <a date long gone>" at a student over audio `getPlaybackUrl` then
 * refuses. Deactivation is untouched: an unpublish or a corrected mark still
 * switches grants off after the date. And the reopen valve still works —
 * moving the due date forward makes the session open again before this runs.
 */
export async function reconcileSessionAssignments(db: Firestore, sessionId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const session = (await tx.get(db.collection(COLLECTIONS.sessions).doc(sessionId))).data() as SessionDoc | undefined;
    const recId = session?.recordingId ?? null;
    if (!session || !recId) return; // no session or no recording — nothing to own

    const rec = (await tx.get(db.collection(COLLECTIONS.recordings).doc(recId))).data() as RecordingDoc | undefined;
    const ready = !!rec && rec.status === 'published' && !!session.attendanceSubmittedAt;
    const excused = ready ? accountableUids(session.attendance) : [];
    const enrolments = excused.length
      ? await tx.getAll(...excused.map((uid) => db.collection(COLLECTIONS.enrollments).doc(enrollmentId(uid, session.courseId))))
      : [];
    const grants = await tx.get(db.collection(COLLECTIONS.assignments).where('recordingId', '==', recId));
    const prior = new Map(grants.docs.map((d) => [(d.data() as AssignmentDoc).studentUid, d.data() as AssignmentDoc]));

    let target = excused.filter((_, i) => (enrolments[i].data() as EnrollmentDoc | undefined)?.active);
    if (isOverdue(session.dueDate, todayInZone(INSTITUTE_TIMEZONE))) {
      target = target.filter((uid) => prior.get(uid)?.active === true);
    }

    const now = Date.now();
    const keep = new Set(target);
    for (const uid of target) {
      const was = prior.get(uid);
      const grant: AssignmentDoc = {
        studentUid: uid,
        recordingId: recId,
        sessionId,
        courseId: session.courseId,
        cohortId: session.cohortId,
        dueDate: session.dueDate,
        active: true,
        assignedAt: was?.assignedAt ?? now,
        assignedBy: was?.assignedBy ?? 'system',
      };
      if (was && sameGrant(was, grant)) continue;
      tx.set(db.collection(COLLECTIONS.assignments).doc(assignmentId(uid, recId)), grant);
    }
    for (const d of grants.docs) {
      const g = d.data() as AssignmentDoc;
      if (g.active && !keep.has(g.studentUid)) tx.update(d.ref, { active: false });
    }
  });
}

/** Whether a stored grant already says everything a reconcile would write. */
function sameGrant(a: AssignmentDoc, b: AssignmentDoc): boolean {
  return (
    a.active === b.active &&
    a.sessionId === b.sessionId &&
    a.courseId === b.courseId &&
    a.cohortId === b.cohortId &&
    a.dueDate === b.dueDate
  );
}

/**
 * Reconcile every session in a course — the other half of unenrolment.
 *
 * `deactivateStudentAssignmentsInCourse` switches a student's grants off when
 * they leave. Nothing switched them back on when they returned: there is no
 * trigger on `enrollments`, and `setEnrollmentActive` wrote one field. So a
 * student who was unenrolled and re-enrolled a fortnight later came back to an
 * empty home screen — every recording refused by the rules and by
 * `getPlaybackUrl` — while the recording ledger told staff, in as many words,
 * that "re-enrolling them or republishing restores it". Access actually returned
 * only if somebody independently edited each session or republished each
 * recording, which is not a thing anybody would think to do.
 *
 * Per SESSION rather than per assignment, because the grant is derived, never
 * restored from a copy: each session is reconciled from its own attendance and
 * its own recording, which is the same decision `onSessionWritten` makes. A
 * student excused before they left is granted again; one who was not is not;
 * and a session whose recording is no longer published grants nobody, exactly as
 * if it had been reconciled for any other reason.
 *
 * Sized for a course, not for the institute: a term is tens of sessions, and
 * this runs on an admin action nobody performs in a loop.
 */
export async function reconcileCourseAssignments(db: Firestore, courseId: string): Promise<void> {
  const sessions = await db
    .collection(COLLECTIONS.sessions)
    .where('courseId', '==', courseId)
    .get();
  for (const doc of sessions.docs) {
    const session = doc.data() as SessionDoc;
    if (!session.recordingId) continue;
    // A closed session hands nothing back — the rule lives in
    // `reconcileSessionAssignments`, once, so every path that reconciles a
    // session agrees. The deactivated assignment stays, and the ledger goes on
    // listing the student under "Excused, access closed".
    await reconcileSessionAssignments(db, doc.id);
  }
}

/**
 * React to a recording write: reconcile its session's obligations. A recording
 * that is gone deactivates everything pointing at it.
 *
 * THE EVENT PAYLOAD DECIDES NOTHING — not what to write, and not whether the
 * recording still exists. The delete branch used to read the event's `after`,
 * which is the one thing `applySessionFanout`'s docblock says not to do: delivery
 * is at-least-once and unordered, so a delete event arriving after the document
 * at that id exists again deactivated a live grant. Production never reuses a
 * recording id, so this was only ever reachable in a fixture — but a trigger
 * that trusts a stale snapshot for a destructive branch is the wrong shape, and
 * it made three unrelated suites fail a few runs in a hundred, in a different
 * test each time.
 */
export async function applyRecordingFanout(db: Firestore, recordingId: string): Promise<void> {
  const rec = (await db.collection(COLLECTIONS.recordings).doc(recordingId).get()).data() as
    | RecordingDoc
    | undefined;
  if (!rec?.sessionId) {
    // Gone, or malformed with no session — nothing left to reconcile against.
    await deactivateAssignmentsForRecording(db, recordingId);
    return;
  }
  await reconcileSessionAssignments(db, rec.sessionId);
}

/**
 * React to a session write (attendance / due-date change): reconcile its
 * recording's obligations.
 *
 * Both sides are RE-READ rather than taken from the event's `after` snapshot.
 * Cloud Functions delivery is at-least-once and unordered, so two quick writes
 * — submit attendance, then correct one student and re-submit — can reconcile in
 * reverse order. Reconciling from a snapshot lets the older invocation write
 * last and silently restore the obligation that was just removed, and it stays
 * wrong until the next write to that session. Reconciling from stored truth
 * converges no matter what order the events arrive in.
 */
export async function applySessionFanout(
  db: Firestore,
  sessionId: string,
  _before: SessionDoc | undefined,
  after: SessionDoc | undefined,
): Promise<void> {
  if (!after) return; // a deleted session cascades its assignments in the delete callable
  await reconcileSessionAssignments(db, sessionId);
}

/** Turn off a student's obligations in a course (unenrolment), keeping history. */
export async function deactivateStudentAssignmentsInCourse(
  db: Firestore,
  courseId: string,
  studentUid: string,
): Promise<void> {
  const snap = await db
    .collection(COLLECTIONS.assignments)
    .where('studentUid', '==', studentUid)
    .where('courseId', '==', courseId)
    .get();
  for (const group of chunked(snap.docs)) {
    const batch = db.batch();
    for (const d of group) batch.update(d.ref, { active: false });
    await batch.commit();
  }
}
