import { isOverdue, stampInZone, todayInZone } from './assignments';
import type { AssignmentDoc, CompletionDoc } from './assignments';
import { SCALE_LABELS, gradeText, submissionId, tallyCounts, workTally, courseworkCounts } from './coursework';
import type { CourseworkDoc, GradeDoc, StaffWorkState, SubmissionDoc, WorkTally } from './coursework';
import { effectiveCompletion } from './ledger';
import type { CompletionOverrideDoc } from './ledger';
import { isVisibleToStudents, listenedShare } from './recordings';
import type { ListeningProgressDoc, RecordingDoc } from './recordings';
import { canPlayFromCourse } from './structure';
import type { CourseDoc, EnrollmentDoc, SessionDoc } from './types';
import type { Cell, CellStyle, SheetSpec, WorkbookSpec } from './xlsx';

/**
 * The two export workbooks — a course, and a student — built as pure data.
 *
 * Nothing here reads Firestore: the app collects the documents a screen would
 * (with the same course-pinned queries the rules require) and hands them in;
 * this turns them into sheets, and `xlsx.ts` turns sheets into a file. Every
 * count on a sheet is derived once, by `courseStudentStats`, and every tab
 * that shows a total shows the same one — the Students tab's Held is the
 * Register tab's Held is the Summary's denominator. The unit tests hold those
 * identities.
 *
 * THE VOCABULARY IS THE DEFINITIONS TAB, printed into every workbook and into
 * the manual (`workbookDefinitions.test.ts` holds the two to the same words).
 *
 * Assignments are counted by `workTally` in `coursework.ts`, the function the
 * assignment screens count with, so a figure here is the figure there; the
 * Assignments tab's columns add up to the Grades tab's.
 */

// ------------------------------------------------------------ definitions --

export const WORKBOOK_DEFINITIONS: readonly [term: string, definition: string][] = [
  [
    'Held',
    'Registers submitted in which the student was marked, whatever the session’s date: a newcomer marked on an earlier session’s register, to catch them up, counts too. A session whose register was never taken is not held for anyone.',
  ],
  [
    'Present / Absent / Excused',
    'The mark on the register. Excused is the only mark that opens the recording and requires it.',
  ],
  ['Attendance rate', 'Present ÷ Held.'],
  [
    'Required',
    'Excused sessions whose recording is published — one recording the student must play and mark complete by its due date. A recording that has been archived or unpublished is withdrawn: it counts nowhere, and the Sessions tab says so.',
  ],
  [
    'Completed',
    'The student marked the recording complete, or staff overrode it as complete (the override’s reason is recorded).',
  ],
  ['Still open', 'Not yet completed, and the due date has not passed.'],
  [
    'Missed deadline',
    'Not completed by the due date. Access has closed; nothing further can happen to it unless the date is moved.',
  ],
  [
    'Closed',
    'Withdrawn before its date, so neither done nor missed: a required recording when the student left the class or the class was archived with its recordings closed; an assignment still open when its course was archived.',
  ],
  ['Catch-up rate', 'Completed ÷ (Completed + Missed deadline). Open and closed items are not held against anyone.'],
  [
    'Played',
    'Time played as a share of the recording’s length. Evidence, not the gate — completion is the student’s own mark.',
  ],
  [
    'Assigned',
    'Students an assignment went to, less any a teacher marked not required. Someone who left the class counts only if they handed something in first.',
  ],
  ['Handed in', 'Work given in, graded or not and late or not, and work graded on paper with nothing handed in.'],
  ['Late', 'Handed in after the student’s due date: their own date, if they were given more time.'],
  ['To grade', 'Handed in and not graded yet.'],
  ['To return', 'Graded but not given back yet. The student does not see the grade.'],
  ['Returned', 'Graded and given back. The grade is what the student sees.'],
  ['Not in yet', 'Nothing handed in, and the due date has not passed.'],
  ['Past due', 'Nothing handed in, the due date has passed, and late work is still taken.'],
  ['Missed', 'Nothing handed in by the last day work was taken, or before the teacher stopped taking it.'],
  ['Not required', 'A teacher let the student off the assignment, with a reason. It counts nowhere.'],
  [
    'Average grade',
    'Returned grades on assignments graded in points, each as a share of its points. Satisfactory and Needs work are not averaged.',
  ],
  ['Times', 'Institute time (America/Chicago). Dates are real dates; sort and filter them in Excel.'],
];

// ------------------------------------------------------------------ input --

export interface WorkbookCourse extends CourseDoc {
  id: string;
}
export interface WorkbookSession extends SessionDoc {
  id: string;
}
export interface WorkbookRecording extends RecordingDoc {
  id: string;
}
export interface WorkbookCoursework extends CourseworkDoc {
  id: string;
}

/** One course's worth of documents, as the rules let staff read them. */
export interface CourseData {
  course: WorkbookCourse;
  cohortName: string;
  sessions: WorkbookSession[];
  recordings: WorkbookRecording[];
  enrollments: EnrollmentDoc[];
  assignments: AssignmentDoc[];
  completions: CompletionDoc[];
  overrides: CompletionOverrideDoc[];
  progress: ListeningProgressDoc[];
  /** Its assignments, drafts included; every tab leaves drafts out. */
  coursework: WorkbookCoursework[];
  submissions: SubmissionDoc[];
  grades: GradeDoc[];
}

export interface WorkbookContext {
  /** uid → display name, for staff and students alike. */
  names: Map<string, string>;
  /** uid → email, where known. */
  emails: Map<string, string>;
  timeZone: string;
  /** `YYYY-MM-DD` in the institute's zone. */
  today: string;
  exportedAt: number;
  exportedBy: string;
  /** What the file covers, when it is less than everything: "the courses you manage". */
  scopeNote?: string;
}

// -------------------------------------------------------------- outcomes --

export type ListeningOutcome = 'completed' | 'open' | 'missed' | 'closed';

export interface RequiredItem {
  studentUid: string;
  session: WorkbookSession;
  recording: WorkbookRecording;
  outcome: ListeningOutcome;
  /** Share heard, or null when the recording's length is unknown. */
  heard: number | null;
  lastListened: number | null;
  completedAt: number | null;
  /** 'student', or the name of the staff member whose override made it complete. */
  markedBy: string | null;
  override: CompletionOverrideDoc | null;
}

export interface StudentCourseStats {
  studentUid: string;
  joined: string | null;
  left: string | null;
  enrolled: boolean;
  held: number;
  present: number;
  absent: number;
  excused: number;
  /** Registers inside their window that hold no mark for them. */
  unmarked: number;
  required: number;
  completed: number;
  open: number;
  missed: number;
  closed: number;
  items: RequiredItem[];
  /** One mark per session id: P / A / E, '·' not taken, '—' outside their window and unmarked. */
  marks: Map<string, string>;
}

function dateOf(ms: number | undefined, zone: string): string | null {
  return typeof ms === 'number' ? todayInZone(zone, ms) : null;
}

/**
 * The whole of one student's standing in one course. Both workbooks read it.
 */
export function courseStudentStats(
  data: CourseData,
  studentUid: string,
  ctx: WorkbookContext,
): StudentCourseStats {
  const enrollment = data.enrollments.find((e) => e.studentUid === studentUid);
  const joined = enrollment ? dateOf(enrollment.enrolledAt, ctx.timeZone) : null;
  const left = enrollment && !enrollment.active ? dateOf(enrollment.unenrolledAt, ctx.timeZone) : null;
  // When they last left, even if they have come back since.
  const lastLeft = dateOf(enrollment?.unenrolledAt, ctx.timeZone);
  const inWindow = (date: string) => (!joined || date >= joined) && (!left || date <= left);
  const playable = canPlayFromCourse(data.course);
  const recordingById = new Map(data.recordings.map((r) => [r.id, r]));
  const completionOf = new Map(
    data.completions.filter((c) => c.studentUid === studentUid).map((c) => [c.recordingId, c]),
  );
  const overrideOf = new Map(
    data.overrides.filter((o) => o.studentUid === studentUid).map((o) => [o.recordingId, o]),
  );
  const progressOf = new Map(
    data.progress.filter((p) => p.studentUid === studentUid).map((p) => [p.recordingId, p]),
  );
  const grantOf = new Map(
    data.assignments.filter((a) => a.studentUid === studentUid).map((a) => [a.recordingId, a]),
  );

  const stats: StudentCourseStats = {
    studentUid,
    joined,
    left,
    enrolled: !!enrollment?.active,
    held: 0,
    present: 0,
    absent: 0,
    excused: 0,
    unmarked: 0,
    required: 0,
    completed: 0,
    open: 0,
    missed: 0,
    closed: 0,
    items: [],
    marks: new Map(),
  };

  for (const session of [...data.sessions].sort((a, b) => a.date.localeCompare(b.date))) {
    const taken = session.attendanceSubmittedAt !== null;
    const mark = session.attendance[studentUid];
    /*
     * A MARK ON A TAKEN REGISTER COUNTS, whenever the session was. A class that
     * met before its roster was entered is marked afterwards, and a newcomer is
     * caught up by being excused on an earlier session's register (the brief's
     * late-enrolment step); the server grants on the mark, with no date window.
     * Dropping those left the file disagreeing with the register, the grants
     * and every screen. Only a session with no mark for them, outside the days
     * they were in the class, is '—'.
     */
    if (!(taken && mark) && !inWindow(session.date)) {
      stats.marks.set(session.id, '—');
      continue;
    }
    if (!taken) {
      stats.marks.set(session.id, '·');
      continue;
    }
    if (!mark) {
      stats.unmarked += 1;
      stats.marks.set(session.id, '');
      continue;
    }
    stats.held += 1;
    stats.marks.set(session.id, mark === 'present' ? 'P' : mark === 'absent' ? 'A' : 'E');
    if (mark === 'present') stats.present += 1;
    else if (mark === 'absent') stats.absent += 1;
    else stats.excused += 1;

    // REQUIRED LISTENING: excused, and the recording is published. A recording
    // archived or unpublished is withdrawn from every total (decided
    // 2026-09-11); a grant that was never made — attendance corrected since —
    // is nothing to count.
    if (mark !== 'excused' || !session.recordingId) continue;
    const recording = recordingById.get(session.recordingId);
    if (!recording || !isVisibleToStudents(recording.status)) continue;
    const grant = grantOf.get(recording.id);
    if (!grant) continue;

    const completion = completionOf.get(recording.id);
    const override = overrideOf.get(recording.id) ?? null;
    const eff = effectiveCompletion(completion, override);
    const progress = progressOf.get(recording.id);
    let outcome: ListeningOutcome;
    if (eff.completed) outcome = 'completed';
    // Left the class before the date: the date never closed on them. Nor on
    // one brought back since, whose grant leaving switched off and a date
    // already past did not switch on again: the ledger says closed too.
    else if (left && left < session.dueDate) outcome = 'closed';
    else if (!grant.active && lastLeft && lastLeft < session.dueDate) outcome = 'closed';
    else if (isOverdue(session.dueDate, ctx.today)) outcome = 'missed';
    else if (!grant.active || !playable) outcome = 'closed';
    else outcome = 'open';

    stats.required += 1;
    stats[outcome] += 1;
    stats.items.push({
      studentUid,
      session,
      recording,
      outcome,
      heard: progress ? listenedShare(progress.listenedMs, recording.durationSec) : 0,
      lastListened: progress?.updatedAt ?? null,
      completedAt: eff.completed
        ? eff.source === 'override'
          ? (override?.at ?? null)
          : (completion?.completedAt ?? null)
        : null,
      markedBy: eff.completed
        ? eff.source === 'override'
          ? (ctx.names.get(override?.overriddenBy ?? '') ?? 'staff')
          : 'student'
        : null,
      override,
    });
  }
  return stats;
}

// ------------------------------------------------------------ assignments --

/** One student's work on one posted assignment, and what it counts as. */
interface WorkItem {
  coursework: WorkbookCoursework;
  sub: SubmissionDoc;
  grade: GradeDoc | undefined;
  /** Null when it counts nowhere: they left the class with nothing in. */
  tally: WorkTally | null;
}

/** A course's posted assignments, by due date, and every piece of work on them. */
function courseWork(data: CourseData, ctx: WorkbookContext): { posted: WorkbookCoursework[]; work: WorkItem[] } {
  const posted = data.coursework
    .filter((cw) => cw.status === 'posted')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  const byId = new Map(posted.map((cw) => [cw.id, cw]));
  const gradeOf = new Map(data.grades.map((g) => [submissionId(g.studentUid, g.courseworkId), g]));
  const work = data.submissions.flatMap((sub) => {
    const coursework = byId.get(sub.courseworkId);
    if (!coursework) return [];
    const grade = gradeOf.get(submissionId(sub.studentUid, sub.courseworkId));
    const tally = workTally(coursework.grading, sub, grade, ctx.today, data.course.effectiveActive, ctx.timeZone);
    return [{ coursework, sub, grade, tally }];
  });
  return { posted, work };
}

// ------------------------------------------------------------------ cells --

const c = (v: Cell['v'], style?: CellStyle): Cell => ({ v, style });
const text = (v: string | null | undefined, style: CellStyle = 'text'): Cell => c(v ?? '', style);
const int = (v: number, style: CellStyle = 'int'): Cell => c(v, style);
const pct = (num: number, den: number): Cell => (den > 0 ? c(num / den, 'pct') : c('—', 'dim'));
/** A `YYYY-MM-DD` as a real date cell — UTC fields carry the civil date. */
const day = (d: string | null | undefined): Cell =>
  d ? c(new Date(Date.parse(`${d}T00:00:00Z`)), 'date') : c('', 'text');
/** A moment, as the institute's clock reads it, as a real date-time cell. */
const stamp = (ms: number | null | undefined, zone: string): Cell => {
  if (typeof ms !== 'number') return c('', 'text');
  const [d, t] = stampInZone(zone, ms).split(' ');
  return c(new Date(Date.parse(`${d}T${t}:00Z`)), 'datetime');
};
const outcomeText = (o: ListeningOutcome): string =>
  o === 'completed' ? 'Completed' : o === 'open' ? 'Still open' : o === 'missed' ? 'Missed deadline' : 'Closed';
const outcomeStyle = (o: ListeningOutcome): CellStyle =>
  o === 'completed' ? 'good' : o === 'open' ? 'open' : o === 'missed' ? 'missed' : 'dim';
const outcomeIntStyle = (o: ListeningOutcome, n: number): CellStyle =>
  n > 0 && o === 'missed' ? 'missedInt' : n > 0 && o === 'open' ? 'openInt' : 'int';
const gradingText = (cw: WorkbookCoursework) =>
  cw.grading.kind === 'points' ? `out of ${cw.grading.outOf}` : 'Satisfactory / Needs work';
const averageCell = (a: number | null): Cell => (a === null ? c('—', 'dim') : c(a, 'pct'));
const averageText = (a: number | null) => (a === null ? '—' : `${Math.round(a * 100)}%`);
const WORK_STATE_TEXT: Record<StaffWorkState, string> = {
  returned: 'Returned',
  graded: 'Graded, to return',
  toGrade: 'To grade',
  toDo: 'Not in yet',
  pastDue: 'Past due',
  missed: 'Missed',
  notRequired: 'Not required',
  closed: 'Closed',
};
const workStyle = (state: StaffWorkState): CellStyle =>
  state === 'missed' ? 'missed' : state === 'toGrade' || state === 'graded' || state === 'pastDue' ? 'open' : state === 'returned' ? 'text' : 'dim';
/** A grade as a cell: points as a number, so a column adds up; a scale mark in words. */
function gradeCell(w: WorkItem): Cell {
  if (w.tally?.state === 'returned') {
    const g = w.sub.returned?.grade ?? null;
    if (!g) return text('');
    return 'points' in g ? c(g.points, 'num') : text(SCALE_LABELS[g.scale]);
  }
  if (w.tally?.state === 'graded' && w.grade?.grade) return text(`${gradeText(w.grade.grade, w.coursework.grading)} · to return`, 'open');
  return text('');
}
/** One piece of work in the Grades grid: its grade once returned, where it stands otherwise. */
function gradebookCell(w: WorkItem | undefined): Cell {
  if (!w?.tally) return text('', 'dim');
  if (w.tally.state === 'returned' || (w.tally.state === 'graded' && w.grade?.grade)) {
    const cell = gradeCell(w);
    if (cell.v !== '') return cell;
  }
  return text(WORK_STATE_TEXT[w.tally.state].toLowerCase(), workStyle(w.tally.state));
}
const shortDate = (d: string) => d.slice(5);
const rate = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '—');

function definitionsSheet(): SheetSpec {
  return {
    name: 'Definitions',
    widths: [24, 110],
    rows: [
      [text('Term', 'head'), text('What it counts', 'head')],
      ...WORKBOOK_DEFINITIONS.map(([term, def]) => [text(term, 'bold'), text(def, 'note')]),
    ],
    freeze: { rows: 1, cols: 0 },
  };
}

/** Two header rows: merged group titles over their sub-columns. */
function groupedHeader(
  groups: { title: string; cols: string[] }[],
): { rows: Cell[][]; merges: SheetSpec['merges'] } {
  const top: Cell[] = [];
  const second: Cell[] = [];
  const merges: NonNullable<SheetSpec['merges']> = [];
  let col = 0;
  for (const g of groups) {
    for (let i = 0; i < g.cols.length; i += 1) top.push(text(i === 0 ? g.title : '', g.title ? 'group' : 'head'));
    if (g.title && g.cols.length > 1) merges.push({ r1: 0, c1: col, r2: 0, c2: col + g.cols.length - 1 });
    for (const name of g.cols) second.push(text(name, 'head'));
    col += g.cols.length;
  }
  return { rows: [top, second], merges };
}

// --------------------------------------------------------- course workbook --

export function courseWorkbook(data: CourseData, ctx: WorkbookContext): WorkbookSpec {
  const name = (uid: string) => ctx.names.get(uid) ?? uid;
  const sessions = [...data.sessions].sort((a, b) => a.date.localeCompare(b.date));
  const recordingById = new Map(data.recordings.map((r) => [r.id, r]));
  const roster = [...data.enrollments]
    .map((e) => e.studentUid)
    .sort((a, b) => name(a).localeCompare(name(b)));
  const stats = new Map(roster.map((uid) => [uid, courseStudentStats(data, uid, ctx)]));
  const all = [...stats.values()];
  const sum = (k: keyof StudentCourseStats) => all.reduce((n, s) => n + (s[k] as number), 0);
  const published = sessions.filter((s) => {
    const r = s.recordingId ? recordingById.get(s.recordingId) : undefined;
    return r && isVisibleToStudents(r.status);
  });
  const status = !data.course.effectiveActive
    ? `Archived · recordings ${data.course.archivedAccess ? 'open' : 'closed'}`
    : 'Running';
  const { posted, work } = courseWork(data, ctx);
  const workOf = new Map(work.map((w) => [submissionId(w.sub.studentUid, w.coursework.id), w]));
  const allWork = tallyCounts(work.map((w) => w.tally));

  // Summary
  const summary: SheetSpec = {
    name: 'Summary',
    widths: [36, 60],
    rows: [
      [text(data.course.name, 'title'), text('')],
      [text('Cohort', 'bold'), text(data.cohortName)],
      [text('Status', 'bold'), text(status)],
      [text('Managers', 'bold'), text(data.course.managerUids.map(name).join(', ') || '—')],
      [
        text('Students on roster', 'bold'),
        text(`${all.filter((s) => s.enrolled).length}${all.some((s) => !s.enrolled) ? ` (${all.filter((s) => !s.enrolled).length} left during the term)` : ''}`),
      ],
      [
        text('Sessions / registers taken', 'bold'),
        text(`${sessions.length} / ${sessions.filter((s) => s.attendanceSubmittedAt !== null).length}`),
      ],
      [text('Attendance rate (present ÷ held)', 'bold'), text(rate(sum('present'), sum('held')))],
      [text('Recordings published', 'bold'), text(`${published.length} of ${sessions.length} sessions`)],
      [text('Catch-up rate (completed ÷ completed + missed)', 'bold'), text(rate(sum('completed'), sum('completed') + sum('missed')))],
      [
        text('Still open', 'bold'),
        text(`${sum('open')} required recording${sum('open') === 1 ? '' : 's'}, ${all.filter((s) => s.open > 0).length} student${all.filter((s) => s.open > 0).length === 1 ? '' : 's'}`),
      ],
      [text('Assignments posted', 'bold'), text(String(posted.length))],
      [text('Work to grade', 'bold'), text(String(allWork.toGrade))],
      [text('Average grade (returned, in points)', 'bold'), text(averageText(allWork.average))],
      [text('Exported', 'bold'), text(`${stampInZone(ctx.timeZone, ctx.exportedAt)} · by ${ctx.exportedBy}`)],
      ...(ctx.scopeNote ? [[text('Scope', 'bold'), text(ctx.scopeNote)]] : []),
    ],
  };

  // Students
  const studentsHeader = groupedHeader([
    { title: '', cols: ['Student'] },
    { title: 'Enrolment', cols: ['Joined', 'Left', 'Status'] },
    { title: 'Attendance', cols: ['Held', 'Present', 'Absent', 'Excused', 'Rate'] },
    { title: 'Catch-up on excused sessions', cols: ['Required', 'Completed', 'Still open', 'Missed deadline', 'Closed', 'Rate'] },
    { title: '', cols: ['Note'] },
  ]);
  const studentRows = [...all]
    .sort((a, b) => b.missed - a.missed || b.absent - a.absent || name(a.studentUid).localeCompare(name(b.studentUid)))
    .map((s) => {
      const notes: string[] = [];
      if (s.unmarked > 0) notes.push(`${s.unmarked} register${s.unmarked === 1 ? '' : 's'} without a mark for them`);
      if (s.closed > 0) notes.push(`${s.closed} closed: ${s.left ? 'left the class' : 'recordings closed'}`);
      const byOverride = s.items.filter((i) => i.outcome === 'completed' && i.override?.completed).length;
      if (byOverride > 0) notes.push(`${byOverride} completion${byOverride === 1 ? '' : 's'} by override`);
      return [
        text(name(s.studentUid)),
        day(s.joined),
        day(s.left),
        text(s.enrolled ? 'Enrolled' : 'Left'),
        int(s.held),
        int(s.present),
        int(s.absent),
        int(s.excused),
        pct(s.present, s.held),
        int(s.required),
        int(s.completed),
        int(s.open, outcomeIntStyle('open', s.open)),
        int(s.missed, outcomeIntStyle('missed', s.missed)),
        int(s.closed),
        pct(s.completed, s.completed + s.missed),
        text(notes.join(' · '), 'note'),
      ];
    });
  const students: SheetSpec = {
    name: 'Students',
    widths: [28, 12, 12, 10, 8, 9, 9, 9, 8, 10, 10, 10, 15, 8, 8, 40],
    rows: [...studentsHeader.rows, ...studentRows],
    merges: studentsHeader.merges,
    freeze: { rows: 2, cols: 1 },
    filterRow: 2,
  };

  // Sessions
  const sessionsHeader = groupedHeader([
    { title: '', cols: ['Date', 'Session'] },
    { title: 'Register', cols: ['Taken on', 'Present', 'Absent', 'Excused'] },
    { title: 'Recording', cols: ['Status', 'Published', 'Due by'] },
    { title: 'Catch-up (excused)', cols: ['Completed', 'Still open', 'Missed deadline', 'Closed'] },
    { title: '', cols: ['Note'] },
  ]);
  const sessionRows = sessions.map((s) => {
    const taken = s.attendanceSubmittedAt !== null;
    const marks = Object.values(s.attendance);
    const count = (m: string) => (taken ? int(marks.filter((x) => x === m).length) : text('—', 'dim'));
    const rec = s.recordingId ? recordingById.get(s.recordingId) : undefined;
    const live = !!rec && isVisibleToStudents(rec.status);
    const items = all.flatMap((st) => st.items.filter((i) => i.session.id === s.id));
    const tally = (o: ListeningOutcome) => (live ? int(items.filter((i) => i.outcome === o).length, outcomeIntStyle(o, items.filter((i) => i.outcome === o).length)) : text('—', 'dim'));
    const note = s.notRecorded
      ? 'marked not recorded'
      : !rec
        ? taken
          ? 'no recording yet'
          : ''
        : !live
          ? `${rec.status} — withdrawn from the totals`
          : !taken
            ? 'register not taken: recording open to nobody'
            : '';
    return [
      day(s.date),
      text(s.title),
      taken ? stamp(s.attendanceSubmittedAt, ctx.timeZone) : text('', 'text'),
      count('present'),
      count('absent'),
      count('excused'),
      text(s.notRecorded ? 'Not recorded' : rec ? rec.status[0].toUpperCase() + rec.status.slice(1) : 'None'),
      rec?.publishedAt ? stamp(rec.publishedAt, ctx.timeZone) : text(''),
      day(s.dueDate),
      tally('completed'),
      tally('open'),
      tally('missed'),
      tally('closed'),
      text(note, 'note'),
    ];
  });
  const sessionsSheet: SheetSpec = {
    name: 'Sessions',
    widths: [12, 44, 17, 9, 9, 9, 14, 17, 12, 10, 10, 15, 8, 44],
    rows: [...sessionsHeader.rows, ...sessionRows],
    merges: sessionsHeader.merges,
    freeze: { rows: 2, cols: 2 },
    filterRow: 2,
  };

  // Register: students down, sessions across.
  const registerHeader = groupedHeader([
    { title: '', cols: ['Student'] },
    { title: 'Sessions', cols: sessions.map((s) => `${shortDate(s.date)}\n${s.title}`) },
    { title: 'Totals', cols: ['Held', 'P', 'A', 'E'] },
  ]);
  const registerRows = roster.map((uid) => {
    const s = stats.get(uid)!;
    return [
      text(name(uid)),
      ...sessions.map((se) => {
        const m = s.marks.get(se.id) ?? '';
        return text(m, m === '—' || m === '·' ? 'dim' : m === 'E' ? 'open' : 'text');
      }),
      int(s.held),
      int(s.present),
      int(s.absent),
      int(s.excused),
    ];
  });
  const register: SheetSpec = {
    name: 'Register',
    widths: [28, ...sessions.map(() => 9), 8, 6, 6, 6],
    rows: [...registerHeader.rows, ...registerRows],
    merges: registerHeader.merges,
    freeze: { rows: 2, cols: 1 },
  };

  // Listening: students down, published recordings across.
  const listeningHeader = groupedHeader([
    { title: '', cols: ['Student'] },
    { title: 'Recordings (due by)', cols: published.map((s) => `${s.title}\nby ${shortDate(s.dueDate)}`) },
    { title: 'Totals', cols: ['Required', 'Completed', 'Open', 'Missed', 'Closed'] },
  ]);
  const listeningRows = roster.map((uid) => {
    const s = stats.get(uid)!;
    return [
      text(name(uid)),
      ...published.map((se) => {
        const item = s.items.find((i) => i.session.id === se.id);
        if (!item) return text('', 'dim');
        const heard = item.heard === null ? '' : ` · ${Math.round(item.heard * 100)}%`;
        const when = item.completedAt ? ` ${shortDate(todayInZone(ctx.timeZone, item.completedAt))}` : '';
        const label =
          item.outcome === 'completed'
            ? `${item.override?.completed ? 'override' : 'completed'}${when}`
            : `${item.outcome === 'open' ? 'open' : item.outcome === 'missed' ? 'missed' : 'closed'}${heard}`;
        return text(label, outcomeStyle(item.outcome));
      }),
      int(s.required),
      int(s.completed),
      int(s.open, outcomeIntStyle('open', s.open)),
      int(s.missed, outcomeIntStyle('missed', s.missed)),
      int(s.closed),
    ];
  });
  const listening: SheetSpec = {
    name: 'Recordings',
    widths: [28, ...published.map(() => 16), 9, 9, 7, 8, 8],
    rows: [...listeningHeader.rows, ...listeningRows],
    merges: listeningHeader.merges,
    freeze: { rows: 2, cols: 1 },
  };

  // Detail
  const detail: SheetSpec = {
    name: 'Detail',
    widths: [28, 12, 40, 12, 16, 8, 17, 17, 16, 20, 17, 44],
    rows: [
      ...groupedHeader([
        { title: '', cols: ['Student', 'Session', 'Recording'] },
        { title: 'Deadline', cols: ['Due by', 'Outcome'] },
        { title: 'Progress', cols: ['Played', 'Last played', 'Completed at', 'Marked by'] },
        { title: 'Override', cols: ['By', 'On', 'Reason'] },
      ]).rows,
      ...all.flatMap((s) =>
        s.items.map((i) => [
          text(name(s.studentUid)),
          day(i.session.date),
          text(i.recording.title),
          day(i.session.dueDate),
          text(outcomeText(i.outcome), outcomeStyle(i.outcome)),
          i.heard === null ? text('', 'dim') : c(i.heard, 'pct'),
          stamp(i.lastListened, ctx.timeZone),
          stamp(i.completedAt, ctx.timeZone),
          text(i.markedBy ?? ''),
          text(i.override ? name(i.override.overriddenBy) : ''),
          stamp(i.override?.at, ctx.timeZone),
          text(i.override?.reason ?? '', 'note'),
        ]),
      ),
    ],
    merges: groupedHeader([
      { title: '', cols: ['Student', 'Session', 'Recording'] },
      { title: 'Deadline', cols: ['Due by', 'Outcome'] },
      { title: 'Progress', cols: ['Played', 'Last played', 'Completed at', 'Marked by'] },
      { title: 'Override', cols: ['By', 'On', 'Reason'] },
    ]).merges,
    freeze: { rows: 2, cols: 1 },
    filterRow: 2,
  };

  // Assignments: one row each, counted as the assignment's own page counts.
  const assignmentsHeader = groupedHeader([
    { title: '', cols: ['Assignment', 'Posted', 'Due', 'Late work until', 'Graded'] },
    { title: 'Work', cols: ['Assigned', 'Handed in', 'Late', 'To grade', 'To return', 'Returned'] },
    { title: 'Nothing in', cols: ['Not in yet', 'Past due', 'Missed'] },
    { title: '', cols: ['Not required', 'Average', 'Note'] },
  ]);
  const assignmentRows = posted.map((cw) => {
    const mine = work.filter((w) => w.coursework.id === cw.id);
    const n = courseworkCounts(
      cw.grading,
      mine.map((w) => w.sub),
      new Map(mine.filter((w) => w.grade).map((w) => [w.sub.studentUid, w.grade!])),
      ctx.today,
      data.course.effectiveActive,
      ctx.timeZone,
    );
    const notes: string[] = [];
    if (cw.closedAt !== null) notes.push(`stopped taking work ${todayInZone(ctx.timeZone, cw.closedAt)}`);
    if (n.closed > 0) notes.push(`${n.closed} closed when the course was archived`);
    return [
      text(cw.title),
      stamp(cw.postedAt, ctx.timeZone),
      day(cw.dueDate),
      day(cw.lateUntil),
      text(gradingText(cw)),
      int(n.expected),
      int(n.handedIn),
      int(n.late),
      int(n.toGrade, n.toGrade > 0 ? 'openInt' : 'int'),
      int(n.toReturn),
      int(n.returned),
      int(n.notInYet),
      int(n.pastDue, n.pastDue > 0 ? 'openInt' : 'int'),
      int(n.missed, n.missed > 0 ? 'missedInt' : 'int'),
      int(n.notRequired),
      averageCell(n.average),
      text(notes.join(' · '), 'note'),
    ];
  });
  const assignments: SheetSpec = {
    name: 'Assignments',
    widths: [40, 17, 12, 14, 24, 9, 10, 7, 9, 9, 9, 10, 9, 8, 12, 9, 40],
    rows: [...assignmentsHeader.rows, ...assignmentRows],
    merges: assignmentsHeader.merges,
    freeze: { rows: 2, cols: 1 },
    filterRow: 2,
  };

  // Grades: students down, assignments across, as Register is for sessions.
  const gradesHeader = groupedHeader([
    { title: '', cols: ['Student'] },
    { title: 'Assignments', cols: posted.map((cw) => `${cw.title}\ndue ${shortDate(cw.dueDate)} · ${gradingText(cw)}`) },
    { title: 'Totals', cols: ['Assigned', 'Handed in', 'Late', 'Returned', 'Missed', 'Average'] },
  ]);
  const gradeRows = roster.map((uid) => {
    const mine = posted.map((cw) => workOf.get(submissionId(uid, cw.id)));
    const n = tallyCounts(mine.map((w) => w?.tally ?? null));
    return [
      text(name(uid)),
      ...mine.map(gradebookCell),
      int(n.expected),
      int(n.handedIn),
      int(n.late),
      int(n.returned),
      int(n.missed, n.missed > 0 ? 'missedInt' : 'int'),
      averageCell(n.average),
    ];
  });
  const grades: SheetSpec = {
    name: 'Grades',
    widths: [28, ...posted.map(() => 18), 9, 10, 7, 9, 8, 9],
    rows: [...gradesHeader.rows, ...gradeRows],
    merges: gradesHeader.merges,
    freeze: { rows: 2, cols: 1 },
  };

  return {
    sheets: [summary, students, sessionsSheet, register, listening, detail, assignments, grades, definitionsSheet()],
  };
}

// -------------------------------------------------------- student workbook --

export interface StudentHistoryRow {
  at: number;
  actorUid: string;
  what: string;
  courseId: string | null;
  detail: string;
}

export interface StudentWorkbookInput {
  student: { uid: string; name: string; email: string; status: string; createdAt: number };
  /** Every course the file covers, each with its documents. */
  courses: CourseData[];
  history: StudentHistoryRow[];
  /** False when the history read stopped at its cap, so the earliest of it is not here. */
  historyComplete: boolean;
}

export function studentWorkbook(input: StudentWorkbookInput, ctx: WorkbookContext): WorkbookSpec {
  const name = (uid: string) => ctx.names.get(uid) ?? uid;
  const uid = input.student.uid;
  const perCourse = input.courses
    .map((data) => ({ data, stats: courseStudentStats(data, uid, ctx) }))
    .filter(({ data }) => data.enrollments.some((e) => e.studentUid === uid));
  const sum = (k: keyof StudentCourseStats) => perCourse.reduce((n, { stats }) => n + (stats[k] as number), 0);
  const current = perCourse.filter(({ stats, data }) => stats.enrolled && data.course.effectiveActive).length;
  const status = (data: CourseData) =>
    !data.course.effectiveActive ? `Archived · recordings ${data.course.archivedAccess ? 'open' : 'closed'}` : 'Running';
  // Their work on every posted assignment, soonest due first; work that
  // counts nowhere (they left with nothing in) is not theirs to answer for.
  const myWork = perCourse
    .flatMap(({ data }) => courseWork(data, ctx).work.map((w) => ({ course: data.course.name, w })))
    .filter(({ w }) => w.sub.studentUid === uid && w.tally !== null)
    .sort((a, b) => a.w.sub.dueDate.localeCompare(b.w.sub.dueDate) || a.w.coursework.title.localeCompare(b.w.coursework.title));
  const work = tallyCounts(myWork.map(({ w }) => w.tally));

  const summary: SheetSpec = {
    name: 'Summary',
    widths: [30, 60],
    rows: [
      [text(input.student.name, 'title'), text('')],
      [text('Email', 'bold'), text(input.student.email)],
      [
        text('Account', 'bold'),
        text(`${input.student.status[0].toUpperCase()}${input.student.status.slice(1)} · created ${todayInZone(ctx.timeZone, input.student.createdAt)}`),
      ],
      [text('Courses', 'bold'), text(`${current} current, ${perCourse.length - current} finished or left`)],
      [
        text('Attendance, all courses', 'bold'),
        text(`${sum('present')} of ${sum('held')} sessions present (${rate(sum('present'), sum('held'))})`),
      ],
      [
        text('Catch-up, all courses', 'bold'),
        text(`${sum('completed')} completed · ${sum('open')} still open · ${sum('missed')} missed deadline${sum('closed') ? ` · ${sum('closed')} closed` : ''}`),
      ],
      [
        text('Assignments, all courses', 'bold'),
        text(
          `${work.expected} assigned · ${work.returned} returned · ${work.toGrade + work.toReturn} with the teacher · ${work.notInYet + work.pastDue} not in yet · ${work.missed} missed · average grade ${averageText(work.average)}`,
        ),
      ],
      [text('Scope', 'bold'), text(ctx.scopeNote ?? 'every course')],
      [text('Exported', 'bold'), text(`${stampInZone(ctx.timeZone, ctx.exportedAt)} · by ${ctx.exportedBy}`)],
    ],
  };

  const coursesHeader = groupedHeader([
    { title: '', cols: ['Course', 'Cohort'] },
    { title: 'Enrolment', cols: ['Joined', 'Left', 'Course status'] },
    { title: 'Attendance', cols: ['Held', 'Present', 'Absent', 'Excused', 'Rate'] },
    { title: 'Catch-up on excused sessions', cols: ['Required', 'Completed', 'Still open', 'Missed deadline', 'Closed'] },
  ]);
  const courses: SheetSpec = {
    name: 'Courses',
    widths: [30, 18, 12, 12, 24, 8, 9, 9, 9, 8, 10, 10, 10, 15, 8],
    rows: [
      ...coursesHeader.rows,
      ...perCourse.map(({ data, stats }) => [
        text(data.course.name),
        text(data.cohortName),
        day(stats.joined),
        day(stats.left),
        text(status(data)),
        int(stats.held),
        int(stats.present),
        int(stats.absent),
        int(stats.excused),
        pct(stats.present, stats.held),
        int(stats.required),
        int(stats.completed),
        int(stats.open, outcomeIntStyle('open', stats.open)),
        int(stats.missed, outcomeIntStyle('missed', stats.missed)),
        int(stats.closed),
      ]),
    ],
    merges: coursesHeader.merges,
    freeze: { rows: 2, cols: 1 },
    filterRow: 2,
  };

  // Sessions: every session in their window, chronological across courses.
  const sessionRows = perCourse
    .flatMap(({ data, stats }) =>
      data.sessions
        .filter((s) => (stats.marks.get(s.id) ?? '—') !== '—')
        .map((s) => {
          const m = stats.marks.get(s.id) ?? '';
          const item = stats.items.find((i) => i.session.id === s.id);
          const mark = m === 'P' ? 'Present' : m === 'A' ? 'Absent' : m === 'E' ? 'Excused' : m === '·' ? 'not taken' : 'not marked';
          return {
            date: s.date,
            cells: [
              day(s.date),
              text(data.course.name),
              text(s.title),
              text(mark, m === 'P' || m === 'A' || m === 'E' ? 'text' : 'dim'),
              item ? day(s.dueDate) : text(''),
              item ? text(outcomeText(item.outcome), outcomeStyle(item.outcome)) : text(''),
              item ? stamp(item.completedAt, ctx.timeZone) : text(''),
            ],
          };
        }),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => r.cells);
  const sessionsHeader = groupedHeader([
    { title: '', cols: ['Date', 'Course', 'Session', 'Mark'] },
    { title: 'If excused: the recording', cols: ['Due by', 'Outcome', 'On'] },
  ]);
  const sessions: SheetSpec = {
    name: 'Sessions',
    widths: [12, 26, 44, 11, 12, 16, 17],
    rows: [...sessionsHeader.rows, ...sessionRows],
    merges: sessionsHeader.merges,
    freeze: { rows: 2, cols: 0 },
    filterRow: 2,
  };

  const listening: SheetSpec = {
    name: 'Recordings',
    widths: [26, 40, 12, 16, 8, 17, 17, 44],
    rows: [
      [
        text('Course', 'head'),
        text('Recording', 'head'),
        text('Due by', 'head'),
        text('Outcome', 'head'),
        text('Played', 'head'),
        text('Last played', 'head'),
        text('Completed at', 'head'),
        text('Override by / reason', 'head'),
      ],
      ...perCourse.flatMap(({ data, stats }) =>
        stats.items.map((i) => [
          text(data.course.name),
          text(i.recording.title),
          day(i.session.dueDate),
          text(outcomeText(i.outcome), outcomeStyle(i.outcome)),
          i.heard === null ? text('', 'dim') : c(i.heard, 'pct'),
          stamp(i.lastListened, ctx.timeZone),
          stamp(i.completedAt, ctx.timeZone),
          text(i.override ? `${name(i.override.overriddenBy)} — ${i.override.reason}` : '', 'note'),
        ]),
      ),
    ],
    freeze: { rows: 1, cols: 0 },
    filterRow: 1,
  };

  const assignments: SheetSpec = {
    name: 'Assignments',
    widths: [26, 36, 12, 18, 17, 7, 14, 17, 50],
    rows: [
      [
        text('Course', 'head'),
        text('Assignment', 'head'),
        text('Due', 'head'),
        text('Where it stands', 'head'),
        text('Handed in', 'head'),
        text('Late', 'head'),
        text('Grade', 'head'),
        text('Returned', 'head'),
        text('Feedback', 'head'),
      ],
      ...myWork.map(({ course, w }) => {
        const state = w.tally!.state;
        return [
          text(course),
          text(w.coursework.title),
          day(w.sub.dueDate),
          text(WORK_STATE_TEXT[state], workStyle(state)),
          stamp(w.sub.handedInAt, ctx.timeZone),
          text(w.tally!.late ? 'Late' : ''),
          gradeCell(w),
          stamp(state === 'returned' ? w.sub.returned?.at : null, ctx.timeZone),
          text(state === 'returned' ? (w.sub.returned?.feedback ?? '') : '', 'note'),
        ];
      }),
    ],
    freeze: { rows: 1, cols: 0 },
    filterRow: 1,
  };

  const courseName = new Map(input.courses.map((d) => [d.course.id, d.course.name]));
  const history: SheetSpec = {
    name: 'History',
    widths: [17, 24, 30, 26, 60],
    rows: [
      [text('When', 'head'), text('Who', 'head'), text('What', 'head'), text('Course', 'head'), text('Detail', 'head')],
      ...(input.historyComplete
        ? []
        : [[text(''), text(''), text('Earlier changes are kept, but not in this file: it holds the most recent.', 'note')]]),
      ...[...input.history]
        .sort((a, b) => a.at - b.at)
        .map((h) => [
          stamp(h.at, ctx.timeZone),
          text(name(h.actorUid)),
          text(h.what),
          text(h.courseId ? (courseName.get(h.courseId) ?? h.courseId) : ''),
          text(h.detail, 'note'),
        ]),
    ],
    freeze: { rows: 1, cols: 0 },
    filterRow: 1,
  };

  return { sheets: [summary, courses, sessions, listening, assignments, history, definitionsSheet()] };
}
