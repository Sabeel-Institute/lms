import { describe, expect, it } from 'vitest';
import { HELP_VIDEOS, helpVideoKey, helpVideosFor } from '../src';

describe('the help films', () => {
  it('are named once each', () => {
    const ids = HELP_VIDEOS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('show a student the students’ films and nothing of the staff’s', () => {
    const mine = helpVideosFor('student');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.audience === 'student')).toBe(true);
    expect(mine.length).toBe(HELP_VIDEOS.filter((v) => v.audience === 'student').length);
  });

  it('show staff every film, the students’ included, so they can help a student through one', () => {
    for (const role of ['manager', 'admin'] as const) {
      expect(helpVideosFor(role).map((v) => v.id)).toEqual(HELP_VIDEOS.map((v) => v.id));
    }
    // Every audience is represented, or "every film" would prove nothing.
    expect(new Set(HELP_VIDEOS.map((v) => v.audience))).toEqual(new Set(['student', 'staff', 'admin']));
  });

  it('are kept under help/ in the bucket, one file per cut and kind', () => {
    expect(helpVideoKey('student-to-do', 'phone', 'video')).toBe('help/student-to-do-phone.mp4');
    expect(helpVideoKey('student-to-do', 'computer', 'captions')).toBe('help/student-to-do-computer.vtt');
  });
});
