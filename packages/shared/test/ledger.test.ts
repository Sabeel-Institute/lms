import { describe, it, expect } from 'vitest';
import {
  accountableUids,
  attendanceGroups,
  attendanceReport,
  effectiveCompletion,
  grantOutcome,
  rollup,
  type AttendanceStatus,
} from '../src';

describe('attendanceReport', () => {
  const ZONE = 'America/Chicago';
  const T = (d: string, hhmm = '12:00') => Date.parse(`${d}T${hhmm}:00-05:00`);
  /** A session on `date`, its register taken that evening unless `submitted` is false. */
  const mkSession = (id: string, date: string, attendance: Record<string, AttendanceStatus>, submitted = true) => ({
    id,
    title: id,
    date,
    attendance,
    attendanceSubmittedAt: submitted ? T(date, '20:00') : null,
  });
  /** An enrolment: joined, then left and came back as the days alternate. */
  const enrolled = (studentUid: string, ...days: string[]) => ({
    studentUid,
    active: days.length % 2 === 1,
    stretches: days.flatMap((d, i) => (i % 2 === 0 ? [{ from: T(d, '09:00'), to: days[i + 1] ? T(days[i + 1], '09:00') : null }] : [])),
  });

  const report = () =>
    attendanceReport({
      sessions: [
        mkSession('s1', '2026-07-06', { a: 'present', b: 'absent', c: 'excused' }),
        mkSession('s2', '2026-07-08', { a: 'absent', b: 'present' }), // c in the class, left off
        mkSession('s3', '2026-07-10', { a: 'present', b: 'present', c: 'present' }, false), // not taken
      ],
      enrollments: [enrolled('a', '2026-07-01'), enrolled('b', '2026-07-01'), enrolled('c', '2026-07-01')],
      assignments: [
        { studentUid: 'a', completed: false, dueDate: '2026-07-01' }, // missed
        { studentUid: 'b', completed: true, dueDate: '2026-07-01' }, // done
        { studentUid: 'c', completed: false, dueDate: '2026-08-01' }, // still open
      ],
      today: '2026-07-15',
      timeZone: ZONE,
    });

  it('per-session counts, and marks the un-taken session', () => {
    const r = report();
    expect(r.totalSessions).toBe(3);
    expect(r.sessionsWithAttendance).toBe(2);
    expect(r.sessions[0]).toMatchObject({ sessionId: 's1', submitted: true, present: 1, absent: 1, excused: 1 });
    expect(r.sessions[2]).toMatchObject({ sessionId: 's3', submitted: false, present: 0, absent: 0, excused: 0 });
  });

  it('per-student tallies over SUBMITTED sessions only, with a register that left them off as not marked', () => {
    const r = report();
    const a = r.students.find((s) => s.studentUid === 'a')!;
    expect(a).toMatchObject({ present: 1, absent: 1, excused: 0, notMarked: 0 });
    const c = r.students.find((s) => s.studentUid === 'c')!;
    // c was excused in s1 and left off s2's register while in the class; s3 untaken doesn't count.
    expect(c).toMatchObject({ present: 0, absent: 0, excused: 1, notMarked: 1 });
  });

  /*
   * "NOT MARKED" IS A MARK STAFF COULD HAVE GIVEN. A register taken before a
   * newcomer joined, after a student left, or while they were away could not
   * list them; counting those told a teacher to fix registers that are right,
   * and disagreed with the course workbook, which says '—' for the same
   * sessions.
   */
  it('counts as not marked only registers taken while the student was in the class', () => {
    const r = attendanceReport({
      sessions: [
        mkSession('s1', '2026-07-06', { a: 'present', gone: 'present' }),
        mkSession('s2', '2026-07-08', { a: 'present' }), // gone is out of the class
        mkSession('s3', '2026-07-13', { a: 'present', gone: 'absent' }), // newcomer not yet in
      ],
      enrollments: [
        enrolled('a', '2026-07-01'),
        enrolled('gone', '2026-07-01', '2026-07-07', '2026-07-12', '2026-07-14'),
        enrolled('newcomer', '2026-07-14'),
      ],
      assignments: [],
      today: '2026-07-15',
      timeZone: ZONE,
    });
    expect(r.students.find((s) => s.studentUid === 'gone')).toMatchObject({ present: 1, absent: 1, notMarked: 0, departed: true });
    expect(r.students.find((s) => s.studentUid === 'newcomer')).toMatchObject({ notMarked: 0, departed: false });
  });

  it('flags nobody as departed when everyone marked is still enrolled', () => {
    expect(report().students.every((s) => s.departed === false)).toBe(true);
  });

  /*
   * A STUDENT WHO LEFT MID-TERM IS STILL IN THE REGISTER.
   *
   * Unenrolling keeps their marks — "an attendance record is what happened on
   * the day and outlives the enrolment" — so every session's counts go on
   * including them. Listing the active roster alone meant the two halves of one
   * report stopped reconciling: a manager reading "3 present" on a session and
   * counting two rows underneath had nothing on screen to explain the third, and
   * the person who withdrew had no record at all in the only view that says what
   * each student did.
   *
   * THE TEST IS THE RECONCILIATION, not the presence of a row: the sum of the
   * per-student marks equals the sum of the per-session marks. That is the
   * promise, and it is what an alternative fix — dropping them from the session
   * counts too — would also have to satisfy.
   */
  it('keeps a departed student, flagged, so the two halves of the report agree', () => {
    const r = attendanceReport({
      sessions: [
        mkSession('s1', '2026-07-06', { a: 'present', gone: 'excused' }),
        mkSession('s2', '2026-07-08', { a: 'absent', gone: 'absent' }),
      ],
      // `gone` was unenrolled after both registers were submitted.
      enrollments: [enrolled('a', '2026-07-01'), enrolled('gone', '2026-07-01', '2026-07-10')],
      assignments: [],
      today: '2026-07-15',
      timeZone: ZONE,
    });

    const departed = r.students.find((s) => s.studentUid === 'gone');
    expect(departed).toMatchObject({ departed: true, present: 0, absent: 1, excused: 1, notMarked: 0 });
    expect(r.students.find((s) => s.studentUid === 'a')).toMatchObject({ departed: false });

    const marksByStudent = r.students.reduce((n, s) => n + s.present + s.absent + s.excused, 0);
    const marksBySession = r.sessions.reduce((n, s) => n + s.present + s.absent + s.excused, 0);
    expect(marksByStudent).toBe(marksBySession);
    expect(marksBySession).toBe(4);
  });

  it('does not resurrect someone marked only in a register that was never submitted', () => {
    const r = attendanceReport({
      sessions: [mkSession('s1', '2026-07-06', { a: 'present', ghost: 'present' }, false)],
      enrollments: [enrolled('a', '2026-07-01')],
      assignments: [],
      today: '2026-07-15',
      timeZone: ZONE,
    });
    // An un-taken register counts nobody, so it names nobody either.
    expect(r.students.map((s) => s.studentUid)).toEqual(['a']);
  });
});

describe('attendance split', () => {
  const roster: Record<string, AttendanceStatus> = {
    a: 'present',
    b: 'absent',
    c: 'excused',
    d: 'present',
    e: 'absent',
  };

  it('granted = excused alone; present and absent get nothing', () => {
    expect(accountableUids(roster).sort()).toEqual(['c']);
  });

  it('groups the roster into present / absent / excused', () => {
    expect(attendanceGroups(roster)).toEqual({
      present: ['a', 'd'],
      absent: ['b', 'e'],
      excused: ['c'],
    });
  });

  it('an empty roster yields empty groups and grants nobody', () => {
    expect(attendanceGroups({})).toEqual({ present: [], absent: [], excused: [] });
    expect(accountableUids({})).toEqual([]);
  });
});

describe('effectiveCompletion', () => {
  it('an override wins over the student attestation, and carries its reason', () => {
    expect(effectiveCompletion({ completed: false }, { completed: true, reason: 'attended live' })).toEqual({
      completed: true,
      source: 'override',
      reason: 'attended live',
    });
    // Override can also FORCE not-complete over a student's self-mark.
    expect(effectiveCompletion({ completed: true }, { completed: false, reason: 'did not actually listen' })).toEqual({
      completed: false,
      source: 'override',
      reason: 'did not actually listen',
    });
  });

  it('falls back to the student completion when there is no override', () => {
    expect(effectiveCompletion({ completed: true }, null)).toEqual({ completed: true, source: 'student' });
  });

  it('is not-complete when neither exists', () => {
    expect(effectiveCompletion(null, null)).toEqual({ completed: false, source: 'none' });
  });
});

describe('rollup', () => {
  const TODAY = '2026-07-25';
  it('counts complete / incomplete / missed with missed ⊂ incomplete', () => {
    const items = [
      { completed: true, dueDate: '2020-01-01' }, // complete (never missed though past)
      { completed: false, dueDate: '2026-07-24' }, // missed
      { completed: false, dueDate: '2026-07-30' }, // incomplete, still open
    ];
    expect(rollup(items, TODAY)).toEqual({ total: 3, complete: 1, incomplete: 2, missed: 1 });
  });

  it('a completed item is never missed, however far past due', () => {
    expect(rollup([{ completed: true, dueDate: '2000-01-01' }], TODAY)).toEqual({
      total: 1,
      complete: 1,
      incomplete: 0,
      missed: 0,
    });
  });

  it('due today is not yet missed', () => {
    expect(rollup([{ completed: false, dueDate: '2026-07-25' }], TODAY).missed).toBe(0);
  });

  it('empties to zeros', () => {
    expect(rollup([], TODAY)).toEqual({ total: 0, complete: 0, incomplete: 0, missed: 0 });
  });
});

/*
 * WHAT A STAFF LEDGER ROW SAYS about a grant nobody has finished. "Not
 * complete" and "Listen by <date>" both promise the student can still do it;
 * on a course archived with listening off, nobody can. The student's own
 * screens already say so ("no longer required and cannot be played"), and a
 * ledger that went on saying "Listen by" beside them was the two populations
 * reading two different facts off one grant.
 */
describe('grantOutcome', () => {
  const TODAY = '2026-07-25';
  it('is open while the date is ahead and the class can be played', () => {
    expect(grantOutcome({ completed: false, dueDate: '2026-07-30' }, TODAY, true)).toBe('open');
  });

  it('is closed by an archived class with listening off, however far ahead the date', () => {
    expect(grantOutcome({ completed: false, dueDate: '2099-01-01' }, TODAY, false)).toBe('closed');
  });

  it('is missed once the date has gone, whether or not the class can still be played', () => {
    // The date passed: that is the Missed the manual defines, and archiving
    // afterwards is filing. Nothing here can tell a miss that predates the
    // archive from one the archive caused, so the row keeps the fact it has.
    expect(grantOutcome({ completed: false, dueDate: '2026-07-24' }, TODAY, true)).toBe('missed');
    expect(grantOutcome({ completed: false, dueDate: '2026-07-24' }, TODAY, false)).toBe('missed');
  });

  it('is complete before anything else is asked', () => {
    expect(grantOutcome({ completed: true, dueDate: '2000-01-01' }, TODAY, false)).toBe('complete');
  });
});
