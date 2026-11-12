import { describe, expect, it } from 'vitest';
import {
  completionShown,
  giveAction,
  givenChanged,
  giveRefusal,
  givenRecordingId,
  isCalendarDate,
  lastRequiredDayMessage,
  listenWindow,
  NOTIFICATION_DESCRIPTION,
  recordingGivenMessage,
  recordingRequiredMessage,
  requiredUntil,
  windowLastDay,
  type RegisterFacts,
} from '../src';

/**
 * A recording given to one student: open until a date, required by nothing.
 * These are the decisions every surface reads — the callable, the sheet, the
 * player, the docked bar, To do and `getPlaybackUrl` — so the promises are
 * asserted here, at the boundaries, and the surfaces only wire them.
 */

const TODAY = '2026-11-10';
const YESTERDAY = '2026-11-09';
const TOMORROW = '2026-11-11';

const submitted = (marks: RegisterFacts['attendance'], dueDate = TOMORROW): RegisterFacts => ({
  attendanceSubmittedAt: 1,
  attendance: marks,
  dueDate,
});
const untaken: RegisterFacts = { attendanceSubmittedAt: null, attendance: {}, dueDate: TOMORROW };
const open = { effectiveActive: true, archivedAccess: false };

describe('givenRecordingId', () => {
  it('is one per student per recording', () => {
    expect(givenRecordingId('stu', 'rec')).toBe('stu_rec');
  });
});

describe('isCalendarDate', () => {
  it('takes a date that exists and nothing else', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-99-99')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
  });
});

describe('requiredUntil', () => {
  const facts = (over: Partial<Parameters<typeof requiredUntil>[1]> = {}) => ({
    session: submitted({ u1: 'excused' }),
    grant: null,
    enrolled: true,
    recordingStatus: 'published',
    today: TODAY,
    ...over,
  });

  it('is the grant date while an active grant is in date', () => {
    expect(requiredUntil('u1', facts({ grant: { active: true, dueDate: TOMORROW } }))).toBe(TOMORROW);
    expect(requiredUntil('u1', facts({ grant: { active: true, dueDate: TODAY } }))).toBe(TODAY);
  });

  it('is read from the session in the seconds before the grant is written', () => {
    // The register gap: submitted, excused, no grant yet. A grant-only check
    // let a teacher give a recording the register had just made required.
    expect(requiredUntil('u1', facts())).toBe(TOMORROW);
  });

  it('is nothing once the date has passed, whether from the grant or the session', () => {
    expect(requiredUntil('u1', facts({ grant: { active: true, dueDate: YESTERDAY }, session: submitted({ u1: 'excused' }, YESTERDAY) }))).toBeNull();
  });

  it('is nothing for a student not excused, a register not submitted, a draft, or a student who left', () => {
    expect(requiredUntil('u1', facts({ session: submitted({ u1: 'present' }) }))).toBeNull();
    expect(requiredUntil('u1', facts({ session: { ...untaken, attendance: { u1: 'excused' } } }))).toBeNull();
    expect(requiredUntil('u1', facts({ recordingStatus: 'unpublished' }))).toBeNull();
    expect(requiredUntil('u1', facts({ enrolled: false }))).toBeNull();
    expect(requiredUntil('u1', facts({ grant: { active: false, dueDate: TOMORROW }, session: submitted({ u1: 'present' }) }))).toBeNull();
  });
});

describe('giveAction', () => {
  it('gives, moves an open one, and reopens an ended one', () => {
    expect(giveAction(null, TODAY)).toBe('give');
    expect(giveAction({ openUntil: TODAY }, TODAY)).toBe('move');
    expect(giveAction({ openUntil: YESTERDAY }, TODAY)).toBe('reopen');
  });
});

describe('giveRefusal', () => {
  const ask = (over: Partial<Parameters<typeof giveRefusal>[0]> = {}) =>
    giveRefusal({
      studentUid: 'u1',
      openUntil: TOMORROW,
      today: TODAY,
      session: submitted({ u1: 'present' }),
      recordingStatus: 'published',
      cls: open,
      enrolled: true,
      grant: null,
      given: null,
      fromPlus: true,
      ...over,
    });

  it('gives a present student a date today or later', () => {
    expect(ask()).toBeNull();
    expect(ask({ openUntil: TODAY })).toBeNull();
    expect(ask({ openUntil: '2027-06-01' })).toBeNull();
  });

  it('gives an absent student, an unmarked one, and an excused one whose date has passed', () => {
    expect(ask({ session: submitted({ u1: 'absent' }) })).toBeNull();
    expect(ask({ session: submitted({}) })).toBeNull();
    expect(ask({ session: submitted({ u1: 'excused' }, YESTERDAY), grant: { active: true, dueDate: YESTERDAY } })).toBeNull();
  });

  it('says what stands in the way, one sentence each', () => {
    expect(ask({ session: untaken })).toBe('Take attendance for this session first.');
    expect(ask({ recordingStatus: 'draft' })).toBe('Only a published recording can be given.');
    expect(ask({ cls: { effectiveActive: false, archivedAccess: false } })).toBe('This class is archived and its recordings are closed.');
    expect(ask({ enrolled: false })).toBe('That student is not in this class.');
    expect(ask({ openUntil: null })).toBe('Choose the last day it stays open.');
    expect(ask({ openUntil: '2026-02-30' })).toBe('Choose the last day it stays open.');
    expect(ask({ openUntil: YESTERDAY })).toBe('That date has passed. Choose today or a later day.');
    expect(ask({ given: { openUntil: TOMORROW } })).toBe('It has already been given to them. Change it from their row.');
  });

  it('lets an archived class that kept listening on be given from', () => {
    expect(ask({ cls: { effectiveActive: false, archivedAccess: true } })).toBeNull();
  });

  it('refuses a student who is required right now, including in the register gap', () => {
    const sentence = `It is required for them until ${TOMORROW}. It can be given after that.`;
    expect(ask({ grant: { active: true, dueDate: TOMORROW }, session: submitted({ u1: 'excused' }) })).toBe(sentence);
    expect(ask({ session: submitted({ u1: 'excused' }) })).toBe(sentence);
  });

  it('refuses reopening while required, and never moving an open one', () => {
    const required = { grant: { active: true, dueDate: TOMORROW }, session: submitted({ u1: 'excused' }), fromPlus: false };
    expect(ask({ ...required, given: { openUntil: YESTERDAY } })).toBe(`It is required for them until ${TOMORROW}. It can be given after that.`);
    expect(ask({ ...required, given: { openUntil: TODAY }, openUntil: '2026-11-20' })).toBeNull();
  });

  it('moves an open one earlier or later, from its own row', () => {
    expect(ask({ given: { openUntil: '2026-11-20' }, openUntil: TODAY, fromPlus: false })).toBeNull();
    expect(ask({ given: { openUntil: '2026-11-20' }, openUntil: '2026-12-20', fromPlus: false })).toBeNull();
  });
});

describe('givenChanged', () => {
  const seen = { givenAt: 100, openUntil: '2026-11-20' };

  it('is silent when the record is as the caller saw it, or the caller expected none', () => {
    expect(givenChanged(seen, { ...seen }, 'save')).toBeNull();
    expect(givenChanged(seen, { ...seen }, 'takeBack')).toBeNull();
    expect(givenChanged(null, null, 'save')).toBeNull();
    expect(givenChanged(null, seen, 'save')).toBeNull();
  });

  it('names the new date when a colleague moved it or gave it again since', () => {
    const moved = 'Someone else changed the date to 2026-11-27 just now. Save again to use yours.';
    expect(givenChanged(seen, { givenAt: 100, openUntil: '2026-11-27' }, 'save')).toBe(moved);
    expect(givenChanged(seen, { givenAt: 200, openUntil: '2026-11-27' }, 'save')).toBe(moved);
    // Taken back and given again to the same date is still a change: the
    // caller's sheet was about an opening that no longer exists.
    expect(givenChanged(seen, { givenAt: 200, openUntil: '2026-11-20' }, 'save')).toBe(
      'Someone else changed the date to 2026-11-20 just now. Save again to use yours.',
    );
  });

  it('asks a take back after a colleague moved the date to be made again, on purpose', () => {
    expect(givenChanged(seen, { givenAt: 100, openUntil: '2026-11-27' }, 'takeBack')).toBe(
      'Someone else changed the date to 2026-11-27 just now. Take back again to take it back anyway.',
    );
  });

  it('says it was taken back to a save, and lets a take back of one already gone through', () => {
    expect(givenChanged(seen, null, 'save')).toBe('Someone else took it back just now. Give it again with the plus if they still need it.');
    expect(givenChanged(seen, null, 'takeBack')).toBeNull();
  });
});

describe('listenWindow', () => {
  const grant = (dueDate: string, active = true) => ({ active, dueDate });
  const given = (openUntil: string) => ({ openUntil });

  it('is required while an excused grant is in date', () => {
    expect(listenWindow(grant(TOMORROW), null, true, TODAY)).toEqual({ state: 'open', required: true, until: TOMORROW, then: null });
    expect(listenWindow(grant(TODAY), null, true, TODAY)).toEqual({ state: 'open', required: true, until: TODAY, then: null });
  });

  it('carries a later given date as what follows the requirement', () => {
    expect(listenWindow(grant(TOMORROW), given('2026-11-20'), true, TODAY)).toEqual({
      state: 'open',
      required: true,
      until: TOMORROW,
      then: '2026-11-20',
    });
    // An earlier or equal given date adds nothing.
    expect(listenWindow(grant(TOMORROW), given(TODAY), true, TODAY)).toEqual({ state: 'open', required: true, until: TOMORROW, then: null });
  });

  it('is optional under a given recording, through the whole of its last day', () => {
    expect(listenWindow(null, given(TODAY), true, TODAY)).toEqual({ state: 'open', required: false, until: TODAY, listenByWas: null });
  });

  it('remembers the listen-by date a student missed, so their record is not mistaken for open', () => {
    expect(listenWindow(grant(YESTERDAY), given(TOMORROW), true, TODAY)).toEqual({
      state: 'open',
      required: false,
      until: TOMORROW,
      listenByWas: YESTERDAY,
    });
  });

  it('ignores a grant corrected away and a given recording of a student who left', () => {
    expect(listenWindow(grant(TOMORROW, false), given(TOMORROW), true, TODAY)).toEqual({
      state: 'open',
      required: false,
      until: TOMORROW,
      listenByWas: null,
    });
    expect(listenWindow(null, given(TOMORROW), false, TODAY)).toEqual({ state: 'none' });
    expect(listenWindow(grant(TOMORROW, false), null, true, TODAY)).toEqual({ state: 'none' });
  });

  it('ends on the LATER of the dates held, so the last midnight closes on the right day', () => {
    // Excused until the 5th, given until the 9th: it closes after the 9th.
    expect(listenWindow(grant('2026-11-05'), given(YESTERDAY), true, TODAY)).toEqual({ state: 'ended', lastDay: YESTERDAY, record: true });
    // Given until the 5th, excused until the 9th.
    expect(listenWindow(grant(YESTERDAY), given('2026-11-05'), true, TODAY)).toEqual({ state: 'ended', lastDay: YESTERDAY, record: true });
    expect(listenWindow(null, given(YESTERDAY), true, TODAY)).toEqual({ state: 'ended', lastDay: YESTERDAY, record: false });
    expect(listenWindow(grant(YESTERDAY), null, true, TODAY)).toEqual({ state: 'ended', lastDay: YESTERDAY, record: true });
  });

  it('is nothing with nothing held', () => {
    expect(listenWindow(null, null, true, TODAY)).toEqual({ state: 'none' });
  });
});

describe('windowLastDay', () => {
  it('is the day whose midnight closes it', () => {
    expect(windowLastDay({ state: 'open', required: true, until: TODAY, then: null })).toBe(TODAY);
    expect(windowLastDay({ state: 'open', required: true, until: TODAY, then: '2026-11-20' })).toBe('2026-11-20');
    expect(windowLastDay({ state: 'open', required: false, until: TOMORROW, listenByWas: YESTERDAY })).toBe(TOMORROW);
    expect(windowLastDay({ state: 'ended', lastDay: YESTERDAY, record: false })).toBe(YESTERDAY);
    expect(windowLastDay({ state: 'none' })).toBeNull();
  });
});

describe('completionShown', () => {
  it('offers Mark complete only while listening is required and open', () => {
    expect(completionShown({ state: 'open', required: true, until: TODAY, then: null })).toBe(true);
    expect(completionShown({ state: 'open', required: false, until: TODAY, listenByWas: null })).toBe(false);
    // Missed, then given: a miss stands, so there is nothing to mark.
    expect(completionShown({ state: 'open', required: false, until: TODAY, listenByWas: YESTERDAY })).toBe(false);
    expect(completionShown({ state: 'ended', lastDay: YESTERDAY, record: true })).toBe(false);
    expect(completionShown({ state: 'none' })).toBe(false);
  });
});

describe('the messages', () => {
  it('tells a given student it is open and not required', () => {
    expect(recordingGivenMessage('Hikam', 'Session 3', '2026-11-20', 'r1')).toEqual({
      title: 'Hikam: a recording is ready',
      body: 'Session 3 is open to you until 2026-11-20. It is not required.',
      path: 'play/r1',
    });
  });

  it('tells a student who held it given that excusing them made it required', () => {
    expect(recordingRequiredMessage('Hikam', 'Session 3', '2026-11-12', 'r1').body).toBe(
      'Session 3 — you were excused, so it is now required by 2026-11-12.',
    );
  });

  it('never says a recording closes today when it stays open after', () => {
    const m = lastRequiredDayMessage('Hikam', 'Session 3', '2026-11-20', 'r1');
    expect(m.title).toBe('Hikam: last day for a required recording');
    expect(m.body).toBe('Session 3 is required by the end of today. It stays open to you until 2026-11-20.');
    expect(`${m.title} ${m.body}`).not.toMatch(/closes/);
  });

  it('settings say the message covers a given recording, and the reminder the listen-by date', () => {
    expect(NOTIFICATION_DESCRIPTION.recordingReady).toBe(
      'When a recording is opened to you, because you were excused or your teacher gave it to you.',
    );
    expect(NOTIFICATION_DESCRIPTION.lastDay).toBe("On the morning of a recording's listen-by date, if you have not finished it.");
  });
});
