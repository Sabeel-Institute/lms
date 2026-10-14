import type { AuditEntryDoc, StudentHistoryRow } from '@sabeel/shared';

/**
 * A student's history, read out of the audit log.
 *
 * NOT A SECOND RECORD. Every change staff make to a student already lands in
 * `auditLog` through the `auditedCall` wrapper, tagged with the student's uid
 * under `targets.studentUid` — so a student's history is one query on the log
 * that exists, not an events collection kept in step with it. What this module
 * adds is the reading: which of those rows are about the student's standing
 * (their account, their enrolments), and how each is said on their page.
 *
 * The actions that are NOT here are deliberate. A completion override or an
 * attendance submission names the student too, but belongs to a recording's
 * ledger or a session's register, where it is already shown with its context.
 */
export interface StudentEvent {
  id: string;
  at: number;
  actorUid: string;
  /** What happened, as a sentence fragment: "Enrolled in Hikam Foundations". */
  what: string;
}

/**
 * The sentence for one audit row, or `null` when the row is not part of the
 * student's history.
 *
 * `courseLabel` names a course (with its cohort, since the same course name
 * recurs term after term); it is asked for a course that may since have been
 * deleted, and answers with whatever it has.
 *
 * Every branch has a fallback for a row whose `detail` predates the field it
 * reads — `setEnrollmentActive` audited without its boolean until the history
 * needed it — and the fallback says less rather than guessing: "Enrolment
 * changed" is true of both directions, and a wrong "Removed" on a student who
 * came back is exactly the sentence this page must never print.
 */
export function describeStudentEvent(
  e: AuditEntryDoc,
  courseLabel: (courseId: string) => string,
): string | null {
  const course = () => courseLabel(e.courseId ?? '');
  switch (e.action) {
    case 'createStudent':
      // The account itself is dated from the student document, which every
      // student has whether or not their creation was logged under this key.
      // What the log adds is the enrolment made in the same step.
      return e.courseId ? `Enrolled in ${course()}` : null;
    case 'createEnrollment':
      return `${e.detail?.reenrolled === true ? 'Re-enrolled' : 'Enrolled'} in ${course()}`;
    case 'setEnrollmentActive':
      return e.detail?.active === false
        ? `Removed from ${course()}`
        : e.detail?.active === true
          ? `Re-enrolled in ${course()}`
          : `Enrolment changed in ${course()}`;
    case 'setStudentAccess':
      return e.detail?.status === 'disabled'
        ? 'Account disabled'
        : e.detail?.status === 'active'
          ? 'Account re-enabled'
          : 'Account access changed';
    case 'deleteAccount':
      return 'Account deleted';
    default:
      return null;
  }
}

/**
 * A second row saying the same thing as the one before it, by the same person,
 * this soon after, is the same tap twice — not a second event.
 *
 * Two "Enrolled in Tafseer" rows 24 ms apart reached production from one
 * double-tapped row before the server refused the second call. The log keeps
 * both, and the audit screen shows both, because both calls ran; the student's
 * page is about what happened to the student, and one thing did.
 */
const SAME_TAP_MS = 60_000;

/**
 * The rows for the page, OLDEST FIRST — a history starts at the beginning.
 *
 * The query behind this is newest-first with a cap, like every read of the
 * audit log, so the cap keeps the most recent events rather than the oldest;
 * the order is turned round here for reading. Rows that are not about the
 * student's standing are dropped, not shown raw.
 */
export function studentHistory(
  entries: readonly (AuditEntryDoc & { id: string })[],
  courseLabel: (courseId: string) => string,
): StudentEvent[] {
  const rows: StudentEvent[] = [];
  for (const e of entries) {
    const what = describeStudentEvent(e, courseLabel);
    if (what) rows.push({ id: e.id, at: e.at, actorUid: e.actorUid, what });
  }
  return oneRowPerTap(rows);
}

/** Oldest first, with a repeat of the row before it, by the same person this soon after, dropped. */
function oneRowPerTap<R extends { at: number; actorUid: string; what: string }>(rows: R[]): R[] {
  const out: R[] = [];
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const prev = out[out.length - 1];
    const sameTap = prev !== undefined && prev.what === r.what && prev.actorUid === r.actorUid && r.at - prev.at <= SAME_TAP_MS;
    if (!sameTap) out.push(r);
  }
  return out;
}

/**
 * The student workbook's History tab: the page's history, rows for the
 * overrides beside it, and the account's creation first, as the page shows it
 * whether or not its audit row is among those read. Built row by row, a
 * double tap's two enrolments were both in the file the page shows as one.
 */
export function workbookHistory(
  entries: readonly AuditEntryDoc[],
  courseLabel: (courseId: string) => string,
  created: { at: number; by: string },
): StudentHistoryRow[] {
  const rows = oneRowPerTap(entries.flatMap((e) => describeHistoryRow(e, courseLabel) ?? []));
  return rows.some((r) => r.what === 'Account created')
    ? rows
    : [{ at: created.at, actorUid: created.by, what: 'Account created', courseId: null, detail: '' }, ...rows];
}

/**
 * A row for the student workbook's History tab: the standing events above,
 * plus the ones the page leaves to their own screens — a completion override
 * and its removal — because a file that has the term in it can hold them
 * beside the listening they changed. `null` for a row that is not about this
 * student (an attendance submission names the whole roster, say).
 */
function describeHistoryRow(
  e: AuditEntryDoc,
  courseLabel: (courseId: string) => string,
): StudentHistoryRow | null {
  const standing = describeStudentEvent(e, courseLabel);
  const reason = typeof e.detail?.reason === 'string' ? e.detail.reason : '';
  const row = (what: string, detail = '') => ({
    at: e.at,
    actorUid: e.actorUid,
    what,
    courseId: e.courseId,
    detail,
  });
  if (standing) return row(standing);
  if (e.action === 'createStudent') return row('Account created');
  if (e.action === 'overrideCompletion') {
    return row(e.detail?.completed === false ? 'Marked not complete by staff' : 'Marked complete by staff', reason);
  }
  if (e.action === 'clearCompletionOverride') return row('Staff mark removed', reason);
  return null;
}
