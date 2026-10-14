import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { NO_MEDIA } from '../mediaFixtures';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, enrollmentId } from '@sabeel/shared';
import { idTokenFor } from './emulatorToken';
import { createEnrollment, setEnrollmentActive } from '../../src/enrollments';
import { clearCompletionOverride, overrideCompletion } from '../../src/overrides';
import { createSession, deleteSession, submitAttendance, updateSession } from '../../src/sessions';
import {
  editRecordingMedia,
  removeRecordingMedia,
  createRecording,
  deleteRecording,
  setRecordingStatus,
} from '../../src/recordings';
import { finalizeRecordingUpload, signRecordingUploadParts, startRecordingUpload } from '../../src/uploads';
import { createStudent } from '../../src/students';
import { importZoomFiles, retryZoomImport } from '../../src/zoomImport';
import {
  closeCoursework,
  createCoursework,
  deleteCoursework,
  giveMoreTime,
  postCoursework,
  reopenCoursework,
  returnWork,
  saveGrade,
  setNotRequired,
  updateCoursework,
} from '../../src/coursework';
import { finalizeAttachment, getAttachmentUrl, removeAttachment, startAttachmentUpload } from '../../src/attachments';

/**
 * "Managers are scoped class by class" — proved against the CALLABLES, one row
 * per call site, rather than against the guard in isolation.
 *
 * `guards.integration.test.ts` next door proves `requireCourseScope` answers
 * correctly. It cannot prove anybody CALLS it, and nothing else did: deleting
 * the line from any single callable left every suite in this repo green while
 * that one action was open to every manager in the institute. The guard being
 * tested and the guard being wired are two different claims, and only the second
 * is what a student's classmate in another cohort depends on.
 *
 * SO THE TABLE IS THE TEST. A row per `requireCourseScope` call site in
 * `functions/src`, driven through `onCall`'s `.run()` so the real handler runs —
 * validation, lookups, guard and all. Adding a course-scoped callable without
 * adding a row here is the gap this is built to make obvious; the last test in
 * the file holds the number of call sites in `functions/src` and the number of
 * rows together.
 *
 * TWO ASSERTIONS PER ROW, because one is not enough. "A manager of another class
 * is refused" passes just as well when the payload is malformed, the document is
 * missing, or the callable rejects everyone — none of which is the promise. So
 * each row is also called by the manager who DOES run the class, and asserted
 * NOT to be refused with `permission-denied`. Payload validation and missing
 * documents fire identically for both callers; only the scope check tells them
 * apart. The second assertion is deliberately weak on everything else — several
 * of these then fail for their own good reasons (no Zoom credentials, no
 * uploaded object, a session that already has a recording), and pinning those
 * would be pinning the fixture rather than the promise.
 */
beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();

const OWNER = 'mgr-owns-it';
const OTHER = 'mgr-owns-something-else';
const ADMIN = 'admin-uid';
const THEIRS = 'course-theirs';
const MINE = 'course-mine';
const SESSION = 'session-theirs';
const RECORDING = 'recording-theirs';
const STUDENT = 'student-theirs';
const COURSEWORK = 'coursework-theirs';

const req = async (uid: string, role: 'manager' | 'admin', data: unknown): Promise<CallableRequest> =>
  ({
    auth: { uid, token: { role, status: 'active' }, rawToken: await idTokenFor(uid) },
    data,
  }) as unknown as CallableRequest;

/**
 * A class that belongs to somebody else, complete enough that every row's
 * payload is otherwise VALID — which is the whole point. A row whose call would
 * have been rejected for a bad id proves nothing about authorization.
 */
async function seed() {
  const d = db();
  await Promise.all([
    d.collection(COLLECTIONS.courses).doc(THEIRS).set({
      cohortId: 'cohort1',
      name: 'Theirs',
      managerUids: [OWNER],
      active: true,
    }),
    d.collection(COLLECTIONS.courses).doc(MINE).set({
      cohortId: 'cohort1',
      name: 'Mine',
      managerUids: [OTHER],
      active: true,
    }),
    d.collection(COLLECTIONS.sessions).doc(SESSION).set({
      courseId: THEIRS,
      date: '2099-01-01',
      title: 'Session',
      dueDate: '2099-02-01',
      notes: '',
      attendance: {},
      recordingId: RECORDING,
      notRecorded: false,
      createdBy: OWNER,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    d.collection(COLLECTIONS.recordings).doc(RECORDING).set({
      courseId: THEIRS,
      cohortId: 'cohort1',
      sessionId: SESSION,
      title: 'Session',
      status: 'draft',
      ...NO_MEDIA,
      source: 'manual',
      createdBy: OWNER,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    d.collection(COLLECTIONS.students).doc(STUDENT).set({
      displayName: 'A Student',
      email: 'scoped@example.com',
      status: 'active',
    }),
    d.collection(COLLECTIONS.coursework).doc(COURSEWORK).set({
      courseId: THEIRS,
      cohortId: 'cohort1',
      title: 'Reflection',
      instructions: '',
      files: {},
      dueDate: '2099-03-01',
      lateUntil: null,
      grading: { kind: 'scale' },
      status: 'posted',
      closedAt: null,
      postedAt: Date.now(),
      postedBy: OWNER,
      createdAt: Date.now(),
      createdBy: OWNER,
      updatedAt: Date.now(),
      editedAt: null,
    }),
    d.collection(COLLECTIONS.submissions).doc(`${STUDENT}_${COURSEWORK}`).set({
      studentUid: STUDENT,
      courseworkId: COURSEWORK,
      courseId: THEIRS,
      cohortId: 'cohort1',
      active: true,
      dueDate: '2099-03-01',
      lateUntil: null,
      closedEarly: false,
      state: 'handedIn',
      attempt: 1,
      handedInAt: Date.now(),
      note: 'Done',
      files: {},
      returned: null,
      attempts: [],
      notRequired: null,
      moreTime: null,
      assignedAt: Date.now(),
    }),
    d.collection(COLLECTIONS.enrollments).doc(enrollmentId(STUDENT, THEIRS)).set({
      studentUid: STUDENT,
      courseId: THEIRS,
      active: true,
      enrolledAt: Date.now(),
    }),
    // A file held for a new assignment of the class, not saved yet.
    d.collection(COLLECTIONS.attachmentUploads).doc('held1').set({
      target: 'coursework',
      courseworkId: 'reservedcw0000000000',
      courseId: THEIRS,
      studentUid: null,
      uploadedBy: OWNER,
      name: 'Sheet.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      storageKey: 'coursework/reservedcw0000000000/held1',
      startedAt: Date.now(),
      reserved: true,
      held: {
        id: 'held1',
        name: 'Sheet.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        durationSec: null,
        storageKey: 'coursework/reservedcw0000000000/held1',
        addedAt: Date.now(),
      },
    }),
  ]);
}

beforeEach(seed);

/** Every `requireCourseScope` call site, by the callable that reaches them. */
const SCOPED: Array<{
  name: string;
  /** `.run` is what `onCall` exposes for driving the real handler in a test. */
  call: (r: CallableRequest) => Promise<unknown>;
  data: unknown;
  /**
   * Who the legitimate caller is. A manager of the class for everything except
   * `deleteSession`, which layers `requireAdmin` on top — so no manager passes
   * it, and the scope check there is the floor under an admin-only action rather
   * than the gate. The manager denial for that row is over-determined and the
   * row is kept anyway: it is a call site, and a reader counting them will look.
   */
  owner?: 'admin';
}> = [
  { name: 'createEnrollment', call: (r) => createEnrollment.run(r), data: { studentUid: STUDENT, courseId: THEIRS } },
  { name: 'setEnrollmentActive', call: (r) => setEnrollmentActive.run(r), data: { studentUid: STUDENT, courseId: THEIRS, active: false } },
  { name: 'overrideCompletion', call: (r) => overrideCompletion.run(r), data: { studentUid: STUDENT, recordingId: RECORDING, completed: true, reason: 'attended live' } },
  { name: 'clearCompletionOverride', call: (r) => clearCompletionOverride.run(r), data: { studentUid: STUDENT, recordingId: RECORDING, reason: 'set in error' } },
  { name: 'createSession', call: (r) => createSession.run(r), data: { courseId: THEIRS, date: '2099-03-01', title: 'New', dueDate: '2099-04-01' } },
  { name: 'updateSession', call: (r) => updateSession.run(r), data: { sessionId: SESSION, title: 'Renamed' } },
  { name: 'submitAttendance', call: (r) => submitAttendance.run(r), data: { sessionId: SESSION, attendance: { [STUDENT]: 'present' } } },
  { name: 'deleteSession', call: (r) => deleteSession.run(r), data: { sessionId: SESSION }, owner: 'admin' },
  { name: 'createRecording', call: (r) => createRecording.run(r), data: { sessionId: SESSION } },
  { name: 'startRecordingUpload', call: (r) => startRecordingUpload.run(r), data: { recordingId: RECORDING, contentType: 'audio/mp4', sizeBytes: 1000, placement: { as: 'part' } } },
  { name: 'signRecordingUploadParts', call: (r) => signRecordingUploadParts.run(r), data: { recordingId: RECORDING, itemId: 'item1', partNumbers: [1] } },
  { name: 'finalizeRecordingUpload', call: (r) => finalizeRecordingUpload.run(r), data: { recordingId: RECORDING, itemId: 'item1', parts: [{ partNumber: 1, etag: 'e' }] } },
  { name: 'setRecordingStatus', call: (r) => setRecordingStatus.run(r), data: { recordingId: RECORDING, status: 'draft' } },
  { name: 'editRecordingMedia', call: (r) => editRecordingMedia.run(r), data: { recordingId: RECORDING, op: 'hide', itemId: 'item1' } },
  { name: 'removeRecordingMedia', call: (r) => removeRecordingMedia.run(r), data: { recordingId: RECORDING, itemId: 'item1' } },
  { name: 'deleteRecording', call: (r) => deleteRecording.run(r), data: { recordingId: RECORDING } },
  { name: 'deleteRecording, only if still empty', call: (r) => deleteRecording.run(r), data: { recordingId: RECORDING, ifEmpty: true } },
  { name: 'createStudent', call: (r) => createStudent.run(r), data: { displayName: 'New Student', email: `scoped-${Date.now()}@example.com`, courseId: THEIRS } },
  { name: 'createCoursework', call: (r) => createCoursework.run(r), data: { courseId: THEIRS, title: 'New', instructions: '', dueDate: '2099-03-01', lateUntil: null, grading: { kind: 'scale' } } },
  { name: 'updateCoursework', call: (r) => updateCoursework.run(r), data: { courseworkId: COURSEWORK, title: 'Renamed', instructions: '', dueDate: '2099-03-01', lateUntil: null, grading: { kind: 'scale' } } },
  { name: 'postCoursework', call: (r) => postCoursework.run(r), data: { courseworkId: COURSEWORK } },
  { name: 'closeCoursework', call: (r) => closeCoursework.run(r), data: { courseworkId: COURSEWORK } },
  { name: 'reopenCoursework', call: (r) => reopenCoursework.run(r), data: { courseworkId: COURSEWORK } },
  { name: 'deleteCoursework', call: (r) => deleteCoursework.run(r), data: { courseworkId: COURSEWORK }, owner: 'admin' },
  { name: 'saveGrade', call: (r) => saveGrade.run(r), data: { courseworkId: COURSEWORK, studentUid: STUDENT, grade: { scale: 'satisfactory' }, feedback: '' } },
  { name: 'returnWork', call: (r) => returnWork.run(r), data: { courseworkId: COURSEWORK, studentUids: [STUDENT] } },
  { name: 'giveMoreTime', call: (r) => giveMoreTime.run(r), data: { courseworkId: COURSEWORK, studentUid: STUDENT, dueDate: '2099-04-01', lateUntil: null, reason: 'Ill' } },
  { name: 'setNotRequired', call: (r) => setNotRequired.run(r), data: { courseworkId: COURSEWORK, studentUid: STUDENT, reason: 'Joined late' } },
  { name: 'startAttachmentUpload', call: (r) => startAttachmentUpload.run(r), data: { target: 'coursework', courseworkId: COURSEWORK, name: 'Sheet.pdf', sizeBytes: 100 } },
  { name: 'finalizeAttachment', call: (r) => finalizeAttachment.run(r), data: { courseworkId: COURSEWORK, fileId: 'file1' } },
  { name: 'removeAttachment', call: (r) => removeAttachment.run(r), data: { courseworkId: COURSEWORK, fileId: 'file1' } },
  { name: 'getAttachmentUrl', call: (r) => getAttachmentUrl.run(r), data: { courseworkId: COURSEWORK, fileId: 'file1' } },
  { name: 'removeAttachment, a held file', call: (r) => removeAttachment.run(r), data: { courseworkId: 'reservedcw0000000000', fileId: 'held1' } },
  { name: 'importZoomFiles', call: (r) => importZoomFiles.run(r), data: { sessionId: SESSION, files: [{ meetingUuid: 'uuid', fileId: 'file' }] } },
  { name: 'retryZoomImport', call: (r) => retryZoomImport.run(r), data: { recordingId: RECORDING } },
];

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

describe('every course-scoped callable is scoped', () => {
  it.each(SCOPED)('$name refuses a manager who does not run the class', async (entry) => {
    expect(await codeOf(entry.call(await req(OTHER, 'manager', entry.data)))).toBe('permission-denied');
  });

  it.each(SCOPED)('$name does not refuse the manager who does — so the row above is about scope', async (entry) => {
    const caller =
      entry.owner === 'admin'
        ? await req(ADMIN, 'admin', entry.data)
        : await req(OWNER, 'manager', entry.data);
    expect(await codeOf(entry.call(caller))).not.toBe('permission-denied');
  });
});

/**
 * The table is only as good as its completeness, and a table that silently falls
 * behind the source is the failure mode this file exists to prevent one level
 * down. So: count the call sites in `functions/src` and hold the table to them.
 */
describe('the table covers every call site', () => {
  it('has one row per requireCourseScope in functions/src', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(import.meta.dirname, '../../src');
    let sites = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'guards.ts')) {
      sites += [...readFileSync(resolve(dir, file), 'utf8').matchAll(/requireCourseScope\(/g)].length;
    }
    // A guard on the guard: a regex that matched nothing would pass any count.
    expect(sites).toBeGreaterThan(10);
    expect(SCOPED).toHaveLength(sites);
  });

  /*
   * THE OTHER DIRECTION. Counting `requireCourseScope` call sites holds the
   * table to the guards that exist; it says nothing about a callable that
   * never calls the guard at all — the one omission this whole file is for.
   * So every audited callable in `functions/src` is either in the table or in
   * the list of institute-level actions below, and each of those has to call
   * `requireAdmin` inside its own handler. A new `auditedCall` lands in
   * neither until somebody says which it is.
   */
  it('every audited callable is either course-scoped or admin-only', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const ADMIN_ONLY = [
      'createCohort',
      'createCourse',
      'deleteAccount',
      'renameCohort',
      'setCohortArchived',
      'setCourseManagers',
      'setStaffAccess',
      'setStudentAccess',
      'updateCourse',
    ];
    const scoped = new Set(SCOPED.map((row) => row.name));
    const dir = resolve(import.meta.dirname, '../../src');
    const seen: string[] = [];
    let sites = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'audited.ts')) {
      const src = readFileSync(resolve(dir, file), 'utf8');
      sites += (src.match(/\bauditedCall\(/g) ?? []).length;
      // `\s*` because two call sites break the line after the paren.
      for (const m of src.matchAll(/auditedCall\(\s*'([A-Za-z]+)'/g)) {
        const name = m[1];
        seen.push(name);
        if (scoped.has(name)) continue;
        expect(ADMIN_ONLY, `${name} is neither in the scope table nor admin-only`).toContain(name);
        // The handler's own body: everything up to the next top-level
        // declaration, since a handler written over several lines closes with
        // `);` and a `});`-bounded slice ran on into the next function's guard.
        const body = src.slice(m.index).split(/\nexport (?:const|function|async function) /)[0];
        expect(body, `${name} is listed admin-only but never calls requireAdmin`).toMatch(
          /requireAdmin\(/,
        );
      }
    }
    // Every call site was read: a name the regex could not see is a callable
    // this test never placed.
    expect(seen.length).toBe(sites);
    expect(sites).toBeGreaterThan(15);
    for (const name of ADMIN_ONLY) expect(seen, `${name} is no longer an audited callable`).toContain(name);
  });
});
