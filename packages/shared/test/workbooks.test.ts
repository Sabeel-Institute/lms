import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildXlsx,
  courseStudentStats,
  courseWorkbook,
  excelSerial,
  readXlsx,
  studentWorkbook,
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
const enrol = (studentUid: string, joined: string, left?: string) => ({
  studentUid,
  courseId: COURSE,
  cohortId: 'aut26',
  active: !left,
  enrolledAt: T(joined),
  enrolledBy: 'adm',
  ...(left ? { unenrolledAt: T(left) } : {}),
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
    { studentUid: S.fatima, recordingId: 'r1', courseId: COURSE, positionMs: 1, listenedMs: 2_232_000, updatedAt: T('2026-09-10') },
    { studentUid: S.aminah, recordingId: 'r2', courseId: COURSE, positionMs: 1, listenedMs: 540_000, updatedAt: T('2026-10-09') },
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
  emails: new Map(),
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

    // Ayesha joined 10-10: only S5 is in her window.
    const ayesha = courseStudentStats(world, S.ayesha, ctx);
    expect(ayesha).toMatchObject({ held: 1, present: 1, required: 0 });
    expect(ayesha.marks.get('1')).toBe('—');
    // A register never taken is '·' for everyone in its window.
    expect(fatima.marks.get('3')).toBe('·');
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

  it('recordings closed on an archived class closes an open grant', () => {
    const off = { ...world, course: { ...world.course, effectiveActive: false, archivedAccess: false } };
    expect(courseStudentStats(off, S.aminah, ctx)).toMatchObject({ open: 0, closed: 1 });
  });
});

describe('courseWorkbook', () => {
  const wb = courseWorkbook(world, ctx);

  it('has the seven tabs, in order, with the Definitions last', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(['Summary', 'Students', 'Sessions', 'Register', 'Recordings', 'Detail', 'Definitions']);
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
    // present 8 of held 14 → 57%; completed 1 ÷ (1 + 1 missed) → 50%.
    expect(summary['Attendance rate (present ÷ held)']).toBe('57%');
    expect(summary['Catch-up rate (completed ÷ completed + missed)']).toBe('50%');
    expect(summary['Recordings published']).toBe('3 of 5 sessions');
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
  };
  const wb = studentWorkbook(
    {
      student: { uid: S.fatima, name: 'Fatima Ahmed', email: 'fatima@example.com', status: 'active', createdAt: T('2026-08-24') },
      courses: [world, other],
      history: [
        { at: T('2026-08-24'), actorUid: 'mgr', what: 'Enrolled in Hikam Foundations', courseId: COURSE, detail: '' },
        { at: T('2026-08-24', '12:01'), actorUid: 'mgr', what: 'Enrolled in Arabic I', courseId: 'arabic', detail: '' },
      ],
    },
    { ...ctx, scopeNote: 'the courses you manage' },
  );

  it('has the six tabs and one row per course', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(['Summary', 'Courses', 'Sessions', 'Recordings', 'History', 'Definitions']);
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

  it('carries the scope and the history', () => {
    const summary = Object.fromEntries(sheet(wb, 'Summary').rows.map((r) => [String(r[0].v), String(r[1].v)]));
    expect(summary.Scope).toBe('the courses you manage');
    expect(summary['Catch-up, all courses']).toBe('0 completed · 0 still open · 1 missed deadline');
    expect(table(wb, 'History', 1).map((r) => r.What)).toEqual(['Enrolled in Hikam Foundations', 'Enrolled in Arabic I']);
  });
});
