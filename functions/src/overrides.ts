import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  enrollmentId,
  overrideId,
  type CompletionOverrideDoc,
  type EnrollmentDoc,
  type RecordingDoc,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { requireCourseScope } from './guards';

export interface OverrideInput {
  studentUid: string;
  recordingId: string;
  completed: boolean;
  reason: string;
}

export function validateOverride(data: unknown): OverrideInput {
  const d = data as Partial<OverrideInput> | null;
  if (typeof d?.studentUid !== 'string' || !d.studentUid) {
    throw new HttpsError('invalid-argument', 'studentUid is required.');
  }
  if (typeof d.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  if (typeof d.completed !== 'boolean') {
    throw new HttpsError('invalid-argument', 'completed must be a boolean.');
  }
  // The reason is the whole point of an override — the brief permits one ONLY
  // with a recorded reason. An empty/whitespace reason is rejected.
  return {
    studentUid: d.studentUid,
    recordingId: d.recordingId,
    completed: d.completed,
    reason: overrideReason(d.reason, 'A reason is required to override.'),
  };
}

/**
 * An override's reason, setting one or removing one: required, and short
 * enough for the audit row that carries it. Uncapped, a removal's reason
 * could be too large to write, and the override went with nothing in the
 * history to say so.
 */
function overrideReason(value: unknown, missing: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason) throw new HttpsError('invalid-argument', missing);
  if (reason.length > 500) throw new HttpsError('invalid-argument', 'That reason is too long (500 characters at most).');
  return reason;
}

async function recordingCourseId(recordingId: string): Promise<string> {
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  return (snap.data() as RecordingDoc).courseId;
}

async function requireEnrolled(studentUid: string, courseId: string): Promise<void> {
  const snap = await getFirestore()
    .collection(COLLECTIONS.enrollments)
    .doc(enrollmentId(studentUid, courseId))
    .get();
  const enrol = snap.data() as EnrollmentDoc | undefined;
  if (!enrol || !enrol.active) {
    throw new HttpsError('failed-precondition', 'That student is not in this class.');
  }
}

/**
 * Write the override doc. SEPARATE from the student's completion, so the student
 * can never clobber it and the ledger reads override ?? student.
 *
 * Says whether anything changed: the same mark with the same reason sent again
 * — a stale screen, a second tap — rewrote the row with a new author and time
 * and was audited as a second override, so the student's history said it twice.
 * The record keeps who actually made the call, and when.
 */
export async function applyOverride(callerUid: string, input: OverrideInput, courseId: string) {
  const ref = getFirestore()
    .collection(COLLECTIONS.completionOverrides)
    .doc(overrideId(input.studentUid, input.recordingId));
  const changed = await getFirestore().runTransaction(async (tx) => {
    const existing = (await tx.get(ref)).data() as CompletionOverrideDoc | undefined;
    if (existing && existing.completed === input.completed && existing.reason === input.reason) {
      return false;
    }
    const doc: CompletionOverrideDoc = {
      studentUid: input.studentUid,
      recordingId: input.recordingId,
      courseId,
      completed: input.completed,
      reason: input.reason,
      overriddenBy: callerUid,
      at: Date.now(),
    };
    tx.set(ref, doc);
    return true;
  });
  return { studentUid: input.studentUid, recordingId: input.recordingId, completed: input.completed, changed };
}

/**
 * Remove an override — effective status falls back to the student's own.
 *
 * Says whether there was one to remove: a `delete()` of a missing document
 * succeeds, so a stale screen (or a second tap) audited "Removed override" for
 * an override that was already gone.
 */
export async function clearOverride(studentUid: string, recordingId: string) {
  const ref = getFirestore()
    .collection(COLLECTIONS.completionOverrides)
    .doc(overrideId(studentUid, recordingId));
  const changed = await getFirestore().runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) return false;
    tx.delete(ref);
    return true;
  });
  return { studentUid, recordingId, changed };
}

/**
 * Staff override of a student's completion, with a required reason. Course-scoped
 * and enrolment-checked; the reason lands in the audit entry's `detail`.
 */
export const overrideCompletion = auditedCall('overrideCompletion', async (req, audit) => {
  const input = validateOverride(req.data);
  const courseId = await recordingCourseId(input.recordingId);
  const uid = await requireCourseScope(req, courseId);
  await requireEnrolled(input.studentUid, courseId);
  audit.courseId = courseId;
  audit.detail = { completed: input.completed, reason: input.reason };
  const result = await applyOverride(uid, input, courseId);
  // The same override a second time is not a second override.
  audit.noop = !result.changed;
  return result;
});

export function validateClearOverride(data: unknown): { studentUid: string; recordingId: string; reason: string } {
  const d = data as { studentUid?: unknown; recordingId?: unknown; reason?: unknown } | null;
  if (typeof d?.studentUid !== 'string' || !d.studentUid) {
    throw new HttpsError('invalid-argument', 'studentUid is required.');
  }
  if (typeof d.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  return { studentUid: d.studentUid, recordingId: d.recordingId, reason: overrideReason(d.reason, 'A reason is required.') };
}

export const clearCompletionOverride = auditedCall('clearCompletionOverride', async (req, audit) => {
  const { studentUid, recordingId, reason } = validateClearOverride(req.data);
  const courseId = await recordingCourseId(recordingId);
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  audit.detail = { reason };
  const result = await clearOverride(studentUid, recordingId);
  audit.noop = !result.changed;
  return result;
});
