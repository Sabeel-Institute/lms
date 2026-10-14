/**
 * The app's paths, per population — the URL of every screen on the web, and
 * where a tapped notification lands on both surfaces (`pushTaps`).
 *
 * Plain data in a module of its own, with no React Native in it, so a unit test
 * can resolve every path the server sends (`pushPaths` in @sabeel/shared)
 * through the same tables `App.tsx` gives React Navigation.
 */

/**
 * What makes the browser's Back button work.
 *
 * React Navigation only touches browser history when a `linking` config is
 * present — with none, the whole app lives in one history entry and Back leaves
 * the site. Every screen therefore needs a path: a screen without one
 * contributes nothing to the URL, so navigating to it adds no history entry and
 * Back skips straight past it.
 *
 * URLs are WEB ONLY, deliberately. Native already has a working back gesture
 * through the stack, and enabling linking there would mean an `expo-linking`
 * dependency and a scheme to register for no benefit. Android still reads
 * these tables, to turn a tapped notification's path into a screen.
 */
const SHARED_PATHS = {
  Home: '',
  // Staff listen too — from the library and from a session's recording.
  Player: 'play/:recordingId',
  // Both populations get notifications, so both get the screen that turns them
  // off. The switches it shows are role-dependent; the route is not.
  Notifications: 'notifications',
} as const;

/** Everything only staff may reach. "My courses" is one of them: it is the
 *  courses a MANAGER is assigned, not anything a student has. */
export const STAFF_PATHS = {
  ...SHARED_PATHS,
  Students: 'students',
  StudentDetail: 'students/:studentUid',
  Cohorts: 'cohorts',
  Courses: 'cohorts/:cohortId',
  CourseDetail: 'courses/:courseId',
  CourseAttendance: 'courses/:courseId/attendance',
  Sessions: 'courses/:courseId/sessions',
  SessionDetail: 'courses/:courseId/sessions/:sessionId',
  StudentLedger: 'courses/:courseId/students/:studentUid',
  Coursework: 'courses/:courseId/assignments',
  CourseworkEdit: 'courses/:courseId/assignments/edit/:courseworkId?',
  CourseworkDetail: 'courses/:courseId/assignments/:courseworkId',
  Grade: 'courses/:courseId/assignments/:courseworkId/grade/:studentUid',
  RecordingLedger: 'recordings/:recordingId/progress',
  ZoomImport: 'sessions/:sessionId/import',
  Library: 'library',
  Audit: 'audit',
  MyAudit: 'my-actions',
  MyCourses: 'my-courses',
  Tokens: 'tokens',
  /** Emulator builds only: a screen that throws, for the browser suite (CrashScreen). */
  Crash: 'crash-test',
} as const;

export const STUDENT_PATHS = {
  ...SHARED_PATHS,
  MyClasses: 'my-classes',
  MyClassRecord: 'my-classes/:courseId',
  Work: 'work/:courseworkId',
} as const;

