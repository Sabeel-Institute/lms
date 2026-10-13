import { HttpsError } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { deactivateStudentCoursework, reconcileStudentCoursework } from './coursework';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  enrollmentId,
  type CourseDoc,
  type EnrollmentDoc,
  type StudentDoc,
} from '@sabeel/shared';
import { requireCourseScope } from './guards';
import {
  deactivateStudentAssignmentsInCourse,
  reconcileCourseAssignments,
} from './assignmentsFanout';

export interface EnrollmentInput {
  studentUid: string;
  courseId: string;
}

export function validateEnrollment(data: unknown): EnrollmentInput {
  const d = data as { studentUid?: unknown; courseId?: unknown } | null;
  if (typeof d?.studentUid !== 'string' || !d.studentUid) {
    throw new HttpsError('invalid-argument', 'studentUid is required.');
  }
  if (typeof d.courseId !== 'string' || !d.courseId) {
    throw new HttpsError('invalid-argument', 'courseId is required.');
  }
  return { studentUid: d.studentUid, courseId: d.courseId };
}

/**
 * Enrol a student into a course, or reactivate a previous enrolment.
 *
 * The document id is `${studentUid}_${courseId}`, so re-enrolling is a `set`
 * over the SAME document rather than a second row — which keeps the listening
 * history attached to one enrolment record over time.
 *
 * No RECORDING is granted here: listening is attendance-driven and starts from
 * enrolment onward. A newly enrolled student simply appears in the roster the
 * teacher marks at the NEXT session; nothing retroactive is granted. Assignments
 * are the exception — the class's current work, independent of the register —
 * so the student gets every posted one not yet past its due date.
 */
export async function createEnrollmentRecord(callerUid: string, input: EnrollmentInput) {
  const db = getFirestore();

  const [courseSnap, studentSnap] = await Promise.all([
    db.collection(COLLECTIONS.courses).doc(input.courseId).get(),
    db.collection(COLLECTIONS.students).doc(input.studentUid).get(),
  ]);
  if (!courseSnap.exists) throw new HttpsError('not-found', 'No such course.');
  if (!studentSnap.exists) throw new HttpsError('not-found', 'No such student.');
  if ((studentSnap.data() as StudentDoc).status === 'disabled') {
    throw new HttpsError('failed-precondition', 'That student account is disabled.');
  }

  const id = enrollmentId(input.studentUid, input.courseId);
  const ref = db.collection(COLLECTIONS.enrollments).doc(id);

  /*
   * ONE ENROLMENT, ONE RECORD — held by a transaction, not by the read above
   * the write. Two taps on an "Add a student" row 24 ms apart both read "not
   * enrolled" before either wrote, both succeeded, and both were audited: the
   * student's history then said "Enrolled in Tafseer" twice, which is exactly
   * the kind of sentence that page must never print. Inside the transaction the
   * second call sees the first's write and is refused as already enrolled.
   */
  const { doc, reenrolled } = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists && (existing.data() as EnrollmentDoc).active) {
      throw new HttpsError('already-exists', 'That student is already in this course.');
    }
    const next: EnrollmentDoc = {
      studentUid: input.studentUid,
      courseId: input.courseId,
      cohortId: (courseSnap.data() as CourseDoc).cohortId,
      active: true,
      // Preserve the original enrolment date across a re-enrolment.
      enrolledAt: existing.exists ? (existing.data() as EnrollmentDoc).enrolledAt : Date.now(),
      enrolledBy: callerUid,
    };
    tx.set(ref, next);
    return { doc: next, reenrolled: existing.exists };
  });
  /*
   * A RE-ENROLMENT RESTORES; A FIRST ENROLMENT HAS NOTHING TO RESTORE.
   *
   * This is the path the app actually takes: the only re-enrol affordance staff
   * have is "Add a student", which lists anyone not currently enrolled —
   * including somebody removed earlier in the term — and calls this. So a fix
   * wired only to `setEnrollmentActive` fixed nothing a person could reach.
   *
   * Skipped for a genuinely new student, where the reconcile would be pure cost:
   * they are in no attendance snapshot, so it can only ever grant them nothing.
   */
  if (reenrolled) await reconcileCourseAssignments(db, input.courseId);
  // Assignments are the class's current work, so a NEW student gets them too:
  // every posted assignment not yet past its due date.
  await reconcileStudentCoursework(input.courseId, input.studentUid);
  return { id, ...doc, reenrolled };
}

export const createEnrollment = auditedCall('createEnrollment', async (req, audit) => {
  const input = validateEnrollment(req.data);
  const uid = await requireCourseScope(req, input.courseId);
  audit.courseId = input.courseId;
  const created = await createEnrollmentRecord(uid, input);
  // A return through "Add a student" is a re-enrolment, and the student's
  // history reads it as one; a first enrolment says nothing extra.
  if (created.reenrolled) audit.detail = { reenrolled: true };
  return created;
});

export interface SetEnrollmentActiveInput extends EnrollmentInput {
  active: boolean;
}

export function validateSetEnrollmentActive(data: unknown): SetEnrollmentActiveInput {
  const base = validateEnrollment(data);
  const active = (data as { active?: unknown }).active;
  if (typeof active !== 'boolean') {
    throw new HttpsError('invalid-argument', 'active must be a boolean.');
  }
  return { ...base, active };
}

/**
 * Unenrol (or re-enrol) without deleting anything.
 *
 * `active: false` is what removal means here — the row, and everything hanging
 * off it, stays for the accountability record. Unenrolling turns this student's
 * obligations in the course off (history kept).
 *
 * AND THE FAN-OUT KEEPS THEM OFF: `reconcileSessionAssignments` filters its
 * target set by active enrolment, so a later edit to any session in the course
 * cannot switch them back on. Without that filter it did — the attendance
 * snapshot keeps a student's mark for ever, and the reconcile rebuilt the grants
 * from it alone.
 *
 * RE-ENROLLING restores them, here and now — `reconcileCourseAssignments` walks
 * the course's sessions and re-derives each grant from its own attendance and
 * recording. It did NOT before: nothing reconciles on an enrolment write, so a
 * returning student came back to an empty screen while the ledger and the manual
 * both told staff "re-enrolling them or republishing restores it". Two documents
 * and a comment agreed with each other and not with the code.
 */
export async function applyEnrollmentActive(input: SetEnrollmentActiveInput) {
  const db = getFirestore();
  const ref = db
    .collection(COLLECTIONS.enrollments)
    .doc(enrollmentId(input.studentUid, input.courseId));
  // The same refusal `createEnrollmentRecord` makes: a disabled account is
  // not put back into a class, and neither are its grants.
  if (input.active) {
    const student = (
      await db.collection(COLLECTIONS.students).doc(input.studentUid).get()
    ).data() as StudentDoc | undefined;
    if (student?.status === 'disabled') {
      throw new HttpsError('failed-precondition', 'That student account is disabled.');
    }
  }

  /*
   * READ AND WRITE IN ONE TRANSACTION, like `createEnrollmentRecord`: two
   * removals sent 24 ms apart both read "still enrolled", both wrote, both ran
   * the deactivation, and both were audited — the student's history then said
   * "Removed from Hikam" twice for one removal. Inside the transaction the
   * second sees the first's write and reports that nothing changed, which is
   * what keeps the second out of the audit log.
   *
   * THE GRANTS ARE SWITCHED EITHER WAY. The flag commits here and the grants
   * are dealt with after; a failure in between left the roster reading
   * "removed" while every grant stayed active — and a retry that stopped at
   * "nothing changed" switched nothing off, for good, since no trigger
   * reconciles an enrolment. Running the idempotent half on a no-op costs one
   * query on the press nobody makes twice; not running it costs a student
   * audio they were removed from.
   */
  const changed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such enrolment.');
    if ((snap.data() as EnrollmentDoc).active === input.active) return false;
    const update: Record<string, unknown> = { active: input.active };
    if (!input.active) update.unenrolledAt = Date.now();
    tx.update(ref, update);
    return true;
  });

  if (input.active) {
    // Re-enrolling RESTORES, which is what the ledger and the manual promise —
    // and what nothing did. There is no trigger on enrolments, so the reconcile
    // has to be asked for here.
    await reconcileCourseAssignments(db, input.courseId);
    await reconcileStudentCoursework(input.courseId, input.studentUid);
  } else {
    await deactivateStudentAssignmentsInCourse(db, input.courseId, input.studentUid);
    await deactivateStudentCoursework(input.courseId, input.studentUid);
  }
  return { studentUid: input.studentUid, courseId: input.courseId, active: input.active, changed };
}

export const setEnrollmentActive = auditedCall('setEnrollmentActive', async (req, audit) => {
  const input = validateSetEnrollmentActive(req.data);
  await requireCourseScope(req, input.courseId);
  audit.courseId = input.courseId;
  // WHICH WAY. The derivation picks up the ids and drops the boolean, so the
  // log said "changed enrolment" of a removal and a return alike — and the
  // student's history, which reads these rows, could not tell a student who
  // was removed from one who came back.
  audit.detail = { active: input.active };
  const result = await applyEnrollmentActive(input);
  // A removal of somebody already removed is not a second removal.
  audit.noop = !result.changed;
  return result;
});
