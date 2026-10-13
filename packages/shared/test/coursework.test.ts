import { describe, expect, it } from 'vitest';
import {
  INSTITUTE_TIMEZONE,
  MAX_ATTACHMENT_BYTES,
  attachmentContentType,
  attachmentProblem,
  canHandIn,
  canTakeBack,
  closesOn,
  defaultLateUntil,
  gradeFits,
  gradeText,
  isLate,
  nextDeadline,
  receivesOnJoining,
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
  it('is possible until the due date, and never once returned', () => {
    expect(canTakeBack({ state: 'handedIn', dueDate: '2026-10-13' }, '2026-10-13')).toBe(true);
    expect(canTakeBack({ state: 'handedIn', dueDate: '2026-10-13' }, '2026-10-14')).toBe(false);
    expect(canTakeBack({ state: 'returned', dueDate: '2026-10-13' }, '2026-10-10')).toBe(false);
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
