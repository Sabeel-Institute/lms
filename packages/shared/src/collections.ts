/**
 * Firestore collection names, from the data-model sketch in
 * docs/PRODUCT_BRIEF.md. Names only — the document types land with the phase
 * that first writes them, so this file stays the one place a collection is
 * spelled and rules/tests/queries cannot disagree on a string literal.
 */
export const COLLECTIONS = {
  /** Staff identity, role, approval state. */
  staffUsers: 'staffUsers',
  /** Student identity, active/disabled state, profile. */
  students: 'students',
  /** Cohort/semester records and archive state. */
  cohorts: 'cohorts',
  /** Courses (the subject, e.g. Hikam Foundations) inside cohorts; archive
   *  state, archived-access setting, class-scoped managers. */
  courses: 'courses',
  /** Student membership in courses over time. */
  enrollments: 'enrollments',
  /** One dated meeting of a course: attendance + optional recording. */
  sessions: 'sessions',
  /** Each student's own copy of their attendance mark for one session. A
   *  server-written projection of the session's attendance map, which students
   *  cannot read: Firestore has no field-level security, so the only way to
   *  show a student their own mark is to give them a document holding it. */
  attendanceRecords: 'attendanceRecords',
  /** Recording asset, media + lifecycle, linked to a session. */
  recordings: 'recordings',
  /** Which Zoom files are already in a recording, keyed by Zoom's file id:
   *  the picker marks every imported file in one read, and a file is claimed
   *  exactly once, in a transaction. Server-only. */
  zoomImports: 'zoomImports',
  /** Required-listening obligations, and the ONLY thing granting a student
   *  access to a recording (the excused of a session, until the due date). */
  assignments: 'assignments',
  /** Playback progress, listened percent, last listened, sync metadata. */
  listeningProgress: 'listeningProgress',
  /** Current completion STATE per student+recording, client-written. Keyed by
   *  student+recording because completion can exist for an accessible recording
   *  that was never assigned, so it cannot live on the assignment. */
  completions: 'completions',
  /** Completion/uncompletion events and staff overrides — append-only audit. */
  completionEvents: 'completionEvents',
  /** Staff overrides of a student's completion, keyed by student+recording.
   *  Server-written only; the effective ledger status is override ?? student. */
  completionOverrides: 'completionOverrides',
  /** Student notification preferences and sent records. */
  notifications: 'notifications',
  /** Admin-facing operational metrics. */
  backendStats: 'backendStats',
  /** Staff and system changes that must remain inspectable. */
  auditLog: 'auditLog',
  /** Institute-wide settings the app reads before anyone signs in: today one
   *  document, `config/app`, carrying the oldest build still allowed to run. */
  config: 'config',
} as const;

/** The one document under `config`. */
export const APP_CONFIG_DOC = 'app';

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
