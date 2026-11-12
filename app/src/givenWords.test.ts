import { describe, expect, it } from 'vitest';
import type { RegisterFacts } from '@sabeel/shared';
import { changedSince, giveResult, givenStatus, namesList } from './givenWords';

/**
 * What a teacher reads about each student given a recording, and what the
 * sheet does with a colleague's change. The decisions are the shared ones;
 * these are the words.
 */

const TODAY = '2026-11-10';
const register = (mark: 'present' | 'excused', dueDate = '2026-11-12'): RegisterFacts => ({
  attendanceSubmittedAt: 1,
  attendance: { u1: mark },
  dueDate,
});
/** Read as a person reads it: the non-breaking hyphens the dates carry, as hyphens. */
const status = (over: Partial<Parameters<typeof givenStatus>[0]> = {}) =>
  plain(givenStatus({
    given: { studentUid: 'u1', openUntil: '2026-11-20' },
    closedBy: null,
    enrolled: true,
    session: register('present'),
    grant: null,
    recordingStatus: 'published',
    today: TODAY,
    ...over,
  }));
const plain = (text: string) => text.replace(/\u2011/g, '-');

describe('givenStatus', () => {
  it('keeps each date on one line', () => {
    expect(givenStatus({
      given: { studentUid: 'u1', openUntil: '2026-11-20' },
      closedBy: null,
      enrolled: true,
      session: register('present'),
      grant: null,
      recordingStatus: 'published',
      today: TODAY,
    })).toBe('Open until 2026\u201111\u201120');
  });

  it('says until when it is open, and when it ended', () => {
    expect(status()).toBe('Open until 2026-11-20');
    expect(status({ given: { studentUid: 'u1', openUntil: TODAY } })).toBe(`Open until ${TODAY}`);
    expect(status({ given: { studentUid: 'u1', openUntil: '2026-11-09' } })).toBe('Ended 2026-11-09');
  });

  it('says it is required while it is, and what follows', () => {
    expect(status({ session: register('excused') })).toBe('Required until 2026-11-12, then open until 2026-11-20');
    expect(status({ session: register('excused', '2026-11-25') })).toBe('Required until 2026-11-25');
  });

  it('says why it is closed before anything about dates', () => {
    expect(status({ closedBy: 'recording unpublished' })).toBe('Closed (recording unpublished)');
    expect(status({ closedBy: 'course archived', given: { studentUid: 'u1', openUntil: '2026-11-01' } })).toBe(
      'Closed (course archived)',
    );
    expect(status({ enrolled: false })).toBe('Left the class');
  });
});

describe('giveResult', () => {
  it('never claims a message arrived', () => {
    const opened = giveResult('opened', 'Fatima Ahmed', '2026-11-20', TODAY);
    expect(opened).toBe(
      'Given to Fatima Ahmed until 2026-11-20. It is on their To do under Optional, with a message if their notifications are on.',
    );
    expect(giveResult('reopened', 'Fatima Ahmed', '2026-11-20', TODAY)).toBe(
      'Open again until 2026-11-20. They get a message if their notifications are on.',
    );
    expect(giveResult('moved', 'Fatima Ahmed', '2026-11-20', TODAY)).toBe('Now open until 2026-11-20.');
  });

  it('says a date of today closes at midnight', () => {
    expect(giveResult('moved', 'Fatima Ahmed', TODAY, TODAY)).toBe(`Now open until ${TODAY}. It closes at midnight tonight.`);
  });
});

describe('changedSince', () => {
  it('reads what a colleague left, from the refusal that says so', () => {
    const moved = { code: 'functions/failed-precondition', details: { current: { givenAt: 5, openUntil: '2026-11-27' } } };
    expect(changedSince(moved)).toEqual({ givenAt: 5, openUntil: '2026-11-27' });
    expect(changedSince({ code: 'functions/failed-precondition', details: { current: null } })).toBeNull();
  });

  it('ignores every other refusal, so a plain one never rewrites what the sheet saw', () => {
    expect(changedSince({ code: 'functions/failed-precondition', message: 'Take attendance for this session first.' })).toBeUndefined();
    expect(changedSince({ code: 'functions/permission-denied', details: { current: null } })).toBeUndefined();
    expect(changedSince(new Error('offline'))).toBeUndefined();
  });
});

describe('namesList', () => {
  it('names up to three, then counts the rest', () => {
    expect(namesList(['Aisha'])).toBe('Aisha');
    expect(namesList(['Aisha', 'Omar'])).toBe('Aisha and Omar');
    expect(namesList(['Aisha', 'Omar', 'Zayd'])).toBe('Aisha, Omar and Zayd');
    expect(namesList(['Aisha', 'Omar', 'Zayd', 'Huda'])).toBe('Aisha, Omar, Zayd and 1 other');
    expect(namesList(['Aisha', 'Omar', 'Zayd', 'Huda', 'Bilal'])).toBe('Aisha, Omar, Zayd and 2 others');
  });
});
