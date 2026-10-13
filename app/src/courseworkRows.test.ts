import { describe, expect, it } from 'vitest';
import type { SubmissionDoc } from '@sabeel/shared';
import { inFilter, staffRows, stepFrom } from './courseworkRows';
import type { GradeRow, SubmissionRow } from './coursework';

const today = '2026-10-13';
const sub = (studentUid: string, over: Partial<SubmissionDoc> = {}): SubmissionRow =>
  ({
    id: `${studentUid}_cw`,
    studentUid,
    courseworkId: 'cw',
    courseId: 'c',
    cohortId: 'h',
    state: 'open',
    attempt: 1,
    handedInAt: null,
    note: '',
    files: {},
    returned: null,
    attempts: [],
    notRequired: null,
    moreTime: null,
    closedEarly: false,
    active: true,
    dueDate: '2026-10-20',
    lateUntil: '2026-10-27',
    assignedAt: 0,
    ...over,
  }) as SubmissionRow;
const names: Record<string, string> = { a: 'Aminah', b: 'Bilal', f: 'Fatima', h: 'Hamza', z: 'Zaynab' };
const nameOf = (uid: string) => names[uid];
const none = new Map<string, GradeRow>();

describe('the class list for one assignment', () => {
  it('is in name order, and leaves out a student who left with nothing in', () => {
    const rows = staffRows([sub('z'), sub('a'), sub('h', { active: false }), sub('b', { active: false, state: 'handedIn', handedInAt: 1 })], none, today, true, nameOf);
    expect(rows.map((r) => r.s.studentUid)).toEqual(['a', 'b', 'z']);
  });

  it('filters by where each student stands', () => {
    const rows = staffRows([sub('a'), sub('b', { state: 'handedIn', handedInAt: 1 })], none, today, true, nameOf);
    expect(rows.filter((r) => inFilter(r.st, 'toGrade')).map((r) => r.s.studentUid)).toEqual(['b']);
    expect(rows.filter((r) => inFilter(r.st, 'all'))).toHaveLength(2);
  });
});

describe('J and K', () => {
  const rows = staffRows([sub('a'), sub('f'), sub('z')], none, today, true, nameOf);
  it('step through the list in order, and stop at either end', () => {
    expect(stepFrom(rows, 'a', 1, nameOf)).toBe('f');
    expect(stepFrom(rows, 'f', -1, nameOf)).toBe('a');
    expect(stepFrom(rows, 'z', 1, nameOf)).toBe(null);
    expect(stepFrom(rows, 'a', -1, nameOf)).toBe(null);
  });

  it('from a student no longer in the list, step from where their name would sit — never back to the top', () => {
    // Hamza was graded a moment ago and left the "To grade" list.
    expect(stepFrom(rows, 'h', 1, nameOf)).toBe('z');
    expect(stepFrom(rows, 'h', -1, nameOf)).toBe('f');
  });
});
