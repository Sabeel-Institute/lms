import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  MAX_ATTACHMENTS,
  MAX_POINTS,
  canHandIn,
  canTakeBack,
  closesOn,
  gradeFits,
  gradeText,
  hasOwnDates,
  isLate,
  normalizeMarkdown,
  receivesOnJoining,
  submissionId,
  todayInZone,
  workState,
  type AttachmentFile,
  type AttachmentMap,
  type CourseDoc,
  type CourseworkDoc,
  type CourseworkGrading,
  type DraftDoc,
  type Grade,
  type GradeDoc,
  type SubmissionDoc,
  type SubmissionEventDoc,
  type SubmissionState,
} from '@sabeel/shared';

const SUBMISSION_STATES: SubmissionState[] = ['open', 'handedIn', 'returned'];
import { auditedCall } from './audited';
import { reportedCall } from './reported';
import { isAdminCaller, requireCourseScope, requireStudent } from './guards';
import { isCalendarDate } from './sessions';
import { MEDIA_WRITE_SECRETS, deleteObject } from './mediaStore';
import { notifyDueDateMoved, notifyPosted, notifyReturned } from './notifyCoursework';
import type { AttachmentUploadDoc } from './attachments';

/**
 * Assignments: a teacher posts work to a whole class, each student hands in a
 * note and files, and the teacher grades and returns it
 * (docs/plans/ASSIGNMENTS.md; the rules are the approved proposal's, section 5).
 *
 * Every write here is a callable's. Students write one thing directly, the
 * note on their own draft (`firestore.rules`); the rest — handing in, taking
 * back, files — comes through here, where the dates are checked against the
 * institute's clock rather than the phone's.
 *
 * WHAT A STUDENT SEES OF A GRADE is `submissions.returned`, copied when the
 * work is returned. `grades/` is staff-only, and Firestore has no field-level
 * security, so a grade being written never reaches the student early.
 */

const db = () => getFirestore();
const cwRef = (id: string) => db().collection(COLLECTIONS.coursework).doc(id);
const subRef = (uid: string, cwId: string) => db().collection(COLLECTIONS.submissions).doc(submissionId(uid, cwId));
const draftRef = (uid: string, cwId: string) => db().collection(COLLECTIONS.drafts).doc(submissionId(uid, cwId));
const gradeRef = (uid: string, cwId: string) => db().collection(COLLECTIONS.grades).doc(submissionId(uid, cwId));
const today = () => todayInZone(INSTITUTE_TIMEZONE);

const MAX_TITLE = 200;
const MAX_INSTRUCTIONS = 20_000;
const MAX_REASON = 500;
const MAX_FEEDBACK = 5_000;

// ------------------------------------------------------------ validation --

function str(v: unknown, name: string, max: number, { required = true } = {}): string {
  if (typeof v !== 'string') throw new HttpsError('invalid-argument', `${name} is required.`);
  const t = v.trim();
  if (required && !t) throw new HttpsError('invalid-argument', `${name} is required.`);
  if (t.length > max) throw new HttpsError('invalid-argument', `${name} is too long (${max} characters at most).`);
  return t;
}

function calendarDate(v: unknown, name: string): string {
  if (typeof v !== 'string' || !isCalendarDate(v)) {
    throw new HttpsError('invalid-argument', `${name} is required, as YYYY-MM-DD.`);
  }
  return v;
}

/**
 * The due date and the last day late work is taken. Never written in the
 * past — nothing is born overdue — and the late-work date is never before
 * the due date. `current` is the stored pair on an edit: resending a date that
 * has since passed is not a move, so it is let through.
 */
export function validateDates(
  input: { dueDate: unknown; lateUntil: unknown },
  todayIs: string,
  current?: { dueDate: string; lateUntil: string | null },
): { dueDate: string; lateUntil: string | null } {
  const dueDate = calendarDate(input.dueDate, 'A due date');
  if (dueDate !== current?.dueDate && dueDate < todayIs) {
    throw new HttpsError('invalid-argument', 'A due date cannot be in the past.');
  }
  if (input.lateUntil === null) return { dueDate, lateUntil: null };
  const lateUntil = calendarDate(input.lateUntil, 'The last day for late work');
  if (lateUntil < dueDate) {
    throw new HttpsError('invalid-argument', 'Late work cannot end before the due date.');
  }
  if (lateUntil !== current?.lateUntil && lateUntil < todayIs) {
    throw new HttpsError('invalid-argument', 'The last day for late work cannot be in the past.');
  }
  return { dueDate, lateUntil };
}

function validateGrading(v: unknown): CourseworkGrading {
  const g = v as { kind?: unknown; outOf?: unknown } | null;
  if (g?.kind === 'scale') return { kind: 'scale' };
  if (g?.kind === 'points' && typeof g.outOf === 'number' && Number.isInteger(g.outOf) && g.outOf >= 1 && g.outOf <= MAX_POINTS) {
    return { kind: 'points', outOf: g.outOf };
  }
  throw new HttpsError('invalid-argument', `Grading is points out of a whole number from 1 to ${MAX_POINTS}, or satisfactory / needs work.`);
}

export interface CourseworkFields {
  title: string;
  instructions: string;
  dueDate: string;
  lateUntil: string | null;
  grading: CourseworkGrading;
}

function validateCourseworkFields(
  d: Record<string, unknown>,
  todayIs: string,
  current?: CourseworkDoc,
): CourseworkFields {
  return {
    title: str(d.title, 'A title', MAX_TITLE),
    instructions: str(d.instructions, 'Instructions', MAX_INSTRUCTIONS, { required: false }),
    ...validateDates({ dueDate: d.dueDate, lateUntil: d.lateUntil }, todayIs, current),
    grading: validateGrading(d.grading),
  };
}

const idOf = (v: unknown, name: string) => str(v, name, 200);

// ------------------------------------------------------------------ reads --

async function readCoursework(id: string): Promise<CourseworkDoc> {
  const snap = await cwRef(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such assignment.');
  return snap.data() as CourseworkDoc;
}

async function readCourse(courseId: string): Promise<CourseDoc> {
  const snap = await db().collection(COLLECTIONS.courses).doc(courseId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such class.');
  return snap.data() as CourseDoc;
}

// --------------------------------------------------------------- fan-out --

/** A student's fresh work on an assignment, dated as the assignment is. */
function freshSubmission(cwId: string, cw: CourseworkDoc, studentUid: string): SubmissionDoc {
  return {
    studentUid,
    courseworkId: cwId,
    courseId: cw.courseId,
    cohortId: cw.cohortId,
    active: true,
    dueDate: cw.dueDate,
    lateUntil: cw.lateUntil,
    closedEarly: cw.closedAt !== null,
    state: 'open',
    attempt: 1,
    handedInAt: null,
    note: '',
    files: {},
    returned: null,
    attempts: [],
    notRequired: null,
    moreTime: null,
    assignedAt: Date.now(),
  };
}

async function activeStudents(courseId: string): Promise<string[]> {
  const snap = await db()
    .collection(COLLECTIONS.enrollments)
    .where('courseId', '==', courseId)
    .where('active', '==', true)
    .get();
  return snap.docs.map((d) => d.data().studentUid as string);
}

/** Write in chunks under Firestore's batch limit. */
async function inBatches<T>(items: T[], write: (batch: FirebaseFirestore.WriteBatch, item: T) => void) {
  for (let i = 0; i < items.length; i += 400) {
    const batch = db().batch();
    for (const item of items.slice(i, i + 400)) write(batch, item);
    await batch.commit();
  }
}

/**
 * Bring one student's assignments in a course up to date with their
 * enrolment: called when they join or come back.
 *
 * WHO GETS WHAT: a student joining gets every posted assignment not yet past
 * its due date. Coming back restores the work they had — handed in, returned,
 * or still due — but not open work whose date went by while they were away;
 * nobody comes back to an obligation they had no chance to meet.
 */
export async function reconcileStudentCoursework(courseId: string, studentUid: string): Promise<void> {
  const todayIs = today();
  const posted = await db()
    .collection(COLLECTIONS.coursework)
    .where('courseId', '==', courseId)
    .where('status', '==', 'posted')
    .get();
  for (const doc of posted.docs) {
    const cw = doc.data() as CourseworkDoc;
    const ref = subRef(studentUid, doc.id);
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const sub = snap.data() as SubmissionDoc | undefined;
      if (!sub) {
        if (receivesOnJoining(cw, todayIs)) tx.set(ref, freshSubmission(doc.id, cw, studentUid));
      } else if (!sub.active && (sub.state !== 'open' || receivesOnJoining(cw, todayIs))) {
        tx.update(ref, { active: true });
      }
    });
  }
}

/** A student left the course: their assignments leave To do; their work stays as record. */
export async function deactivateStudentCoursework(courseId: string, studentUid: string): Promise<void> {
  const snap = await db()
    .collection(COLLECTIONS.submissions)
    .where('courseId', '==', courseId)
    .where('studentUid', '==', studentUid)
    .get();
  await inBatches(
    snap.docs.filter((d) => d.data().active === true),
    (batch, d) => batch.update(d.ref, { active: false }),
  );
}

// ---------------------------------------------------------------- create --

/** The id a new assignment's form reserved, and the files the form shows as held under it. */
interface ReservedForm {
  id: string;
  held: string[];
}

/**
 * A new assignment, saved as a draft. For one written on the form, `form` is
 * the id it reserved and the files it showed: those, held under that id, join
 * it here in the same transaction, so the assignment carries exactly the files
 * the teacher saw — not one the form lost track of. Only the caller's own held
 * files, for this class, are taken, and an id already saved is refused rather
 * than written over.
 */
export async function createCourseworkRecord(callerUid: string, courseId: string, fields: CourseworkFields, form?: ReservedForm) {
  const course = await readCourse(courseId);
  if (!course.effectiveActive) throw new HttpsError('failed-precondition', 'This course is archived.');
  const ref = form ? cwRef(form.id) : db().collection(COLLECTIONS.coursework).doc();
  await db().runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) throw new HttpsError('already-exists', 'That assignment is already saved.');
    const listed = form?.held.length
      ? await tx.getAll(...form.held.map((fileId) => db().collection(COLLECTIONS.attachmentUploads).doc(fileId)))
      : [];
    const held = listed.filter((d) => {
      const up = d.data() as AttachmentUploadDoc | undefined;
      return !!up?.held && up.courseworkId === ref.id && up.uploadedBy === callerUid && up.courseId === courseId && up.studentUid === null;
    });
    const now = Date.now();
    const doc: CourseworkDoc = {
      courseId,
      cohortId: course.cohortId,
      ...fields,
      files: Object.fromEntries(held.map((d) => [d.id, (d.data() as AttachmentUploadDoc).held as AttachmentFile])),
      status: 'draft',
      closedAt: null,
      postedAt: null,
      postedBy: null,
      createdAt: now,
      createdBy: callerUid,
      updatedAt: now,
      editedAt: null,
    };
    tx.set(ref, doc);
    for (const d of held) tx.delete(d.ref);
  });
  return { id: ref.id };
}

/** Firestore's own ids, which a form's reserved id and its files' ids both are. */
const AUTO_ID = /^[A-Za-z0-9]{20}$/;

/** A new assignment's form: the id it reserved, and the files it holds. */
function reservedFormOf(d: Record<string, unknown>): ReservedForm | undefined {
  if (d.id === undefined && d.held === undefined) return undefined;
  if (typeof d.id !== 'string' || !AUTO_ID.test(d.id)) throw new HttpsError('invalid-argument', 'id is not an assignment id.');
  if (
    !Array.isArray(d.held) ||
    d.held.length > MAX_ATTACHMENTS ||
    !d.held.every((f): f is string => typeof f === 'string' && AUTO_ID.test(f))
  ) {
    throw new HttpsError('invalid-argument', `held must list at most ${MAX_ATTACHMENTS} file ids.`);
  }
  return { id: d.id, held: [...new Set(d.held)] };
}

export const createCoursework = auditedCall('createCoursework', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const courseId = idOf(d.courseId, 'courseId');
  const uid = await requireCourseScope(req, courseId);
  const fields = validateCourseworkFields(d, today());
  audit.courseId = courseId;
  const res = await createCourseworkRecord(uid, courseId, fields, reservedFormOf(d));
  audit.targets = { courseworkId: res.id };
  audit.detail = { title: fields.title, dueDate: fields.dueDate };
  return res;
});

// ------------------------------------------------------------------ post --

/**
 * Send a draft to the class: everyone enrolled now receives it. A posted
 * assignment never goes back to being a draft.
 */
export async function postCourseworkRecord(callerUid: string, id: string): Promise<{ id: string; students: number }> {
  const course = await readCourse((await readCoursework(id)).courseId);
  if (!course.effectiveActive) throw new HttpsError('failed-precondition', 'This course is archived.');
  const now = Date.now();
  // ONE POST, whoever presses it. Two posts of one draft at once both read
  // 'draft', both fanned out, and both were recorded; the flip is now a
  // transaction that refuses anything already posted.
  const cw = await db().runTransaction(async (tx) => {
    const snap = await tx.get(cwRef(id));
    if (!snap.exists) throw new HttpsError('not-found', 'No such assignment.');
    const current = snap.data() as CourseworkDoc;
    if (current.status !== 'draft') throw new HttpsError('failed-precondition', 'That assignment is already posted.');
    if (current.dueDate < today()) {
      throw new HttpsError('failed-precondition', 'Its due date has passed. Move it before posting.');
    }
    tx.update(cwRef(id), { status: 'posted', postedAt: now, postedBy: callerUid, updatedAt: now });
    return current;
  });
  const posted: CourseworkDoc = { ...cw, status: 'posted', postedAt: now, postedBy: callerUid, updatedAt: now };
  const students = await activeStudents(cw.courseId);
  await inBatches(students, (batch, uid) => batch.set(subRef(uid, id), freshSubmission(id, posted, uid)));
  return { id, students: students.length };
}

export const postCoursework = auditedCall('postCoursework', async (req, audit) => {
  const id = idOf((req.data as { courseworkId?: unknown })?.courseworkId, 'courseworkId');
  const cw = await readCoursework(id);
  const uid = await requireCourseScope(req, cw.courseId);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: id };
  const res = await postCourseworkRecord(uid, id);
  await notifyPosted(db(), id);
  audit.detail = {
    title: cw.title,
    dueDate: cw.dueDate,
    lateUntil: cw.lateUntil,
    grading: cw.grading.kind === 'points' ? `out of ${cw.grading.outOf}` : 'satisfactory / needs work',
    students: res.students,
  };
  return res;
});

// ------------------------------------------------------------------ edit --

/**
 * Change an assignment. On a posted one, a new due date or late-work date
 * reaches every student still working on it, except one whose dates are their
 * own (`hasOwnDates`: more time, or another try), whose date stands. How it
 * is graded cannot change once any grade has been saved.
 */
const FIELD_NAMES: (keyof CourseworkFields)[] = ['title', 'instructions', 'dueDate', 'lateUntil', 'grading'];

/** A value as text with its keys sorted, so a map compares by content and not by key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

/**
 * What the form was opened with, when the caller says. Only shape is checked
 * here: the values are compared, never stored.
 */
function expectedFields(v: unknown): Partial<Record<keyof CourseworkFields, unknown>> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpsError('invalid-argument', 'ifUnchanged is the fields the form was opened with.');
  }
  const o = v as Record<string, unknown>;
  return Object.fromEntries(FIELD_NAMES.filter((k) => k in o).map((k) => [k, o[k]]));
}

export async function updateCourseworkRecord(id: string, d: Record<string, unknown>) {
  const expected = expectedFields(d.ifUnchanged);
  const before = await readCoursework(id);
  const fields = validateCourseworkFields(d, today(), before);
  const gradingChanged = JSON.stringify(fields.grading) !== JSON.stringify(before.grading);
  if (gradingChanged) {
    // A grade saved, or one already given back: another try deletes the grade
    // being written, but the attempt it returned keeps its grade, which a new
    // scale would misread (8/10 shown as 8/100).
    const graded = await db().collection(COLLECTIONS.grades).where('courseworkId', '==', id).limit(1).get();
    const returned =
      graded.empty &&
      (await db().collection(COLLECTIONS.submissions).where('courseworkId', '==', id).get()).docs.some((s) => {
        const sub = s.data() as SubmissionDoc;
        return sub.returned !== null || sub.attempts.length > 0;
      });
    if (!graded.empty || returned) {
      throw new HttpsError('failed-precondition', 'How it is graded cannot change once a grade has been saved.');
    }
  }
  const now = Date.now();
  /*
   * ANOTHER TEACHER'S EDIT IS NOT OVERWRITTEN UNSEEN. Two people can have the
   * same assignment open; the form says what it was opened with, and a save is
   * refused when any of that has changed since. Content only: posting, closing
   * and files move the timestamps without touching what the form edits.
   */
  const cw = await db().runTransaction(async (tx) => {
    const snap = await tx.get(cwRef(id));
    if (!snap.exists) throw new HttpsError('not-found', 'No such assignment.');
    const current = snap.data() as CourseworkDoc;
    if (expected && Object.entries(expected).some(([k, v]) => canonical(current[k as keyof CourseworkFields]) !== canonical(v))) {
      throw new HttpsError(
        'failed-precondition',
        'Someone else changed this assignment while you were editing it. Your changes are not saved; open it again to see theirs.',
      );
    }
    tx.update(cwRef(id), {
      ...fields,
      updatedAt: now,
      ...(current.status === 'posted' ? { editedAt: now } : {}),
    });
    return current;
  });
  const datesMoved = fields.dueDate !== cw.dueDate || fields.lateUntil !== cw.lateUntil;
  if (cw.status === 'posted' && datesMoved) {
    const subs = await db().collection(COLLECTIONS.submissions).where('courseworkId', '==', id).get();
    await inBatches(
      subs.docs.filter((s) => !hasOwnDates(s.data() as SubmissionDoc)),
      (batch, s) => batch.update(s.ref, { dueDate: fields.dueDate, lateUntil: fields.lateUntil }),
    );
  }
  const changed = (Object.keys(fields) as (keyof CourseworkFields)[]).filter(
    (k) => JSON.stringify(fields[k]) !== JSON.stringify(cw[k]),
  );
  return {
    id,
    changed,
    before: { dueDate: cw.dueDate, lateUntil: cw.lateUntil },
    after: { dueDate: fields.dueDate, lateUntil: fields.lateUntil },
  };
}

export const updateCoursework = auditedCall('updateCoursework', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const id = idOf(d.courseworkId, 'courseworkId');
  const cw = await readCoursework(id);
  await requireCourseScope(req, cw.courseId);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: id };
  const res = await updateCourseworkRecord(id, d);
  if (res.changed.includes('dueDate')) await notifyDueDateMoved(db(), id);
  audit.noop = res.changed.length === 0;
  // Worded, not the result spread in: the audit screen printed its nested maps as [object Object].
  const moved = (from: string | null, to: string | null) => `${from ?? 'no late work'} → ${to ?? 'no late work'}`;
  audit.detail = {
    changed: res.changed.join(', '),
    ...(res.changed.includes('dueDate') ? { dueDate: moved(res.before.dueDate, res.after.dueDate) } : {}),
    ...(res.changed.includes('lateUntil') ? { lateUntil: moved(res.before.lateUntil, res.after.lateUntil) } : {}),
  };
  return { id, changed: res.changed };
});

/** Stop taking work before its dates: every student with nothing in has missed it. */
export async function closeCourseworkRecord(id: string) {
  const cw = await readCoursework(id);
  if (cw.status !== 'posted') throw new HttpsError('failed-precondition', 'Only a posted assignment can be closed.');
  if (cw.closedAt !== null) return { id, changed: false };
  const now = Date.now();
  await cwRef(id).update({ closedAt: now, updatedAt: now, editedAt: now });
  const subs = await db().collection(COLLECTIONS.submissions).where('courseworkId', '==', id).get();
  await inBatches(subs.docs, (batch, s) => batch.update(s.ref, { closedEarly: true }));
  return { id, changed: true };
}

export const closeCoursework = auditedCall('closeCoursework', async (req, audit) => {
  const id = idOf((req.data as { courseworkId?: unknown })?.courseworkId, 'courseworkId');
  const cw = await readCoursework(id);
  await requireCourseScope(req, cw.courseId);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: id };
  const res = await closeCourseworkRecord(id);
  audit.noop = !res.changed;
  return res;
});

// ---------------------------------------------------------------- delete --

/**
 * Whether any student has started this assignment: a draft, a hand-in, a
 * grade, or a teacher's mark on their work. Asked of the collections that
 * would hold it, not of the assignment's current shape — the same discipline
 * as `hasRecordingHistory`.
 */
async function hasStudentWork(id: string): Promise<boolean> {
  const any = async (collection: string) =>
    !(await db().collection(collection).where('courseworkId', '==', id).limit(1).get()).empty;
  if ((await any(COLLECTIONS.drafts)) || (await any(COLLECTIONS.submissionEvents)) || (await any(COLLECTIONS.grades))) {
    return true;
  }
  const subs = await db().collection(COLLECTIONS.submissions).where('courseworkId', '==', id).get();
  return subs.docs.some((s) => {
    const sub = s.data() as SubmissionDoc;
    return sub.state !== 'open' || sub.notRequired !== null || sub.moreTime !== null || sub.attempts.length > 0;
  });
}

/** Every stored file an assignment and its students' work point at. */
function filesOf(...maps: AttachmentMap[]): string[] {
  return maps.flatMap((m) => Object.values(m).map((f) => f.storageKey));
}

/**
 * Delete an assignment and everything that hangs off it. A teacher may delete
 * one no student has started — posted by mistake, say. Once any student has,
 * only an admin may, because it destroys students' work; checked before
 * anything is touched, so a refused delete destroys nothing.
 */
export async function deleteCourseworkRecord(id: string, asAdmin: boolean) {
  const cw = await readCoursework(id);
  if (!asAdmin && (await hasStudentWork(id))) {
    throw new HttpsError(
      'permission-denied',
      'Students have started this assignment, so only an admin can delete it. Close it instead to keep the record.',
    );
  }
  const keys: string[] = filesOf(cw.files);
  for (const collection of [
    COLLECTIONS.submissions,
    COLLECTIONS.drafts,
    COLLECTIONS.grades,
    COLLECTIONS.submissionEvents,
    COLLECTIONS.attachmentUploads,
  ]) {
    const snap = await db().collection(collection).where('courseworkId', '==', id).get();
    for (const d of snap.docs) {
      const data = d.data() as Partial<SubmissionDoc> & { storageKey?: string };
      if (data.files) keys.push(...filesOf(data.files));
      // A file still on its way in.
      if (data.storageKey) keys.push(data.storageKey);
      for (const a of data.attempts ?? []) keys.push(...filesOf(a.files));
    }
    await inBatches(snap.docs, (batch, d) => batch.delete(d.ref));
  }
  await Promise.all(keys.map((k) => deleteObject(k)));
  await cwRef(id).delete();
  return { id, title: cw.title, files: keys.length };
}

export const deleteCoursework = auditedCall(
  'deleteCoursework',
  async (req, audit) => {
    const id = idOf((req.data as { courseworkId?: unknown })?.courseworkId, 'courseworkId');
    const cw = await readCoursework(id);
    await requireCourseScope(req, cw.courseId);
    audit.courseId = cw.courseId;
    audit.targets = { courseworkId: id };
    const res = await deleteCourseworkRecord(id, isAdminCaller(req));
    audit.detail = { title: res.title, files: res.files };
    return { id };
  },
  MEDIA_WRITE_SECRETS,
);

// ----------------------------------------------------- the student's side --

/** The student's own work, with everything a hand-in or take-back checks. */
async function myWork(tx: Transaction, uid: string, cwId: string) {
  const subSnap = await tx.get(subRef(uid, cwId));
  const sub = subSnap.data() as SubmissionDoc | undefined;
  if (!sub || !sub.active) throw new HttpsError('permission-denied', 'That assignment is not yours.');
  const course = (await tx.get(db().collection(COLLECTIONS.courses).doc(sub.courseId))).data() as CourseDoc;
  return { sub, courseOpen: course.effectiveActive };
}

const STATE_REFUSAL: Record<string, string> = {
  handedIn: 'This work is already handed in.',
  returned: 'This work has been returned.',
  missed: 'This assignment has closed. Ask your teacher if you need more time.',
  closed: 'This course has been archived, so nothing more can be handed in.',
  notRequired: 'This assignment is not required for you.',
};

/**
 * Hand in what the draft holds. The server checks the date — the phone's clock
 * plays no part — and records the moment, so late is judged from it.
 */
export async function handInWork(uid: string, cwId: string) {
  const todayIs = today();
  return db().runTransaction(async (tx) => {
    const { sub, courseOpen } = await myWork(tx, uid, cwId);
    const draft = (await tx.get(draftRef(uid, cwId))).data() as DraftDoc | undefined;
    const state = workState(sub, todayIs, courseOpen);
    if (!canHandIn(state)) throw new HttpsError('failed-precondition', STATE_REFUSAL[state] ?? 'This cannot be handed in.');
    // The answer as the reader will parse it: the editor's markdown, made
    // canonical, so a draft written by hand cannot store something else.
    const note = normalizeMarkdown(draft?.note ?? '').trim();
    const files = draft?.files ?? {};
    if (!note && Object.keys(files).length === 0) {
      throw new HttpsError('failed-precondition', 'Write an answer or add a file before handing in.');
    }
    const now = Date.now();
    const late = isLate(now, sub.dueDate, INSTITUTE_TIMEZONE);
    tx.update(subRef(uid, cwId), { state: 'handedIn', handedInAt: now, note, files });
    tx.delete(draftRef(uid, cwId));
    const event: SubmissionEventDoc = {
      studentUid: uid,
      courseworkId: cwId,
      courseId: sub.courseId,
      kind: 'handIn',
      attempt: sub.attempt,
      at: now,
      late,
    };
    tx.set(db().collection(COLLECTIONS.submissionEvents).doc(), event);
    return { handedInAt: now, late };
  });
}

export const handIn = reportedCall(async (req) => {
  const uid = requireStudent(req);
  return handInWork(uid, idOf((req.data as { courseworkId?: unknown })?.courseworkId, 'courseworkId'));
});

/** Why handed-in work cannot be taken back, in the words that are true of it. */
function takeBackRefusal(sub: SubmissionDoc, courseOpen: boolean): string {
  if (sub.state !== 'handedIn') return 'This work is not handed in.';
  if (sub.notRequired) return STATE_REFUSAL.notRequired;
  if (!courseOpen) return 'This course has been archived, so this work stays handed in.';
  if (sub.closedEarly) return 'Your teacher has stopped taking work on this assignment, so this stays handed in.';
  return 'The due date has passed, so this can no longer be taken back.';
}

/**
 * Take handed-in work back to change it: until the due date, while it has not
 * been returned, and while it could be handed in again (`canTakeBack`).
 */
export async function takeBackWork(uid: string, cwId: string) {
  const todayIs = today();
  return db().runTransaction(async (tx) => {
    const { sub, courseOpen } = await myWork(tx, uid, cwId);
    if (!canTakeBack(sub, todayIs, courseOpen)) {
      throw new HttpsError('failed-precondition', takeBackRefusal(sub, courseOpen));
    }
    const now = Date.now();
    const draft: DraftDoc = {
      studentUid: uid,
      courseworkId: cwId,
      courseId: sub.courseId,
      note: sub.note,
      files: sub.files,
      updatedAt: now,
    };
    tx.set(draftRef(uid, cwId), draft);
    tx.update(subRef(uid, cwId), { state: 'open', handedInAt: null, note: '', files: {} });
    // A grade being written was for the work taken back. Kept, the next
    // hand-in read as graded, and Return sent that grade and its feedback on
    // work nobody had read.
    tx.delete(gradeRef(uid, cwId));
    const event: SubmissionEventDoc = {
      studentUid: uid,
      courseworkId: cwId,
      courseId: sub.courseId,
      kind: 'takeBack',
      attempt: sub.attempt,
      at: now,
      late: false,
    };
    tx.set(db().collection(COLLECTIONS.submissionEvents).doc(), event);
    return { takenBackAt: now };
  });
}

export const takeBack = reportedCall(async (req) => {
  const uid = requireStudent(req);
  return takeBackWork(uid, idOf((req.data as { courseworkId?: unknown })?.courseworkId, 'courseworkId'));
});

// ------------------------------------------------------- grade and return --

/** Why a grade was not saved: the work is no longer as it was when it was graded. */
const STATE_MOVED: Record<SubmissionState, string> = {
  open: 'The student took this work back to change it. Grade it when it is handed in again.',
  handedIn: 'The student has just handed this work in. Read it before grading it.',
  returned: 'This work has just been returned. Open it again to change the grade.',
};

function validateGrade(v: unknown, grading: CourseworkGrading): Grade | null {
  if (v === null) return null;
  const g = v as Grade;
  if (typeof g !== 'object' || !gradeFits(g, grading)) {
    throw new HttpsError(
      'invalid-argument',
      grading.kind === 'points'
        ? `A grade is a number from 0 to ${grading.outOf}, in halves at most.`
        : 'A grade is satisfactory or needs work.',
    );
  }
  return 'points' in g ? { points: g.points } : { scale: g.scale };
}

interface StudentWorkInput {
  courseworkId: string;
  studentUid: string;
}

function studentWorkInput(d: Record<string, unknown>): StudentWorkInput {
  return { courseworkId: idOf(d.courseworkId, 'courseworkId'), studentUid: idOf(d.studentUid, 'studentUid') };
}

async function readSubmission(tx: Transaction, uid: string, cwId: string): Promise<SubmissionDoc> {
  const sub = (await tx.get(subRef(uid, cwId))).data() as SubmissionDoc | undefined;
  if (!sub) throw new HttpsError('not-found', 'That student does not have this assignment.');
  return sub;
}

/**
 * Save a grade and feedback. Until the work is returned this is a draft only
 * staff see. On returned work it changes what the student sees at once, and
 * the change is recorded; a changed GRADE is a new return, so the student is
 * told (`seq` moves on). A returned grade can be changed, never taken away,
 * and a save that changes nothing the student has is no change at all. Work
 * done on paper can be graded with nothing handed in.
 */
export async function saveGradeRecord(
  staffUid: string,
  input: StudentWorkInput & { grade: unknown; feedback: unknown; onState?: SubmissionState },
) {
  const cw = await readCoursework(input.courseworkId);
  const grade = validateGrade(input.grade, cw.grading);
  const feedback = str(input.feedback ?? '', 'Feedback', MAX_FEEDBACK, { required: false });
  return db().runTransaction(async (tx) => {
    const sub = await readSubmission(tx, input.studentUid, input.courseworkId);
    if (sub.notRequired) throw new HttpsError('failed-precondition', 'This work is marked not required.');
    // GRADED AS IT WAS ON SCREEN. A grade typed on handed-in work and saved a
    // moment after the student took it back was stored as work done on paper,
    // and returning it closed the student's open work under that grade.
    if (input.onState && sub.state !== input.onState) throw new HttpsError('failed-precondition', STATE_MOVED[sub.state]);
    if (sub.state === 'returned' && sub.returned) {
      if (grade === null && sub.returned.grade !== null) {
        throw new HttpsError('failed-precondition', 'A returned grade can be changed, but it cannot be removed.');
      }
      if (JSON.stringify(sub.returned.grade) === JSON.stringify(grade) && sub.returned.feedback === feedback) {
        return { returnedChanged: false, before: sub.returned.grade, after: grade };
      }
    }
    const doc: GradeDoc = {
      studentUid: input.studentUid,
      courseworkId: input.courseworkId,
      courseId: cw.courseId,
      grade,
      feedback,
      gradedBy: staffUid,
      gradedAt: Date.now(),
      withoutHandIn: sub.state === 'open',
    };
    tx.set(gradeRef(input.studentUid, input.courseworkId), doc);
    if (sub.state !== 'returned' || !sub.returned) return { returnedChanged: false, before: null, after: grade };
    const gradeChanged = JSON.stringify(sub.returned.grade) !== JSON.stringify(grade);
    tx.update(subRef(input.studentUid, input.courseworkId), {
      returned: { ...sub.returned, grade, feedback, ...(gradeChanged ? { seq: sub.returned.seq + 1, at: Date.now() } : {}) },
    });
    return { returnedChanged: true, before: sub.returned.grade, after: grade };
  });
}

export const saveGrade = auditedCall('saveGrade', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const input = studentWorkInput(d);
  const cw = await readCoursework(input.courseworkId);
  const uid = await requireCourseScope(req, cw.courseId);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: input.courseworkId, studentUid: input.studentUid };
  const onState = d.onState === undefined ? undefined : SUBMISSION_STATES.find((s) => s === d.onState);
  if (d.onState !== undefined && !onState) throw new HttpsError('invalid-argument', 'onState is not a state of work.');
  const res = await saveGradeRecord(uid, { ...input, grade: d.grade, feedback: d.feedback, onState });
  // A changed GRADE on returned work is a new return: the student is told.
  if (res.returnedChanged && JSON.stringify(res.before) !== JSON.stringify(res.after)) {
    await notifyReturned(db(), input.courseworkId, [input.studentUid]);
  }
  // A draft grade changes constantly while a teacher works; only a change to
  // one the student has is a record.
  audit.noop = !res.returnedChanged;
  const worded = (g: Grade | null) => (g ? gradeText(g, cw.grading) : 'none');
  audit.detail = { grade: `${worded(res.before)} → ${worded(res.after)}` };
  return { saved: true };
});

/**
 * Give graded work back. Each student named must have a saved grade, unless
 * the teacher is asking for another try, which may come with feedback alone.
 *
 * ANOTHER TRY keeps this attempt — the work, the grade, the feedback — in
 * `attempts`, and opens the work again with a new date. The grade being
 * written for the next attempt starts empty.
 */
export async function returnWorkRecord(
  cwId: string,
  studentUids: string[],
  retry: { dueDate: string; lateUntil: string | null } | null,
) {
  /*
   * ONE STUDENT'S REFUSAL STOPS NOBODY ELSE'S RETURN. A student who took their
   * work back while Return all was being confirmed made the call fail after
   * the students before them were returned: those returns were never audited,
   * the students never told, and the teacher saw an error over work that had
   * gone back. Each refusal is now collected and reported beside the returns;
   * only when nothing at all was returned is the call refused.
   */
  const results: { studentUid: string; grade: Grade | null }[] = [];
  const refused: { studentUid: string; reason: string }[] = [];
  for (const studentUid of studentUids) {
    const res = await db().runTransaction(async (tx) => {
      const sub = await readSubmission(tx, studentUid, cwId);
      const graded = (await tx.get(gradeRef(studentUid, cwId))).data() as GradeDoc | undefined;
      if (sub.notRequired) throw new HttpsError('failed-precondition', 'This work is marked not required.');
      /*
       * ALREADY BACK IS DONE, not an error. Two teachers on one class can
       * return the same work a moment apart, and a refusal here stopped the
       * rest of a "return all graded" partway, behind an error over returns
       * that had worked. Another try is different: it acts on returned work
       * and is refused below if there is nothing to act on.
       */
      if (sub.state === 'returned' && !retry) return null;
      if (sub.state === 'returned') throw new HttpsError('failed-precondition', 'This work has already been returned.');
      // A grade, not just a grades document: feedback written first leaves one with none.
      if ((!graded || graded.grade === null) && !retry) throw new HttpsError('failed-precondition', 'Grade the work before returning it.');
      if (sub.state === 'open' && !graded?.withoutHandIn) {
        throw new HttpsError('failed-precondition', 'Nothing has been handed in to return.');
      }
      const returned = {
        grade: graded?.grade ?? null,
        feedback: graded?.feedback ?? '',
        at: Date.now(),
        seq: (sub.returned?.seq ?? 0) + 1,
        retry: retry !== null,
      };
      if (retry) {
        tx.update(subRef(studentUid, cwId), {
          state: 'open',
          attempt: sub.attempt + 1,
          attempts: FieldValue.arrayUnion({
            attempt: sub.attempt,
            note: sub.note,
            files: sub.files,
            handedInAt: sub.handedInAt,
            returned,
          }),
          note: '',
          files: {},
          handedInAt: null,
          returned,
          dueDate: retry.dueDate,
          lateUntil: retry.lateUntil,
          // Another try is open to hand-ins on its own date, as more time is,
          // even if the class has stopped taking work: else it began Missed.
          closedEarly: false,
        });
        if (graded) tx.delete(gradeRef(studentUid, cwId));
      } else {
        tx.update(subRef(studentUid, cwId), { state: 'returned', returned });
      }
      return { studentUid, grade: returned.grade };
    }).catch((e: unknown) => {
      if (!(e instanceof HttpsError)) throw e;
      refused.push({ studentUid, reason: e.message });
      return null;
    });
    if (res) results.push(res);
  }
  if (results.length === 0 && refused.length > 0) throw new HttpsError('failed-precondition', refused[0].reason);
  return { returned: results, refused };
}

export const returnWork = auditedCall('returnWork', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const cwId = idOf(d.courseworkId, 'courseworkId');
  const uids = d.studentUids;
  if (!Array.isArray(uids) || uids.length === 0 || uids.length > 500 || !uids.every((u) => typeof u === 'string' && u)) {
    throw new HttpsError('invalid-argument', 'studentUids must name the students to return work to.');
  }
  const cw = await readCoursework(cwId);
  await requireCourseScope(req, cw.courseId);
  const retry =
    d.retry === undefined || d.retry === null
      ? null
      : validateDates(d.retry as { dueDate: unknown; lateUntil: unknown }, today());
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: cwId };
  const res = await returnWorkRecord(cwId, uids as string[], retry);
  await notifyReturned(db(), cwId, res.returned.map((r) => r.studentUid));
  audit.noop = res.returned.length === 0;
  audit.detail = {
    // A list of uids, which the audit screen names; the grades beside them in the same order.
    returned: res.returned.map((r) => r.studentUid),
    grades: res.returned.map((r) => (r.grade ? gradeText(r.grade, cw.grading) : 'none')).join(', '),
    retry: retry !== null,
  };
  return { returned: res.returned.length, refused: res.refused };
});

/**
 * A later date for one student, before or after theirs has passed, with a
 * reason they see. MORE TIME IS MORE: never a due date before the class's,
 * and, for work not in yet, never a last day before the class's last day for
 * late work, so a teacher's slip cannot leave a student less time than their
 * classmates. Work already in may close sooner: more time there is how late
 * work is forgiven, and nothing is left to hand in.
 */
export async function giveMoreTimeRecord(staffUid: string, input: StudentWorkInput & { dates: { dueDate: string; lateUntil: string | null }; reason: string }) {
  const cw = await readCoursework(input.courseworkId);
  return db().runTransaction(async (tx) => {
    const sub = await readSubmission(tx, input.studentUid, input.courseworkId);
    if (sub.state === 'returned') throw new HttpsError('failed-precondition', 'This work has been returned.');
    if (input.dates.dueDate < cw.dueDate || (sub.state === 'open' && closesOn(input.dates) < closesOn(cw))) {
      throw new HttpsError(
        'invalid-argument',
        `More time cannot end before the class's dates: due ${cw.dueDate}${cw.lateUntil ? `, late work until ${cw.lateUntil}` : ''}.`,
      );
    }
    tx.update(subRef(input.studentUid, input.courseworkId), {
      ...input.dates,
      closedEarly: false,
      moreTime: { reason: input.reason, by: staffUid, at: Date.now() },
    });
    return { before: { dueDate: sub.dueDate, lateUntil: sub.lateUntil } };
  });
}

export const giveMoreTime = auditedCall('giveMoreTime', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const input = studentWorkInput(d);
  const cw = await readCoursework(input.courseworkId);
  const uid = await requireCourseScope(req, cw.courseId);
  const dates = validateDates({ dueDate: d.dueDate, lateUntil: d.lateUntil ?? null }, today());
  const reason = str(d.reason, 'A reason', MAX_REASON);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: input.courseworkId, studentUid: input.studentUid };
  const res = await giveMoreTimeRecord(uid, { ...input, dates, reason });
  audit.detail = { ...dates, reason, beforeDueDate: res.before.dueDate };
  return { saved: true };
});

/** Let one student off one assignment, with a reason they see; `null` undoes it. */
export async function setNotRequiredRecord(staffUid: string, input: StudentWorkInput & { reason: string | null }) {
  return db().runTransaction(async (tx) => {
    const sub = await readSubmission(tx, input.studentUid, input.courseworkId);
    if (sub.state === 'returned') throw new HttpsError('failed-precondition', 'This work has been returned.');
    tx.update(subRef(input.studentUid, input.courseworkId), {
      notRequired: input.reason === null ? null : { reason: input.reason, by: staffUid, at: Date.now() },
    });
    return { changed: (sub.notRequired?.reason ?? null) !== input.reason };
  });
}

export const setNotRequired = auditedCall('setNotRequired', async (req, audit) => {
  const d = (req.data ?? {}) as Record<string, unknown>;
  const input = studentWorkInput(d);
  const cw = await readCoursework(input.courseworkId);
  const uid = await requireCourseScope(req, cw.courseId);
  const reason = d.reason === null ? null : str(d.reason, 'A reason', MAX_REASON);
  audit.courseId = cw.courseId;
  audit.targets = { courseworkId: input.courseworkId, studentUid: input.studentUid };
  const res = await setNotRequiredRecord(uid, { ...input, reason });
  audit.noop = !res.changed;
  audit.detail = { notRequired: reason !== null, ...(reason ? { reason } : {}) };
  return { saved: true };
});
