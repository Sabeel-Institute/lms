import { DONE_DAYS, TODO_ORDER, type TodoBucket } from '@sabeel/shared';

/**
 * The student's To do: required recordings and assignments in one list
 * (docs/proposals/lms-assignments-proposal.html, section 2). Pure, so the
 * order is tested rather than read off a screen.
 *
 * The order, top to bottom:
 *
 *  - NEXT UP: the nearest day anything still open closes, of either kind —
 *    a recording's date, an assignment's due date, or for late work the last
 *    day it is taken.
 *  - Past due, Due soon, Upcoming: what can still be done.
 *  - Missed, Archived: closed without being done, kept quietly as the record.
 *  - Done: the last two weeks of finished work, newest first. Older work is
 *    on each class page.
 */
export interface TodoEntry {
  key: string;
  title: string;
  bucket: TodoBucket;
  /** The day it closes, for open work; null otherwise. */
  deadline: string | null;
  /** When it was finished, for done work; null when unknown. */
  doneAt: number | null;
}

const TODO_LABELS: Record<TodoBucket, string> = {
  pastDue: 'Past due',
  dueSoon: 'Due soon',
  upcoming: 'Upcoming',
  missed: 'Missed',
  archived: 'Archived',
  done: 'Done',
};

const OPEN: TodoBucket[] = ['pastDue', 'dueSoon', 'upcoming'];
const DAY_MS = 86_400_000;

export interface TodoGroup<T> {
  bucket: TodoBucket;
  label: string;
  items: T[];
}

export function arrangeTodo<T extends TodoEntry>(
  entries: T[],
  now: number,
): { next: T | null; groups: TodoGroup<T>[] } {
  const byDeadline = (a: T, b: T) =>
    (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.title.localeCompare(b.title);
  const open = entries.filter((e) => OPEN.includes(e.bucket)).sort(byDeadline);
  const next = open[0] ?? null;
  const recent = (e: T) => e.doneAt === null || e.doneAt >= now - DONE_DAYS * DAY_MS;
  const groups = TODO_ORDER.map((bucket) => {
    const items = entries.filter((e) => e.bucket === bucket && e !== next && (bucket !== 'done' || recent(e)));
    items.sort(bucket === 'done' ? (a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) : byDeadline);
    return { bucket, label: TODO_LABELS[bucket], items };
  }).filter((g) => g.items.length > 0);
  return { next, groups };
}
