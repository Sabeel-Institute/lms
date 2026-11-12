import { describe, expect, it } from 'vitest';
import { playingSinceItsDay, rememberedOpenDay } from './instituteDay';

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

/*
 * THE DAY THE WINDOW HAD WHILE OPEN, one memory for the app: the docked bar
 * sees the window open before midnight, and a player opened after it reads
 * the same day, so both agree the file plays on.
 */
describe('the last day a window had while it was open', () => {
  const open = { state: 'open', required: true, until: '2026-10-14', then: null } as const;
  const ended = { state: 'ended', lastDay: '2026-10-14', record: true } as const;
  it('is known to a reader that only ever saw it closed', () => {
    expect(rememberedOpenDay('s1', 'r1', open)).toBe('2026-10-14');
    // Another screen, opened after midnight.
    expect(rememberedOpenDay('s1', 'r1', ended)).toBe('2026-10-14');
  });
  it('is kept per student and recording', () => {
    expect(rememberedOpenDay('s2', 'r1', ended)).toBeNull();
    expect(rememberedOpenDay('s1', 'r2', ended)).toBeNull();
  });
  it('follows the window while it is open: a given date taken back is told apart', () => {
    rememberedOpenDay('s3', 'r1', { state: 'open', required: false, until: '2026-10-20', listenByWas: '2026-10-14' });
    expect(rememberedOpenDay('s3', 'r1', ended)).toBe('2026-10-20');
  });
});
