import { type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  assignmentId,
  attendanceMissingMessage,
  canPlayFromCourse,
  effectiveCompletion,
  isOverdue,
  lastDayMessage,
  recordingReadyMessage,
  type AssignmentDoc,
  type CompletionDoc,
  type CompletionOverrideDoc,
  type CourseDoc,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import { notifyOnce } from './notify';

/**
 * What each of the three notifications actually looks up and sends.
 *
 * Separated from the trigger/schedule bindings so every one of them can be
 * driven directly against the emulator with the FCM sender stubbed. Delivery is
 * the only part no test can reach; deciding WHO gets WHAT is all here.
 */

/**
 * Cache courses across a batch — a morning sweep touches the same few. Each
 * answers with its name and whether its recordings can still be played, which
 * is the one thing about a course a message to a student has to respect.
 */
function courseLookup(db: Firestore) {
  const cache = new Map<string, { name: string; playable: boolean }>();
  return async (courseId: string) => {
    const hit = cache.get(courseId);
    if (hit !== undefined) return hit;
    const doc = (await db.collection(COLLECTIONS.courses).doc(courseId).get()).data() as
      | CourseDoc
      | undefined;
    // A course that is gone plays nothing; a name is still needed for the copy
    // of messages that do go out.
    const entry = { name: doc?.name ?? 'Your class', playable: !!doc && canPlayFromCourse(doc) };
    cache.set(courseId, entry);
    return entry;
  };
}

/**
 * A grant just became active on a published recording: tell the student.
 *
 * Fires from the assignments trigger rather than the publish callable because a
 * grant appears from either direction — publishing a recording, or submitting
 * attendance for one already published — and the assignment document is where
 * those two paths meet.
 */
export async function notifyRecordingReady(
  db: Firestore,
  edge: Pick<AssignmentDoc, 'studentUid' | 'recordingId'>,
  today: string,
): Promise<boolean> {
  /*
   * THE EVENT SAYS WHICH GRANT; THE DOCUMENT SAYS WHETHER. The trigger is
   * retried, and a retry is handed the ORIGINAL event's payload — hours old,
   * still reading `active: true`. A register corrected from excused to present
   * in between, an unpublish, an unenrolment: each had closed the grant, and a
   * send that trusted the payload told the student "ready to listen" about
   * audio `getPlaybackUrl` was already refusing. The stored grant is also where
   * the CURRENT deadline is: a listen-by date moved after the edge fired is
   * rewritten onto it by the reconcile, and the payload keeps the old one.
   */
  const assignment = (
    await db
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId(edge.studentUid, edge.recordingId))
      .get()
  ).data() as AssignmentDoc | undefined;
  if (!assignment?.active) return false;
  // NOTHING IS ANNOUNCED PAST ITS DATE. The reconcile never revives a grant on
  // a closed session, so an active edge here on a past due date is a grant that
  // should not exist; saying "yours to listen to until <a date long gone>" over
  // audio `getPlaybackUrl` refuses would only compound it.
  if (isOverdue(assignment.dueDate, today)) return false;
  const rec = (
    await db.collection(COLLECTIONS.recordings).doc(assignment.recordingId).get()
  ).data() as RecordingDoc | undefined;
  if (!rec || rec.status !== 'published') return false;

  // AND ONLY WHERE IT CAN BE PLAYED. An archived course with listening off
  // refuses the audio (`getPlaybackUrl`: class-listening-off), so "ready to
  // listen" over it would be a message about a door that is locked.
  const course = await courseLookup(db)(assignment.courseId);
  if (!course.playable) return false;
  return notifyOnce(
    db,
    assignment.studentUid,
    'recordingReady',
    assignment.recordingId,
    recordingReadyMessage(course.name, rec.title, assignment.dueDate, assignment.recordingId),
  );
}

/**
 * One recipient's failure must not cost everyone else theirs.
 *
 * `notifyOnce` rethrows anything that is not "already claimed", which is right
 * for the trigger — it retries. A SWEEP is different: it is not retried, and both
 * sweeps are once-a-day-or-never. `lastDay` in particular has no second chance,
 * because tomorrow the deadline has passed and the query no longer matches, so
 * one transient error a third of the way through a batch would silently cost
 * every student after it their only reminder. Logged, not swallowed silently:
 * the run keeps going and the failure is still in the logs.
 */
export async function attempt(what: string, send: () => Promise<boolean>): Promise<boolean> {
  try {
    return await send();
  } catch (e) {
    console.error(`notify ${what} failed`, e);
    return false;
  }
}

/**
 * Everyone whose grant closes at the end of `today` and who has not finished it.
 *
 * Deliberately the morning OF the due date, not the day after: after it the
 * recording is gone, so the only honest message would be "you missed it".
 */
export async function notifyLastDay(db: Firestore, today: string): Promise<number> {
  const due = await db
    .collection(COLLECTIONS.assignments)
    .where('active', '==', true)
    .where('dueDate', '==', today)
    .get();

  const courseOf = courseLookup(db);
  let sent = 0;
  for (const doc of due.docs) {
    const a = doc.data() as AssignmentDoc;
    // The brief's "when a course is archived, active reminders stop": with
    // listening off the audio is refused, so a last-day reminder would only
    // send somebody to a door that is locked.
    const course = await courseOf(a.courseId);
    if (!course.playable) continue;
    /*
     * THE EFFECTIVE COMPLETION, which is the student's own mark UNLESS staff
     * have overridden it. Reading `completions` alone meant a student a staff
     * member had already marked complete — "caught up with the teacher
     * one-on-one", the reason the override exists — was still told on the last
     * day that they had a recording to listen to. Every screen in the product
     * uses `effectiveCompletion` for exactly this; the one thing that speaks to
     * a student unprompted did not.
     */
    const [completionSnap, overrideSnap] = await Promise.all([
      db.collection(COLLECTIONS.completions).doc(`${a.studentUid}_${a.recordingId}`).get(),
      db.collection(COLLECTIONS.completionOverrides).doc(`${a.studentUid}_${a.recordingId}`).get(),
    ]);
    const effective = effectiveCompletion(
      completionSnap.data() as CompletionDoc | undefined,
      overrideSnap.data() as CompletionOverrideDoc | undefined,
    );
    if (effective.completed) continue;

    const rec = (
      await db.collection(COLLECTIONS.recordings).doc(a.recordingId).get()
    ).data() as RecordingDoc | undefined;
    if (!rec || rec.status !== 'published') continue;

    const message = lastDayMessage(course.name, rec.title, a.dueDate, a.recordingId);
    /*
     * ONCE PER DEADLINE, not once per recording. Staff reopen a closed session
     * by moving its listen-by date forward — the documented way back in — and
     * a marker keyed on the recording alone had already been spent on the
     * first date, so the second last day passed in silence. The date in the
     * key makes a new deadline a new reminder.
     */
    const ok = await attempt(`lastDay ${a.studentUid} ${a.recordingId}`, () =>
      notifyOnce(db, a.studentUid, 'lastDay', `${a.recordingId}_${a.dueDate}`, message),
    );
    if (ok) sent++;
  }
  return sent;
}

/**
 * Sessions that have met but whose attendance was never submitted, to the staff
 * who run them.
 *
 * Under excused-only access an un-taken sheet is not an admin nicety: nobody is
 * granted anything, so a published recording sits there openable by no one and
 * nothing in the app says so. This is the message that catches it.
 *
 * `graceDays` keeps it off a teacher's back the same evening — attendance taken
 * the next morning is normal, not a lapse.
 */
export async function notifyAttendanceMissing(
  db: Firestore,
  today: string,
  graceDays = 2,
): Promise<number> {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - graceDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const stale = await db
    .collection(COLLECTIONS.sessions)
    .where('attendanceSubmittedAt', '==', null)
    .where('date', '<=', cutoff)
    .get();

  let sent = 0;
  for (const doc of stale.docs) {
    const s = doc.data() as SessionDoc;
    // Marked as not recorded: there is no audio for a missing register to lock
    // anyone out of, which is the entire reason this message exists.
    if (s.notRecorded) continue;
    const course = (await db.collection(COLLECTIONS.courses).doc(s.courseId).get()).data() as
      | CourseDoc
      | undefined;
    // An archived or finished course is not a reminder anyone wants.
    if (!course || !course.effectiveActive) continue;

    const message = attendanceMissingMessage(course.name, s.title, s.date, s.courseId, doc.id);
    for (const uid of course.managerUids) {
      const ok = await attempt(`attendanceMissing ${uid} ${doc.id}`, () =>
        notifyOnce(db, uid, 'attendanceMissing', doc.id, message),
      );
      if (ok) sent++;
    }
  }
  return sent;
}
