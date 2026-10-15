/**
 * The accountability ledger — pure shaping and counting over the Phase 4 data.
 *
 * No Firestore here: the staff ledger reads assignments + completions +
 * overrides + progress live in the app and computes everything with these
 * functions, so the counts can be unit-tested at the day boundary without an
 * emulator. Same discipline as `assignments.ts`, whose `isOverdue` this reuses
 * rather than re-deriving.
 */
import { isOverdue } from './assignments';
import { registerExpects } from './membership';
import { attendanceGroups, type AttendanceStatus, type EnrollmentDoc } from './types';

/**
 * A staff override of a student's completion — separate from the student's own
 * completion doc so the student can never touch it. Server-written only.
 */
export interface CompletionOverrideDoc {
  studentUid: string;
  recordingId: string;
  courseId: string;
  completed: boolean;
  /** Required — the brief allows an override only WITH a recorded reason. */
  reason: string;
  overriddenBy: string;
  at: number;
}

export function overrideId(studentUid: string, recordingId: string): string {
  return `${studentUid}_${recordingId}`;
}

/**
 * The completion the ledger acts on: a staff override wins over the student's
 * self-attestation; absent both, it is simply not complete.
 */
export interface EffectiveCompletion {
  completed: boolean;
  source: 'override' | 'student' | 'none';
  /** Present only when an override is in effect. */
  reason?: string;
}

export function effectiveCompletion(
  student: { completed: boolean } | undefined | null,
  override: { completed: boolean; reason: string } | undefined | null,
): EffectiveCompletion {
  if (override) return { completed: override.completed, source: 'override', reason: override.reason };
  if (student) return { completed: student.completed, source: 'student' };
  return { completed: false, source: 'none' };
}

/** Counts for a class-level / recording-level rollup. */
export interface LedgerRollup {
  total: number;
  complete: number;
  incomplete: number;
  missed: number;
}

/**
 * Tally a set of obligations by effective completion and due state.
 *
 * `incomplete` is everything not (effectively) complete; `missed` is the subset
 * of those past their due date — so a missed item is always also incomplete. A
 * completed item is never missed, however far past its due date. Staff and
 * students use the same word, and it says the truth: access closed, so nothing
 * further will happen to that row on its own.
 */
export function rollup(
  items: { completed: boolean; dueDate: string }[],
  today: string,
): LedgerRollup {
  let complete = 0;
  let missed = 0;
  for (const it of items) {
    if (it.completed) complete++;
    else if (isOverdue(it.dueDate, today)) missed++;
  }
  return {
    total: items.length,
    complete,
    incomplete: items.length - complete,
    missed,
  };
}

/**
 * Where one required listening stands, for a staff ledger row.
 *
 * In the order the answers outrank each other: done is done; a date that has
 * gone is Missed, the word the manual defines by the date, whether or not the
 * class can still be played — nothing stored can tell a miss that predates an
 * archive from one the archive caused, so the row keeps the fact it has; and
 * a grant still inside its date on a course archived with listening OFF is
 * CLOSED, not open: `getPlaybackUrl` refuses the audio, the student's own
 * screens file it under Archived as "no longer required", and a ledger that
 * went on saying "Not complete" or "Listen by <date>" promised something
 * nobody could do. `playable` is `canPlayFromCourse` of the grant's class.
 */
export type GrantOutcome = 'complete' | 'missed' | 'closed' | 'open';

export function grantOutcome(
  item: { completed: boolean; dueDate: string },
  today: string,
  playable: boolean,
): GrantOutcome {
  if (item.completed) return 'complete';
  if (isOverdue(item.dueDate, today)) return 'missed';
  if (!playable) return 'closed';
  return 'open';
}

// ------------------------------------------------------- attendance report ---
// A course's attendance rolled up two ways — per session and per student — plus
// each student's catch-up progress on the recordings they were accountable for.
// Pure, so the whole report is unit-testable at the day boundary.

/** One session's row in the per-session summary. */
export interface SessionAttendanceRow {
  sessionId: string;
  title: string;
  date: string;
  /** false ⇒ attendance was never taken for this session (nobody accountable). */
  submitted: boolean;
  present: number;
  absent: number;
  excused: number;
}

/** One student's row: attendance tally across submitted sessions + catch-up. */
export interface StudentAttendanceRow {
  studentUid: string;
  present: number;
  absent: number;
  excused: number;
  /**
   * Registers taken while they were in the class that hold no mark for them:
   * a mark staff could have given. One taken before they joined, after they
   * left or while they were away is not counted (`registerExpects`).
   */
  notMarked: number;
  /** Recordings the student was granted (active assignments in the course). */
  assigned: number;
  /** …of which effectively complete. */
  completed: number;
  /** …of which incomplete and past due, so no longer openable. */
  missed: number;
  /**
   * They have a mark in this course's register but are no longer on its roster.
   *
   * The register is kept when someone is unenrolled — "an attendance record is
   * what happened on the day and outlives the enrolment" — so their marks go on
   * counting in every session's totals. Dropping them from this half meant the
   * two cuts of one report stopped adding up, and a student who left mid-term
   * simply vanished from the only view that says what they did.
   */
  departed: boolean;
}

export interface AttendanceReport {
  sessions: SessionAttendanceRow[];
  students: StudentAttendanceRow[];
  totalSessions: number;
  sessionsWithAttendance: number;
}

/**
 * Aggregate a course's attendance.
 *
 * `sessions` are all the course's sessions; `enrollments` every enrolment in
 * the course, past and present, with the stretches each student spent in it;
 * `assignments` the active catch-up obligations (one per excused
 * student×recording) already reduced to their effective completion. Only
 * SUBMITTED sessions count toward a student's present/absent/excused tally — an
 * un-taken session marks nobody. Catch-up is grouped from the assignments, so it
 * counts exactly the recordings that exist and are required.
 */
export function attendanceReport(input: {
  sessions: {
    id: string;
    title: string;
    date: string;
    attendance: Record<string, AttendanceStatus>;
    attendanceSubmittedAt: number | null;
  }[];
  enrollments: Pick<EnrollmentDoc, 'studentUid' | 'active' | 'stretches'>[];
  assignments: { studentUid: string; completed: boolean; dueDate: string }[];
  today: string;
  timeZone: string;
}): AttendanceReport {
  const { sessions, enrollments, assignments, today, timeZone } = input;
  /** The CURRENT roster — everyone actively enrolled, marked or not. */
  const rosterUids = enrollments.filter((e) => e.active).map((e) => e.studentUid);
  const enrolmentOf = new Map(enrollments.map((e) => [e.studentUid, e]));

  const sessionRows: SessionAttendanceRow[] = sessions.map((s) => {
    const submitted = s.attendanceSubmittedAt !== null;
    // Only a submitted roster is real; an un-taken session counts nobody.
    const g = attendanceGroups(submitted ? s.attendance : {});
    return {
      sessionId: s.id,
      title: s.title,
      date: s.date,
      submitted,
      present: g.present.length,
      absent: g.absent.length,
      excused: g.excused.length,
    };
  });

  const submitted = sessions.filter((s) => s.attendanceSubmittedAt !== null);

  // Catch-up grouped per student from the active assignments.
  const catchUp = new Map<string, { assigned: number; completed: number; missed: number }>();
  for (const a of assignments) {
    const c = catchUp.get(a.studentUid) ?? { assigned: 0, completed: 0, missed: 0 };
    c.assigned++;
    if (a.completed) c.completed++;
    else if (isOverdue(a.dueDate, today)) c.missed++;
    catchUp.set(a.studentUid, c);
  }

  /*
   * THE ROSTER, PLUS ANYONE THE REGISTER REMEMBERS.
   *
   * A submitted register is a record of who was in the room that day, and it
   * survives an unenrolment on purpose. So the session half of this report goes
   * on counting a departed student in its present/absent/excused totals — while
   * this half listed the active roster alone, and the two stopped reconciling:
   * a class of ten showing nine rows and ten marks, with nothing on screen to
   * explain the tenth.
   *
   * Order matters and is not alphabetical here: the current roster first, in the
   * order it was given, then the departed appended. Sorting is the caller's job
   * (it holds the names); what this fixes is which people appear at all.
   */
  const departed = new Set<string>();
  for (const s of submitted) {
    for (const uid of Object.keys(s.attendance)) {
      if (!rosterUids.includes(uid)) departed.add(uid);
    }
  }

  const studentRows: StudentAttendanceRow[] = [...rosterUids, ...departed].map((uid) => {
    let present = 0;
    let absent = 0;
    let excused = 0;
    let notMarked = 0;
    for (const s of submitted) {
      const st = s.attendance[uid];
      if (st === 'present') present++;
      else if (st === 'absent') absent++;
      else if (st === 'excused') excused++;
      else if (registerExpects(enrolmentOf.get(uid), s, timeZone)) notMarked++;
    }
    const c = catchUp.get(uid) ?? { assigned: 0, completed: 0, missed: 0 };
    return { studentUid: uid, present, absent, excused, notMarked, ...c, departed: departed.has(uid) };
  });

  return {
    sessions: sessionRows,
    students: studentRows,
    totalSessions: sessions.length,
    sessionsWithAttendance: submitted.length,
  };
}
