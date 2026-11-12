import { describe, expect, it } from 'vitest';
import type { ListenWindow } from '@sabeel/shared';
import { closedSentence, dateLine, markShown, playsOn, recordShown, requiredPlaysOn } from './listening';

/**
 * What a student's player and docked bar do in each state of their window,
 * and in the two states nobody had listed: playing on past the midnight that
 * closed it, and a class archived while the date is still ahead.
 */

const D = '2026-11-10';
const D5 = '2026-11-15';
/** A moment on day D in the institute's zone (Chicago, UTC-6 in November). */
const at = (iso: string) => Date.parse(iso);
const before = at('2026-11-10T23:30:00-06:00');
const after = at('2026-11-11T00:10:00-06:00');
const excusedEnded: ListenWindow = { state: 'ended', lastDay: D, record: true };
const givenEnded: ListenWindow = { state: 'ended', lastDay: D, record: false };
const excused = { grant: { active: true, dueDate: D } };

describe('playsOn', () => {
  it('plays on past the midnight that closed it, when it was playing since before', () => {
    expect(playsOn(excusedEnded, D, before)).toBe(true);
    expect(playsOn(givenEnded, D, before)).toBe(true);
  });

  it('does not start again after that midnight', () => {
    expect(playsOn(excusedEnded, D, after)).toBe(false);
    expect(playsOn(excusedEnded, D, null)).toBe(false);
  });

  it('stops at once when the window closed because its last day shrank: a given date taken back', () => {
    // Given until D+5, excused until D: played on through D's midnight under
    // the given date, then taken back. The ended window's last day is D, but
    // it was D+5 while open: staff took it away.
    expect(playsOn(excusedEnded, D5, before)).toBe(false);
  });

  it('never plays on an open window or none', () => {
    expect(playsOn({ state: 'none' }, D, before)).toBe(false);
    expect(playsOn({ state: 'open', required: true, until: D, then: null }, D, before)).toBe(false);
  });
});

describe('requiredPlaysOn', () => {
  it('holds while an excused recording plays on from before its excused midnight', () => {
    expect(requiredPlaysOn(excused, true, before)).toBe(true);
  });

  it('ends when it stops, or when it started after that midnight, or with no grant', () => {
    expect(requiredPlaysOn(excused, false, null)).toBe(false);
    expect(requiredPlaysOn(excused, true, after)).toBe(false);
    expect(requiredPlaysOn({ grant: null }, true, before)).toBe(false);
    expect(requiredPlaysOn({ grant: { active: false, dueDate: D } }, true, before)).toBe(false);
  });
});

describe('markShown', () => {
  const stillRequired = requiredPlaysOn(excused, true, before);
  it('offers Mark complete while required, and through a play-on past the excused midnight', () => {
    expect(markShown({ state: 'open', required: true, until: D, then: null }, false)).toBe(true);
    // An excused recording finishing after midnight is still the excused one:
    // never "optional, nothing to mark".
    expect(markShown(excusedEnded, stillRequired)).toBe(true);
  });

  it('keeps it through that play-on when a later given date keeps the window open', () => {
    // Excused until D, given until D5, playing at D's midnight: the window
    // turns open and optional, and the file being finished is still required.
    expect(markShown({ state: 'open', required: false, until: D5, listenByWas: D }, stillRequired)).toBe(true);
  });

  it('does not offer it for a given recording, a missed one given again, or once stopped', () => {
    expect(markShown({ state: 'open', required: false, until: D5, listenByWas: null }, requiredPlaysOn(null, true, before))).toBe(false);
    // Missed, given again, played after the excused date had gone.
    expect(markShown({ state: 'open', required: false, until: D5, listenByWas: D }, requiredPlaysOn(excused, true, after))).toBe(false);
    expect(markShown(givenEnded, requiredPlaysOn({ grant: null }, true, before))).toBe(false);
    // Missed, given until D5, finishing at D5's midnight: the given date closed it.
    const onD5 = at('2026-11-15T23:30:00-06:00');
    expect(markShown({ state: 'ended', lastDay: D5, record: true }, requiredPlaysOn(excused, true, onD5))).toBe(false);
    expect(markShown(excusedEnded, requiredPlaysOn(excused, false, null))).toBe(false);
  });
});

describe('recordShown', () => {
  it('shows the record whenever the student holds an excused grant, whatever closed it', () => {
    expect(recordShown(excused)).toBe(true);
  });

  it('shows none to a student only given it', () => {
    expect(recordShown({ grant: null })).toBe(false);
    expect(recordShown({ grant: { active: false, dueDate: D } })).toBe(false);
  });
});

describe('closedSentence', () => {
  it('says the class closed, and keeps "your record" for the excused alone', () => {
    expect(closedSentence(false, { state: 'open', required: true, until: D5, then: null }, { grant: { active: true, dueDate: D5 } })).toMatch(
      /Your record is kept/,
    );
    expect(closedSentence(false, { state: 'open', required: false, until: D5, listenByWas: null }, { grant: null })).not.toMatch(/Your record/);
  });

  it('names the date that closed it, in the words for what was held', () => {
    expect(closedSentence(true, excusedEnded, excused)).toBe(`This recording closed on ${D}. Your record is kept — ask your teacher if you need it reopened.`);
    expect(closedSentence(true, givenEnded, { grant: null })).toBe(`This recording was open to you until ${D}. Ask your teacher if you need it again.`);
    expect(closedSentence(true, { state: 'none' }, null)).toBe('This recording is not open to you. Ask your teacher if you need it.');
  });
});

describe('dateLine', () => {
  const plain = (s: string | null) => s?.replace(/\u2011/g, '-').replace(/\u00A0/g, ' ') ?? null;
  it('gives staff the due date, and a student until when it is open', () => {
    expect(plain(dateLine(null, null, D, 'Listen'))).toBe(`due ${D}`);
    expect(plain(dateLine('s', { state: 'open', required: false, until: D5, listenByWas: null }, null, 'Listen'))).toBe(`open until ${D5}`);
    expect(plain(dateLine('s', { state: 'open', required: true, until: D, then: D5 }, null, 'Watch'))).toBe(`watch by ${D} · open until ${D5}`);
    expect(dateLine('s', excusedEnded, null, 'Listen')).toBeNull();
  });
});
