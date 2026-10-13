import { describe, expect, it } from 'vitest';
import type { TodoBucket } from '@sabeel/shared';
import { arrangeTodo, type TodoEntry } from './todo';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;
const e = (key: string, bucket: TodoBucket, deadline: string | null, doneAt: number | null = null): TodoEntry => ({
  key,
  title: key,
  bucket,
  deadline,
  doneAt,
});

describe('To do', () => {
  it('leads with the nearest day anything open closes, whatever its kind', () => {
    const { next } = arrangeTodo(
      [e('recording', 'upcoming', '2026-10-31'), e('memorize', 'dueSoon', '2026-10-13'), e('late letters', 'pastDue', '2026-10-17')],
      NOW,
    );
    expect(next?.key).toBe('memorize');
  });

  it('puts late work right under the lead, then what is due, then the record', () => {
    const { groups } = arrangeTodo(
      [
        e('done', 'done', null, NOW - DAY),
        e('missed', 'missed', null),
        e('upcoming', 'upcoming', '2026-10-23'),
        e('soon', 'dueSoon', '2026-10-14'),
        e('lead', 'dueSoon', '2026-10-13'),
        e('late', 'pastDue', '2026-10-17'),
        e('archived', 'archived', null),
      ],
      NOW,
    );
    expect(groups.map((g) => g.bucket)).toEqual(['pastDue', 'dueSoon', 'upcoming', 'missed', 'archived', 'done']);
    // The lead is drawn large, once, and not again in its group.
    expect(groups.find((g) => g.bucket === 'dueSoon')?.items.map((i) => i.key)).toEqual(['soon']);
  });

  it('keeps two weeks of finished work, newest first; older work is on the class page', () => {
    const { groups } = arrangeTodo(
      [e('a week ago', 'done', null, NOW - 7 * DAY), e('yesterday', 'done', null, NOW - DAY), e('a month ago', 'done', null, NOW - 30 * DAY)],
      NOW,
    );
    expect(groups[0].items.map((i) => i.key)).toEqual(['yesterday', 'a week ago']);
  });

  it('has no lead when nothing can still be done', () => {
    const { next, groups } = arrangeTodo([e('missed', 'missed', null)], NOW);
    expect(next).toBeNull();
    expect(groups.map((g) => g.label)).toEqual(['Missed']);
  });
});
