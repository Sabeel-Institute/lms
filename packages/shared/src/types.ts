import type { Role, UserStatus } from './auth';
import type { Stretch } from './membership';

/**
 * Document shapes. Timestamps are epoch milliseconds everywhere — one
 * representation across client, functions and tests, so nothing has to remember
 * whether a given field is a Firestore Timestamp or a number.
 */

/** A staff member. Document id is the Firebase Auth uid. */
export interface StaffUserDoc {
  displayName: string;
  /** Null once the account is deleted: the name stays with the record, the address goes. */
  email: string | null;
  photoUrl: string | null;
  /** Mirror of the token claim; the token is what rules trust. */
  role: Extract<Role, 'admin' | 'manager'>;
  status: UserStatus;
  createdAt: number;
  approvedAt?: number;
  approvedBy?: string;
}

/** A student. Document id is the Firebase Auth uid. */
export interface StudentDoc {
  displayName: string;
  /** Null once the account is deleted: the name stays with the record, the address goes. */
  email: string | null;
  /**
   * Always 'student'. Present so the mirror carries the same two fields as the
   * token for both populations — the session compares them to detect a token
   * lagging behind an access change, and a missing field there would read as a
   * permanent mismatch and poll forever.
   */
  role: Extract<Role, 'student'>;
  /** Students are never pending — staff creating them is the approval. */
  status: Extract<UserStatus, 'active' | 'disabled' | 'deleted'>;
  createdAt: number;
  createdBy: string;
}

export interface CohortDoc {
  name: string;
  /** Manually set when the cohort ends. Archiving cascades to its courses. */
  archived: boolean;
  createdAt: number;
  createdBy: string;
}

export interface CourseDoc {
  cohortId: string;
  name: string;
  /** The class's own state, independent of its cohort's. */
  archived: boolean;
  /**
   * Denormalised: `deriveEffectiveActive(cohort.archived, class.archived)`.
   *
   * Written by a Cloud Function whenever the class or its cohort changes.
   * Security rules cannot import TypeScript, so deriving this in rules would
   * mean a second implementation that drifts from the first. One canonical
   * function, one stored boolean, one cheap read.
   */
  effectiveActive: boolean;
  /**
   * When the class is archived, may students still play its recordings?
   * Defaults to false — archiving turns access off unless staff say otherwise.
   */
  archivedAccess: boolean;
  /**
   * EVERY STRETCH THE CLASS'S RECORDINGS WERE CLOSED TO ITS STUDENTS, oldest
   * first: one opens when `canPlayFromCourse` stops being true (the class or
   * its cohort archived, with access off) and closes when it is true again,
   * so the last is open exactly while it is false. A student's date that ran
   * out inside one could not be met, which is Closed, never Missed — however
   * the class stands now (`grantOutcome`). Written beside `effectiveActive`
   * and `archivedAccess` by every writer of either (`recordingsClosedAfter`).
   */
  recordingsClosed: Stretch[];
  /**
   * Managers scoped to this class. Denormalised onto the class rather than kept
   * in a separate scopes collection so that a manager's LIST query can be
   * `where('managerUids','array-contains',uid)` — a rule depending on a
   * cross-document get() would force every listing client to carry a matching
   * where clause and cost a read per row.
   */
  managerUids: string[];
  createdAt: number;
  createdBy: string;
}

/**
 * Student membership in a class.
 *
 * Document id is `${studentUid}_${courseId}` so a rule can check membership with
 * a single exists(), and a student can list their own with
 * `where('studentUid','==',uid)` — no cross-document read either way.
 */
export interface EnrollmentDoc {
  studentUid: string;
  courseId: string;
  cohortId: string;
  /**
   * Unenrolling sets this false; it never deletes the row.
   *
   * The brief calls enrollment "membership … over time" and requires that
   * "listening history is preserved across enrollments" — a hard delete would
   * remove the record that history hangs off. Re-enrolling reactivates this same
   * document rather than creating a second one, which the composite id makes
   * automatic.
   */
  active: boolean;
  /**
   * EVERY STRETCH THE STUDENT HAS SPENT IN THE CLASS, oldest first: one opens
   * when they join or come back, and closes when they leave, so the last is
   * open exactly while `active` is true. `active` stays beside it because the
   * rules and the roster queries filter on it; `checkEnrolmentStretches` holds the two
   * to one story. Read through `inClassAt` and its siblings (membership.ts),
   * never by hand.
   */
  stretches: Stretch[];
  /** Who last added them: the first enrolment, or a return. */
  enrolledBy: string;
}

export function enrollmentId(studentUid: string, courseId: string): string {
  return `${studentUid}_${courseId}`;
}

/**
 * A student's attendance for one session.
 *
 * `excused` is the ONLY status that gives a student anything. It grants access
 * to the session's recording AND makes listening to it required, until the
 * session's due date. `present` needs nothing (they were there) and `absent` is
 * an unexcused miss — neither can open the recording. Staff say "everyone must
 * listen" by excusing everyone.
 */
export type AttendanceStatus = 'present' | 'absent' | 'excused';

/**
 * The uids a session's recording is granted to: the excused.
 *
 * This is the assignment target, and because an assignment is now also the
 * access grant, it is the whole of who may ever play that recording. Students
 * not in the map (e.g. enrolled after attendance was taken) are intentionally
 * excluded: accountability starts at enrollment.
 */
export function accountableUids(attendance: Record<string, AttendanceStatus>): string[] {
  return Object.entries(attendance)
    .filter(([, s]) => s === 'excused')
    .map(([uid]) => uid);
}

/** A session's roster split by status. `excused` is the granted set; `present`
 *  and `absent` get nothing, and differ only for attendance reporting. */
export interface AttendanceGroups {
  present: string[];
  absent: string[];
  excused: string[];
}

export function attendanceGroups(attendance: Record<string, AttendanceStatus>): AttendanceGroups {
  const g: AttendanceGroups = { present: [], absent: [], excused: [] };
  for (const [uid, s] of Object.entries(attendance)) g[s].push(uid);
  return g;
}

/**
 * One dated meeting of a course.
 *
 * The organizing unit under a course: attendance lives here, and a recording
 * (0..1) attaches to it. It exists whether or not it was recorded.
 *
 * `attendance` is the submitted roster SNAPSHOT (present/absent/excused per
 * student). It is what makes obligations attendance-driven AND what implements
 * "accountable from enrollment onward": a student who was not enrolled when
 * attendance was taken is simply not in the map, so is never granted this
 * session's recording. `attendanceSubmittedAt` is the explicit submit — until it
 * is set, nobody is granted anything even if a recording is published.
 *
 * Staff-read only; students never read a session or its attendance. Each
 * student's own mark is projected onto an `attendanceRecords` document instead,
 * because Firestore cannot hide one key of a map from one reader.
 */
export interface SessionDoc {
  courseId: string;
  cohortId: string;
  /** The meeting date, date-only `YYYY-MM-DD` in the institute timezone. */
  date: string;
  title: string;
  /**
   * Date-only `YYYY-MM-DD` — the day the excused must have listened BY, and the
   * day their access closes. Required, never null: a blank deadline would mean
   * permanent access, which is the most permissive setting reachable by leaving
   * a field alone. Never written with a date already in the past.
   */
  dueDate: string;
  /** Shared with everyone who can access the recording — not private staff notes. */
  notes: string;
  /** The session's recording, if one has been added yet. */
  recordingId: string | null;
  attendance: Record<string, AttendanceStatus>;
  /** The explicit-submit marker. Null until attendance is submitted. */
  attendanceSubmittedAt: number | null;
  attendanceSubmittedBy?: string;
  /**
   * This class met but was deliberately not recorded.
   *
   * Set by whoever runs the class, and its whole job is silence: the staff work
   * queue drops the "no recording yet" card and the morning "attendance still
   * not taken" reminder stops. Without it, a meeting nobody recorded left a card
   * on Today for the life of the course, and the only escape was deleting the
   * session — which destroys that day's register with it.
   *
   * NOT `archived`, which is what this field used to be called and what nothing
   * ever wrote. Both readers already treated it as "leave this session alone";
   * the name simply never said which kind of leaving-alone, so no screen could
   * offer it and no reader could tell whether a false meant "not archived" or
   * "nobody has decided".
   *
   * The register is unaffected: attendance can still be taken, and the marks
   * that are there still count. What ends is the chasing.
   */
  notRecorded: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

/**
 * One student's own copy of their attendance mark for one session.
 *
 * A server-written projection of `SessionDoc.attendance`, and the only way a
 * student can be shown their own mark: Firestore security is per-document, so
 * there is no rule that reveals one key of the session's map and hides the rest.
 * The session remains canonical; this is reconciled from it, never the reverse.
 *
 * `date` and `title` are denormalised for the same reason the recording
 * denormalises them — the reader cannot open the session they came from. There
 * is deliberately no `dueDate` or `recordingId` here: the student's own
 * `assignments` row already carries both, and joining on `sessionId` costs
 * nothing.
 *
 * Document id is `${studentUid}_${sessionId}`, so reconciling is idempotent and
 * a student's query is `where('studentUid','==',uid)`.
 */
export interface AttendanceRecordDoc {
  studentUid: string;
  sessionId: string;
  courseId: string;
  cohortId: string;
  /** The meeting date, denormalised from the session. */
  date: string;
  /** The session title, denormalised from the session. */
  title: string;
  status: AttendanceStatus;
  /** The session's `attendanceSubmittedAt` this row was projected from. */
  submittedAt: number;
}

export function attendanceRecordId(studentUid: string, sessionId: string): string {
  return `${studentUid}_${sessionId}`;
}
