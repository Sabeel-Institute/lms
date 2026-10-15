import { describe, expect, it } from 'vitest';
import { readsRightToLeft, slideEnds } from './titleSlide';

describe('a title too long for its line', () => {
  it('rests with its beginning in view, whichever way it reads', () => {
    // Left-anchored: the window shows the left end at no offset.
    expect(slideEnds(300, false)).toEqual({ rest: 0, far: -300 });
    // An Arabic title begins at its right end, in view at the full offset.
    expect(slideEnds(300, true)).toEqual({ rest: -300, far: 0 });
  });

  it('reads the way its first letter does', () => {
    expect(readsRightToLeft('الدرس الثالث: أحكام التجويد')).toBe(true);
    expect(readsRightToLeft('Week 3: الدرس الثالث')).toBe(false);
    // Digits, punctuation and spaces decide nothing.
    expect(readsRightToLeft('3. ٣ — الدرس الثالث')).toBe(true);
    expect(readsRightToLeft('3. — Tajweed')).toBe(false);
    expect(readsRightToLeft('שיעור ג')).toBe(true);
    expect(readsRightToLeft('')).toBe(false);
  });
});
