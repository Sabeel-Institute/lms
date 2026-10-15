import { HttpsError } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  deriveEffectiveActive,
  recordingsClosedAfter,
  type CourseDoc,
  type CohortDoc,
} from '@sabeel/shared';
import { requireAdmin } from './guards';

export function validateCohortName(data: unknown): string {
  const name = typeof (data as { name?: unknown })?.name === 'string'
    ? (data as { name: string }).name.trim()
    : '';
  if (!name) throw new HttpsError('invalid-argument', 'A cohort name is required.');
  if (name.length > 120) throw new HttpsError('invalid-argument', 'That name is too long.');
  return name;
}

export async function createCohortRecord(callerUid: string, name: string) {
  const doc: CohortDoc = {
    name,
    archived: false,
    createdAt: Date.now(),
    createdBy: callerUid,
  };
  const ref = await getFirestore().collection(COLLECTIONS.cohorts).add(doc);
  return { id: ref.id };
}

// Cohort-level actions are not class-scoped: their audit entries carry no
// courseId and are admin-only to read.
export const createCohort = auditedCall('createCohort', async (req, audit) => {
  const uid = requireAdmin(req);
  const created = await createCohortRecord(uid, validateCohortName(req.data));
  // The id it made. The request carries only a name, so the derivation had
  // nothing to pick up and the row named nothing at all.
  audit.targets.cohortId = created.id;
  return created;
});

export function validateSetCohortArchived(data: unknown): { cohortId: string; archived: boolean } {
  const d = data as { cohortId?: unknown; archived?: unknown } | null;
  if (typeof d?.cohortId !== 'string' || !d.cohortId) {
    throw new HttpsError('invalid-argument', 'cohortId is required.');
  }
  if (typeof d.archived !== 'boolean') {
    throw new HttpsError('invalid-argument', 'archived must be a boolean.');
  }
  return { cohortId: d.cohortId, archived: d.archived };
}

/**
 * Archive or reactivate a cohort, cascading to every class inside it.
 *
 * The cascade recomputes each class's denormalised `effectiveActive` and
 * **never touches the class's own `archived` flag**. That is precisely what
 * makes the round-trip work: reactivating a cohort restores each class to
 * whatever state it was already in, rather than switching them all on. See
 * `deriveEffectiveActive` in @sabeel/shared, whose tests assert exactly this.
 *
 * Done synchronously here rather than in a Firestore trigger. Clients cannot
 * write these collections at all, so there is nothing for a trigger to defend
 * against — and doing it inline means no propagation lag and one testable path.
 */
export async function applyCohortArchived(input: { cohortId: string; archived: boolean }) {
  const db = getFirestore();
  const cohortRef = db.collection(COLLECTIONS.cohorts).doc(input.cohortId);

  /*
   * ONE TRANSACTION over the cohort and its classes: each class's
   * `recordingsClosed` is decided from what the class was, and a class
   * updated at the same moment must be read as it is.
   */
  const coursesUpdated = await db.runTransaction(async (tx) => {
    if (!(await tx.get(cohortRef)).exists) throw new HttpsError('not-found', 'No such cohort.');
    const courses = await tx.get(db.collection(COLLECTIONS.courses).where('cohortId', '==', input.cohortId));
    const now = Date.now();
    tx.update(cohortRef, { archived: input.archived });
    for (const cls of courses.docs) {
      const data = cls.data() as CourseDoc;
      const after = { effectiveActive: deriveEffectiveActive(input.archived, data.archived), archivedAccess: data.archivedAccess };
      tx.update(cls.ref, { effectiveActive: after.effectiveActive, recordingsClosed: recordingsClosedAfter(data, after, now) });
    }
    return courses.size;
  });

  return { cohortId: input.cohortId, archived: input.archived, coursesUpdated };
}

export const setCohortArchived = auditedCall('setCohortArchived', async (req, audit) => {
  requireAdmin(req);
  const input = validateSetCohortArchived(req.data);
  // Which way: the log's label is "Archived/unarchived cohort", and without
  // this the row could not say which of the two it was.
  audit.detail = { archived: input.archived };
  return applyCohortArchived(input);
});

export function validateRenameCohort(data: unknown): { cohortId: string; name: string } {
  const d = data as { cohortId?: unknown } | null;
  if (typeof d?.cohortId !== 'string' || !d.cohortId) {
    throw new HttpsError('invalid-argument', 'cohortId is required.');
  }
  // The same rule a new cohort's name passes — one definition of a valid name,
  // so a cohort cannot be renamed to something it could not have been created as.
  return { cohortId: d.cohortId, name: validateCohortName(data) };
}

/**
 * Rename a cohort. Its own callable rather than a `name` field on
 * `setCohortArchived`: archiving cascades over every class in the cohort and a
 * rename touches nothing but the one document, so one call that might do either
 * would have to be read twice to know which it did — in the audit log most of
 * all.
 */
export async function applyCohortRename(input: { cohortId: string; name: string }) {
  const ref = getFirestore().collection(COLLECTIONS.cohorts).doc(input.cohortId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'No such cohort.');
  await ref.update({ name: input.name });
  return { cohortId: input.cohortId, name: input.name };
}

export const renameCohort = auditedCall('renameCohort', async (req, audit) => {
  requireAdmin(req);
  const input = validateRenameCohort(req.data);
  // The new name, so the log answers "renamed to what?" without a second lookup.
  audit.detail = { name: input.name };
  return applyCohortRename(input);
});
