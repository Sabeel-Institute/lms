import {
  INSTITUTE_TIMEZONE,
  isLate,
  leftWithNothingIn,
  staffWorkState,
  todayInZone,
  unbreakableDate,
  type StaffWorkState,
} from '@sabeel/shared';
import type { GradeRow, SubmissionRow } from './coursework';

/**
 * One assignment's class, as staff see it — the list on the assignment's page
 * and beside the work when grading at a desk. One builder, so the two lists
 * are the same list: same rows, same order, same words, same filter.
 */

export type WorkFilter = 'all' | 'toGrade' | 'pastDue' | 'returned';

export interface StaffRow {
  s: SubmissionRow;
  st: StaffWorkState;
  g: GradeRow | undefined;
}

/**
 * The rows, by name. A student who left the class with nothing handed in is
 * not listed (`leftWithNothingIn`); one who left after handing in still is,
 * because their work still needs a grade or stands as their record.
 */
export function staffRows(
  subs: readonly SubmissionRow[],
  grades: ReadonlyMap<string, GradeRow>,
  today: string,
  courseOpen: boolean,
  nameOf: (uid: string) => string,
): StaffRow[] {
  return subs
    .filter((s) => !leftWithNothingIn(s))
    .map((s) => ({ s, st: staffWorkState(s, grades.get(s.studentUid), today, courseOpen), g: grades.get(s.studentUid) }))
    .sort((a, b) => nameOf(a.s.studentUid).localeCompare(nameOf(b.s.studentUid)));
}

export function inFilter(st: StaffWorkState, filter: WorkFilter): boolean {
  return filter === 'all' || st === filter;
}

const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

/** One student's line, in the words the proposal settled. */
export function rowLine(s: SubmissionRow, st: StaffWorkState): string {
  const late = s.handedInAt !== null && isLate(s.handedInAt, s.dueDate, INSTITUTE_TIMEZONE);
  switch (st) {
    case 'notRequired':
      return `Not required · ${s.notRequired?.reason ?? ''}`;
    case 'returned':
      return `Returned ${s.returned ? dayOf(s.returned.at) : ''}`;
    case 'toGrade':
    case 'graded':
      return s.handedInAt ? `Handed in ${dayOf(s.handedInAt)}${late ? ' · late' : ''}` : 'Graded without a hand-in';
    case 'toDo':
      return s.moreTime ? `More time, until ${unbreakableDate(s.dueDate)}` : 'Nothing handed in yet';
    case 'pastDue':
      return 'Nothing handed in';
    case 'missed':
      return 'Missed';
    case 'closed':
      return 'Closed, course archived';
  }
}

/**
 * Where J (+1) or K (-1) goes from `current`: the next or previous row in the
 * list as filtered. A student no longer in the list — graded a moment ago
 * under "To grade" — steps from where their name would sit, so J never jumps
 * back to the top. Null at either end.
 */
export function stepFrom(
  rows: readonly StaffRow[],
  current: string,
  dir: 1 | -1,
  nameOf: (uid: string) => string,
): string | null {
  const uids = rows.map((r) => r.s.studentUid);
  const at = uids.indexOf(current);
  if (at >= 0) return uids[at + dir] ?? null;
  const name = nameOf(current);
  if (dir === 1) return uids.find((u) => nameOf(u).localeCompare(name) > 0) ?? null;
  return [...uids].reverse().find((u) => nameOf(u).localeCompare(name) < 0) ?? null;
}
