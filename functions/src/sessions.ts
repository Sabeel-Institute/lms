import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  todayInZone,
  type AttendanceStatus,
  type CourseDoc,
  type EnrollmentDoc,
  type SessionDoc,
} from '@sabeel/shared';
import { auditedCall, type AuditContext } from './audited';
import { requireAdmin, requireCourseScope } from './guards';
import { applyDeleteRecording } from './recordings';
import { MEDIA_WRITE_SECRETS } from './mediaStore';
import { reconcileAttendanceRecords } from './attendanceMirror';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date that exists. The shape alone let `2026-99-99` through: a
 * string compare then kept it "open" until 2027, the day count came out `NaN`
 * (bucketed as upcoming), and the last-day sweep never matched it. Round-trip
 * through the UTC calendar and require the same text back.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
const ATTENDANCE: AttendanceStatus[] = ['present', 'absent', 'excused'];

/**
 * A session's due date is the day the excused lose access, so it is required:
 * a blank one would mean permanent access, the most permissive setting reachable
 * by leaving a field alone.
 */
function validateDueDateShape(value: unknown): string {
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    throw new HttpsError('invalid-argument', 'A due date is required, as YYYY-MM-DD.');
  }
  return value;
}

/**
 * A deadline may only BECOME past by the passage of time — which is how a
 * recording closes — but nothing may WRITE one that has already gone, because
 * that is an obligation born unfulfillable.
 *
 * `today` is a parameter rather than a hidden `Date.now()` so the validators
 * stay pure and testable at the day boundary, same discipline as `@sabeel/shared`.
 */
function validateDueDate(value: unknown, today: string): string {
  const dueDate = validateDueDateShape(value);
  if (dueDate < today) {
    throw new HttpsError('invalid-argument', 'A due date cannot be in the past.');
  }
  return dueDate;
}

/**
 * The same rule for an EDIT, which needs the stored value to apply it.
 *
 * The session editor sends all four fields on every save, so an unchanged
 * deadline arrives on the wire exactly like a new one. Judging the payload alone
 * would make a session whose date has passed uneditable in every other respect —
 * a typo in the title could only be fixed by also moving the deadline forward,
 * silently reopening access for everyone excused. Only a MOVE into the past is
 * refused; resending what is already stored is a no-op.
 */
export function validateDueDateChange(next: string, current: string, today: string): void {
  if (next !== current && next < today) {
    throw new HttpsError('invalid-argument', 'A due date cannot be in the past.');
  }
}

// ---------------------------------------------------------------- create --

export interface CreateSessionInput {
  courseId: string;
  date: string;
  title: string;
  dueDate: string;
  notes: string;
}

/** A session's title, the same on create and on edit: a pasted page is not a title. */
function sessionTitle(v: unknown, empty: string): string {
  const title = typeof v === 'string' ? v.trim() : '';
  if (!title) throw new HttpsError('invalid-argument', empty);
  if (title.length > 200) throw new HttpsError('invalid-argument', 'That title is too long.');
  return title;
}

/** A session's notes, which students read beside the recording. */
function sessionNotes(v: unknown): string {
  if (typeof v !== 'string') throw new HttpsError('invalid-argument', 'notes must be text.');
  if (v.length > 5000) throw new HttpsError('invalid-argument', 'Those notes are too long (5,000 characters at most).');
  return v;
}

export function validateCreateSession(
  data: unknown,
  today: string = todayInZone(INSTITUTE_TIMEZONE),
): CreateSessionInput {
  const d = data as Partial<CreateSessionInput> | null;
  if (typeof d?.courseId !== 'string' || !d.courseId) {
    throw new HttpsError('invalid-argument', 'courseId is required.');
  }
  if (typeof d.date !== 'string' || !isCalendarDate(d.date)) {
    throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD.');
  }
  const title = sessionTitle(d.title, 'A title is required.');
  const dueDate = validateDueDate(d.dueDate, today);
  const notes = d.notes === undefined ? '' : sessionNotes(d.notes);
  return { courseId: d.courseId, date: d.date, title, dueDate, notes };
}

export async function createSessionRecord(callerUid: string, input: CreateSessionInput) {
  const db = getFirestore();
  const courseSnap = await db.collection(COLLECTIONS.courses).doc(input.courseId).get();
  if (!courseSnap.exists) throw new HttpsError('not-found', 'No such course.');
  const doc: SessionDoc = {
    courseId: input.courseId,
    cohortId: (courseSnap.data() as CourseDoc).cohortId,
    date: input.date,
    title: input.title,
    dueDate: input.dueDate,
    notes: input.notes,
    recordingId: null,
    attendance: {},
    attendanceSubmittedAt: null,
    notRecorded: false,
    createdAt: Date.now(),
    createdBy: callerUid,
    updatedAt: Date.now(),
  };
  const ref = await db.collection(COLLECTIONS.sessions).add(doc);
  return { id: ref.id };
}

export const createSession = auditedCall('createSession', async (req, audit) => {
  const input = validateCreateSession(req.data);
  const uid = await requireCourseScope(req, input.courseId);
  audit.courseId = input.courseId;
  const res = await createSessionRecord(uid, input);
  audit.targets = { sessionId: res.id };
  return res;
});

// ---------------------------------------------------------------- update --

export interface UpdateSessionInput {
  sessionId: string;
  date?: string;
  title?: string;
  dueDate?: string;
  notes?: string;
  /** "This class was not recorded" — see the field's note in `@sabeel/shared`. */
  notRecorded?: boolean;
}

/**
 * Shape only. The past-date rule needs the STORED due date to tell an edit from
 * a resend, so it lives in the callable as `validateDueDateChange`.
 */
export function validateUpdateSession(data: unknown): UpdateSessionInput {
  const d = data as Partial<UpdateSessionInput> | null;
  if (typeof d?.sessionId !== 'string' || !d.sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
  const out: UpdateSessionInput = { sessionId: d.sessionId };
  if (d.date !== undefined) {
    if (typeof d.date !== 'string' || !isCalendarDate(d.date)) {
      throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD.');
    }
    out.date = d.date;
  }
  if (d.title !== undefined) out.title = sessionTitle(d.title, 'A title cannot be empty.');
  if (d.dueDate !== undefined) {
    out.dueDate = validateDueDateShape(d.dueDate);
  }
  if (d.notes !== undefined) out.notes = sessionNotes(d.notes);
  if (d.notRecorded !== undefined) {
    // Not truthiness: a string 'false' arriving from a hand-built call would set
    // the flag it names the opposite of, and silence a class for the term.
    if (typeof d.notRecorded !== 'boolean') {
      throw new HttpsError('invalid-argument', 'notRecorded must be a boolean.');
    }
    out.notRecorded = d.notRecorded;
  }
  if (Object.keys(out).length === 1) throw new HttpsError('invalid-argument', 'Nothing to change.');
  return out;
}

export const updateSession = auditedCall('updateSession', async (req, audit) => {
  const input = validateUpdateSession(req.data);
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.sessions).doc(input.sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such session.');
  // The course never changes, so the scope check reads once, outside the
  // transaction; everything the write depends on is re-read inside it.
  const courseId = (snap.data() as SessionDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  const { sessionId: _id, ...fields } = input;
  // Named in the audit, unlike a title or a note: this one stops the work queue
  // and the morning reminder, so "why did we never chase that class?" has an
  // answer with a person and a time on it.
  // The due date too: moving it is the documented way to reopen a closed
  // recording, so the log should carry the date the class was given.
  audit.detail = { notRecorded: input.notRecorded, dueDate: input.dueDate, date: input.date };
  /*
   * ONE TRANSACTION, holding the session as read. The checks below are about
   * the STORED session — its due date, whether it has a recording — and a
   * read-then-write let `createRecordingDraft` link a recording between the
   * two, so "this class was not recorded" landed on a session that had just
   * acquired one: the very document the two refusals exist to make impossible.
   * The recording's student-facing copy is written in the same transaction,
   * for the reason it was in one batch before: written one after the other, a
   * failure between them left the title, notes or date stale on the recording
   * with nothing to repair it.
   */
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new HttpsError('not-found', 'No such session.');
    const session = fresh.data() as SessionDoc;
    if (input.dueDate !== undefined) {
      // Moving the deadline FORWARD is the documented way to reopen a session
      // that has closed, so this is the recovery valve as well as a validator.
      validateDueDateChange(input.dueDate, session.dueDate, todayInZone(INSTITUTE_TIMEZONE));
    }
    // The other half of `createRecordingDraft`'s refusal: a session with a
    // recording was recorded, and marking it otherwise would hide that
    // recording from the work queue and the morning sweep.
    if (input.notRecorded && session.recordingId) {
      throw new HttpsError('failed-precondition', 'This session has a recording.');
    }
    // A dueDate edit re-flows to obligations via the onSessionWritten trigger.
    tx.update(ref, { ...fields, updatedAt: Date.now() });
    if (session.recordingId) {
      const denorm: Record<string, unknown> = {};
      if (fields.title !== undefined) denorm.title = fields.title;
      if (fields.notes !== undefined) denorm.notes = fields.notes;
      if (fields.date !== undefined) denorm.date = fields.date;
      if (Object.keys(denorm).length > 0) {
        tx.update(db.collection(COLLECTIONS.recordings).doc(session.recordingId), {
          ...denorm,
          updatedAt: Date.now(),
        });
      }
    }
  });
  return { sessionId: input.sessionId };
});

// ------------------------------------------------------------- attendance --

/**
 * Does this submission excuse anyone who is not already excused?
 *
 * The distinction the past-due guard turns on, and the reason it is a comparison
 * rather than a scan. The attendance screen rebuilds the WHOLE map for every
 * active roster member on every submit, so a session that excused five students
 * resends all five excusals when staff correct a sixth student to present.
 * Looking only at the payload would read that as five new excusals and refuse
 * the correction, leaving the attendance of every closed session permanently
 * uncorrectable.
 */
export function addsExcusal(
  submitted: Record<string, unknown>,
  stored: Record<string, AttendanceStatus>,
): boolean {
  return Object.entries(submitted).some(
    ([studentUid, status]) => status === 'excused' && stored[studentUid] !== 'excused',
  );
}

/**
 * Submit attendance for a session (the explicit-submit step).
 *
 * Filtered to the ACTIVE roster so the snapshot only contains real, current
 * members — a student enrolled after this is simply absent from the map and
 * never granted anything (accountability starts at enrollment). Setting
 * `attendanceSubmittedAt` is what unlocks the grant; the onSessionWritten
 * trigger then reconciles the excused → obligations, and projects everyone's
 * mark onto their own attendanceRecords row.
 *
 * Refuses to NEWLY excuse anyone once the due date has passed: an excused mark
 * is the access grant, and granting access that expired yesterday produces a
 * recording nobody can open and a ledger row nobody can clear. Measured against
 * the stored attendance, not the payload, because the screen rebuilds the whole
 * map on every submit — judging the payload alone would freeze the attendance of
 * every closed session that excused anybody. Correcting an old session still
 * works in every direction except adding a new excusal; to do that, move the
 * session's due date first.
 */
/**
 * Record a register: validate it, authorize it, and merge it into the session.
 *
 * SEPARATED FROM THE WRAPPER so a test can drive the whole of it, which is the
 * only way to assert what it promises — that submitting a correction records
 * the correction and destroys nothing else. Same reasoning as every other core
 * in this file.
 */
export async function applySubmitAttendance(
  req: CallableRequest,
  audit: AuditContext,
): Promise<{ sessionId: string; marked: number }> {
  const d = req.data as { sessionId?: unknown; attendance?: unknown };
  if (typeof d?.sessionId !== 'string' || !d.sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
  if (typeof d.attendance !== 'object' || d.attendance === null || Array.isArray(d.attendance)) {
    throw new HttpsError('invalid-argument', 'attendance must be a { uid: status } map.');
  }
  const raw = d.attendance as Record<string, unknown>;
  for (const [, status] of Object.entries(raw)) {
    if (!ATTENDANCE.includes(status as AttendanceStatus)) {
      throw new HttpsError('invalid-argument', 'attendance values must be present/absent/excused.');
    }
  }

  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.sessions).doc(d.sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such session.');
  const session = snap.data() as SessionDoc;
  const uid = await requireCourseScope(req, session.courseId);
  audit.courseId = session.courseId;
  audit.targets = { sessionId: d.sessionId };

  if (addsExcusal(raw, session.attendance) && session.dueDate < todayInZone(INSTITUTE_TIMEZONE)) {
    throw new HttpsError(
      'failed-precondition',
      "This session's due date has passed. Move it before excusing anyone new.",
    );
  }

  /*
   * THE ROSTER FILTERS WHAT IS BEING SUBMITTED. It does not delete what was
   * recorded before.
   *
   * Its job is to stop a mark being written for somebody not in the class. But
   * rebuilding the whole map from the payload made it do a second thing nobody
   * asked for: a student unenrolled halfway through term vanished from the
   * register the next time a manager corrected anybody's mark — and
   * `reconcileAttendanceRecords` then deleted that student's own copy too. A
   * permanent deletion of accountability history, performed by a manager, with
   * no confirmation and nothing in the audit log saying what went. The product
   * rule is disable, archive, unpublish — don't delete.
   *
   * It also emptied the ledger's "Excused, access closed" group, which exists to
   * show staff exactly those students: excused at the time, no longer enrolled.
   * They keep the mark and they still get no grant — `stillEnrolled` in the
   * fan-out is what withholds that, and the two decisions belong apart.
   *
   * So the payload OVERLAYS the stored map: every mark already there stands
   * unless the submission names that student, and it may name only the roster.
   * A submission that omits a current student says nothing about them. The
   * app omits a newcomer with no mark yet on a submitted register (a mark
   * nobody chose is not a mark), and a register opened before a student was
   * re-enrolled omits a stored one; either way the omission is not a removal.
   * Nothing in the app unmarks anyone, so there is no mark a submission may
   * remove.
   */
  const rosterSnap = await db
    .collection(COLLECTIONS.enrollments)
    .where('courseId', '==', session.courseId)
    .where('active', '==', true)
    .get();
  const roster = new Set(rosterSnap.docs.map((e) => (e.data() as EnrollmentDoc).studentUid));
  const attendance: Record<string, AttendanceStatus> = { ...session.attendance };
  for (const [studentUid, status] of Object.entries(raw)) {
    if (roster.has(studentUid)) attendance[studentUid] = status as AttendanceStatus;
  }

  await ref.update({
    attendance,
    attendanceSubmittedAt: Date.now(),
    attendanceSubmittedBy: uid,
    updatedAt: Date.now(),
  });
  /*
   * WHAT THE PERSON JUST MARKED, not the size of the stored map. The screen says
   * "Attendance submitted for N students" over a list of the current roster, and
   * the merged map also holds marks for anybody who has left the class since —
   * so counting it reported thirteen over a register of ten.
   */
  return { sessionId: d.sessionId, marked: Object.keys(raw).filter((u) => roster.has(u)).length };
}

export const submitAttendance = auditedCall('submitAttendance', (req, audit) =>
  applySubmitAttendance(req, audit),
);

// --------------------------------------------------------- archive/delete --

/**
 * PERMANENTLY delete a session and its recording.
 *
 * ADMIN-ONLY, like every other permanent deletion — a session carries the whole
 * class's attendance for that day, and `onSessionWritten` clears every student's
 * projection of it on the way out. Course scope alone was the gate here, and
 * with a recording attached it cascaded straight into `applyDeleteRecording`,
 * which authorizes nothing itself: deleting the SESSION was a way for a manager
 * to destroy a recording's entire ledger without ever meeting the admin check
 * that `deleteRecording` applies. The client had it right all along
 * (`SessionDetailScreen` offers this to admins only); the boundary did not.
 *
 * Refuses a session whose recording is published (unpublish/archive first) so a
 * delete can never pull a live recording out from under students. Cascades the
 * recording (and its assignments/completions/progress) then the session.
 *
 * THE CASCADE IS DELIBERATE, and the UI asking for the other order is not a rule
 * this contradicts: `SessionDetailScreen` offers Delete only when the session
 * has no recording, so a person is walked through removing the recording first
 * and sees what they are destroying. An admin may delete either directly, so
 * cascading here grants nothing the same admin could not do in two calls —
 * which is exactly why the missing `requireAdmin` mattered and the missing
 * ordering check does not.
 */
export const deleteSession = auditedCall('deleteSession', async (req, audit) => {
  const d = req.data as { sessionId?: unknown };
  if (typeof d?.sessionId !== 'string' || !d.sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.sessions).doc(d.sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such session.');
  const session = snap.data() as SessionDoc;
  await requireCourseScope(req, session.courseId);
  requireAdmin(req);
  audit.courseId = session.courseId;

  // applyDeleteRecording refuses a published recording and cascades the rest.
  // A pointer to a recording that is already gone is nothing to cascade —
  // the state a delete interrupted between its two writes used to leave, and
  // the one thing that made a session undeletable.
  if (
    session.recordingId &&
    (await db.collection(COLLECTIONS.recordings).doc(session.recordingId).get()).exists
  ) {
    await applyDeleteRecording(session.recordingId);
  }
  await ref.delete();
  // The students' own copies of their marks go with the session, HERE and not
  // only in `onSessionWritten`: that trigger has no retry, so one failed
  // invocation left rows a student still saw listed under a session that no
  // longer existed, with nothing to reconcile them ever again. The trigger
  // still runs and finds nothing to do.
  await reconcileAttendanceRecords(db, d.sessionId, undefined);
  return { sessionId: d.sessionId };
}, MEDIA_WRITE_SECRETS);
