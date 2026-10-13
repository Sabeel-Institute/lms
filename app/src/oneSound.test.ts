import { afterEach, describe, expect, it } from 'vitest';
import { releasedSound, startedPlaying, type Sound } from './oneSound';

/** A player that counts the pauses it is asked for. */
function player(): Sound & { paused: number } {
  const p = { paused: 0, pause: () => void (p.paused += 1) };
  return p;
}

const made: Sound[] = [];
const fresh = () => {
  const p = player();
  made.push(p);
  return p;
};
afterEach(() => made.splice(0).forEach(releasedSound));

describe('one sound at a time', () => {
  it('starting an attachment pauses the class recording, and starting the recording again pauses the attachment', () => {
    const lecture = fresh();
    const recitation = fresh();
    startedPlaying(lecture);
    startedPlaying(recitation);
    expect(lecture.paused).toBe(1);
    expect(recitation.paused).toBe(0);

    startedPlaying(lecture);
    expect(recitation.paused).toBe(1);
    expect(lecture.paused).toBe(1);
  });

  it('a player that starts again after its own pause is not paused by itself', () => {
    const lecture = fresh();
    startedPlaying(lecture);
    startedPlaying(lecture);
    expect(lecture.paused).toBe(0);
  });

  it('only the one sounding is paused: a third start does not reach the first again', () => {
    const a = fresh();
    const b = fresh();
    const c = fresh();
    startedPlaying(a);
    startedPlaying(b);
    startedPlaying(c);
    expect([a.paused, b.paused, c.paused]).toEqual([1, 1, 0]);
  });

  it('a released player is never asked to pause: the screen that held it is gone', () => {
    const recitation = fresh();
    const lecture = fresh();
    startedPlaying(recitation);
    releasedSound(recitation);
    startedPlaying(lecture);
    expect(recitation.paused).toBe(0);
  });

  it('releasing a player that is not the one sounding leaves the rule on the one that is', () => {
    const lecture = fresh();
    const other = fresh();
    startedPlaying(lecture);
    releasedSound(other);
    const recitation = fresh();
    startedPlaying(recitation);
    expect(lecture.paused).toBe(1);
  });
});
