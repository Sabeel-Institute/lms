import { describe, expect, it } from 'vitest';
import { playingSinceItsDay } from './instituteDay';

/*
 * PLAYING SINCE BEFORE THE DAY ENDED is what lets a recording play on past
 * its last day; started again after midnight, it is closed. The institute's
 * zone decides the day, not the device's.
 */
describe('a recording playing across midnight', () => {
  const at = (iso: string) => Date.parse(iso);
  it('plays on when it has been playing since its last day', () => {
    expect(playingSinceItsDay(at('2026-10-14T23:59:40-05:00'), '2026-10-14')).toBe(true);
  });
  it('is closed when it started again after midnight', () => {
    expect(playingSinceItsDay(at('2026-10-15T00:00:05-05:00'), '2026-10-14')).toBe(false);
  });
  it('is closed when it is not playing', () => {
    expect(playingSinceItsDay(null, '2026-10-14')).toBe(false);
  });
});
