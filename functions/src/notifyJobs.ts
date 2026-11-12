import { type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  assignmentId,
  attendanceMissingMessage,
  canPlayFromCourse,
  effectiveCompletion,
  enrollmentId,
  givenRecordingId,
  isOverdue,
  lastDayMessage,
  lastRequiredDayMessage,
  recordingGivenMessage,
  recordingReadyMessage,
  recordingRequiredMessage,
  requiredUntil,
  sentNotificationId,
  todayInZone,
  type AssignmentDoc,
  type EnrollmentDoc,
  type GivenRecordingDoc,
  type CompletionDoc,
  type CompletionOverrideDoc,
  type CourseDoc,
  type RecordingDoc,
  type SentNotificationDoc,
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
  // A student who already holds it given was told it was open and not
  // required; the news now is that it is required.
  const given = await openGiven(db, assignment.studentUid, assignment.recordingId, today);
  if (!given) {
    return notifyOnce(
      db,
      assignment.studentUid,
      'recordingReady',
      await readyTarget(db, assignment.studentUid, assignment.recordingId),
      recordingReadyMessage(course.name, rec.title, assignment.dueDate, assignment.recordingId),
    );
  }
  /*
   * ITS OWN MARKER, ONE PER GIVEN OPENING. The excused marker is spent once
   * per recording, ever, so a student excused, corrected to present, given it
   * ("It is not required") and excused again heard nothing more: the last
   * thing their phone said was the opposite of the truth.
   */
  return notifyOnce(
    db,
    assignment.studentUid,
    'recordingReady',
    `${assignment.recordingId}_required_${given.givenAt}`,
    recordingRequiredMessage(course.name, rec.title, assignment.dueDate, assignment.recordingId),
  );
}

/**
 * THE MARKER FOR AN EXCUSED "READY", once per recording, unless a "given"
 * message ("It is not required") has gone since the last one: then the
 * student's phone holds the opposite of the truth, and this is news again,
 * once for that message. Excused, corrected to present, given it, and then,
 * with it taken back or ended, excused again was silence.
 */
async function readyTarget(db: Firestore, studentUid: string, recordingId: string): Promise<string> {
  const sent = db.collection(COLLECTIONS.notifications).doc(studentUid).collection('sent');
  const startingWith = (prefix: string) => sent.where('targetId', '>=', prefix).where('targetId', '<', `${prefix}\uf8ff`).get();
  const [first, givens, required] = await Promise.all([
    sent.doc(sentNotificationId('recordingReady', recordingId)).get(),
    startingWith(givenMessageTarget(recordingId, '')),
    // Every message that said it is required: this one, and "now required".
    startingWith(`${recordingId}_required_`),
  ]);
  if (!first.exists) return recordingId;
  const at = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => docs.map((d) => (d.data() as SentNotificationDoc).at);
  const told = Math.max((first.data() as SentNotificationDoc).at, ...at(required.docs));
  const since = at(givens.docs).filter((t) => t > told);
  return since.length === 0 ? recordingId : `${recordingId}_required_after_${Math.max(...since)}`;
}

/** The student's given recording of this one, if its date has not passed. */
async function openGiven(db: Firestore, studentUid: string, recordingId: string, today: string): Promise<GivenRecordingDoc | null> {
  const given = (await db.collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(studentUid, recordingId)).get()).data() as
    | GivenRecordingDoc
    | undefined;
  return given && !isOverdue(given.openUntil, today) ? given : null;
}

/**
 * Staff just gave this student a recording, or opened an ended one again:
 * tell them, once.
 *
 * THE EVENT SAYS WHICH OPENING; THE DOCUMENTS SAY WHETHER, as for the excused.
 * The trigger is retried with the original payload, so everything is read
 * again here: a record taken back or opened again since (its `givenAt` no
 * longer this one), a date that has passed, a recording unpublished, a class
 * archived with listening off, a student who left. And nothing when they are
 * required right now: the excused message is the one that speaks then.
 *
 * At most one a day for a student and a recording: the marker carries the
 * institute day of the opening, so give, take back and give again in one
 * afternoon sends one message, and a reopen (only possible once the last date
 * has passed, so on a later day) sends its own.
 */
export async function notifyRecordingGiven(db: Firestore, givenId: string, givenAt: number, today: string): Promise<boolean> {
  const given = (await db.collection(COLLECTIONS.givenRecordings).doc(givenId).get()).data() as GivenRecordingDoc | undefined;
  if (!given || given.givenAt !== givenAt) return false;
  if (isOverdue(given.openUntil, today)) return false;
  const rec = (await db.collection(COLLECTIONS.recordings).doc(given.recordingId).get()).data() as RecordingDoc | undefined;
  if (!rec || rec.status !== 'published') return false;
  const course = await courseLookup(db)(given.courseId);
  if (!course.playable) return false;
  const [enrolSnap, sessionSnap, grantSnap] = await Promise.all([
    db.collection(COLLECTIONS.enrollments).doc(enrollmentId(given.studentUid, given.courseId)).get(),
    db.collection(COLLECTIONS.sessions).doc(rec.sessionId).get(),
    db.collection(COLLECTIONS.assignments).doc(assignmentId(given.studentUid, given.recordingId)).get(),
  ]);
  if (!(enrolSnap.data() as EnrollmentDoc | undefined)?.active) return false;
  const session = sessionSnap.data() as SessionDoc | undefined;
  if (!session) return false;
  const required = requiredUntil(given.studentUid, {
    session,
    grant: (grantSnap.data() as AssignmentDoc | undefined) ?? null,
    enrolled: true,
    recordingStatus: rec.status,
    today,
  });
  if (required) return false;
  return notifyOnce(
    db,
    given.studentUid,
    'recordingReady',
    givenMessageTarget(given.recordingId, todayInZone(INSTITUTE_TIMEZONE, givenAt)),
    recordingGivenMessage(course.name, rec.title, given.openUntil, given.recordingId),
  );
}

/** The day's one "given" message for a student and a recording: its marker's target. */
export function givenMessageTarget(recordingId: string, day: string): string {
  return `${recordingId}_given_${day}`;
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
  // ONE STUDENT AT A TIME, reads and all: a read that failed for one student
  // used to escape the guard around the send and end the sweep for everyone
  // after them. Their reminder has no second chance tomorrow.
  for (const doc of due.docs) {
    const a = doc.data() as AssignmentDoc;
    if (await attempt(`lastDay ${a.studentUid} ${a.recordingId}`, () => remindLastDay(db, a, today, courseOf))) sent++;
  }
  return sent;
}

/** One student's last-day reminder for one grant: whether it was sent. */
async function remindLastDay(
  db: Firestore,
  a: AssignmentDoc,
  today: string,
  courseOf: ReturnType<typeof courseLookup>,
): Promise<boolean> {
  // The brief's "when a course is archived, active reminders stop": with
  // listening off the audio is refused, so a last-day reminder would only
  // send somebody to a door that is locked.
  const course = await courseOf(a.courseId);
  if (!course.playable) return false;
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
  if (effective.completed) return false;

  const rec = (await db.collection(COLLECTIONS.recordings).doc(a.recordingId).get()).data() as RecordingDoc | undefined;
  if (!rec || rec.status !== 'published') return false;

  // Given until a later date, it does not close today: what ends is the
  // requirement, and the message says that instead. That read only chooses
  // the wording, so its failure costs the clause, not the reminder, which has
  // no second chance.
  const given = await openGiven(db, a.studentUid, a.recordingId, today).catch((e: unknown) => {
    console.error(`lastDay ${a.studentUid} ${a.recordingId}: given read failed, plain wording sent`, e);
    return null;
  });
  const message =
    given && given.openUntil > a.dueDate
      ? lastRequiredDayMessage(course.name, rec.title, given.openUntil, a.recordingId)
      : lastDayMessage(course.name, rec.title, a.dueDate, a.recordingId);
  /*
   * ONCE PER DEADLINE, not once per recording. Staff reopen a closed session
   * by moving its listen-by date forward — the documented way back in — and
   * a marker keyed on the recording alone had already been spent on the
   * first date, so the second last day passed in silence. The date in the
   * key makes a new deadline a new reminder.
   */
  return notifyOnce(db, a.studentUid, 'lastDay', `${a.recordingId}_${a.dueDate}`, message);
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
    // Each session's reads inside its own guard, as each send is: one that
    // fails costs that session's reminder, not every one after it.
    await attempt(`attendanceMissing ${doc.id}`, async () => {
      const s = doc.data() as SessionDoc;
      // Marked as not recorded: there is no audio for a missing register to lock
      // anyone out of, which is the entire reason this message exists.
      if (s.notRecorded) return false;
      const course = (await db.collection(COLLECTIONS.courses).doc(s.courseId).get()).data() as
        | CourseDoc
        | undefined;
      // An archived or finished course is not a reminder anyone wants.
      if (!course || !course.effectiveActive) return false;

      const message = attendanceMissingMessage(course.name, s.title, s.date, s.courseId, doc.id);
      for (const uid of course.managerUids) {
        const ok = await attempt(`attendanceMissing ${uid} ${doc.id}`, () =>
          notifyOnce(db, uid, 'attendanceMissing', doc.id, message),
        );
        if (ok) sent++;
      }
      return true;
    });
  }
  return sent;
}
