import './setup';
import { initializeApp } from 'firebase-admin/app';
import { isEmulatorProject } from './env';
import * as bootstrap from './bootstrap';

// Once, before any handler runs. Credentials and the project come from the
// environment on both the emulator and Cloud Functions. Media is not in
// Firebase at all (`mediaStore.ts`), so there is no bucket to name.
initializeApp();

export { onUserCreate } from './authTrigger';
export { beforeSignUp, beforeSignIn } from './signUpGate';
export { setStaffAccess } from './staff';
export { createStudent, setStudentAccess } from './students';
export { deleteAccount } from './deleteAccount';
export { createCohort, setCohortArchived, renameCohort } from './cohorts';
export { createCourse, updateCourse, setCourseManagers } from './courses';
export { createEnrollment, setEnrollmentActive } from './enrollments';
export { createSession, updateSession, submitAttendance, deleteSession } from './sessions';
export {
  createRecording,
  setRecordingStatus,
  removeRecordingMedia,
  editRecordingMedia,
  deleteRecording,
} from './recordings';
export {
  createCoursework,
  updateCoursework,
  postCoursework,
  closeCoursework,
  reopenCoursework,
  deleteCoursework,
  handIn,
  takeBack,
  saveGrade,
  returnWork,
  giveMoreTime,
  setNotRequired,
} from './coursework';
export { startAttachmentUpload, finalizeAttachment, removeAttachment, getAttachmentUrl } from './attachments';
export {
  startRecordingUpload,
  signRecordingUploadParts,
  finalizeRecordingUpload,
  sweepAbandonedUploads,
} from './uploads';
export { listZoomRecordings, importZoomFiles, retryZoomImport, copyZoomFile } from './zoomImport';
export { getPlaybackUrl } from './playback';
export { getHelpVideoUrl } from './help';
export { accountExists } from './accountExists';
export { onRecordingWritten, onSessionWritten } from './assignmentsTrigger';
export { onCourseworkTallied, onGradeTallied, onSubmissionTallied } from './courseworkTallies';
export { onAssignmentWritten, onDeviceRegistered, onMorning } from './notifyTrigger';
export { overrideCompletion, clearCompletionOverride } from './overrides';
export { acceptRules, reportProblem } from './conduct';
export { requestPasswordLink, onPasswordLinkRequested, sendPasswordLink, sendMyPasswordLink } from './passwordLinks';

/**
 * `bootstrapAdmin` exists ONLY against the emulator.
 *
 * It was deployed once to the real project on 2026-07-22, called once to
 * promote the first admin, and deleted immediately (verified: the URL 404s).
 * Leaving it in the export list would silently recreate it on the next
 * `deploy --only functions` — an unauthenticated endpoint that grants admin,
 * back in production because nobody remembered a comment.
 *
 * It cannot be deleted outright: the e2e suite calls it to promote its first
 * admin, which is the same bootstrap problem in miniature. So it is scoped to
 * the project where that is safe. Spent in production anyway — it refuses with
 * 409 once any admin exists.
 *
 * A static import, not a lazy `require`: the deploy discovers functions by
 * walking this module's exports, so an imported-but-unexported handler is
 * never deployed — and one `require()` in an otherwise-ESM entry made esbuild
 * wrap every module lazily, which switched off the tree-shaking that keeps
 * `@sabeel/shared`'s app-only code (and its npm dependency) out of the
 * bundle. `bundleExternals.test.ts` holds that line.
 */
export const bootstrapAdmin = isEmulatorProject() ? bootstrap.bootstrapAdmin : undefined;
