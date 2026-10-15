import { describe, expect, it } from 'vitest';
import { validateClearOverride, validateOverride } from '../../src/overrides';

const base = { studentUid: 'stu', recordingId: 'rec', completed: true, reason: 'attended live' };

describe('validateOverride', () => {
  it('accepts a complete override with a reason', () => {
    expect(validateOverride({ ...base })).toEqual(base);
  });

  it('trims the reason', () => {
    expect(validateOverride({ ...base, reason: '  attended live  ' }).reason).toBe('attended live');
  });

  it('allows overriding to NOT complete (with a reason)', () => {
    expect(validateOverride({ ...base, completed: false }).completed).toBe(false);
  });

  it('REQUIRES a reason — empty or whitespace is rejected', () => {
    for (const reason of ['', '   ', undefined, null, 42]) {
      expect(() => validateOverride({ ...base, reason })).toThrow();
    }
  });

  it('rejects a non-boolean completed', () => {
    expect(() => validateOverride({ ...base, completed: 'yes' })).toThrow();
  });

  it('requires studentUid and recordingId', () => {
    expect(() => validateOverride({ ...base, studentUid: '' })).toThrow();
    expect(() => validateOverride({ ...base, recordingId: '' })).toThrow();
  });

  it('rejects an over-long reason', () => {
    expect(() => validateOverride({ ...base, reason: 'x'.repeat(501) })).toThrow();
  });
});

/*
 * REMOVING AN OVERRIDE LEAVES A ROW SAYING SO. The removal's reason goes into
 * its audit row; uncapped, a reason too large for that row let the override
 * go with the history still saying "Marked complete by staff". Refused here,
 * the removal never starts.
 */
describe('validateClearOverride', () => {
  const clear = { studentUid: 'stu', recordingId: 'rec', reason: 'set by mistake' };

  it('takes a removal with a reason, trimmed', () => {
    expect(validateClearOverride({ ...clear, reason: '  set by mistake ' })).toEqual(clear);
  });

  it('refuses a removal with no reason, or one longer than an override may have', () => {
    for (const reason of ['', '  ', undefined, 'x'.repeat(501), 'x'.repeat(1_100_000)]) {
      expect(() => validateClearOverride({ ...clear, reason })).toThrow();
    }
    expect(validateClearOverride({ ...clear, reason: 'x'.repeat(500) }).reason).toHaveLength(500);
  });
});
