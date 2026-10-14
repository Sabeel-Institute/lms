import { DUE_SOON_DAYS } from './constants';
import { addDays, daysUntilDue, isOverdue, todayInZone } from './assignments';

/**
 * Assignments a teacher posts to a whole class, and each student's work on
 * them (docs/plans/ASSIGNMENTS.md, approved proposal
 * docs/proposals/lms-assignments-proposal.html).
 *
 * NAMED `coursework`, NOT `assignments`: that collection is the listening
 * grant, and has been since before this feature. Only the interface says
 * "assignment". An assignment is independent of the register: attendance
 * plays no part in who gets one, and an assignment never opens a recording.
 *
 * Every date here is a civil date, `YYYY-MM-DD` in the institute's timezone,
 * like a session's listen-by date, and the same two rules hold: nothing is
 * ever written in the past, and everything open has a day it closes.
 */

// ---------------------------------------------------------------- grading --

/** Points out of a whole number, or satisfactory / needs work. */
export type CourseworkGrading = { kind: 'points'; outOf: number } | { kind: 'scale' };

export type ScaleMark = 'satisfactory' | 'needsWork';

/** A grade as staff save it: points (halves allowed) or a scale mark. */
export type Grade = { points: number } | { scale: ScaleMark };

export const SCALE_LABELS: Record<ScaleMark, string> = {
  satisfactory: 'Satisfactory',
  needsWork: 'Needs work',
};

export const MAX_POINTS = 1000;

/** Whether a grade fits the way an assignment is graded. */
export function gradeFits(grade: Grade, grading: CourseworkGrading): boolean {
  if (grading.kind === 'points') {
    if (!('points' in grade)) return false;
    const p = grade.points;
    return Number.isFinite(p) && p >= 0 && p <= grading.outOf && Number.isInteger(p * 2);
  }
  return 'scale' in grade && (grade.scale === 'satisfactory' || grade.scale === 'needsWork');
}

/** A grade in a few characters: "8.5/10", "Satisfactory". */
export function gradeText(grade: Grade, grading: CourseworkGrading): string {
  if ('scale' in grade) return SCALE_LABELS[grade.scale];
  return grading.kind === 'points' ? `${grade.points}/${grading.outOf}` : String(grade.points);
}

// ------------------------------------------------------------------ files --

/**
 * What may be attached, to an assignment or to a student's work, by
 * extension, and the content type it is stored under. Video is refused
 * everywhere: it is the cost cliff the product avoids for attachments.
 * A phone turns HEIC into JPEG before upload; a HEIC chosen on a computer is
 * refused with a request for a JPEG, since most browsers cannot show one.
 */
export const ATTACHMENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
} as const;

export type AttachmentContentType = (typeof ATTACHMENT_TYPES)[keyof typeof ATTACHMENT_TYPES];

export type AttachmentKind = 'document' | 'image' | 'audio';

/**
 * How long a written answer may be, as stored (the editor's markdown): about
 * 3,000 words, as long as a teacher's instructions may be. Longer work goes
 * in a document. Every handed-in answer sits on its submission with the
 * earlier attempts', and the teachers' screens read a class's submissions
 * whole, so the cap also keeps those reads small. `firestore.rules` holds the
 * draft to it (`rules.coursework.test.ts` holds the two together).
 */
export const MAX_ANSWER_CHARS = 20_000;

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 2 ** 20;
/** A teacher's audio is for examples and corrections, not for handing out class recordings. */
export const MAX_TEACHER_AUDIO_SEC = 15 * 60;

/** The content type a file is stored under, from its name; null if it may not be attached. */
export function attachmentContentType(fileName: string): AttachmentContentType | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext && ext in ATTACHMENT_TYPES ? ATTACHMENT_TYPES[ext as keyof typeof ATTACHMENT_TYPES] : null;
}

export function attachmentKind(contentType: string): AttachmentKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Why a file cannot be attached, in a sentence; null when it can. */
export function attachmentProblem(fileName: string, sizeBytes: number): string | null {
  if (/\.(heic|heif)$/i.test(fileName)) return 'This browser cannot show HEIC pictures. Save it as a JPEG and add that.';
  if (!attachmentContentType(fileName)) {
    return 'Not a file the app takes. Use a document (PDF, Word, PowerPoint, Excel, text), a picture (JPEG, PNG, WebP) or audio.';
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) return 'Too large: a file can be 25 MB at most.';
  if (sizeBytes === 0) return 'This file is empty.';
  return null;
}

/** A file on an assignment or on a student's work, once it has arrived. */
export interface AttachmentFile {
  id: string;
  name: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  /** An audio file's length, read from the file; null for anything else. */
  durationSec: number | null;
  storageKey: string;
  /**
   * When its upload began, which is the order it was chosen in, and the order
   * lists show. Not when it arrived: a small file chosen after a large one
   * arrives first.
   */
  addedAt: number;
}

export type AttachmentMap = Record<string, AttachmentFile>;

// -------------------------------------------------------------- documents --

export type CourseworkStatus = 'draft' | 'posted';

/** `coursework/{id}` — one assignment, written only by callables. */
export interface CourseworkDoc {
  courseId: string;
  cohortId: string;
  title: string;
  /** Markdown in the five-element vocabulary of `richtext.ts`. */
  instructions: string;
  files: AttachmentMap;
  dueDate: string;
  /** The last day late work is taken; null when late work is off. */
  lateUntil: string | null;
  grading: CourseworkGrading;
  status: CourseworkStatus;
  /** Set when a teacher stops accepting work before its dates. */
  closedAt: number | null;
  postedAt: number | null;
  postedBy: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  /** When a POSTED assignment last changed, which students see as "Updated". */
  editedAt: number | null;
}

/** What a student's work holds: a note and files. */
export interface WorkContent {
  note: string;
  files: AttachmentMap;
}

/** A grade as the student receives it, copied when the work is returned. */
export interface ReturnedGrade {
  grade: Grade | null;
  feedback: string;
  at: number;
  /** Counts returns of this work, so a second return is a new message. */
  seq: number;
  /** The teacher asked for another try. */
  retry: boolean;
}

/** One earlier attempt, kept when another try is asked for. */
export interface PastAttempt extends WorkContent {
  attempt: number;
  handedInAt: number | null;
  returned: ReturnedGrade;
}

export type SubmissionState = 'open' | 'handedIn' | 'returned';

/** A teacher's word on one student's work, with the reason the student sees. */
export interface StaffNote {
  reason: string;
  by: string;
  at: number;
}

/**
 * `submissions/{uid}_{courseworkId}` — one student's work on one assignment,
 * written only by the server: the fan-out creates it, hand-in and return
 * change it. The dates are the student's own (more time moves them), copied
 * from the assignment otherwise.
 */
export interface SubmissionDoc extends WorkContent {
  studentUid: string;
  courseworkId: string;
  courseId: string;
  cohortId: string;
  /** False once the student has left the course; their work stays as record. */
  active: boolean;
  dueDate: string;
  lateUntil: string | null;
  /** The assignment was closed early by its teacher. */
  closedEarly: boolean;
  state: SubmissionState;
  attempt: number;
  handedInAt: number | null;
  returned: ReturnedGrade | null;
  attempts: PastAttempt[];
  notRequired: StaffNote | null;
  moreTime: StaffNote | null;
  assignedAt: number;
}

/** `drafts/{uid}_{courseworkId}` — the student's unsent work. No staff ever reads it. */
export interface DraftDoc extends WorkContent {
  studentUid: string;
  courseworkId: string;
  courseId: string;
  updatedAt: number;
}

/** `grades/{uid}_{courseworkId}` — the grade as staff are writing it. Never student-readable. */
export interface GradeDoc {
  studentUid: string;
  courseworkId: string;
  courseId: string;
  grade: Grade | null;
  feedback: string;
  gradedBy: string;
  gradedAt: number;
  /** Graded with nothing handed in: work done on paper, or recited in class. */
  withoutHandIn: boolean;
}

export type SubmissionEventKind = 'handIn' | 'takeBack';

/** `submissionEvents/{auto}` — what students did, append-only. */
export interface SubmissionEventDoc {
  studentUid: string;
  courseworkId: string;
  courseId: string;
  kind: SubmissionEventKind;
  attempt: number;
  at: number;
  late: boolean;
}

export const submissionId = (studentUid: string, courseworkId: string) => `${studentUid}_${courseworkId}`;

/** Where an assignment's file is stored. */
export const courseworkFileKey = (courseworkId: string, fileId: string) => `coursework/${courseworkId}/${fileId}`;
/** Where a student's file is stored. Their uid is in the key, so a key names its owner. */
export const workFileKey = (studentUid: string, courseworkId: string, fileId: string) =>
  `work/${studentUid}/${courseworkId}/${fileId}`;

// ------------------------------------------------------------------ dates --

/** Late work is taken until a week after the due date unless the teacher says otherwise. */
export const DEFAULT_LATE_DAYS = 7;

export function defaultLateUntil(dueDate: string): string {
  return addDays(dueDate, DEFAULT_LATE_DAYS);
}

/** The last day a piece of work is taken: the late-work date, or the due date when late work is off. */
export function closesOn(work: { dueDate: string; lateUntil: string | null }): string {
  return work.lateUntil ?? work.dueDate;
}

/**
 * Whether work handed in at `handedInAt` was late. Judged against the date AS
 * IT STANDS — moving a student's date later makes late work on time — and
 * never stored, for exactly that reason.
 */
export function isLate(handedInAt: number, dueDate: string, timeZone: string): boolean {
  return todayInZone(timeZone, handedInAt) > dueDate;
}

// ------------------------------------------------------------------ state --

/**
 * Where one student's work stands, as both they and their teachers see it.
 *
 *  - `notRequired` — a teacher let them off, with a reason. Counts nowhere.
 *  - `returned`    — graded and given back (another try reopens it instead).
 *  - `handedIn`    — the teacher can see it; not returned yet.
 *  - `toDo`        — open, due date not passed.
 *  - `pastDue`     — open, due date passed, late work still taken.
 *  - `missed`      — closed with nothing in.
 *  - `closed`      — its course was archived while it was open. Neither
 *                    handed in nor missed.
 */
export type WorkState = 'notRequired' | 'returned' | 'handedIn' | 'toDo' | 'pastDue' | 'missed' | 'closed';

export function workState(
  sub: Pick<SubmissionDoc, 'state' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly'>,
  today: string,
  /** The course is running: `effectiveActive`. */
  courseOpen: boolean,
): WorkState {
  if (sub.notRequired) return 'notRequired';
  if (sub.state === 'returned') return 'returned';
  if (sub.state === 'handedIn') return 'handedIn';
  if (!courseOpen) return 'closed';
  if (sub.closedEarly) return 'missed';
  if (!isOverdue(sub.dueDate, today)) return 'toDo';
  if (!isOverdue(closesOn(sub), today)) return 'pastDue';
  return 'missed';
}

/** Whether the student may hand in now. */
export function canHandIn(state: WorkState): boolean {
  return state === 'toDo' || state === 'pastDue';
}

/**
 * Whether the student may take handed-in work back: until their due date,
 * while it has not been returned, and only while it could go back in. After
 * the date, taking it back would make it late, so the chance goes; once the
 * teacher has stopped taking work, or the course is archived, work taken back
 * could never be handed in again, and would drop out of the teacher's view.
 */
export function canTakeBack(
  sub: Pick<SubmissionDoc, 'state' | 'dueDate' | 'closedEarly' | 'notRequired'>,
  today: string,
  /** The course is running: `effectiveActive`. */
  courseOpen: boolean,
): boolean {
  return sub.state === 'handedIn' && !sub.closedEarly && !sub.notRequired && courseOpen && !isOverdue(sub.dueDate, today);
}

/**
 * The student's dates are their own: given more time, or asked for another
 * try with a new date. A change to the class's dates passes them by, and
 * nobody whose date did not move is told it did.
 */
export function hasOwnDates(sub: Pick<SubmissionDoc, 'moreTime' | 'returned'>): boolean {
  return sub.moreTime !== null || sub.returned?.retry === true;
}

/**
 * Whether a student joining the course today receives this assignment:
 * everyone enrolled when it is posted, and anyone who joins by its due date.
 * The due date itself counts.
 */
export function receivesOnJoining(cw: Pick<CourseworkDoc, 'status' | 'dueDate' | 'closedAt'>, today: string): boolean {
  return cw.status === 'posted' && cw.closedAt === null && !isOverdue(cw.dueDate, today);
}

// ------------------------------------------------------------------ To do --

/**
 * The group a piece of work sits in on the student's To do, or null when it
 * is not on To do at all (not required: it stays on the class page).
 */
export type TodoBucket = 'pastDue' | 'dueSoon' | 'upcoming' | 'missed' | 'archived' | 'done';

/** Open work first, the record after: the order the groups are drawn in. */
export const TODO_ORDER: TodoBucket[] = ['pastDue', 'dueSoon', 'upcoming', 'missed', 'archived', 'done'];

/** How long finished work stays in Done; older work is on the class page. */
export const DONE_DAYS = 14;

export function workBucket(state: WorkState, dueDate: string, today: string): TodoBucket | null {
  switch (state) {
    case 'notRequired':
      return null;
    case 'returned':
    case 'handedIn':
      return 'done';
    case 'pastDue':
      return 'pastDue';
    case 'missed':
      return 'missed';
    case 'closed':
      return 'archived';
    case 'toDo':
      return daysUntilDue(dueDate, today) <= DUE_SOON_DAYS ? 'dueSoon' : 'upcoming';
  }
}

/** The day the student's work is next due: their own date, or for late work the day it closes. */
export function nextDeadline(state: WorkState, sub: Pick<SubmissionDoc, 'dueDate' | 'lateUntil'>): string | null {
  if (state === 'toDo') return sub.dueDate;
  if (state === 'pastDue') return closesOn(sub);
  return null;
}

// ------------------------------------------------------------ for staff --

/**
 * One student's work as a teacher sees it: the student's state, split where
 * only staff can see — work graded but not returned yet is `graded`, work
 * handed in and not graded is `toGrade`.
 */
export type StaffWorkState = Exclude<WorkState, 'handedIn'> | 'toGrade' | 'graded';

export function staffWorkState(
  sub: Pick<SubmissionDoc, 'state' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly'>,
  grade: Pick<GradeDoc, 'grade' | 'withoutHandIn'> | undefined,
  today: string,
  courseOpen: boolean,
): StaffWorkState {
  const state = workState(sub, today, courseOpen);
  // GRADED MEANS A GRADE. Feedback written first, or a grade cleared to come
  // back to, left a grades document with no grade in it: the work dropped out
  // of To grade while Return would not take it.
  const graded = !!grade && grade.grade !== null;
  if (state === 'handedIn') return graded ? 'graded' : 'toGrade';
  // Work done on paper, graded with nothing handed in and not yet returned.
  if (graded && grade.withoutHandIn && sub.state === 'open' && state !== 'notRequired') return 'graded';
  return state;
}

export interface CourseworkCounts {
  /** Everyone it went to, still in the class, minus anyone marked not required. */
  expected: number;
  handedIn: number;
  late: number;
  toGrade: number;
  /** Graded and not yet given back. */
  toReturn: number;
  returned: number;
  /** Nothing in, due date not passed. */
  notInYet: number;
  /** Nothing in, due date passed, late work still taken. */
  pastDue: number;
  missed: number;
  notRequired: number;
  closed: number;
  /** Average of RETURNED grades, as a share (0–1); points only. Null when none. */
  average: number | null;
}

/** One student's work on one assignment, as the figures count it. */
export interface WorkTally {
  state: StaffWorkState;
  /** Anything given back or waiting with the teacher: handed in, or graded on paper. */
  handedIn: boolean;
  late: boolean;
  /** A returned grade in points as a share of the points; null for anything else. */
  share: number | null;
}

/**
 * Where one student's work on one assignment stands, for the figures: null
 * when it counts nowhere, which is work never handed in by a student who has
 * since left the class. Every count of assignments adds these up, an
 * assignment's (`courseworkCounts`) and a student's across a course (the
 * workbook's Grades tab), so the two cannot disagree.
 */
export function workTally(
  grading: CourseworkGrading,
  sub: Pick<SubmissionDoc, 'active' | 'state' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly' | 'handedInAt' | 'returned'>,
  grade: Pick<GradeDoc, 'grade' | 'withoutHandIn'> | undefined,
  today: string,
  courseOpen: boolean,
  timeZone: string,
): WorkTally | null {
  if (!sub.active && sub.state === 'open') return null;
  const state = staffWorkState(sub, grade, today, courseOpen);
  // Graded on paper counts as handed in, on paper: as the student's page has
  // always counted it, and as the comment above says.
  const handedIn = state !== 'notRequired' && (sub.state !== 'open' || state === 'graded');
  const late = handedIn && sub.handedInAt !== null && isLate(sub.handedInAt, sub.dueDate, timeZone);
  const g = sub.returned?.grade;
  const share = state === 'returned' && g && 'points' in g && grading.kind === 'points' ? g.points / grading.outOf : null;
  return { state, handedIn, late, share };
}

/** The figures a set of tallies add up to: one assignment's, or one student's. */
export function tallyCounts(tallies: (WorkTally | null)[]): CourseworkCounts {
  const c: CourseworkCounts = {
    expected: 0, handedIn: 0, late: 0, toGrade: 0, toReturn: 0, returned: 0,
    notInYet: 0, pastDue: 0, missed: 0, notRequired: 0, closed: 0, average: null,
  };
  const shares: number[] = [];
  for (const t of tallies) {
    if (!t) continue;
    if (t.state === 'notRequired') {
      c.notRequired++;
      continue;
    }
    c.expected++;
    if (t.handedIn) c.handedIn++;
    if (t.late) c.late++;
    if (t.state === 'toGrade') c.toGrade++;
    else if (t.state === 'graded') c.toReturn++;
    else if (t.state === 'returned') c.returned++;
    else if (t.state === 'toDo') c.notInYet++;
    else if (t.state === 'pastDue') c.pastDue++;
    else if (t.state === 'missed') c.missed++;
    else if (t.state === 'closed') c.closed++;
    if (t.share !== null) shares.push(t.share);
  }
  c.average = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
  return c;
}

/**
 * The figures for one assignment — the assignment page's tiles, its card on
 * the course's list, Today's "to grade" row, the workbook's Assignments tab.
 * ONE SOURCE, as the proposal asks: listening is counted twice in this app
 * (screens and workbook), and the counts for assignments should not repeat
 * that.
 *
 * The average counts only returned grades, so it never includes one a student
 * has not seen.
 */
export function courseworkCounts(
  grading: CourseworkGrading,
  subs: Pick<SubmissionDoc, 'studentUid' | 'active' | 'state' | 'dueDate' | 'lateUntil' | 'notRequired' | 'closedEarly' | 'handedInAt' | 'returned'>[],
  grades: Map<string, Pick<GradeDoc, 'grade' | 'withoutHandIn'>>,
  today: string,
  courseOpen: boolean,
  timeZone: string,
): CourseworkCounts {
  return tallyCounts(subs.map((s) => workTally(grading, s, grades.get(s.studentUid), today, courseOpen, timeZone)));
}
