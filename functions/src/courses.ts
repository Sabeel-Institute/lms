import { HttpsError } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  canPlayFromCourse,
  deriveEffectiveActive,
  recordingsClosedAfter,
  type CourseDoc,
  type CohortDoc,
  type StaffUserDoc,
} from '@sabeel/shared';
import { requireAdmin } from './guards';

export interface CreateCourseInput {
  cohortId: string;
  name: string;
}

/** A class's name, the same on create and on rename. */
function courseName(v: unknown, empty: string): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new HttpsError('invalid-argument', empty);
  if (name.length > 120) throw new HttpsError('invalid-argument', 'That name is too long.');
  return name;
}

export function validateCreateCourse(data: unknown): CreateCourseInput {
  const d = data as { cohortId?: unknown; name?: unknown } | null;
  if (typeof d?.cohortId !== 'string' || !d.cohortId) {
    throw new HttpsError('invalid-argument', 'cohortId is required.');
  }
  return { cohortId: d.cohortId, name: courseName(d.name, 'A class name is required.') };
}

export async function createCourseRecord(callerUid: string, input: CreateCourseInput) {
  const db = getFirestore();
  const cohortSnap = await db.collection(COLLECTIONS.cohorts).doc(input.cohortId).get();
  if (!cohortSnap.exists) throw new HttpsError('not-found', 'No such cohort.');
  const cohort = cohortSnap.data() as CohortDoc;
  const now = Date.now();
  // Seeded from the cohort: a class created inside an archived cohort is
  // inactive from birth, without anyone having to remember to run a cascade.
  const effectiveActive = deriveEffectiveActive(cohort.archived, false);

  const doc: CourseDoc = {
    cohortId: input.cohortId,
    name: input.name,
    archived: false,
    effectiveActive,
    // Archiving turns student access off unless staff explicitly say otherwise.
    archivedAccess: false,
    // Closed from birth, then, in an archived cohort.
    recordingsClosed: effectiveActive ? [] : [{ from: now, to: null }],
    managerUids: [],
    createdAt: now,
    createdBy: callerUid,
  };
  const ref = await db.collection(COLLECTIONS.courses).add(doc);
  return { id: ref.id };
}

export const createCourse = auditedCall('createCourse', async (req, audit) => {
  const uid = requireAdmin(req);
  const res = await createCourseRecord(uid, validateCreateCourse(req.data));
  audit.courseId = res.id;
  return res;
});

export interface UpdateCourseInput {
  courseId: string;
  name?: string;
  archived?: boolean;
  archivedAccess?: boolean;
}

export function validateUpdateCourse(data: unknown): UpdateCourseInput {
  const d = data as UpdateCourseInput | null;
  if (typeof d?.courseId !== 'string' || !d.courseId) {
    throw new HttpsError('invalid-argument', 'courseId is required.');
  }
  const out: UpdateCourseInput = { courseId: d.courseId };
  if (d.name !== undefined) out.name = courseName(d.name, 'A class name cannot be empty.');
  if (d.archived !== undefined) {
    if (typeof d.archived !== 'boolean') {
      throw new HttpsError('invalid-argument', 'archived must be a boolean.');
    }
    out.archived = d.archived;
  }
  if (d.archivedAccess !== undefined) {
    if (typeof d.archivedAccess !== 'boolean') {
      throw new HttpsError('invalid-argument', 'archivedAccess must be a boolean.');
    }
    out.archivedAccess = d.archivedAccess;
  }
  if (out.name === undefined && out.archived === undefined && out.archivedAccess === undefined) {
    throw new HttpsError('invalid-argument', 'Nothing to change.');
  }
  return out;
}

export async function applyCourseUpdate(input: UpdateCourseInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.courses).doc(input.courseId);
  /*
   * READ AND WRITE IN ONE TRANSACTION: whether the class's recordings just
   * opened or closed to its students is decided from what it was, and a
   * cohort archived at the same moment must be read as it is.
   */
  const update = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such class.');
    const current = snap.data() as CourseDoc;

    const update: Partial<CourseDoc> = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.archivedAccess !== undefined) update.archivedAccess = input.archivedAccess;

    if (input.archived !== undefined) {
      update.archived = input.archived;
      // The cohort is the other half of the derivation, so it has to be read —
      // a class archived inside an archived cohort must stay inactive.
      const cohortSnap = await tx.get(db.collection(COLLECTIONS.cohorts).doc(current.cohortId));
      const cohortArchived = (cohortSnap.data() as CohortDoc | undefined)?.archived ?? false;
      update.effectiveActive = deriveEffectiveActive(cohortArchived, input.archived);
    }
    // When the class's recordings were closed to its students, kept for good:
    // a date that ran out inside such a stretch was not missed.
    const after = { effectiveActive: update.effectiveActive ?? current.effectiveActive, archivedAccess: update.archivedAccess ?? current.archivedAccess };
    if (canPlayFromCourse(after) !== canPlayFromCourse(current)) {
      update.recordingsClosed = recordingsClosedAfter(current, after, Date.now());
    }

    tx.update(ref, update);
    return update;
  });
  return { courseId: input.courseId, ...update };
}

export const updateCourse = auditedCall('updateCourse', async (req, audit) => {
  requireAdmin(req);
  const input = validateUpdateCourse(req.data);
  audit.courseId = input.courseId;
  // What changed: a rename, an archive and the archived-access switch — which
  // opens or closes every recording in the class to students — all read
  // "Updated course" otherwise. `pruneDetail` drops the fields not sent.
  audit.detail = { name: input.name, archived: input.archived, archivedAccess: input.archivedAccess };
  return applyCourseUpdate(input);
});

export interface SetCourseManagersInput {
  courseId: string;
  managerUids: string[];
}

export function validateSetCourseManagers(data: unknown): SetCourseManagersInput {
  const d = data as { courseId?: unknown; managerUids?: unknown } | null;
  if (typeof d?.courseId !== 'string' || !d.courseId) {
    throw new HttpsError('invalid-argument', 'courseId is required.');
  }
  if (!Array.isArray(d.managerUids) || d.managerUids.some((u) => typeof u !== 'string' || !u)) {
    throw new HttpsError('invalid-argument', 'managerUids must be an array of uids.');
  }
  // De-duplicate: a repeated uid would not grant anything twice, but it makes
  // the array a poor answer to "who manages this class?".
  return { courseId: d.courseId, managerUids: [...new Set(d.managerUids as string[])] };
}

/**
 * Replace the set of managers scoped to a class.
 *
 * Every uid ADDED is checked against `staffUsers` first. `managerUids` is not a
 * label — the security rules read it directly, so writing an invented or
 * disabled uid into it *is* granting access. Validating here is the only place
 * that can be caught, since clients cannot write the collection at all.
 *
 * Only the added ones: a manager who was disabled stays on their courses, where
 * they can open nothing while disabled and have them back if enabled, and the
 * screen sends the whole list. Checking every uid refused every later change to
 * such a course — the next manager could not be added until somebody took the
 * disabled one off, which the screen gave no way to do.
 */
export async function applyCourseManagers(input: SetCourseManagersInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.courses).doc(input.courseId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such class.');
  const before = (snap.data() as CourseDoc).managerUids ?? [];

  const adding = input.managerUids.filter((uid) => !before.includes(uid));
  const checks = await Promise.all(adding.map((uid) => db.collection(COLLECTIONS.staffUsers).doc(uid).get()));
  checks.forEach((snap, i) => {
    const staff = snap.data() as StaffUserDoc | undefined;
    if (!snap.exists || staff?.status !== 'active') {
      throw new HttpsError('failed-precondition', `${adding[i]} is not an active staff member.`);
    }
  });

  await ref.update({ managerUids: input.managerUids });
  // WHO CAME AND WHO WENT, for the audit row. The row used to say only that
  // a course's managers changed; when a manager's stale cache refused their
  // work queue the question was "who was taken off which course when", and
  // thirty rows could not answer it.
  const after = new Set(input.managerUids);
  const was = new Set(before);
  return {
    courseId: input.courseId,
    managerUids: input.managerUids,
    added: input.managerUids.filter((u) => !was.has(u)),
    removed: before.filter((u) => !after.has(u)),
  };
}

export const setCourseManagers = auditedCall('setCourseManagers', async (req, audit) => {
  requireAdmin(req);
  const input = validateSetCourseManagers(req.data);
  audit.courseId = input.courseId;
  const result = await applyCourseManagers(input);
  // Only the sides that moved: `pruneDetail` drops an empty one, and a call
  // that changed nothing is not a change.
  audit.detail = {
    added: result.added.length ? result.added : undefined,
    removed: result.removed.length ? result.removed : undefined,
  };
  audit.noop = result.added.length === 0 && result.removed.length === 0;
  return result;
});
