import { describe, it, expect } from 'vitest';
import {
  addsExcusal,
  validateCreateSession,
  validateDueDateChange,
  validateUpdateSession,
} from '../../src/sessions';

/**
 * The due date is the day the excused lose access, so the validators enforce one
 * invariant: a deadline may become past by the passage of time, but nothing may
 * ever WRITE one that has already gone. `today` is injected so the day boundary
 * is exercised without a clock.
 */
const TODAY = '2026-07-25';

const create = (over: Record<string, unknown> = {}) =>
  validateCreateSession(
    { courseId: 'c1', date: '2026-07-20', title: 'Week 3', dueDate: '2026-08-01', notes: '', ...over },
    TODAY,
  );

describe('validateCreateSession', () => {
  it('accepts a due date in the future', () => {
    expect(create()).toMatchObject({ courseId: 'c1', dueDate: '2026-08-01' });
  });

  it('accepts a due date of today — it is the LAST on-time day', () => {
    expect(create({ dueDate: TODAY }).dueDate).toBe(TODAY);
  });

  it('refuses a due date already in the past', () => {
    expect(() => create({ dueDate: '2026-07-24' })).toThrow(/cannot be in the past/);
  });

  it('refuses a missing due date — a blank deadline would mean permanent access', () => {
    expect(() => create({ dueDate: null })).toThrow(/due date is required/);
    expect(() => create({ dueDate: undefined })).toThrow(/due date is required/);
  });

  it('refuses a malformed due date', () => {
    expect(() => create({ dueDate: '1 Aug 2026' })).toThrow(/YYYY-MM-DD/);
  });

  it('refuses a date that is not on the calendar, however well it is shaped', () => {
    // `2026-99-99` passed the shape check, stayed "open" by string compare
    // until 2027, and never matched the last-day sweep.
    for (const bad of ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10']) {
      expect(() => create({ dueDate: bad })).toThrow(/YYYY-MM-DD/);
      expect(() => create({ date: bad })).toThrow(/YYYY-MM-DD/);
    }
    expect(create({ dueDate: '2028-02-29' }).dueDate).toBe('2028-02-29'); // a leap day exists
  });

  it('still refuses the pre-existing invalid inputs', () => {
    expect(() => create({ courseId: '' })).toThrow(/courseId/);
    expect(() => create({ date: 'soon' })).toThrow(/YYYY-MM-DD/);
    expect(() => create({ title: '   ' })).toThrow(/title is required/);
  });
});

describe('validateUpdateSession', () => {
  /*
   * AN EDIT IS HELD TO WHAT A CREATE IS. Renaming took any length at all, so a
   * page pasted into a title, or 300,000 characters of notes, went into every
   * workbook of the course, past Excel's limit for a cell.
   */
  it('caps the title and the notes as creating one does', () => {
    expect(() => validateUpdateSession({ sessionId: 's1', title: 'x'.repeat(201) })).toThrow(/too long/);
    expect(() => create({ title: 'x'.repeat(201) })).toThrow(/too long/);
    expect(() => validateUpdateSession({ sessionId: 's1', notes: 'x'.repeat(5001) })).toThrow(/too long/);
    expect(() => create({ notes: 'x'.repeat(5001) })).toThrow(/too long/);
    expect(validateUpdateSession({ sessionId: 's1', title: 'x'.repeat(200), notes: 'x'.repeat(5000) }).title).toHaveLength(200);
  });

  it('leaves the due date alone when it is not being changed', () => {
    const out = validateUpdateSession({ sessionId: 's1', title: 'Renamed' });
    expect(out).toEqual({ sessionId: 's1', title: 'Renamed' });
  });

  it('accepts a well-formed due date — whether it is in the past is not its question', () => {
    expect(validateUpdateSession({ sessionId: 's1', dueDate: '2026-09-01' }).dueDate).toBe(
      '2026-09-01',
    );
  });

  it('refuses clearing the due date', () => {
    expect(() => validateUpdateSession({ sessionId: 's1', dueDate: null })).toThrow(
      /due date is required/,
    );
  });

  it('refuses a malformed due date', () => {
    expect(() => validateUpdateSession({ sessionId: 's1', dueDate: 'next week' })).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('refuses an update that changes nothing', () => {
    expect(() => validateUpdateSession({ sessionId: 's1' })).toThrow(/Nothing to change/);
  });
});

describe('validateDueDateChange', () => {
  it('accepts moving the deadline forward — the documented way to reopen a session', () => {
    expect(() => validateDueDateChange('2026-09-01', '2026-08-01', TODAY)).not.toThrow();
  });

  it('refuses moving the deadline into the past', () => {
    expect(() => validateDueDateChange('2026-07-24', '2026-08-01', TODAY)).toThrow(
      /cannot be in the past/,
    );
  });

  it('accepts a past due date that is UNCHANGED', () => {
    // The session editor resends all four fields on every save, so this is the
    // ordinary case of fixing a typo on a session whose deadline has gone. Judged
    // as a write rather than a resend, no closed session could be edited at all
    // without also reopening access for everyone excused.
    expect(() => validateDueDateChange('2026-07-01', '2026-07-01', TODAY)).not.toThrow();
  });

  it('accepts today — the last on-time day is still writable', () => {
    expect(() => validateDueDateChange(TODAY, '2026-08-01', TODAY)).not.toThrow();
  });
});

describe('addsExcusal', () => {
  // What the past-due guard actually asks. An excused mark IS the access grant,
  // so a new one after the deadline would grant access that expired yesterday —
  // but resending the excusals already on the session must stay free, or no
  // closed session's attendance could ever be corrected.
  const stored = { a: 'excused', b: 'present', c: 'absent' } as const;

  it('is true for a student being excused for the first time', () => {
    expect(addsExcusal({ ...stored, b: 'excused' }, { ...stored })).toBe(true);
  });

  it('is false when the whole stored map is resent unchanged', () => {
    expect(addsExcusal({ ...stored }, { ...stored })).toBe(false);
  });

  it('is false when correcting one student while others stay excused', () => {
    // The screen submits every active roster member every time, so the four
    // untouched excusals ride along with the one real change.
    expect(addsExcusal({ ...stored, c: 'present' }, { ...stored })).toBe(false);
  });

  it('is false when an excusal is being REMOVED', () => {
    expect(addsExcusal({ ...stored, a: 'absent' }, { ...stored })).toBe(false);
  });

  it('is true on a first submit, where nothing is stored yet', () => {
    expect(addsExcusal({ a: 'excused' }, {})).toBe(true);
    expect(addsExcusal({ a: 'present', b: 'absent' }, {})).toBe(false);
  });
});
