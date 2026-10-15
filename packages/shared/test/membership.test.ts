import { describe, it, expect } from 'vitest';
import {
  checkEnrolmentStretches,
  checkStretches,
  closeStretch,
  inClassAt,
  inClassOn,
  inClassWhenDayEnds,
  openStretch,
  recordingsClosedAfter,
  recordingsClosedFromHistory,
  registerExpects,
  stretchesFromHistory,
  timesAway,
  type Stretch,
} from '../src';

const ZONE = 'America/Chicago';
const T = (d: string, hhmm = '12:00') => Date.parse(`${d}T${hhmm}:00-05:00`);
const member = (...stretches: Stretch[]) => ({ stretches });

describe('a student’s time in a class', () => {
  // Joined 09-01, out from 09-15 to 09-29, in since.
  const fatima = member({ from: T('2026-09-01'), to: T('2026-09-15', '10:00') }, { from: T('2026-09-29', '18:00'), to: null });

  it('is in the class inside a stretch and out between them', () => {
    expect(inClassAt(fatima, T('2026-09-10'))).toBe(true);
    expect(inClassAt(fatima, T('2026-09-20'))).toBe(false);
    expect(inClassAt(fatima, T('2026-10-20'))).toBe(true);
    expect(inClassAt(undefined, T('2026-09-10'))).toBe(false);
  });

  it('on a day, for any part of it; when a day ran out, at its last moment', () => {
    // She left on the morning of 09-15: in the class that day, out when it ended.
    expect(inClassOn(fatima, '2026-09-15', ZONE)).toBe(true);
    expect(inClassWhenDayEnds(fatima, '2026-09-15', ZONE)).toBe(false);
    // She came back on the evening of 09-29: in the class when it ended.
    expect(inClassOn(fatima, '2026-09-22', ZONE)).toBe(false);
    expect(inClassWhenDayEnds(fatima, '2026-09-29', ZONE)).toBe(true);
    // Leaving at the very start of a day is not being in the class on it.
    const midnight = member({ from: T('2026-09-01'), to: T('2026-09-15', '00:00') });
    expect(inClassOn(midnight, '2026-09-15', ZONE)).toBe(false);
    expect(inClassWhenDayEnds(midnight, '2026-09-14', ZONE)).toBe(true);
  });

  it('a register expects them when they were in the class on its day and when it was taken', () => {
    expect(registerExpects(fatima, { date: '2026-09-15', attendanceSubmittedAt: T('2026-09-15', '09:00') }, ZONE)).toBe(true);
    // Taken that evening, after she had left: the register could not list her.
    expect(registerExpects(fatima, { date: '2026-09-15', attendanceSubmittedAt: T('2026-09-15', '20:00') }, ZONE)).toBe(false);
    // Not taken: the day alone decides.
    expect(registerExpects(fatima, { date: '2026-09-22', attendanceSubmittedAt: null }, ZONE)).toBe(false);
    expect(registerExpects(fatima, { date: '2026-10-06', attendanceSubmittedAt: null }, ZONE)).toBe(true);
  });

  it('joining and leaving keep every stretch, and say the times away', () => {
    let s: Stretch[] = openStretch([], 1);
    s = closeStretch(s, 5);
    s = openStretch(s, 9);
    expect(s).toEqual([{ from: 1, to: 5 }, { from: 9, to: null }]);
    expect(() => checkEnrolmentStretches({ stretches: s, active: true })).not.toThrow();
    expect(timesAway(fatima, ZONE)).toEqual([{ left: '2026-09-15', back: '2026-09-29' }]);
  });

  it('refuses stretches that tell two stories', () => {
    expect(() => checkEnrolmentStretches({ stretches: [], active: false })).toThrow(/no stretch/);
    expect(() => checkStretches([], true)).toThrow(/no stretch is open/);
    expect(() => checkStretches([{ from: 1, to: null }], false)).toThrow(/a stretch is open, and none should be/);
    expect(() => checkStretches([{ from: 1, to: 5 }], true)).toThrow(/no stretch is open/);
    expect(() => checkStretches([{ from: 1, to: null }, { from: 9, to: null }], true)).toThrow(/is open, and is not the last/);
    expect(() => checkStretches([{ from: 1, to: 9 }, { from: 5, to: null }], true)).toThrow(/before the one before it ended/);
    // A record that was never in the state it keeps has no stretch at all.
    expect(() => checkStretches([], false)).not.toThrow();
  });
});

describe('stretchesFromHistory: the migration from the two dates', () => {
  const row = (at: number, action: string, detail?: Record<string, unknown>) => ({ at, action, ...(detail ? { detail } : {}) });

  it('rebuilds every absence the log holds, not only the last', () => {
    // What the callables left: the first joining, and the last leaving.
    const enrolment = { active: true, enrolledAt: T('2026-08-24'), unenrolledAt: T('2026-10-06') };
    const { stretches, inferred } = stretchesFromHistory(enrolment, [
      row(T('2026-08-24') + 40, 'createEnrollment'),
      row(T('2026-09-15'), 'setEnrollmentActive', { active: false }),
      row(T('2026-09-29'), 'createEnrollment', { reenrolled: true }),
      row(T('2026-10-06') - 30, 'setEnrollmentActive', { active: false }),
      row(T('2026-10-08'), 'setEnrollmentActive', { active: true }),
    ]);
    expect(inferred).toBe(false);
    expect(stretches).toEqual([
      { from: T('2026-08-24'), to: T('2026-09-15') },
      { from: T('2026-09-29'), to: T('2026-10-06') - 30 },
      { from: T('2026-10-08'), to: null },
    ]);
    expect(() => checkEnrolmentStretches({ stretches, active: true })).not.toThrow();
  });

  it('closes at the stored leaving when the log has none: an account deleted leaves no row per class', () => {
    const { stretches, inferred } = stretchesFromHistory({ active: false, enrolledAt: 100, unenrolledAt: 900 }, [row(110, 'createStudent')]);
    expect(stretches).toEqual([{ from: 100, to: 900 }]);
    expect(inferred).toBe(false);
  });

  it('turns an enrolment round on a row written before its direction was recorded, and a repeat within a minute is one tap', () => {
    const { stretches } = stretchesFromHistory({ active: true, enrolledAt: 0, unenrolledAt: 500_000 }, [
      row(100_000, 'setEnrollmentActive'),
      row(100_020, 'setEnrollmentActive'),
      row(300_000, 'setEnrollmentActive'),
      row(500_000, 'setEnrollmentActive', { active: false }),
      row(700_000, 'setEnrollmentActive', { active: true }),
    ]);
    expect(stretches).toEqual([
      { from: 0, to: 100_000 },
      { from: 300_000, to: 500_000 },
      { from: 700_000, to: null },
    ]);
  });

  it('says when the log and the stored fields disagree, and the fields win', () => {
    // Active, but the log's last row is a leaving: the return was never logged.
    const back = stretchesFromHistory({ active: true, enrolledAt: 0, unenrolledAt: 500 }, [row(500, 'setEnrollmentActive', { active: false })]);
    expect(back).toEqual({ stretches: [{ from: 0, to: null }], inferred: true });
    // Out of the class since 500, but the log has a return after it.
    const out = stretchesFromHistory({ active: false, enrolledAt: 0, unenrolledAt: 500 }, [
      row(500, 'setEnrollmentActive', { active: false }),
      row(200_000, 'createEnrollment', { reenrolled: true }),
    ]);
    expect(out).toEqual({ stretches: [{ from: 0, to: 500 }], inferred: true });
  });
});

describe('a class’s recordings closed to its students', () => {
  const running = { effectiveActive: true, archivedAccess: false, recordingsClosed: [] };

  it('a stretch opens when they can no longer be played and closes when they can again, and nothing else moves it', () => {
    const shut = recordingsClosedAfter(running, { effectiveActive: false, archivedAccess: false }, 10);
    expect(shut).toEqual([{ from: 10, to: null }]);
    // Archived with listening kept on: still playable, nothing opens.
    expect(recordingsClosedAfter(running, { effectiveActive: false, archivedAccess: true }, 10)).toEqual([]);
    // Listening turned on in the archive: the stretch closes.
    const archived = { effectiveActive: false, archivedAccess: false, recordingsClosed: shut };
    expect(recordingsClosedAfter(archived, { effectiveActive: false, archivedAccess: true }, 20)).toEqual([{ from: 10, to: 20 }]);
    // A rename, or another archive of an archived class, changes nothing.
    expect(recordingsClosedAfter(archived, { effectiveActive: false, archivedAccess: false }, 30)).toEqual(shut);
  });

  const row = (at: number, action: string, detail?: Record<string, unknown>) => ({ at, action, ...(detail ? { detail } : {}) });
  const stored = (o: { effectiveActive: boolean; archivedAccess: boolean; cohortArchived?: boolean }) => ({ createdAt: 0, cohortArchived: false, ...o });

  it('rebuilds every archive the log holds, by the class and by its cohort', () => {
    const { recordingsClosed, inferred } = recordingsClosedFromHistory(stored({ effectiveActive: false, archivedAccess: false, cohortArchived: true }), [
      row(100, 'updateCourse', { archived: true }),
      row(200, 'updateCourse', { archivedAccess: true }),
      row(300, 'updateCourse', { name: 'Renamed' }),
      row(400, 'updateCourse', { archived: false }),
      row(500, 'setCohortArchived', { archived: true }),
      row(600, 'updateCourse', { archivedAccess: false }),
    ]);
    expect(inferred).toBe(false);
    // Closed 100–200 (archived, access off); open while access was on, and
    // after the class came back; the cohort's archive with access still on
    // closed nothing, and turning access off then did.
    expect(recordingsClosed).toEqual([{ from: 100, to: 200 }, { from: 600, to: null }]);
    expect(() => checkStretches(recordingsClosed, true)).not.toThrow();
  });

  it('a class made inside an archived cohort was closed from its making', () => {
    expect(recordingsClosedFromHistory(stored({ effectiveActive: false, archivedAccess: false, cohortArchived: true }), [])).toEqual({
      recordingsClosed: [{ from: 0, to: null }],
      inferred: false,
    });
    // …unless the cohort's own rows say it was running then.
    expect(recordingsClosedFromHistory(stored({ effectiveActive: false, archivedAccess: false, cohortArchived: true }), [row(50, 'setCohortArchived', { archived: true })]).recordingsClosed).toEqual([
      { from: 50, to: null },
    ]);
  });

  it('when the log does not arrive at what is stored, what is stored wins, at the last row, and says so', () => {
    // Archived, but by a row written before the detail was recorded.
    expect(recordingsClosedFromHistory(stored({ effectiveActive: false, archivedAccess: false }), [row(100, 'updateCourse')])).toEqual({
      recordingsClosed: [{ from: 100, to: null }],
      inferred: true,
    });
  });
});
