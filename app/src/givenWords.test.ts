import { describe, expect, it } from 'vitest';
import type { RegisterFacts } from '@sabeel/shared';
import { changedSince, giveResult as result, givenOpen, givenStatus, namesList, whoLosesIt } from './givenWords';

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
    accountActive: true,
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
      accountActive: true,
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
    expect(status({ accountActive: false })).toBe('Account not active');
  });
});

describe('giveResult', () => {
  const giveResult = (...args: Parameters<typeof result>) => plain(result(...args));
  it('keeps each date on one line', () => {
    for (const outcome of ['opened', 'moved', 'reopened', 'unchanged'] as const) {
      expect(result(outcome, 'Fatima Ahmed', '2026-11-20', TODAY)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
  it('never claims a message arrived', () => {
    const opened = giveResult('opened', 'Fatima Ahmed', '2026-11-20', TODAY);
    expect(opened).toBe(
      'Given to Fatima Ahmed until 2026-11-20. It is on their To do under Optional, with a message if their notifications are on.',
    );
    expect(giveResult('reopened', 'Fatima Ahmed', '2026-11-20', TODAY)).toBe(
      'Open again until 2026-11-20. They get a message if their notifications are on.',
    );
    expect(giveResult('moved', 'Fatima Ahmed', '2026-11-20', TODAY)).toBe('Now open until 2026-11-20.');
    // Given again the same day: the day's one message has gone, and no other is promised.
    expect(giveResult('opened', 'Fatima Ahmed', '2026-11-20', TODAY, true)).toBe(
      'Given to Fatima Ahmed until 2026-11-20. It is on their To do under Optional. No message this time: they get one a day at most, and today\'s has gone.',
    );
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

describe('whoLosesIt', () => {
  const session = { attendanceSubmittedAt: 1, attendance: { u1: 'excused' as const }, dueDate: '2026-11-20', recordingId: 'r1' };
  const loaded = {
    roster: [{ studentUid: 'u1', active: true }],
    students: [{ uid: 'u1', displayName: 'Aisha', status: 'active' }],
    given: new Map(),
    cls: { effectiveActive: true, archivedAccess: false },
    today: TODAY,
  };
  const published = { value: { id: 'r1', courseId: 'c1', status: 'published' }, resolved: true };

  it('waits while the session’s recording is still arriving, rather than deciding nothing closes', () => {
    expect(whoLosesIt({ session, recording: { value: null, resolved: false }, ...loaded })).toBeNull();
  });

  it('waits for the roster, the accounts and the given recordings', () => {
    expect(whoLosesIt({ session, recording: published, ...loaded, roster: null })).toBeNull();
    expect(whoLosesIt({ session, recording: published, ...loaded, students: null })).toBeNull();
    expect(whoLosesIt({ session, recording: published, ...loaded, given: null })).toBeNull();
  });

  it('closes nothing for a session with no recording, or one gone', () => {
    expect(whoLosesIt({ session: { ...session, recordingId: null }, recording: { value: null, resolved: false }, ...loaded })?.closes()).toEqual([]);
    expect(whoLosesIt({ session, recording: { value: null, resolved: true }, ...loaded })?.closes()).toEqual([]);
  });

  it('names who a correction would close it to', () => {
    const who = whoLosesIt({ session, recording: published, ...loaded });
    expect(who?.closes({ u1: 'present' }).map((uid) => who.nameOf(uid))).toEqual(['Aisha']);
  });
});

describe('givenOpen', () => {
  const facts = { given: { studentUid: 'u1', openUntil: '2026-11-20' }, closedBy: null, enrolled: true, accountActive: true, today: TODAY };
  it('is open only while the row would say so', () => {
    expect(givenOpen(facts)).toBe(true);
    // Each of these, the row says something other than "Open until", so the
    // note on their other row must not say "given until".
    expect(givenOpen({ ...facts, enrolled: false })).toBe(false);
    expect(givenOpen({ ...facts, accountActive: false })).toBe(false);
    expect(givenOpen({ ...facts, closedBy: 'recording unpublished' })).toBe(false);
    expect(givenOpen({ ...facts, given: { studentUid: 'u1', openUntil: '2026-11-09' } })).toBe(false);
  });
});
