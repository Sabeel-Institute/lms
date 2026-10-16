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
  /** Uploads in flight, keyed by media item id: the bucket's multipart
   *  upload id and how the file is cut into parts. Server-only; gone once the
   *  upload is finished, cancelled or swept. */
  mediaUploads: 'mediaUploads',
  /** Assignments a teacher posts to a whole class (the interface says
   *  "assignment"; `assignments` is the listening grant). Callables only. */
  coursework: 'coursework',
  /** One student's work on one assignment: what they handed in, their own
   *  dates, and the grade once returned. Server-written. */
  submissions: 'submissions',
  /** A student's unsent work. The student's alone: no staff rule reads it. */
  drafts: 'drafts',
  /** Grades as staff write them. Never student-readable; a grade reaches the
   *  student only as `submissions.returned`. */
  grades: 'grades',
  /** Attachments on their way in, keyed by file id: where the finished file
   *  goes and who sent it. Server-only; gone once finished or swept. */
  attachmentUploads: 'attachmentUploads',
  /** Each hand-in and take-back, append-only. */
  submissionEvents: 'submissionEvents',
  /** One assignment's figures, kept by the server as its work and grades
   *  change (`CourseworkTally`), keyed by the assignment's id: a course's pages
   *  read these instead of every piece of work in the course. Staff only. */
  courseworkTallies: 'courseworkTallies',
  /** Required-listening obligations, and the ONLY thing granting a student
   *  access to a recording (the excused of a session, until the due date). */
  assignments: 'assignments',
  /** How much of a recording a student has listened to, and when last:
   *  each sitting's listening, added up. Client-written. */
  listeningProgress: 'listeningProgress',
  /** A student's one bookmark in a recording: the place they chose to come
   *  back to on any device. Client-written; the student's alone. */
  bookmarks: 'bookmarks',
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
  /** What people sent with "Report a problem": who, what, and whether the
   *  email to the administrators went. Server-written; no client reads or
   *  writes it (`reportProblem`). */
  reports: 'reports',
  /** "Email me a password link", asked from the sign-in screen and waiting to
   *  be sent: the typed address, removed as it is taken up. Server-only
   *  (`requestPasswordLink`, `onPasswordLinkRequested`). */
  passwordLinkRequests: 'passwordLinkRequests',
  /** When password links were asked for, per address (keyed by a hash of it,
   *  never the address) and in all: the limits on asking. Server-only. */
  passwordLinkLimits: 'passwordLinkLimits',
} as const;

/** The one document under `config`. */
export const APP_CONFIG_DOC = 'app';

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
