/**
 * Enrolments written when they kept two dates — `enrolledAt` (the first
 * joining) and `unenrolledAt` (the LAST leaving) — given every stretch the
 * student spent in the class instead, rebuilt from the audit log by
 * `stretchesFromHistory` (@sabeel/shared, where the rules are tested).
 *
 * Used by the migration of this project (`backfill-stretches.mjs`)
 * and by the switchover seed, which copies the live app's enrolments, still
 * in the old shape, with the live app's audit log beside them.
 */
import { stretchesFromHistory } from '@sabeel/shared';

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
