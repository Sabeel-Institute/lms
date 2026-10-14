import type { Role } from './auth';

/**
 * One audit-log entry — a staff (or system) change that must stay inspectable.
 *
 * Written ONLY by the server, by the `auditedCall` wrapper that every mutating
 * callable runs through, plus the auth trigger. Never by a client.
 *
 * `courseId` is the scoping key: when an action belongs to a class, the entry
 * carries it, and a MANAGER may read the entry for a class they run. When an
 * action is not class-scoped (cohort, staff, student-directory changes) it is
 * null, and only an admin may read it — which matches "managers manage audit
 * history within assigned courses".
 */
export interface AuditEntryDoc {
  at: number;
  actorUid: string;
  actorRole: Role | 'system';
  /** The callable/trigger name, e.g. `createRecording`, `overrideCompletion`. */
  action: string;
  /** Course this action belongs to, or null when it is not class-scoped. */
  courseId: string | null;
  /** The ids this action touched — recordingId, studentUid, cohortId, uid… */
  targets: Record<string, string>;
  /** Semantic extra where it matters: an override reason, a status change. */
  detail?: Record<string, unknown>;
}

/**
 * What the audit screen says for each action, in words.
 *
 * EVERY action the server audits needs an entry, or the screen prints a
 * camelCase function name in a list of English sentences: `submitAttendance`
 * sat between "Created course" and "Changed recording status" for exactly that
 * reason. Adding an `auditedCall` means adding a line here.
 *
 * CHECKED BOTH WAYS against what the server writes, by
 * `functions/test/unit/auditLabels.test.ts`, and against what the log holds, by
 * `npm run check:documents`: an entry written under a name since retired is
 * migrated to today's name, never given a label of its own. The switchover
 * seed renames the live app's retired names as it copies
 * (`scripts/lib/legacy-audit.mjs`).
 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  createCohort: 'Created cohort',
  setCohortArchived: 'Archived/unarchived cohort',
  renameCohort: 'Renamed cohort',
  createCourse: 'Created course',
  updateCourse: 'Updated course',
  setCourseManagers: 'Set course managers',
  createStudent: 'Created student',
  setStudentAccess: 'Changed student access',
  createEnrollment: 'Enrolled student',
  setEnrollmentActive: 'Changed enrollment',
  createSession: 'Created session',
  updateSession: 'Edited session',
  deleteSession: 'Deleted session',
  submitAttendance: 'Submitted attendance',
  createRecording: 'Created recording',
  deleteRecording: 'Deleted recording',
  finalizeRecordingUpload: 'Uploaded a file',
  setRecordingStatus: 'Changed recording status',
  removeRecordingMedia: 'Removed a file',
  editRecordingMedia: 'Changed a recording’s files',
  importZoomFiles: 'Imported from Zoom',
  retryZoomImport: 'Retried a Zoom import',
  createCoursework: 'Created assignment',
  updateCoursework: 'Edited assignment',
  postCoursework: 'Posted assignment',
  closeCoursework: 'Stopped taking work',
  reopenCoursework: 'Took work again',
  deleteCoursework: 'Deleted assignment',
  saveGrade: 'Changed a returned grade',
  returnWork: 'Returned work',
  giveMoreTime: 'Gave a student more time',
  setNotRequired: 'Marked/unmarked not required',
  finalizeAttachment: 'Attached a file',
  removeAttachment: 'Removed a file from an assignment',
  setStaffAccess: 'Changed staff access',
  overrideCompletion: 'Overrode completion',
  clearCompletionOverride: 'Removed override',
  authProvision: 'Staff account created',
  authReject: 'Rejected sign-up',
};
