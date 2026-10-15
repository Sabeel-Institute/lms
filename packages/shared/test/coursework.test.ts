import { describe, expect, it } from 'vitest';
import {
  INSTITUTE_TIMEZONE,
  MAX_ATTACHMENT_BYTES,
  attachmentContentType,
  attachmentProblem,
  canHandIn,
  canTakeBack,
  closesOn,
  countsFromTally,
  endsSooner,
  offeredAnotherTry,
  offeredMoreTime,
  courseworkCounts,
  courseworkTally,
  defaultLateUntil,
  gradeFits,
  gradeText,
  isLate,
  nextDeadline,
  receivesOnJoining,
  returnsOnComingBack,
  staffWorkState,
  tallyCounts,
  workTally,
  workBucket,
  workState,
  type SubmissionDoc,
} from '../src';

type Sub = Pick<SubmissionDoc, 'state' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly'>;
const open = (over: Partial<Sub> = {}): Sub => ({
  state: 'open',
  dueDate: '2026-10-13',
  lateUntil: '2026-10-20',
  notRequired: null,
  closedEarly: false,
  ...over,
});
/** A moment in the institute's clock (Chicago, five hours behind UTC in October). */
const chicago = (date: string, time: string) => Date.parse(`${date}T${time}:00-05:00`);

describe('where a student’s work stands', () => {
  it('is to do through the whole due date, then past due while late work is taken, then missed', () => {
    expect(workState(open(), '2026-10-13', true)).toBe('toDo');
    expect(workState(open(), '2026-10-14', true)).toBe('pastDue');
    expect(workState(open(), '2026-10-20', true)).toBe('pastDue');
    expect(workState(open(), '2026-10-21', true)).toBe('missed');
  });

  it('is missed the day after the due date when late work is off', () => {
    expect(workState(open({ lateUntil: null }), '2026-10-14', true)).toBe('missed');
  });

  it('is closed, not missed, when its course was archived while it was open', () => {
    expect(workState(open(), '2026-10-30', false)).toBe('closed');
  });

  it('stays handed in or returned whatever the dates and the course do', () => {
    expect(workState(open({ state: 'handedIn' }), '2026-12-01', false)).toBe('handedIn');
    expect(workState(open({ state: 'returned' }), '2026-12-01', true)).toBe('returned');
  });

  it('counts nowhere once a teacher marks it not required, even after it was missed', () => {
    const note = { reason: 'Travelling', by: 't', at: 1 };
    expect(workState(open({ notRequired: note }), '2026-12-01', true)).toBe('notRequired');
    expect(workBucket('notRequired', '2026-10-13', '2026-10-01')).toBeNull();
  });

  it('closes at once when the teacher stops accepting work early', () => {
    expect(workState(open({ closedEarly: true }), '2026-10-10', true)).toBe('missed');
    expect(canHandIn(workState(open({ closedEarly: true }), '2026-10-10', true))).toBe(false);
  });

  it('takes a hand-in while to do or past due, and at no other time', () => {
    expect(canHandIn('toDo')).toBe(true);
    expect(canHandIn('pastDue')).toBe(true);
    for (const s of ['missed', 'closed', 'handedIn', 'returned', 'notRequired'] as const) expect(canHandIn(s)).toBe(false);
  });
});

describe('late', () => {
  it('is judged in the institute’s clock: 11:30 PM on the due date is on time, 12:30 AM the next day is late', () => {
    expect(isLate(chicago('2026-10-13', '23:30'), '2026-10-13', INSTITUTE_TIMEZONE)).toBe(false);
    expect(isLate(chicago('2026-10-14', '00:30'), '2026-10-13', INSTITUTE_TIMEZONE)).toBe(true);
  });

  it('is re-judged when the student’s date moves: more time makes late work on time', () => {
    const handedIn = chicago('2026-10-15', '10:00');
    expect(isLate(handedIn, '2026-10-13', INSTITUTE_TIMEZONE)).toBe(true);
    expect(isLate(handedIn, '2026-10-16', INSTITUTE_TIMEZONE)).toBe(false);
  });

  it('defaults to a week of late work after the due date', () => {
    expect(defaultLateUntil('2026-10-13')).toBe('2026-10-20');
    expect(closesOn({ dueDate: '2026-10-13', lateUntil: null })).toBe('2026-10-13');
  });
});

describe('taking work back', () => {
  const work = (over: Partial<Parameters<typeof canTakeBack>[0]> = {}) => ({
    state: 'handedIn' as const,
    dueDate: '2026-10-13',
    closedEarly: false,
    notRequired: null,
    ...over,
  });

  it('is possible until the due date, and never once returned', () => {
    expect(canTakeBack(work(), '2026-10-13', true)).toBe(true);
    expect(canTakeBack(work(), '2026-10-14', true)).toBe(false);
    expect(canTakeBack(work({ state: 'returned' }), '2026-10-10', true)).toBe(false);
  });

  it('is not possible once it could not go back in: work stopped, the course archived, or not required', () => {
    expect(canTakeBack(work({ closedEarly: true }), '2026-10-10', true)).toBe(false);
    expect(canTakeBack(work(), '2026-10-10', false)).toBe(false);
    expect(canTakeBack(work({ notRequired: { reason: 'Away', by: 't', at: 1 } }), '2026-10-10', true)).toBe(false);
  });
});

describe('who receives an assignment', () => {
  const posted = { status: 'posted' as const, dueDate: '2026-10-13', closedAt: null };
  it('a student who joins on or before its due date gets it; after, they owe nothing', () => {
    expect(receivesOnJoining(posted, '2026-10-13')).toBe(true);
    expect(receivesOnJoining(posted, '2026-10-14')).toBe(false);
  });
  it('a draft goes to nobody, and neither does one closed early', () => {
    expect(receivesOnJoining({ ...posted, status: 'draft' }, '2026-10-01')).toBe(false);
    expect(receivesOnJoining({ ...posted, closedAt: 5 }, '2026-10-01')).toBe(false);
  });
});

describe('To do', () => {
  it('puts work due within seven days in Due soon, later work in Upcoming, late work in Past due', () => {
    expect(workBucket('toDo', '2026-10-20', '2026-10-13')).toBe('dueSoon');
    expect(workBucket('toDo', '2026-10-21', '2026-10-13')).toBe('upcoming');
    expect(workBucket('pastDue', '2026-10-10', '2026-10-13')).toBe('pastDue');
    expect(workBucket('handedIn', '2026-10-10', '2026-10-13')).toBe('done');
    expect(workBucket('closed', '2026-10-10', '2026-10-13')).toBe('archived');
  });

  it('leads with the day late work closes, not the due date that has passed', () => {
    const sub = { dueDate: '2026-10-10', lateUntil: '2026-10-17' };
    expect(nextDeadline('pastDue', sub)).toBe('2026-10-17');
    expect(nextDeadline('toDo', sub)).toBe('2026-10-10');
    expect(nextDeadline('missed', sub)).toBeNull();
  });
});

describe('grades', () => {
  it('take points in halves up to the total, or a scale mark, matching how the work is graded', () => {
    const outOf10 = { kind: 'points' as const, outOf: 10 };
    expect(gradeFits({ points: 8.5 }, outOf10)).toBe(true);
    expect(gradeFits({ points: 8.25 }, outOf10)).toBe(false);
    expect(gradeFits({ points: 11 }, outOf10)).toBe(false);
    expect(gradeFits({ points: -1 }, outOf10)).toBe(false);
    expect(gradeFits({ scale: 'satisfactory' }, outOf10)).toBe(false);
    expect(gradeFits({ scale: 'needsWork' }, { kind: 'scale' })).toBe(true);
    expect(gradeFits({ points: 1 }, { kind: 'scale' })).toBe(false);
    expect(gradeText({ points: 9 }, outOf10)).toBe('9/10');
    expect(gradeText({ scale: 'needsWork' }, { kind: 'scale' })).toBe('Needs work');
  });
});

describe('attachments', () => {
  it('take documents, pictures and audio, and never video', () => {
    expect(attachmentContentType('Worksheet.PDF')).toBe('application/pdf');
    expect(attachmentContentType('page.jpg')).toBe('image/jpeg');
    expect(attachmentContentType('WhatsApp voice note.opus')).toBe('audio/ogg');
    for (const name of ['clip.mp4', 'clip.mov', 'setup.exe', 'work.zip']) expect(attachmentContentType(name)).toBeNull();
  });

  it('say why a file is refused', () => {
    expect(attachmentProblem('IMG_1.HEIC', 10)).toMatch(/JPEG/);
    expect(attachmentProblem('clip.mp4', 10)).toMatch(/Not a file/);
    expect(attachmentProblem('scan.pdf', MAX_ATTACHMENT_BYTES + 1)).toMatch(/25 MB/);
    expect(attachmentProblem('scan.pdf', 1000)).toBeNull();
  });
});

describe('what a teacher sees', () => {
  const sub = (over: Partial<SubmissionDoc>) => ({
    studentUid: 'u',
    active: true,
    state: 'open' as const,
    dueDate: '2026-10-13',
    lateUntil: '2026-10-20',
    notRequired: null,
    closedEarly: false,
    handedInAt: null,
    returned: null,
    attempts: [],
    ...over,
  });
  const at = (date: string) => Date.parse(`${date}T12:00:00-05:00`);

  it('splits handed-in work into to grade and graded, which students cannot see', () => {
    expect(staffWorkState(sub({ state: 'handedIn' }), undefined, '2026-10-12', true)).toBe('toGrade');
    expect(staffWorkState(sub({ state: 'handedIn' }), { grade: { points: 8 }, withoutHandIn: false }, '2026-10-12', true)).toBe('graded');
    expect(staffWorkState(sub({}), { grade: { points: 8 }, withoutHandIn: true }, '2026-10-12', true)).toBe('graded');
  });

  it('counts as graded only work with a grade: feedback first, or a grade cleared, is still to grade', () => {
    expect(staffWorkState(sub({ state: 'handedIn' }), { grade: null, withoutHandIn: false }, '2026-10-12', true)).toBe('toGrade');
    expect(staffWorkState(sub({}), { grade: null, withoutHandIn: true }, '2026-10-12', true)).toBe('toDo');
  });

  it('counts work graded on paper as handed in, as the student’s page does', () => {
    const paper = workTally({ kind: 'points', outOf: 10 }, sub({}), { grade: { points: 9 }, withoutHandIn: true }, '2026-10-12', true, 'America/Chicago');
    expect(paper).toMatchObject({ state: 'graded', handedIn: true });
  });

  it('counts a class: handed in, late, to grade, to return, past due, missed — and leaves out who is not required', () => {
    const subs = [
      sub({ studentUid: 'a', state: 'returned', handedInAt: at('2026-10-12'), returned: { grade: { points: 8 }, feedback: '', at: 1, seq: 1, retry: false } }),
      sub({ studentUid: 'b', state: 'returned', handedInAt: at('2026-10-12'), returned: { grade: { points: 10 }, feedback: '', at: 1, seq: 1, retry: false } }),
      sub({ studentUid: 'c', state: 'handedIn', handedInAt: at('2026-10-14') }),
      sub({ studentUid: 'd', state: 'handedIn', handedInAt: at('2026-10-13') }),
      sub({ studentUid: 'e' }),
      sub({ studentUid: 'f', notRequired: { reason: 'r', by: 't', at: 1 } }),
      sub({ studentUid: 'g', active: false }),
    ];
    const grades = new Map([['d', { grade: { points: 9 }, withoutHandIn: false }]]);
    const c = courseworkCounts({ kind: 'points', outOf: 10 }, subs, grades, '2026-10-15', true, INSTITUTE_TIMEZONE);
    expect(c).toMatchObject({ expected: 5, handedIn: 4, late: 1, toGrade: 1, toReturn: 1, returned: 2, pastDue: 1, missed: 0, notRequired: 1 });
    // Returned grades only: 80% and 100%, not the 90% still in draft.
    expect(c.average).toBeCloseTo(0.9);
    expect(courseworkCounts({ kind: 'points', outOf: 10 }, subs, grades, '2026-10-21', true, INSTITUTE_TIMEZONE).missed).toBe(1);
  });

  it('still counts a student who left during another try, by the attempt given back', () => {
    const graded4 = { grade: { points: 4 }, feedback: '', at: 1, seq: 1, retry: true };
    const subs = [
      // Left while on another try, due on their own date: attempt 1 was in and graded.
      sub({ studentUid: 'h', active: false, dueDate: '2026-10-24', lateUntil: null, returned: graded4, attempts: [{ attempt: 1, note: 'first', files: {}, handedInAt: at('2026-10-12'), returned: graded4 }] }),
      // Left with nothing in: counts nowhere.
      sub({ studentUid: 'g', active: false }),
    ];
    const c = courseworkCounts({ kind: 'points', outOf: 10 }, subs, new Map(), '2026-10-15', true, INSTITUTE_TIMEZONE);
    // Counted as handed in and returned: never as owing the attempt they
    // could no longer hand in (it was "not in yet", then "missed").
    expect(c).toMatchObject({ expected: 1, notInYet: 0, missed: 0, handedIn: 1, returned: 1 });
  });
});

describe('coming back to the class', () => {
  const sub = (over: Partial<SubmissionDoc>) => ({
    state: 'open' as const,
    attempts: [],
    dueDate: '2026-10-13',
    closedEarly: false,
    ...over,
  });
  const graded = { grade: { points: 4 }, feedback: '', at: 1, seq: 1, retry: true };

  it('brings back open work by the student\'s own date: more time, or another try', () => {
    // The class's date passed on the 13th; theirs is the 24th.
    expect(returnsOnComingBack(sub({ dueDate: '2026-10-24' }), '2026-10-15')).toBe(true);
    expect(returnsOnComingBack(sub({}), '2026-10-15')).toBe(false);
  });

  it('brings back an earlier attempt even once the new date has gone by', () => {
    const tried = sub({ dueDate: '2026-10-14', attempts: [{ attempt: 1, note: '', files: {}, handedInAt: 1, returned: graded }] });
    expect(returnsOnComingBack(tried, '2026-10-20')).toBe(true);
  });

  it('brings back anything handed in, and no open work the teacher stopped taking', () => {
    expect(returnsOnComingBack(sub({ state: 'handedIn' }), '2026-10-20')).toBe(true);
    expect(returnsOnComingBack(sub({ dueDate: '2026-10-24', closedEarly: true }), '2026-10-15')).toBe(false);
  });
});

/*
 * THE STORED TALLY SAYS WHAT THE WORK SAYS. A course's pages read one tally
 * per assignment instead of every piece of work in it, so the tally must give
 * the same figures, on any day, as counting the work directly — and the
 * refactor that let both share one decision must not have moved a single
 * state. Checked against two oracles over thousands of generated classes: the
 * staff state as it was written before (copied verbatim below), and the sum
 * of per-student tallies, which the workbooks still use.
 */
describe('the stored tally', () => {
  /** `staffWorkState` as it was before it was split into settled and dated halves. */
  function staffWorkStateBefore(
    sub: Pick<SubmissionDoc, 'active' | 'state' | 'attempts' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly'>,
    grade: { grade: { points: number } | { scale: 'satisfactory' | 'needsWork' } | null; withoutHandIn: boolean } | undefined,
    today: string,
    courseOpen: boolean,
  ) {
    // The one change made on purpose since: a student gone during another
    // try is counted by the attempt given back, not as owing the open one.
    if (!sub.notRequired && !sub.active && sub.state === 'open' && sub.attempts.length > 0) return 'returned';
    const state = workState(sub, today, courseOpen);
    const graded = !!grade && grade.grade !== null;
    if (state === 'handedIn') return graded ? 'graded' : 'toGrade';
    if (graded && grade.withoutHandIn && sub.state === 'open' && state !== 'notRequired') return 'graded';
    return state;
  }

  /** A small deterministic generator, so a failure names its seed. */
  function rng(seed: number) {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 2 ** 32;
    };
  }
  const days = ['2026-10-01', '2026-10-05', '2026-10-09', '2026-10-13', '2026-10-17', '2026-10-21'];
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

  function aClass(seed: number) {
    const r = rng(seed);
    const grading = r() < 0.5 ? { kind: 'points' as const, outOf: 10 } : { kind: 'scale' as const };
    const subs: SubmissionDoc[] = [];
    const grades = new Map<string, { grade: { points: number } | { scale: 'satisfactory' | 'needsWork' } | null; withoutHandIn: boolean }>();
    const n = Math.floor(r() * 25);
    for (let i = 0; i < n; i++) {
      const due = pick(r, days);
      const lateUntil = r() < 0.4 ? null : pick(r, days.filter((d) => d >= due));
      const state = pick(r, ['open', 'open', 'handedIn', 'returned'] as const);
      const points = Math.round(r() * 20) / 2;
      const grade = grading.kind === 'points' ? { points } : { scale: pick(r, ['satisfactory', 'needsWork'] as const) };
      subs.push({
        studentUid: `s${i}`,
        courseworkId: 'cw',
        courseId: 'c',
        cohortId: 'h',
        active: r() < 0.85,
        dueDate: due,
        lateUntil,
        closedEarly: r() < 0.15,
        state,
        attempt: 1,
        handedInAt: state === 'open' ? null : Date.parse(`${pick(r, days)}T12:00:00-05:00`),
        note: '',
        files: {},
        returned: state === 'returned' ? { grade: r() < 0.9 ? grade : null, feedback: '', at: 1, seq: 1, retry: false } : null,
        attempts: r() < 0.2 ? [{} as SubmissionDoc['attempts'][number]] : [],
        notRequired: r() < 0.1 ? { reason: 'x', by: 't', at: 1 } : null,
        moreTime: null,
        assignedAt: 1,
      } as SubmissionDoc);
      if (r() < 0.5) grades.set(`s${i}`, { grade: r() < 0.85 ? grade : null, withoutHandIn: state === 'open' && r() < 0.5 });
    }
    return { grading, subs, grades };
  }

  it('moves no student’s state', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const { subs, grades } = aClass(seed);
      for (const s of subs) {
        for (const today of days) {
          for (const courseOpen of [true, false]) {
            expect(staffWorkState(s, grades.get(s.studentUid), today, courseOpen), `seed ${seed}`).toBe(
              staffWorkStateBefore(s, grades.get(s.studentUid), today, courseOpen),
            );
          }
        }
      }
    }
  });

  it('gives the same figures, on every day, as counting the work', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const { grading, subs, grades } = aClass(seed);
      const tally = courseworkTally(grading, subs, grades, INSTITUTE_TIMEZONE);
      for (const today of days) {
        for (const courseOpen of [true, false]) {
          const direct = tallyCounts(subs.map((s) => workTally(grading, s, grades.get(s.studentUid), today, courseOpen, INSTITUTE_TIMEZONE)));
          expect(countsFromTally(tally, today, courseOpen), `seed ${seed} on ${today}`).toEqual(direct);
        }
      }
    }
  });

  it('is stored the same when nothing changed, whatever order the work came in', () => {
    const { grading, subs, grades } = aClass(7);
    const reversed = [...subs].reverse();
    expect(courseworkTally(grading, reversed, grades, INSTITUTE_TIMEZONE).waiting).toEqual(
      courseworkTally(grading, subs, grades, INSTITUTE_TIMEZONE).waiting,
    );
  });
});

/*
 * NO LESS TIME THAN THEY HAVE. Another try was offered a week from today with
 * no late work, so a student who handed in early was given weeks less than
 * every classmate; a second "more time" was offered from the class's date,
 * so a student already given until later was cut short by one tap.
 */
describe('the dates a teacher is offered', () => {
  const cls = { dueDate: '2026-11-04', lateUntil: '2026-11-11' };

  it('another try for work handed in early keeps the class’s dates, late work included', () => {
    const offer = offeredAnotherTry(cls, { dueDate: '2026-11-04', lateUntil: '2026-11-11' }, '2026-10-14');
    expect(offer).toEqual({ dueDate: '2026-11-04', lateUntil: '2026-11-11' });
    expect(endsSooner(offer, cls)).toBe(false);
  });

  it('another try once the class’s dates have gone gives a week, with the class’s gap for late work', () => {
    expect(offeredAnotherTry(cls, cls, '2026-11-20')).toEqual({ dueDate: '2026-11-27', lateUntil: '2026-12-04' });
    expect(offeredAnotherTry({ dueDate: '2026-11-04', lateUntil: null }, { dueDate: '2026-11-04', lateUntil: null }, '2026-11-20')).toEqual({
      dueDate: '2026-11-27',
      lateUntil: null,
    });
  });

  it('more time for a student who already has until later starts from their date, not the class’s', () => {
    const theirs = { dueDate: '2026-11-03', lateUntil: null };
    const offer = offeredMoreTime({ dueDate: '2026-10-21', lateUntil: '2026-10-28' }, theirs, '2026-10-14');
    expect(offer.dueDate).toBe('2026-11-10');
    expect(endsSooner(offer, theirs)).toBe(false);
  });

  it('says when dates give less time: due sooner, or closing sooner', () => {
    expect(endsSooner({ dueDate: '2026-10-21', lateUntil: null }, cls)).toBe(true);
    expect(endsSooner({ dueDate: '2026-11-04', lateUntil: null }, cls)).toBe(true);
    expect(endsSooner({ dueDate: '2026-11-04', lateUntil: '2026-11-11' }, cls)).toBe(false);
    expect(endsSooner({ dueDate: '2026-11-12', lateUntil: null }, cls)).toBe(false);
  });
});

describe('a student gone during another try', () => {
  it('is counted by the attempt given back, never as owing the open one', () => {
    const cw = { kind: 'points' as const, outOf: 10 };
    const gone = {
      studentUid: 'd',
      active: false,
      state: 'open' as const,
      attempts: [{} as SubmissionDoc['attempts'][number]],
      dueDate: '2026-10-17',
      lateUntil: null,
      notRequired: null,
      closedEarly: false,
      handedInAt: null,
      returned: { grade: { points: 3 }, feedback: '', at: 1, seq: 1, retry: true },
    };
    expect(staffWorkState(gone, undefined, '2026-10-20', true)).toBe('returned');
    expect(courseworkCounts(cw, [gone], new Map(), '2026-10-20', true, INSTITUTE_TIMEZONE)).toMatchObject({
      missed: 0,
      notInYet: 0,
      returned: 1,
      handedIn: 1,
      average: 0.3,
    });
  });
});
