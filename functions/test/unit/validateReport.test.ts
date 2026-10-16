import { describe, it, expect } from 'vitest';
import { REPORT_MAX_CHARS, validateReport } from '../../src/conduct';

/**
 * A report is what the person wrote, trimmed, from one to 2000 characters as
 * they count them (an Arabic letter or an emoji is one); where it came from is
 * kept only when it is something the app sends. Anything else is refused in a
 * sentence the person can act on.
 */
const refusal = (data: unknown) => {
  try {
    validateReport(data);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('validateReport', () => {
  it('keeps the words, trimmed, and where they came from', () => {
    expect(validateReport({ text: '  Abusive comment on Session 1.\n', platform: 'web', appVersion: 'v0.1.3 · abc1234' })).toEqual({
      text: 'Abusive comment on Session 1.',
      platform: 'web',
      appVersion: 'v0.1.3 · abc1234',
    });
    expect(validateReport({ text: 'x' })).toEqual({ text: 'x' });
  });

  it('refuses a report with nothing in it', () => {
    for (const data of [undefined, null, {}, { text: '' }, { text: '   \n\t ' }, { text: 42 }]) {
      expect(refusal(data), JSON.stringify(data)).toBe('Say what you are reporting before sending.');
    }
  });

  it('takes 2000 characters and refuses 2001, counting as a person counts', () => {
    expect(REPORT_MAX_CHARS).toBe(2000);
    expect(refusal({ text: 'a'.repeat(2000) })).toBeNull();
    // 2000 emoji are 4000 UTF-16 units: still 2000 characters.
    expect(refusal({ text: '🙂'.repeat(2000) })).toBeNull();
    expect(refusal({ text: 'ب'.repeat(2001) })).toBe('A report can be up to 2000 characters; this one is 2001.');
  });

  it('refuses a platform or version the app would never send', () => {
    expect(refusal({ text: 'x', platform: 'windows' })).toMatch(/platform/);
    expect(refusal({ text: 'x', appVersion: '' })).toMatch(/appVersion/);
    expect(refusal({ text: 'x', appVersion: 'v1\r\nBcc: x@example.com' })).toMatch(/appVersion/);
    expect(refusal({ text: 'x', appVersion: 'v'.repeat(65) })).toMatch(/appVersion/);
    expect(refusal({ text: 'x', appVersion: 7 })).toMatch(/appVersion/);
  });
});
