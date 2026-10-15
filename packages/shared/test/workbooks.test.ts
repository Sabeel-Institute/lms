import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildXlsx,
  courseStudentStats,
  courseWorkbook,
  courseworkCounts,
  excelSerial,
  MAX_CELL_CHARS,
  readXlsx,
  studentWorkbook,
  workbookFilename,
  WORKBOOK_DEFINITIONS,
  type CourseData,
  type WorkbookContext,
  type WorkbookSpec,
} from '../src';

/**
 * A fixed term, built to hold every row state the two workbooks can print:
 * a student who listened, one who missed, one still open, one who left the
 * class before a deadline, one who joined late, a register never taken, a
 * recording archived and so withdrawn, a completion by override.
 */
const ZONE = 'America/Chicago';
const TODAY = '2026-10-15';
const T = (d: string, hhmm = '12:00') => Date.parse(`${d}T${hhmm}:00-05:00`);

const COURSE = 'hikam';
const S = { fatima: 'u-fatima', bilal: 'u-bilal', aminah: 'u-aminah', idris: 'u-idris', ayesha: 'u-ayesha' };

function session(id: string, date: string, dueDate: string, attendance: Record<string, 'present' | 'absent' | 'excused'> | null, recordingId: string | null) {
  return {
    id,
    courseId: COURSE,
    cohortId: 'aut26',
    date,
    title: `Session ${id}`,
    dueDate,
    notes: '',
    recordingId,
    attendance: attendance ?? {},
    attendanceSubmittedAt: attendance ? T(date, '20:00') : null,
    notRecorded: false,
    createdAt: 1,
    createdBy: 'adm',
    updatedAt: 1,
  };
}
function recording(id: string, sessionId: string, status: 'published' | 'archived' | 'draft') {
  return {
    id,
    sessionId,
    courseId: COURSE,
    cohortId: 'aut26',
    title: `Recording ${sessionId}`,
    notes: '',
    date: '2026-09-01',
    status,
    source: 'manual' as const,
    media: {},
    defaultVersion: 'audio' as const,
    durationSec: 3600,
    createdAt: 1,
    createdBy: 'adm',
    updatedAt: 1,
    ...(status !== 'draft' ? { publishedAt: T('2026-09-02') } : {}),
  };
}
const grant = (studentUid: string, recordingId: string, sessionId: string, dueDate: string, active = true) => ({
  studentUid,
  recordingId,
  sessionId,
  courseId: COURSE,
  cohortId: 'aut26',
  dueDate,
  active,
  assignedAt: 1,
  assignedBy: 'system',
});
/** An assignment, posted unless it says otherwise. */
function work(id: string, title: string, dueDate: string, lateUntil: string | null, grading: { kind: 'points'; outOf: number } | { kind: 'scale' }, status: 'posted' | 'draft' = 'posted') {
  return {
    id,
    courseId: COURSE,
    cohortId: 'aut26',
    title,
    instructions: '',
    files: {},
    dueDate,
    lateUntil,
    grading,
    status,
    closedAt: null,
    postedAt: status === 'posted' ? T('2026-09-01') : null,
    postedBy: status === 'posted' ? 'mgr' : null,
    createdAt: 1,
    createdBy: 'mgr',
    updatedAt: 1,
    editedAt: null,
  };
}
type GradeIn = { points: number } | { scale: 'satisfactory' | 'needsWork' };
/** One student's work: open by default; `inAt` hands it in; `back` returns it with a grade. */
function sub(
  studentUid: string,
  courseworkId: string,
  dueDate: string,
  lateUntil: string | null,
  o: { inAt?: string; back?: { grade: GradeIn; at: string }; active?: boolean; notRequired?: string; moreTime?: string; returnedWithoutHandIn?: GradeIn } = {},
) {
  const returned = o.back
    ? { grade: o.back.grade, feedback: 'Well done.', at: T(o.back.at), seq: 1, retry: false }
    : o.returnedWithoutHandIn
      ? { grade: o.returnedWithoutHandIn, feedback: 'Recited in class.', at: T('2026-09-25'), seq: 1, retry: false }
      : null;
  return {
    studentUid,
    courseworkId,
    courseId: COURSE,
    cohortId: 'aut26',
    active: o.active ?? true,
    dueDate,
    lateUntil,
    closedEarly: false,
    state: returned ? ('returned' as const) : o.inAt ? ('handedIn' as const) : ('open' as const),
    attempt: 1,
    handedInAt: o.inAt ? T(o.inAt) : null,
    note: o.inAt ? 'My answer.' : '',
    files: {},
    returned,
    attempts: [],
    notRequired: o.notRequired ? { reason: o.notRequired, by: 'mgr', at: T('2026-09-20') } : null,
    moreTime: o.moreTime ? { reason: o.moreTime, by: 'mgr', at: T('2026-10-05') } : null,
    assignedAt: T('2026-09-01'),
  };
}
const graded = (studentUid: string, courseworkId: string, grade: GradeIn, withoutHandIn = false) => ({
  studentUid,
  courseworkId,
  courseId: COURSE,
  grade,
  feedback: withoutHandIn ? 'Recited in class.' : 'Well done.',
  gradedBy: 'mgr',
  gradedAt: T('2026-09-12'),
  withoutHandIn,
});

/** An enrolment as the callables keep it: joined, then left and came back as the days alternate. */
const enrol = (studentUid: string, ...days: string[]) => ({
  studentUid,
  courseId: COURSE,
  cohortId: 'aut26',
  active: days.length % 2 === 1,
  stretches: days.flatMap((d, i) => (i % 2 === 0 ? [{ from: T(d), to: days[i + 1] ? T(days[i + 1]) : null }] : [])),
  enrolledBy: 'adm',
});

const world: CourseData = {
  course: {
    id: COURSE,
    cohortId: 'aut26',
    name: 'Hikam Foundations',
    archived: false,
    effectiveActive: true,
    archivedAccess: false,
    managerUids: ['mgr'],
    createdAt: 1,
    createdBy: 'adm',
  },
  cohortName: 'Autumn 2026',
  sessions: [
    // S1: register taken, everyone marked; recording published; deadline gone.
    session('1', '2026-09-01', '2026-09-15', { [S.fatima]: 'excused', [S.bilal]: 'excused', [S.aminah]: 'present', [S.idris]: 'present' }, 'r1'),
    // S2: register taken; recording published; still open. Idris left before it.
    session('2', '2026-09-08', '2026-10-30', { [S.fatima]: 'present', [S.bilal]: 'present', [S.aminah]: 'excused', [S.idris]: 'excused' }, 'r2'),
    // S3: register NOT taken; recording published (open to nobody).
    session('3', '2026-09-15', '2026-10-30', null, 'r3'),
    // S4: register taken; recording ARCHIVED — withdrawn from the totals.
    session('4', '2026-09-22', '2026-10-06', { [S.fatima]: 'excused', [S.bilal]: 'present', [S.aminah]: 'present', [S.ayesha]: 'present' }, 'r4'),
    // S5: register taken after Ayesha joined, no recording yet; Fatima has no mark on it.
    session('5', '2026-10-13', '2026-10-27', { [S.bilal]: 'present', [S.aminah]: 'absent', [S.ayesha]: 'present' }, null),
  ],
  recordings: [recording('r1', '1', 'published'), recording('r2', '2', 'published'), recording('r3', '3', 'published'), recording('r4', '4', 'archived')],
  enrollments: [
    enrol(S.fatima, '2026-08-24'),
    enrol(S.bilal, '2026-08-24'),
    enrol(S.aminah, '2026-08-24'),
    enrol(S.idris, '2026-08-24', '2026-10-02'),
    enrol(S.ayesha, '2026-10-10'),
  ],
  assignments: [
    grant(S.fatima, 'r1', '1', '2026-09-15'),
    grant(S.bilal, 'r1', '1', '2026-09-15'),
    grant(S.aminah, 'r2', '2', '2026-10-30'),
    grant(S.idris, 'r2', '2', '2026-10-30', false),
    grant(S.fatima, 'r4', '4', '2026-10-06', false),
  ],
  completions: [
    { studentUid: S.fatima, recordingId: 'r4', courseId: COURSE, completed: true, completedAt: T('2026-09-25'), updatedAt: 1 },
  ],
  overrides: [
    { studentUid: S.bilal, recordingId: 'r1', courseId: COURSE, completed: true, reason: 'Caught up in person', overriddenBy: 'mgr', at: T('2026-09-14') },
  ],
  progress: [
    { studentUid: S.fatima, recordingId: 'r1', courseId: COURSE, listenedMs: 2_232_000, sittings: { s1: 2_232_000 }, sitting: 's1', updatedAt: T('2026-09-10') },
    { studentUid: S.aminah, recordingId: 'r2', courseId: COURSE, listenedMs: 540_000, sittings: { s1: 540_000 }, sitting: 's1', updatedAt: T('2026-10-09') },
  ],
  // Every state a piece of work can be in, on four posted assignments and a draft.
  coursework: [
    work('cw1', 'Reflection on the first hikma', '2026-09-10', '2026-09-17', { kind: 'points', outOf: 10 }),
    work('cw2', 'Recite the first hikma', '2026-09-24', null, { kind: 'scale' }),
    work('cw3', 'Short answer: intention', '2026-10-20', '2026-10-27', { kind: 'points', outOf: 20 }),
    work('cw4', 'Not posted yet', '2026-10-30', null, { kind: 'points', outOf: 10 }, 'draft'),
    work('cw5', 'Vocabulary', '2026-10-08', '2026-10-22', { kind: 'points', outOf: 5 }),
  ],
  submissions: [
    // cw1: on time and returned; late and returned; nothing in by the last
    // day; handed in and returned before leaving the class.
    sub(S.fatima, 'cw1', '2026-09-10', '2026-09-17', { inAt: '2026-09-09', back: { grade: { points: 8.5 }, at: '2026-09-12' } }),
    sub(S.bilal, 'cw1', '2026-09-10', '2026-09-17', { inAt: '2026-09-12', back: { grade: { points: 6 }, at: '2026-09-14' } }),
    sub(S.aminah, 'cw1', '2026-09-10', '2026-09-17'),
    sub(S.idris, 'cw1', '2026-09-10', '2026-09-17', { inAt: '2026-09-09', back: { grade: { points: 9 }, at: '2026-09-12' }, active: false }),
    // cw2: graded on paper and returned; let off; graded and not returned
    // yet; left with nothing in, which counts nowhere.
    sub(S.fatima, 'cw2', '2026-09-24', null, { returnedWithoutHandIn: { scale: 'satisfactory' } }),
    sub(S.bilal, 'cw2', '2026-09-24', null, { notRequired: 'Recited to the teacher privately' }),
    sub(S.aminah, 'cw2', '2026-09-24', null, { inAt: '2026-09-20' }),
    sub(S.idris, 'cw2', '2026-09-24', null, { active: false }),
    // cw3: due next week. One handed in, the rest not in yet.
    sub(S.fatima, 'cw3', '2026-10-20', '2026-10-27', { inAt: '2026-10-14' }),
    sub(S.bilal, 'cw3', '2026-10-20', '2026-10-27'),
    sub(S.aminah, 'cw3', '2026-10-20', '2026-10-27'),
    sub(S.ayesha, 'cw3', '2026-10-20', '2026-10-27'),
    // cw5: past due with late work still taken; more time, so handed in on
    // the student's own date and not late.
    sub(S.fatima, 'cw5', '2026-10-08', '2026-10-22'),
    sub(S.bilal, 'cw5', '2026-10-18', '2026-10-25', { inAt: '2026-10-12', back: { grade: { points: 5 }, at: '2026-10-13' }, moreTime: 'Away for a week' }),
    sub(S.aminah, 'cw5', '2026-10-08', '2026-10-22'),
  ],
  grades: [
    graded(S.fatima, 'cw1', { points: 8.5 }),
    graded(S.bilal, 'cw1', { points: 6 }),
    graded(S.idris, 'cw1', { points: 9 }),
    graded(S.fatima, 'cw2', { scale: 'satisfactory' }, true),
    graded(S.aminah, 'cw2', { scale: 'needsWork' }),
    graded(S.bilal, 'cw5', { points: 5 }),
  ],
};

const ctx: WorkbookContext = {
  names: new Map([
    [S.fatima, 'Fatima Ahmed'],
    [S.bilal, 'Bilal Khan'],
    [S.aminah, 'Aminah Bello'],
    [S.idris, 'Idris Abubakar'],
    [S.ayesha, 'Ayesha Rahman'],
    ['mgr', 'Rukaiya Ahmed'],
  ]),
  timeZone: ZONE,
  today: TODAY,
  exportedAt: T('2026-10-15', '16:42'),
  exportedBy: 'Rukaiya Ahmed',
};

const sheet = (wb: WorkbookSpec, name: string) => {
  const s = wb.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
};
const cellText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));
/** A sheet's body rows as text, keyed by the second header row. */
const table = (wb: WorkbookSpec, name: string, headerRows = 2) => {
  const s = sheet(wb, name);
  const heads = s.rows[headerRows - 1].map((c) => cellText(c.v));
  return s.rows.slice(headerRows).map((row) => Object.fromEntries(row.map((c, i) => [heads[i], c.v])));
};

describe('courseStudentStats', () => {
  it('classes every outcome the term holds', () => {
    const fatima = courseStudentStats(world, S.fatima, ctx);
    // S1 excused → missed (deadline gone, 62% heard); S2 present; S4 excused
    // but the recording is archived → withdrawn; S5 taken without a mark.
    expect(fatima).toMatchObject({ held: 3, present: 1, absent: 0, excused: 2, unmarked: 1, required: 1, missed: 1, completed: 0, open: 0, closed: 0 });
    expect(fatima.items[0]).toMatchObject({ outcome: 'missed', heard: 0.62 });

    const bilal = courseStudentStats(world, S.bilal, ctx);
    expect(bilal).toMatchObject({ required: 1, completed: 1, missed: 0 });
    expect(bilal.items[0]).toMatchObject({ outcome: 'completed', markedBy: 'Rukaiya Ahmed' });

    const aminah = courseStudentStats(world, S.aminah, ctx);
    expect(aminah).toMatchObject({ held: 4, absent: 1, required: 1, open: 1 });

    // Idris left on 10-02: S5 is outside his window, S4's register (taken
    // while he was still in) holds no mark for him, and his S2 grant —
    // switched off when he left, deadline still ahead — is closed.
    const idris = courseStudentStats(world, S.idris, ctx);
    expect(idris).toMatchObject({ held: 2, unmarked: 1, enrolled: false, left: '2026-10-02', required: 1, closed: 1, missed: 0 });
    expect(idris.marks.get('4')).toBe('');
    expect(idris.marks.get('5')).toBe('—');

    // Ayesha joined 10-10, and was marked on S4's register (09-22) as well:
    // a mark on a taken register counts whenever the session was. S1, with no
    // mark for her and before she joined, is outside her window.
    const ayesha = courseStudentStats(world, S.ayesha, ctx);
    expect(ayesha).toMatchObject({ held: 2, present: 2, required: 0 });
    expect(ayesha.marks.get('4')).toBe('P');
    expect(ayesha.marks.get('1')).toBe('—');
    // A register never taken is '·' for everyone in its window.
    expect(fatima.marks.get('3')).toBe('·');
  });

  it('a newcomer excused on an earlier session’s register must listen to its recording, as the server granted', () => {
    const caughtUp: CourseData = {
      ...world,
      sessions: world.sessions.map((s) => (s.id === '2' ? { ...s, attendance: { ...s.attendance, [S.ayesha]: 'excused' } } : s)),
      assignments: [...world.assignments, grant(S.ayesha, 'r2', '2', '2026-10-30')],
    };
    expect(courseStudentStats(caughtUp, S.ayesha, ctx)).toMatchObject({ excused: 1, required: 1, open: 1 });
  });

  it('Held is the sum of the three marks, and Required of the four outcomes, for everyone', () => {
    for (const uid of Object.values(S)) {
      const s = courseStudentStats(world, uid, ctx);
      expect(s.present + s.absent + s.excused).toBe(s.held);
      expect(s.completed + s.open + s.missed + s.closed).toBe(s.required);
    }
  });

  it('a deadline that passed after the student left is closed, not missed', () => {
    const left = {
      ...world,
      enrollments: world.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-10') : e)),
      assignments: world.assignments.map((a) => (a.studentUid === S.fatima ? { ...a, active: false } : a)),
    };
    const s = courseStudentStats(left, S.fatima, ctx);
    expect(s.items.find((i) => i.session.id === '1')?.outcome).toBe('closed');
    // …while one who left after the date had gone did miss it.
    const later = { ...left, enrollments: world.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-20') : e)) };
    expect(courseStudentStats(later, S.fatima, ctx).items.find((i) => i.session.id === '1')?.outcome).toBe('missed');
  });

  it('a student brought back after a date passed while they were away has it closed, not missed', () => {
    const back = {
      ...world,
      enrollments: world.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-10', '2026-09-29') : e)),
      assignments: world.assignments.map((a) => (a.studentUid === S.fatima && a.recordingId === 'r1' ? { ...a, active: false } : a)),
    };
    expect(courseStudentStats(back, S.fatima, ctx).items.find((i) => i.session.id === '1')?.outcome).toBe('closed');
    // …while one who left only after the date, and came back, did miss it.
    const late = { ...back, enrollments: back.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-20', '2026-09-29') : e)) };
    expect(courseStudentStats(late, S.fatima, ctx).items.find((i) => i.session.id === '1')?.outcome).toBe('missed');
  });

  /*
   * EVERY ABSENCE, NOT THE LAST. Fatima was out of the class from 09-10 to
   * 09-29, over Session 1's date (09-15); a manager then removed her again on
   * 10-06 and added her back on 10-08. The second removal must not make the
   * first forgotten: the file charged her "Missed deadline" for a recording
   * she could not open, while the recording's own ledger said access closed.
   */
  it('a second removal does not make an earlier absence count as a missed deadline', () => {
    const twice = {
      ...world,
      enrollments: world.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-10', '2026-09-29', '2026-10-06', '2026-10-08') : e)),
      assignments: world.assignments.map((a) => (a.studentUid === S.fatima && a.recordingId === 'r1' ? { ...a, active: false } : a)),
    };
    const s = courseStudentStats(twice, S.fatima, ctx);
    expect(s.items.find((i) => i.session.id === '1')).toMatchObject({ outcome: 'closed', closedBy: 'away' });
    expect(s).toMatchObject({ missed: 0, closed: 1, joined: '2026-08-24', left: null });
    // …and the same while she is still out after the second removal.
    const stillOut = { ...twice, enrollments: twice.enrollments.map((e) => (e.studentUid === S.fatima ? enrol(S.fatima, '2026-08-24', '2026-09-10', '2026-09-29', '2026-10-06') : e)) };
    expect(courseStudentStats(stillOut, S.fatima, ctx)).toMatchObject({ missed: 0, closed: 1, left: '2026-10-06' });
  });

  /*
   * A REGISTER WITH NO PLACE FOR THEM is not one they were left off. Idris
   * left on 10-02 and came back on 10-14: Session 5's register (10-13) was
   * taken while he was out, when the register could not list him. Fatima's
   * missing mark on the same register, taken while she was in the class, is
   * one staff could have given.
   */
  it('a register held while a student was out of the class is not one without a mark for them', () => {
    const back = { ...world, enrollments: world.enrollments.map((e) => (e.studentUid === S.idris ? enrol(S.idris, '2026-08-24', '2026-10-02', '2026-10-14') : e)) };
    const idris = courseStudentStats(back, S.idris, ctx);
    expect(idris.marks.get('5')).toBe('—');
    expect(idris.unmarked).toBe(1); // Session 4, taken while he was in
    expect(idris.away).toEqual([{ left: '2026-10-02', back: '2026-10-14' }]);
    expect(courseStudentStats(back, S.fatima, ctx).marks.get('5')).toBe('');
  });

  /*
   * THE SAME DAY, THE REGISTER'S OWN TIME. A newcomer added on the evening a
   * class met, after its register was taken, was not on it; one added that
   * morning, before it was taken, was.
   */
  it('a newcomer added after the day’s register was taken was not on it, and one added before was', () => {
    // Session 5's register was taken at 20:00 on 10-13.
    const at = (hhmm: string) => ({ ...world, enrollments: [...world.enrollments.filter((e) => e.studentUid !== S.ayesha), { ...enrol(S.ayesha, '2026-10-13'), stretches: [{ from: T('2026-10-13', hhmm), to: null }] }] });
    const ayeshaOff = (d: CourseData) => ({ ...d, sessions: d.sessions.map((x) => (x.id === '5' ? { ...x, attendance: { [S.bilal]: 'present' as const } } : x)) });
    expect(courseStudentStats(ayeshaOff(at('21:00')), S.ayesha, ctx).marks.get('5')).toBe('—');
    expect(courseStudentStats(ayeshaOff(at('09:00')), S.ayesha, ctx).marks.get('5')).toBe('');
  });

  it('recordings closed on an archived class closes an open grant', () => {
    const off = { ...world, course: { ...world.course, effectiveActive: false, archivedAccess: false } };
    expect(courseStudentStats(off, S.aminah, ctx)).toMatchObject({ open: 0, closed: 1 });
  });
});

describe('courseWorkbook', () => {
  const wb = courseWorkbook(world, ctx);

  it('has the nine tabs, in order, with the Definitions last', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual([
      'Summary',
      'Students',
      'Sessions',
      'Register',
      'Recordings',
      'Detail',
      'Assignments',
      'Grades',
      'Definitions',
    ]);
    expect(sheet(wb, 'Definitions').rows).toHaveLength(WORKBOOK_DEFINITIONS.length + 1);
  });

  it('the Students tab closes on every row', () => {
    for (const r of table(wb, 'Students')) {
      expect(Number(r.Present) + Number(r.Absent) + Number(r.Excused)).toBe(Number(r.Held));
      expect(Number(r.Completed) + Number(r['Still open']) + Number(r['Missed deadline']) + Number(r.Closed)).toBe(Number(r.Required));
    }
  });

  it('the Register and Recordings totals reproduce the Students tab', () => {
    const students = new Map(table(wb, 'Students').map((r) => [r.Student, r]));
    for (const r of table(wb, 'Register')) {
      const s = students.get(r.Student)!;
      expect([r.Held, r.P, r.A, r.E]).toEqual([s.Held, s.Present, s.Absent, s.Excused]);
    }
    for (const r of table(wb, 'Recordings')) {
      const s = students.get(r.Student)!;
      expect([r.Required, r.Completed, r.Open, r.Missed, r.Closed]).toEqual([s.Required, s.Completed, s['Still open'], s['Missed deadline'], s.Closed]);
    }
  });

  it('the Sessions tab’s register columns sum to the Students tab’s', () => {
    const sumOf = (rows: Record<string, unknown>[], k: string) => rows.reduce((n: number, r) => n + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    for (const k of ['Present', 'Absent', 'Excused']) {
      expect(sumOf(table(wb, 'Sessions'), k), k).toBe(sumOf(table(wb, 'Students'), k));
    }
  });

  it('the Sessions tab’s catch-up columns sum to the Students tab’s', () => {
    const students = table(wb, 'Students');
    const sessions = table(wb, 'Sessions');
    const sumOf = (rows: Record<string, unknown>[], k: string) => rows.reduce((n, r) => n + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    expect(sumOf(sessions, 'Completed')).toBe(sumOf(students, 'Completed'));
    expect(sumOf(sessions, 'Still open')).toBe(sumOf(students, 'Still open'));
    expect(sumOf(sessions, 'Missed deadline')).toBe(sumOf(students, 'Missed deadline'));
    expect(sumOf(sessions, 'Closed')).toBe(sumOf(students, 'Closed'));
  });

  it('withdraws an archived recording and says so on its session', () => {
    const s4 = table(wb, 'Sessions').find((r) => r.Session === 'Session 4')!;
    expect(s4.Status).toBe('Archived');
    expect(String(s4.Note)).toMatch(/withdrawn/);
    expect(s4.Completed).toBe('—');
    // …and the Recordings grid has no column for it.
    const heads = sheet(wb, 'Recordings').rows[1].map((c) => String(c.v));
    expect(heads.some((h) => h.startsWith('Session 4'))).toBe(false);
    expect(heads.some((h) => h.startsWith('Session 1'))).toBe(true);
  });

  it('the Register says why a cell is empty', () => {
    const idris = table(wb, 'Register').find((r) => r.Student === 'Idris Abubakar')!;
    const heads = sheet(wb, 'Register').rows[1].map((c) => String(c.v));
    const col = (title: string) => heads.find((h) => h.endsWith(title))!;
    expect(idris[col('Session 1')]).toBe('P');
    expect(idris[col('Session 3')]).toBe('·');
    expect(idris[col('Session 4')]).toBe('');
    expect(idris[col('Session 5')]).toBe('—');
  });

  it('dates and times are real dates in the institute’s clock', () => {
    const rows = table(wb, 'Detail');
    const fatima = rows.find((r) => r.Student === 'Fatima Ahmed')!;
    expect(fatima['Due by']).toBeInstanceOf(Date);
    expect(cellText(fatima['Due by'])).toBe('2026-09-15');
    // 12:00 Chicago on 09-10, carried in UTC fields so Excel shows 12:00.
    expect((fatima['Last played'] as Date).toISOString()).toBe('2026-09-10T12:00:00.000Z');
    expect(fatima.Played).toBeCloseTo(0.62);
  });

  it('the Summary states the rates the tabs add up to', () => {
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    // present 9 of held 15 → 60% (Ayesha's S4 mark, from before she joined,
    // is on the register and counts); completed 1 ÷ (1 + 1 missed) → 50%.
    expect(summary['Attendance rate (present ÷ held)']).toBe('60%');
    expect(summary['Catch-up rate (completed ÷ completed + missed)']).toBe('50%');
    expect(summary['Recordings published']).toBe('3 of 5 sessions');
  });

  it('the Assignments tab counts each assignment as its own page does', () => {
    const rows = table(wb, 'Assignments');
    // Posted ones only, by due date: the draft is nowhere.
    expect(rows.map((r) => r.Assignment)).toEqual(['Reflection on the first hikma', 'Recite the first hikma', 'Vocabulary', 'Short answer: intention']);
    for (const r of rows) {
      const cw = world.coursework.find((c) => c.title === r.Assignment)!;
      const subs = world.submissions.filter((x) => x.courseworkId === cw.id);
      const grades = new Map(world.grades.filter((g) => g.courseworkId === cw.id).map((g) => [g.studentUid, g]));
      const n = courseworkCounts(cw.grading, subs, grades, TODAY, true, ZONE);
      expect([r.Assigned, r['Handed in'], r.Late, r['To grade'], r['To return'], r.Returned]).toEqual([n.expected, n.handedIn, n.late, n.toGrade, n.toReturn, n.returned]);
      expect([r['Not in yet'], r['Past due'], r.Missed, r['Not required']]).toEqual([n.notInYet, n.pastDue, n.missed, n.notRequired]);
      expect(r.Average).toEqual(n.average ?? '—');
    }
    const cw1 = rows[0];
    expect(cw1).toMatchObject({ Assigned: 4, 'Handed in': 3, Late: 1, Returned: 3, Missed: 1, Graded: 'out of 10' });
    expect(cw1.Average).toBeCloseTo((0.85 + 0.6 + 0.9) / 3);
    // Graded on paper counts as in; a student let off counts nowhere but its column.
    expect(rows[1]).toMatchObject({ Assigned: 2, 'Handed in': 2, 'To return': 1, Returned: 1, 'Not required': 1, Average: '—' });
  });

  it('the Grades tab’s totals add up to the Assignments tab’s', () => {
    const assignments = table(wb, 'Assignments');
    const grades = table(wb, 'Grades');
    const total = (rows: Record<string, unknown>[], k: string) => rows.reduce((n, r) => n + Number(r[k]), 0);
    for (const k of ['Assigned', 'Handed in', 'Late', 'Returned', 'Missed']) {
      expect(total(grades, k), k).toBe(total(assignments, k));
    }
  });

  it('the Grades tab gives a returned grade as a number, and says where the rest stands', () => {
    const grades = table(wb, 'Grades');
    const heads = sheet(wb, 'Grades').rows[1].map((c) => String(c.v));
    const col = (title: string) => heads.find((h) => h.startsWith(`${title}\n`))!;
    const row = (who: string) => grades.find((r) => r.Student === who)!;
    expect(col('Reflection on the first hikma')).toBe('Reflection on the first hikma\ndue 09-10 · out of 10');
    expect(heads.some((h) => h.startsWith('Not posted yet'))).toBe(false);
    const fatima = row('Fatima Ahmed');
    expect(fatima[col('Reflection on the first hikma')]).toBe(8.5);
    expect(fatima[col('Recite the first hikma')]).toBe('Satisfactory');
    expect(fatima[col('Short answer: intention')]).toBe('to grade');
    expect(fatima[col('Vocabulary')]).toBe('past due');
    expect(fatima).toMatchObject({ Assigned: 4, 'Handed in': 3, Returned: 2, Missed: 0, Average: 0.85 });
    const aminah = row('Aminah Bello');
    expect(aminah[col('Reflection on the first hikma')]).toBe('missed');
    expect(aminah[col('Recite the first hikma')]).toBe('Needs work · to return');
    expect(aminah.Average).toBe('—');
    expect(row('Bilal Khan')[col('Recite the first hikma')]).toBe('not required');
    expect(row('Bilal Khan')[col('Short answer: intention')]).toBe('not in yet');
    // More time moved Bilal's date: handed in on his own date is not late.
    expect(row('Bilal Khan')).toMatchObject({ Late: 1, Average: (0.6 + 1) / 2 });
    // Left with nothing in counts nowhere; never given it is empty.
    expect(row('Idris Abubakar')[col('Recite the first hikma')]).toBe('');
    expect(row('Idris Abubakar')).toMatchObject({ Assigned: 1, Returned: 1 });
    expect(row('Ayesha Rahman')[col('Reflection on the first hikma')]).toBe('');
    // The number is a number cell, halves and all.
    const fatimaRow = sheet(wb, 'Grades').rows.find((r) => r[0].v === 'Fatima Ahmed')!;
    expect(fatimaRow[1]).toEqual({ v: 8.5, style: 'num' });
  });

  it('the Summary states the assignments the tabs add up to', () => {
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    expect(summary['Assignments posted']).toBe('4');
    expect(summary['Work to grade']).toBe('1');
    // 0.85, 0.6, 0.9 and 1: every returned grade in points, each a share.
    expect(summary['Average grade (returned, in points)']).toBe('84%');
  });

  it('writes a workbook Excel can open: one part per sheet, merges, a frozen pane, a filter', () => {
    const files = unzipSync(buildXlsx(wb));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet7.xml']));
    const students = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(students).toMatch(/<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"\/>/);
    expect(students).toMatch(/<mergeCell ref="B1:D1"\/>/); // Enrolment
    expect(students).toMatch(/<autoFilter ref="A2:P\d+"\/>/);
    expect(students).toMatch(/<t xml:space="preserve">Fatima Ahmed<\/t>/);
    const workbook = strFromU8(files['xl/workbook.xml']);
    expect(workbook).toMatch(/<sheet name="Students" sheetId="2"/);
    expect(workbook).toMatch(/_xlnm\._FilterDatabase/);
    // A date is a serial number with the date style, not text.
    expect(excelSerial(new Date('2026-09-15T00:00:00Z'))).toBe(46280);
  });

  it('opens whatever was typed into a title: the characters XML forbids go, and a cell over Excel\'s limit is cut short', () => {
    const odd = { name: 'Odd', rows: [[{ v: 'Session\uffff 1\fwith a form feed' }], [{ v: 'x'.repeat(40_000) }]] };
    const file = buildXlsx({ sheets: [odd] } as unknown as Parameters<typeof buildXlsx>[0]);
    const xml = strFromU8(unzipSync(file)['xl/worksheets/sheet1.xml']);
    expect(xml).not.toMatch(/[\uffff\f]/);
    const back = readXlsx(file)[0].rows;
    expect(back[0][0]).toBe('Session 1with a form feed');
    expect(String(back[1][0]).length).toBe(MAX_CELL_CHARS);
    expect(String(back[1][0]).endsWith('…')).toBe(true);
  });

  it('names a file the way every system accepts, # and % included', () => {
    expect(workbookFilename('Arabic #2 — 100% done: A/B')).toBe('Arabic -2 — 100- done- A-B.xlsx');
  });

  it('reads back every row it wrote — the grids\' headers carry a newline', () => {
    // `readXlsx` is what the e2e reads a download with; a row it silently
    // dropped would be a header nobody checked.
    const back = readXlsx(buildXlsx(wb));
    for (const sheet of wb.sheets) {
      expect(back.find((s) => s.name === sheet.name)?.rows.length, sheet.name).toBe(sheet.rows.length);
    }
    const register = back.find((s) => s.name === 'Register')!;
    expect(register.rows[1][1]).toMatch(/^\d\d-\d\d\n/);
  });
});

describe('studentWorkbook', () => {
  const other: CourseData = {
    ...world,
    course: { ...world.course, id: 'arabic', name: 'Arabic I' },
    sessions: [{ ...session('a1', '2026-09-03', '2026-09-17', { [S.fatima]: 'present' }, null), courseId: 'arabic' }],
    recordings: [],
    enrollments: [{ ...enrol(S.fatima, '2026-08-24'), courseId: 'arabic' }],
    assignments: [],
    completions: [],
    overrides: [],
    progress: [],
    coursework: [],
    submissions: [],
    grades: [],
  };
  const wb = studentWorkbook(
    {
      student: { uid: S.fatima, name: 'Fatima Ahmed', email: 'fatima@example.com', status: 'active', createdAt: T('2026-08-24') },
      courses: [world, other],
      history: [
        { at: T('2026-08-24'), actorUid: 'mgr', what: 'Enrolled in Hikam Foundations', courseId: COURSE, detail: '' },
        { at: T('2026-08-24', '12:01'), actorUid: 'mgr', what: 'Enrolled in Arabic I', courseId: 'arabic', detail: '' },
      ],
      historyComplete: true,
    },
    { ...ctx, scopeNote: 'the courses you manage' },
  );

  it('has the seven tabs and one row per course', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(['Summary', 'Courses', 'Sessions', 'Recordings', 'Assignments', 'History', 'Definitions']);
    expect(table(wb, 'Courses').map((r) => r.Course)).toEqual(['Hikam Foundations', 'Arabic I']);
  });

  it('lists sessions chronologically across courses, with the recording’s outcome on the excused ones', () => {
    const rows = table(wb, 'Sessions');
    expect(rows.map((r) => `${cellText(r.Date)} ${r.Course}`)).toEqual([
      '2026-09-01 Hikam Foundations',
      '2026-09-03 Arabic I',
      '2026-09-08 Hikam Foundations',
      '2026-09-15 Hikam Foundations',
      '2026-09-22 Hikam Foundations',
      '2026-10-13 Hikam Foundations',
    ]);
    expect(rows[0]).toMatchObject({ Mark: 'Excused', Outcome: 'Missed deadline' });
    expect(rows[3].Mark).toBe('not taken');
    expect(rows[5].Mark).toBe('not marked');
  });

  it('lists their work on every assignment, soonest due first, with what they were given back', () => {
    const rows = table(wb, 'Assignments', 1);
    expect(rows.map((r) => `${r.Assignment}: ${r['Where it stands']}`)).toEqual([
      'Reflection on the first hikma: Returned',
      'Recite the first hikma: Returned',
      'Vocabulary: Past due',
      'Short answer: intention: To grade',
    ]);
    expect(rows[0]).toMatchObject({ Grade: 8.5, Feedback: 'Well done.', Late: '' });
    expect(rows[1].Grade).toBe('Satisfactory');
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    expect(summary['Assignments, all courses']).toBe(
      '4 assigned · 2 returned · 1 with the teacher · 0 not in yet · 1 past due · 0 missed · average grade 85%',
    );
  });

  /*
   * THE SUMMARY SPEAKS THE DEFINITIONS TAB'S WORDS. A teacher reading the
   * Summary to a student says "one not in yet" of an essay whose date has
   * gone; the same file defines Not in yet as work whose date has not passed,
   * and its Assignments tab says Past due. Each figure is checked against the
   * rows of the Assignments tab that carry the same word.
   */
  it('the Summary counts each piece of work under the word its Assignments tab gives it', () => {
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    const said = new Map(
      summary['Assignments, all courses']
        .split(' · ')
        .map((part) => /^(\d+) (.+)$/.exec(part))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[2], Number(m[1])]),
    );
    const stands = table(wb, 'Assignments', 1).map((r) => String(r['Where it stands']));
    const rowsSaying = (...words: string[]) => stands.filter((s) => words.includes(s)).length;
    expect(said.get('not in yet')).toBe(rowsSaying('Not in yet'));
    expect(said.get('past due')).toBe(rowsSaying('Past due'));
    expect(said.get('missed')).toBe(rowsSaying('Missed'));
    expect(said.get('returned')).toBe(rowsSaying('Returned'));
    expect(said.get('with the teacher')).toBe(rowsSaying('To grade', 'Graded, to return'));
    // …and every word it uses is one the Definitions tab defines.
    const terms = new Set(WORKBOOK_DEFINITIONS.map(([t]) => t.toLowerCase()));
    for (const word of ['not in yet', 'past due', 'missed', 'returned']) expect(terms.has(word), word).toBe(true);
  });

  it('says so when the history read stopped at its cap, before the rows it has', () => {
    const cut = studentWorkbook(
      {
        student: { uid: S.fatima, name: 'Fatima Ahmed', email: 'fatima@example.com', status: 'active', createdAt: T('2026-08-24') },
        courses: [world],
        history: [{ at: T('2026-08-24'), actorUid: 'mgr', what: 'Enrolled in Hikam Foundations', courseId: COURSE, detail: '' }],
        historyComplete: false,
      },
      ctx,
    );
    const rows = sheet(cut, 'History').rows.slice(1).map((r) => r.map((c) => String(c.v ?? '')).join('|'));
    expect(rows[0]).toMatch(/Earlier changes are kept, but not in this file/);
    expect(sheet(wb, 'History').rows.slice(1).some((r) => r.some((c) => /Earlier changes/.test(String(c.v))))).toBe(false);
  });

  it('carries the scope and the history', () => {
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    expect(summary.Scope).toBe('the courses you manage');
    expect(summary['Catch-up, all courses']).toBe('0 completed · 0 still open · 1 missed deadline');
    expect(table(wb, 'History', 1).map((r) => r.What)).toEqual(['Enrolled in Hikam Foundations', 'Enrolled in Arabic I']);
  });
});
