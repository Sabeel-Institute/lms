import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
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
  type CourseworkDoc,
  type DraftDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createEnrollmentRecord } from '../../src/enrollments';
import { createCourseworkRecord, deleteCourseworkRecord, handInWork, postCourseworkRecord } from '../../src/coursework';
import {
  finalizeAttachment,
  getAttachmentUrl,
  removeAttachment,
  startAttachmentUpload,
  sweepAttachmentUploads,
} from '../../src/attachments';
import { idTokenFor } from './emulatorToken';
import { clearPrefix, objectExists } from './mediaObjects';
import { PDF, TEXT, sample } from '../mediaSamples';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'att-teacher';
const AMINAH = 'att-aminah';
const BILAL = 'att-bilal';
const today = todayInZone(INSTITUTE_TIMEZONE);
let courseId = '';
let cwId = '';

beforeEach(async () => {
  for (const c of [
    COLLECTIONS.cohorts,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.students,
    COLLECTIONS.coursework,
    COLLECTIONS.submissions,
    COLLECTIONS.drafts,
    COLLECTIONS.submissionEvents,
    COLLECTIONS.attachmentUploads,
  ]) {
    const snap = await db().collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('coursework/');
  await clearPrefix('work/');
  const { id: cohortId } = await createCohortRecord(TEACHER, 'Autumn');
  ({ id: courseId } = await createCourseRecord(TEACHER, { cohortId, name: 'Hikam' }));
  await db().collection(COLLECTIONS.courses).doc(courseId).update({ managerUids: [TEACHER] });
  for (const uid of [AMINAH, BILAL]) {
    await db().collection(COLLECTIONS.students).doc(uid).set({ displayName: uid, email: `${uid}@example.com`, status: 'active' });
    await createEnrollmentRecord(TEACHER, { studentUid: uid, courseId });
  }
  ({ id: cwId } = await createCourseworkRecord(TEACHER, courseId, {
    title: 'Letter forms',
    instructions: '',
    dueDate: addDays(today, 7),
    lateUntil: null,
    grading: { kind: 'scale' },
  }));
  await postCourseworkRecord(TEACHER, cwId);
});

const as = async (uid: string, role: 'manager' | 'student', data: unknown) =>
  ({ auth: { uid, token: { role, status: 'active' }, rawToken: await idTokenFor(uid) }, data }) as unknown as CallableRequest;

/** Add a file the way the app does: ask, PUT the bytes, confirm. */
async function attach(uid: string, role: 'manager' | 'student', name: string, bytes: Uint8Array): Promise<AttachmentFile> {
  const target = role === 'manager' ? 'coursework' : 'work';
  const start = await startAttachmentUpload.run(await as(uid, role, { target, courseworkId: cwId, name, sizeBytes: bytes.length }));
  const put = await fetch(start.url, { method: 'PUT', headers: start.headers, body: bytes });
  expect(put.status).toBe(200);
  return (await finalizeAttachment.run(await as(uid, role, { courseworkId: cwId, fileId: start.fileId }))).file;
}

const cw = async () => (await db().collection(COLLECTIONS.coursework).doc(cwId).get()).data() as CourseworkDoc;
const draft = async (uid: string) =>
  (await db().collection(COLLECTIONS.drafts).doc(submissionId(uid, cwId)).get()).data() as DraftDoc | undefined;

/** Ask for the link and follow it, as the screen does. */
async function open(uid: string, role: 'manager' | 'student', fileId: string, studentUid?: string) {
  const link = await getAttachmentUrl.run(await as(uid, role, { courseworkId: cwId, fileId, studentUid }));
  return new Uint8Array(await (await fetch(link.url)).arrayBuffer());
}

describe('a teacher’s files', () => {
  it('a PDF, a picture and short audio join the assignment, the audio with its length read from the file', async () => {
    const pdf = await attach(TEACHER, 'manager', 'First hikma.pdf', PDF);
    const png = await attach(TEACHER, 'manager', 'Model letters.png', sample('png'));
    const audio = await attach(TEACHER, 'manager', 'How to recite.m4a', sample('m4a'));
    const files = (await cw()).files;
    expect(Object.keys(files).sort()).toEqual([pdf.id, png.id, audio.id].sort());
    expect(files[audio.id]).toMatchObject({ contentType: 'audio/mp4', durationSec: 3 });
    expect(files[pdf.id].sizeBytes).toBe(PDF.length);
  });

  it('a student it was given to opens one; the bytes are the file', async () => {
    const pdf = await attach(TEACHER, 'manager', 'Sheet.pdf', PDF);
    expect(await open(AMINAH, 'student', pdf.id)).toEqual(PDF);
  });

  it('audio over fifteen minutes is refused, and nothing of it stays', async () => {
    await expect(attach(TEACHER, 'manager', 'Whole class.wav', sample('longAudio'))).rejects.toThrow(/15 minutes/);
    expect((await cw()).files).toEqual({});
    expect((await db().collection(COLLECTIONS.attachmentUploads).get()).size).toBe(0);
  });

  it('removing one deletes it from storage', async () => {
    const pdf = await attach(TEACHER, 'manager', 'Old.pdf', PDF);
    await removeAttachment.run(await as(TEACHER, 'manager', { courseworkId: cwId, fileId: pdf.id }));
    expect((await cw()).files).toEqual({});
    expect(await objectExists(pdf.storageKey)).toBe(false);
  });
});

describe('a file is what its bytes say, not what its name says', () => {
  it('a video renamed .m4a is refused', async () => {
    await expect(attach(AMINAH, 'student', 'recitation.m4a', sample('mp4'))).rejects.toThrow(/Video cannot be attached/);
    expect((await draft(AMINAH))?.files ?? {}).toEqual({});
  });

  it('a picture named .txt is refused; real text is taken', async () => {
    await expect(attach(AMINAH, 'student', 'notes.txt', sample('png'))).rejects.toThrow(/not the document/);
    const txt = await attach(AMINAH, 'student', 'notes.txt', TEXT);
    expect(txt.contentType).toBe('text/plain');
  });

  it('a PDF that is not a PDF is refused', async () => {
    await expect(attach(TEACHER, 'manager', 'scan.pdf', TEXT)).rejects.toThrow(/not the document/);
  });

  it('a type the app does not take is refused before anything is sent', async () => {
    await expect(
      startAttachmentUpload.run(await as(AMINAH, 'student', { target: 'work', courseworkId: cwId, name: 'clip.mov', sizeBytes: 10 })),
    ).rejects.toThrow(/Not a file the app takes/);
  });
});

describe('a student’s files', () => {
  it('go on their own draft, and nobody else sees them until they hand in', async () => {
    const page = await attach(AMINAH, 'student', 'Page 1.png', sample('png'));
    expect(Object.keys((await draft(AMINAH))?.files ?? {})).toEqual([page.id]);
    // Their teacher, before hand-in: nothing.
    await expect(open(TEACHER, 'manager', page.id, AMINAH)).rejects.toThrow(/not available/);
    await handInWork(AMINAH, cwId);
    expect(await open(TEACHER, 'manager', page.id, AMINAH)).toEqual(sample('png'));
    // A classmate, ever: no.
    await expect(open(BILAL, 'student', page.id, AMINAH)).rejects.toThrow(/not your work/);
  });

  it('cannot be added to work already handed in', async () => {
    await attach(AMINAH, 'student', 'one.txt', TEXT);
    await handInWork(AMINAH, cwId);
    await expect(attach(AMINAH, 'student', 'two.txt', TEXT)).rejects.toThrow(/not open/);
  });

  it('ten at most', async () => {
    for (let i = 0; i < 10; i++) await attach(AMINAH, 'student', `page ${i}.txt`, TEXT);
    await expect(attach(AMINAH, 'student', 'eleven.txt', TEXT)).rejects.toThrow(/10 files at most/);
  });

  it('are listed in the order they were chosen, whatever order they arrive in', async () => {
    // A recitation chosen first and a page second; the page, being small,
    // arrives first.
    const begin = async (name: string, bytes: Uint8Array) => {
      const start = await startAttachmentUpload.run(
        await as(AMINAH, 'student', { target: 'work', courseworkId: cwId, name, sizeBytes: bytes.length }),
      );
      expect((await fetch(start.url, { method: 'PUT', headers: start.headers, body: bytes })).status).toBe(200);
      return start.fileId;
    };
    const finish = async (fileId: string) =>
      finalizeAttachment.run(await as(AMINAH, 'student', { courseworkId: cwId, fileId }));
    const recitation = await begin('Recitation.m4a', sample('m4a'));
    // Two starts inside one millisecond would tie, and a tie proves nothing.
    await new Promise((r) => setTimeout(r, 5));
    const page = await begin('Page 1.png', sample('png'));
    await finish(page);
    await new Promise((r) => setTimeout(r, 5));
    await finish(recitation);

    // Sorted as the list on screen sorts them.
    const files = Object.values((await draft(AMINAH))?.files ?? {}).sort((a, b) => a.addedAt - b.addedAt);
    expect(files.map((f) => f.name)).toEqual(['Recitation.m4a', 'Page 1.png']);
  });
});

describe('cleaning up', () => {
  it('an upload never confirmed is swept a day later, bytes and all', async () => {
    const start = await startAttachmentUpload.run(
      await as(AMINAH, 'student', { target: 'work', courseworkId: cwId, name: 'lost.txt', sizeBytes: TEXT.length }),
    );
    await fetch(start.url, { method: 'PUT', headers: start.headers, body: TEXT });
    const pending = db().collection(COLLECTIONS.attachmentUploads).doc(start.fileId);
    const key = (await pending.get()).data()?.storageKey as string;
    await pending.update({ startedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    expect(await sweepAttachmentUploads(Date.now())).toBe(1);
    expect(await objectExists(key)).toBe(false);
  });

  it('deleting the assignment deletes every file on it and on its students’ work', async () => {
    const sheet = await attach(TEACHER, 'manager', 'Sheet.pdf', PDF);
    const page = await attach(AMINAH, 'student', 'Page.png', sample('png'));
    await handInWork(AMINAH, cwId);
    await deleteCourseworkRecord(cwId, true);
    expect(await objectExists(sheet.storageKey)).toBe(false);
    expect(await objectExists(page.storageKey)).toBe(false);
  });
});
