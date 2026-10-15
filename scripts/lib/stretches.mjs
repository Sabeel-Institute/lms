/**
 * Records written before they kept their stretches, given them from the
 * audit log (the rules are in @sabeel/shared, where they are tested):
 *
 *  - an enrolment kept two dates — `enrolledAt` (the first joining) and
 *    `unenrolledAt` (the LAST leaving) — and now keeps every stretch the
 *    student spent in the class (`stretchesFromHistory`);
 *  - a class kept only whether its recordings are closed to its students now,
 *    and now keeps every stretch they were (`recordingsClosedFromHistory`).
 *
 * Used by the migration of this project (`backfill-stretches.mjs`) and by the
 * switchover seed, which copies the live app's records, still in the old
 * shape, with the live app's audit log beside them.
 */
import { recordingsClosedFromHistory, stretchesFromHistory } from '@sabeel/shared';

/** The audit actions that put a student into a class or take them out of it. */
const JOINS_OR_LEAVES = new Set(['createEnrollment', 'setEnrollmentActive', 'createStudent']);

/**
 * The audit rows that join or leave a class, by the enrolment they are about
 * (`${studentUid}_${courseId}`, the enrolment's own id). Rows are decoded
 * audit entries, as `listDocuments` gives them.
 */
export function enrolmentHistory(auditRows) {
  const out = new Map();
  for (const row of auditRows) {
    const studentUid = row.targets?.studentUid;
    if (!JOINS_OR_LEAVES.has(row.action) || !studentUid || !row.courseId) continue;
    const key = `${studentUid}_${row.courseId}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

/**
 * An enrolment in the old shape, in today's: its stretches, and neither of
 * the two dates. Null for one that has its stretches already. `inferred` says
 * the log and the stored dates disagreed, so the operator can look.
 */
export function convertEnrolment(data, history) {
  if (Array.isArray(data.stretches)) return null;
  const { enrolledAt, unenrolledAt, ...rest } = data;
  if (typeof enrolledAt !== 'number') throw new Error('an enrolment with neither stretches nor enrolledAt');
  const { stretches, inferred } = stretchesFromHistory(
    { active: data.active, enrolledAt, ...(typeof unenrolledAt === 'number' ? { unenrolledAt } : {}) },
    history ?? [],
  );
  return { data: { ...rest, stretches }, inferred };
}

/** The audit actions that open or close a class's recordings to its students. */
const ARCHIVES = new Set(['updateCourse', 'setCohortArchived']);

/**
 * The audit rows that may open or close classes' recordings, by what they
 * are about: `course:<id>` for a class's own, `cohort:<id>` for its cohort's.
 */
export function archiveHistory(auditRows) {
  const out = new Map();
  for (const row of auditRows) {
    if (!ARCHIVES.has(row.action)) continue;
    const key = row.action === 'updateCourse' ? `course:${row.courseId ?? row.targets?.courseId}` : `cohort:${row.targets?.cohortId}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

/**
 * A class in the old shape, in today's: with `recordingsClosed`. Null for
 * one that has it already. `cohort` is its cohort's stored document.
 */
export function convertCourse(id, data, cohort, history) {
  if (Array.isArray(data.recordingsClosed)) return null;
  const { recordingsClosed, inferred } = recordingsClosedFromHistory(
    { createdAt: data.createdAt, effectiveActive: data.effectiveActive, archivedAccess: data.archivedAccess, cohortArchived: !!cohort?.archived },
    [...(history.get(`course:${id}`) ?? []), ...(history.get(`cohort:${data.cohortId}`) ?? [])],
  );
  return { data: { ...data, recordingsClosed }, inferred };
}
