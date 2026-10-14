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

  it('show a manager the teachers’ films, and neither the students’ nor the administrators’', () => {
    const mine = helpVideosFor('manager');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.audience === 'staff')).toBe(true);
  });

  it('show an admin the teachers’ films and the administrators’, and not the students’', () => {
    const mine = helpVideosFor('admin');
    expect(mine.some((v) => v.audience === 'staff')).toBe(true);
    expect(mine.some((v) => v.audience === 'admin')).toBe(true);
    expect(mine.some((v) => v.audience === 'student')).toBe(false);
  });

  it('are kept under help/ in the bucket, one file per cut and kind', () => {
    expect(helpVideoKey('student-to-do', 'phone', 'video')).toBe('help/student-to-do-phone.mp4');
    expect(helpVideoKey('student-to-do', 'computer', 'captions')).toBe('help/student-to-do-computer.vtt');
  });
});
