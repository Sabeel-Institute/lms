import { describe, it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  addDays,
  submissionId,
  todayInZone,
  type AttachmentFile,
  type DraftDoc,
} from '@sabeel/shared';
import { deleteObject } from '../../src/mediaStore';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createEnrollmentRecord } from '../../src/enrollments';
import { createCourseworkRecord, deleteCourseworkRecord, handInWork, postCourseworkRecord, saveGradeRecord } from '../../src/coursework';
import { removeAttachment } from '../../src/attachments';
import { idTokenFor } from './emulatorToken';

/*
 * WHEN THE MEDIA STORE REFUSES. Deletes ran the records first and the bucket
 * after, so a store failure part-way left work, grades and history destroyed
 * around an empty assignment, or a file gone from its page, and in neither
 * case an audit row, since the call failed. The promise: a delete the store
 * refuses destroys nothing, and can simply be tried again.
 */
vi.mock('../../src/mediaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mediaStore')>();
  return { ...actual, deleteObject: vi.fn(actual.deleteObject) };
});
const storeRefuses = () => vi.mocked(deleteObject).mockRejectedValue(new Error('R2: 503 Service Unavailable'));

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'teacher-sf';
const AMINAH = 'stu-sf-aminah';
const today = todayInZone(INSTITUTE_TIMEZONE);
let courseId = '';
let cwId = '';

/** A file as the assignment lists it; the store is refused, so its bytes need not exist. */
const sheet = (id: string): AttachmentFile => ({
  id,
  name: 'Sheet.pdf',
  contentType: 'application/pdf',
  sizeBytes: 100,
  durationSec: null,
  storageKey: `coursework/${id}/Sheet.pdf`,
  addedAt: 1,
});

beforeEach(async () => {
  vi.mocked(deleteObject).mockReset();
  for (const c of [COLLECTIONS.courses, COLLECTIONS.coursework, COLLECTIONS.submissions, COLLECTIONS.drafts, COLLECTIONS.grades, COLLECTIONS.submissionEvents]) {
    const snap = await db().collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const { id: cohortId } = await createCohortRecord(TEACHER, 'Autumn');
  ({ id: courseId } = await createCourseRecord(TEACHER, { cohortId, name: 'Hikam' }));
  await db().collection(COLLECTIONS.courses).doc(courseId).update({ managerUids: [TEACHER] });
  await db().collection(COLLECTIONS.students).doc(AMINAH).set({ displayName: 'Aminah', email: 'a@example.com', status: 'active' });
  await createEnrollmentRecord(TEACHER, { studentUid: AMINAH, courseId });
  ({ id: cwId } = await createCourseworkRecord(TEACHER, courseId, {
    title: 'Reflection',
    instructions: '',
    dueDate: addDays(today, 7),
    lateUntil: null,
    grading: { kind: 'points', outOf: 10 },
  }));
  await db().collection(COLLECTIONS.coursework).doc(cwId).update({ [`files.f1`]: sheet('f1') });
  await postCourseworkRecord(TEACHER, cwId);
  const draft: DraftDoc = { studentUid: AMINAH, courseworkId: cwId, courseId, note: 'Mine', files: {}, updatedAt: 1 };
  await db().collection(COLLECTIONS.drafts).doc(submissionId(AMINAH, cwId)).set(draft);
  await handInWork(AMINAH, cwId);
  await saveGradeRecord(TEACHER, { courseworkId: cwId, studentUid: AMINAH, grade: { points: 8 }, feedback: '' });
});

const as = async (uid: string, data: unknown) =>
  ({ auth: { uid, token: { role: 'manager', status: 'active' }, rawToken: await idTokenFor(uid) }, data }) as unknown as CallableRequest;

describe('a delete the media store refuses', () => {
  it('an assignment: its work, grades and history are all still there', async () => {
    storeRefuses();
    await expect(deleteCourseworkRecord(cwId, true)).rejects.toThrow(/503/);
    expect((await db().collection(COLLECTIONS.coursework).doc(cwId).get()).exists).toBe(true);
    expect((await db().collection(COLLECTIONS.submissions).doc(submissionId(AMINAH, cwId)).get()).data()).toMatchObject({ state: 'handedIn' });
    expect((await db().collection(COLLECTIONS.grades).doc(submissionId(AMINAH, cwId)).get()).exists).toBe(true);
    expect((await db().collection(COLLECTIONS.submissionEvents).where('courseworkId', '==', cwId).get()).size).toBeGreaterThan(0);
  });

  it('a teacher’s file: it is still on the assignment', async () => {
    storeRefuses();
    await expect(removeAttachment.run(await as(TEACHER, { courseworkId: cwId, fileId: 'f1' }))).rejects.toThrow();
    expect((await db().collection(COLLECTIONS.coursework).doc(cwId).get()).data()?.files.f1).toBeDefined();
  });
});
