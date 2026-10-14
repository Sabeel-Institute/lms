/**
 * Routes reachable once signed in and active. Gate screens are not routes —
 * they replace the whole navigator, so a gated account cannot be deep-linked
 * past.
 *
 * EVERY PARAM IS AN ID OR A PLAIN STRING, and must stay that way. React
 * Navigation builds the browser URL from these with `String(value)`, so a
 * document param becomes literally `[object Object]` in the address bar and
 * comes back as that string on reload — which is why Back exited the site
 * instead of going anywhere until this was fixed (see the linking config in
 * App.tsx). Documents are resolved from these ids in the App.tsx wrappers,
 * live, which also means no screen can render from a frozen copy of something
 * it edits.
 */
export type RootStackParamList = {
  Home: undefined;
  /** Both populations have one; the switches shown depend on the role. */
  Notifications: undefined;
  Help: undefined;
  /** One help film, by its id in `HELP_VIDEOS`. */
  HelpFilm: { id: string };
  Students: undefined;
  /** The screen reads the student live, and their courses depend on who is
   *  looking (an admin queries; a manager walks their own courses). */
  StudentDetail: { studentUid: string };
  Cohorts: undefined;
  /** A cohort: its settings and the courses in it. */
  Courses: { cohortId: string };
  CourseDetail: { courseId: string };
  CourseAttendance: { courseId: string };
  Sessions: { courseId: string };
  /** courseId rides along so the header can name the course without waiting on
   *  the session to load first. */
  SessionDetail: { sessionId: string; courseId: string };
  /** The recording knows its own session and course, so one id is enough. */
  RecordingLedger: { recordingId: string };
  StudentLedger: { studentUid: string; courseId: string };
  /** A course's assignments, for its teachers. */
  Coursework: { courseId: string };
  /** Writing one; no courseworkId for a new one. */
  CourseworkEdit: { courseId: string; courseworkId?: string };
  /** One assignment: where everyone is. courseId rides along like a session's. */
  CourseworkDetail: { courseId: string; courseworkId: string };
  /** Grading one student's work on one assignment. */
  Grade: { courseId: string; courseworkId: string; studentUid: string };
  Library: undefined;
  ZoomImport: { sessionId: string };
  /** Omit courseId for the admin's unscoped view; a manager passes their own. */
  Audit: { courseId?: string };
  /** A staff member's own actions — see `MoreSheet`. No params: it is always
   *  the signed-in person's, which is what makes it readable without a class. */
  MyAudit: undefined;
  /** A student's own classes, and one class's attendance record. */
  MyClasses: undefined;
  MyClassRecord: { courseId: string };
  /** One assignment, as the student it was given to sees it. */
  Work: { courseworkId: string };
  /** dueDate is passed by the caller: the session's for staff, the student's own
   *  grant for students. For a student it is the day access CLOSES, so the
   *  player states it; omitted only when staff open a recording with no session
   *  context to hand. */
  /** `itemId`: one file to open, for staff previewing it; otherwise the recording's starting file. */
  Player: { recordingId: string; dueDate?: string | null; itemId?: string };
  MyCourses: undefined;
  Tokens: undefined;
  Crash: undefined;
};
