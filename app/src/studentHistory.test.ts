import { describe, expect, it } from 'vitest';
import type { AuditEntryDoc } from '@sabeel/shared';
import { describeStudentEvent, mergeNewestFirst, studentHistory, workbookHistory } from './studentHistory';

/**
 * What a person reads on a student's page, from what the server wrote.
 *
 * Every fixture is a row the wrapper actually produces: `deriveTargets` picks
 * the ids off the payload, the enrolment callables add `detail.active` /
 * `detail.reenrolled`, and `setStudentAccess` adds `detail.status`. The one
 * shape that is NOT current — `setEnrollmentActive` with no detail — is a row
 * written before the boolean was recorded, and it is here because the page
 * must not read a direction into it.
 */
const label = (courseId: string) => (courseId === 'hikam' ? 'Hikam Foundations · Autumn 2026' : courseId);
const row = (partial: Partial<AuditEntryDoc & { id: string }>): AuditEntryDoc & { id: string } => ({
  id: 'x',
  at: 1,
  actorUid: 'admin',
  actorRole: 'admin',
  action: 'setEnrollmentActive',
  courseId: 'hikam',
  targets: { studentUid: 'stu', courseId: 'hikam' },
  ...partial,
});

describe('describeStudentEvent', () => {
  it('reads a removal as a removal and a return as a return', () => {
    expect(describeStudentEvent(row({ detail: { active: false } }), label)).toBe(
      'Removed from Hikam Foundations · Autumn 2026',
    );
    expect(describeStudentEvent(row({ detail: { active: true } }), label)).toBe(
      'Re-enrolled in Hikam Foundations · Autumn 2026',
    );
  });

  // The wrong sentence here is worse than a vague one: "Removed" on a student
  // who was in fact brought back is a claim about their record.
  it('claims no direction for a row written before the direction was recorded', () => {
    expect(describeStudentEvent(row({}), label)).toBe(
      'Enrolment changed in Hikam Foundations · Autumn 2026',
    );
  });

  it('tells a first enrolment from a return through "Add a student"', () => {
    expect(describeStudentEvent(row({ action: 'createEnrollment' }), label)).toBe(
      'Enrolled in Hikam Foundations · Autumn 2026',
    );
    expect(
      describeStudentEvent(row({ action: 'createEnrollment', detail: { reenrolled: true } }), label),
    ).toBe('Re-enrolled in Hikam Foundations · Autumn 2026');
  });

  it('says which password link staff sent, and when the email failed', () => {
    const link = (detail: Record<string, string>) =>
      describeStudentEvent(row({ action: 'sendPasswordLink', courseId: null, targets: { studentUid: 'stu' }, detail }), label);
    expect(link({ kind: 'set', mail: 'sent' })).toBe('Set-password link sent');
    expect(link({ kind: 'reset', mail: 'sent' })).toBe('Password reset link sent');
    expect(link({ kind: 'reset', mail: 'failed' })).toBe('Password link not sent: the email failed');
  });

  it('reads the access change by its status', () => {
    const access = (status: string) =>
      describeStudentEvent(
        row({ action: 'setStudentAccess', courseId: null, targets: { studentUid: 'stu' }, detail: { status } }),
        label,
      );
    expect(access('disabled')).toBe('Account disabled');
    expect(access('active')).toBe('Account re-enabled');
  });

  /*
   * The account's own creation is dated from the student document, so the log's
   * `createStudent` row adds only the enrolment made in the same step — and
   * nothing at all when there was none, or the page would date the account
   * twice.
   */
  it('takes only the enrolment from a creation row', () => {
    const created = (courseId: string | null) =>
      row({ action: 'createStudent', courseId, targets: { studentUid: 'stu' }, detail: { email: 'a@b' } });
    expect(describeStudentEvent(created('hikam'), label)).toBe(
      'Enrolled in Hikam Foundations · Autumn 2026',
    );
    expect(describeStudentEvent(created(null), label)).toBeNull();
  });

  it('leaves out what belongs to a recording or a session', () => {
    for (const action of ['overrideCompletion', 'clearCompletionOverride', 'submitAttendance']) {
      expect(describeStudentEvent(row({ action }), label)).toBeNull();
    }
  });

  it('names a course that no longer resolves by what it has', () => {
    expect(describeStudentEvent(row({ courseId: 'gone', detail: { active: false } }), label)).toBe(
      'Removed from gone',
    );
  });
});

describe('studentHistory', () => {
  it('shows a double-tapped enrolment once, and a genuine repeat twice', () => {
    // The production pair: two createEnrollment rows 24 ms apart, one tap.
    const tap = (id: string, at: number, action = 'createEnrollment', actorUid = 'staff-a') =>
      row({ id, at, action, actorUid, courseId: 'crs' });
    const twice = studentHistory([tap('a', 1_000), tap('b', 1_024)], () => 'Tafseer');
    expect(twice.map((r) => r.what)).toEqual(['Enrolled in Tafseer']);

    // Removed and enrolled again the next day, by someone else: two events.
    const later = studentHistory(
      [
        tap('a', 1_000),
        tap('r', 2_000, 'setEnrollmentActive'),
        tap('c', 90_000_000, 'createEnrollment', 'staff-b'),
      ],
      () => 'Tafseer',
    );
    expect(later.map((r) => r.what)).toEqual([
      'Enrolled in Tafseer',
      'Enrolment changed in Tafseer',
      'Enrolled in Tafseer',
    ]);
  });

  it('reads oldest first, whatever order the query returned', () => {
    const rows = studentHistory(
      [
        row({ id: 'c', at: 30, detail: { active: false } }),
        row({ id: 'b', at: 20, action: 'overrideCompletion' }),
        row({ id: 'a', at: 10, action: 'createEnrollment' }),
      ],
      label,
    );
    expect(rows.map((r) => [r.id, r.what])).toEqual([
      ['a', 'Enrolled in Hikam Foundations · Autumn 2026'],
      ['c', 'Removed from Hikam Foundations · Autumn 2026'],
    ]);
  });
});

describe('workbookHistory', () => {
  const created = { at: 5, by: 'admin' };

  it('is the page’s history: a double tap is one row, and the account’s creation comes first', () => {
    const rows = workbookHistory(
      [row({ at: 10, action: 'createEnrollment' }), row({ at: 10 + 24, action: 'createEnrollment' })],
      label,
      created,
    );
    expect(rows.map((r) => [r.at, r.what])).toEqual([
      [5, 'Account created'],
      [10, 'Enrolled in Hikam Foundations · Autumn 2026'],
    ]);
  });

  it('keeps the creation row the log has, once', () => {
    const rows = workbookHistory([row({ at: 7, action: 'createStudent', courseId: null })], label, created);
    expect(rows.map((r) => [r.at, r.what])).toEqual([[7, 'Account created']]);
  });
});

describe('mergeNewestFirst', () => {
  const at = (...ts: number[]) => ts.map((t) => ({ at: t }));

  it('puts parts back together newest first, and whole when no part stopped at its cap', () => {
    expect(mergeNewestFirst([at(9, 4), at(7, 2)], 5)).toEqual({ rows: at(9, 7, 4, 2), complete: true });
  });

  /*
   * A part cut short at its cap is missing whatever is older than its last
   * row. Keeping the other parts' older rows would print a history with a
   * hole in it, under a note saying only that the earliest is missing.
   */
  it('keeps nothing older than where a cut-short part stops, and says it is not whole', () => {
    expect(mergeNewestFirst([at(10, 9, 8), at(7, 5, 1)], 3)).toEqual({ rows: at(10, 9, 8), complete: false });
    expect(mergeNewestFirst([at(10, 6), at(9, 8)], 3)).toEqual({ rows: at(10, 9, 8), complete: false });
  });
});
