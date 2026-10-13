import { type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  dueDateMovedMessage,
  handInLastDayMessage,
  newAssignmentMessage,
  submissionId,
  workReturnedMessage,
  type CourseDoc,
  type CourseworkDoc,
  type PushMessage,
  type SubmissionDoc,
} from '@sabeel/shared';
import { notifyOnce } from './notify';
import { attempt } from './notifyJobs';

/**
 * The four assignment messages (docs/proposals/lms-assignments-proposal.html,
 * section 6): who gets each, with what, once.
 *
 * Sent by the callables that cause them, after their write — posting, moving a
 * due date, returning — and by the 7 AM sweep for the last day. Not by a
 * trigger on submissions, which fire for joiners and re-enrolments too, who
 * get no message: a student who joins finds the work on To do.
 *
 * Best effort: a failed push never fails the teacher's action, which has
 * already happened. `attempt` logs the failure and the rest are still sent.
 *
 * The "sent once" key of each is the proposal's: an assignment's date for
 * posting and moving it, so a NEW date is a new message and a retry is not;
 * the return's `seq` for a return, so another return (another try, a changed
 * grade) is not swallowed as a repeat of the first.
 */

/** Sends at a time: a class gets its message in a second or two, FCM unhurried. */
const AT_ONCE = 8;

async function sendAll(
  jobs: { uid: string; what: string; send: () => Promise<boolean> }[],
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < jobs.length; i += AT_ONCE) {
    const results = await Promise.all(jobs.slice(i, i + AT_ONCE).map((j) => attempt(j.what, j.send)));
    sent += results.filter(Boolean).length;
  }
  return sent;
}

async function readCw(db: Firestore, id: string) {
  return (await db.collection(COLLECTIONS.coursework).doc(id).get()).data() as CourseworkDoc | undefined;
}

async function readCourse(db: Firestore, id: string) {
  return (await db.collection(COLLECTIONS.courses).doc(id).get()).data() as CourseDoc | undefined;
}

/** Students still working on it: has it, nothing in, and is not let off it. */
const stillWorking = (s: SubmissionDoc) => s.active && s.state === 'open' && s.notRequired === null;

function toEach(
  db: Firestore,
  subs: SubmissionDoc[],
  kind: 'assignmentPosted' | 'handInLastDay',
  message: (s: SubmissionDoc) => PushMessage,
) {
  return sendAll(
    subs.map((s) => ({
      uid: s.studentUid,
      what: `${kind} ${s.studentUid} ${s.courseworkId}`,
      send: () => notifyOnce(db, s.studentUid, kind, `${s.courseworkId}_${s.dueDate}`, message(s)),
    })),
  );
}

/** Posted: everyone it went to. */
export async function notifyPosted(db: Firestore, courseworkId: string): Promise<number> {
  const cw = await readCw(db, courseworkId);
  if (!cw || cw.status !== 'posted') return 0;
  const course = await readCourse(db, cw.courseId);
  if (!course?.effectiveActive) return 0;
  const subs = await db.collection(COLLECTIONS.submissions).where('courseworkId', '==', courseworkId).get();
  return toEach(
    db,
    subs.docs.map((d) => d.data() as SubmissionDoc).filter(stillWorking),
    'assignmentPosted',
    (s) => newAssignmentMessage(course.name, cw.title, s.dueDate, courseworkId),
  );
}

/**
 * The due date moved: everyone still working on it whose date moved with it.
 * A student given more time keeps their own date, so nothing moved for them.
 */
export async function notifyDueDateMoved(db: Firestore, courseworkId: string): Promise<number> {
  const cw = await readCw(db, courseworkId);
  if (!cw || cw.status !== 'posted' || cw.closedAt !== null) return 0;
  const course = await readCourse(db, cw.courseId);
  if (!course?.effectiveActive) return 0;
  const subs = await db.collection(COLLECTIONS.submissions).where('courseworkId', '==', courseworkId).get();
  return toEach(
    db,
    subs.docs.map((d) => d.data() as SubmissionDoc).filter((s) => stillWorking(s) && s.moreTime === null && s.dueDate === cw.dueDate),
    'assignmentPosted',
    (s) => dueDateMovedMessage(course.name, cw.title, s.dueDate, courseworkId),
  );
}

/** Returned — as is, for another try, or with a returned grade changed. Never the grade. */
export async function notifyReturned(db: Firestore, courseworkId: string, studentUids: string[]): Promise<number> {
  const cw = await readCw(db, courseworkId);
  if (!cw) return 0;
  const course = await readCourse(db, cw.courseId);
  const name = course?.name ?? 'Your class';
  const jobs = [];
  for (const uid of studentUids) {
    const sub = (await db.collection(COLLECTIONS.submissions).doc(submissionId(uid, courseworkId)).get()).data() as
      | SubmissionDoc
      | undefined;
    if (!sub?.returned || !sub.active) continue;
    const seq = sub.returned.seq;
    jobs.push({
      uid,
      what: `workReturned ${uid} ${courseworkId}`,
      send: () => notifyOnce(db, uid, 'workReturned', `${courseworkId}_${seq}`, workReturnedMessage(name, cw.title, courseworkId)),
    });
  }
  return sendAll(jobs);
}

/**
 * 7 AM: everyone whose work is due today and who has nothing in — on their own
 * date when they were given more time, which is the date their record holds.
 * Not for a course that has been archived, nor an assignment a teacher stopped
 * taking work on, nor anyone let off it.
 */
export async function notifyHandInLastDay(db: Firestore, today: string): Promise<number> {
  const due = await db
    .collection(COLLECTIONS.submissions)
    .where('dueDate', '==', today)
    .where('state', '==', 'open')
    .where('active', '==', true)
    .get();
  const cws = new Map<string, CourseworkDoc | undefined>();
  const courses = new Map<string, CourseDoc | undefined>();
  const jobs: SubmissionDoc[] = [];
  const messages = new Map<string, PushMessage>();
  for (const doc of due.docs) {
    const s = doc.data() as SubmissionDoc;
    if (!stillWorking(s) || s.closedEarly) continue;
    if (!cws.has(s.courseworkId)) cws.set(s.courseworkId, await readCw(db, s.courseworkId));
    const cw = cws.get(s.courseworkId);
    if (!cw || cw.status !== 'posted' || cw.closedAt !== null) continue;
    if (!courses.has(cw.courseId)) courses.set(cw.courseId, await readCourse(db, cw.courseId));
    const course = courses.get(cw.courseId);
    if (!course?.effectiveActive) continue;
    jobs.push(s);
    messages.set(doc.id, handInLastDayMessage(course.name, cw.title, s.dueDate, s.courseworkId));
  }
  return toEach(db, jobs, 'handInLastDay', (s) => messages.get(submissionId(s.studentUid, s.courseworkId)) as PushMessage);
}
