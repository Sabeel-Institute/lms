import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  attachmentContentType,
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
import {
  createCoursework,
  createCourseworkRecord,
  deleteCourseworkRecord,
  handInWork,
  postCourseworkRecord,
} from '../../src/coursework';
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
import { OFFICE_97, SPREADSHEET, WORD } from '../documentSamples';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'att-teacher';
const AMINAH = 'att-aminah';
const BILAL = 'att-bilal';
const today = todayInZone(INSTITUTE_TIMEZONE);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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
const cw2 = async (id: string) => (await db().collection(COLLECTIONS.coursework).doc(id).get()).data() as CourseworkDoc;
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

  it('comes from its link under its own name, shown where a browser can, not as the key it is stored at', async () => {
    // A name a browser downloads, saves or shows in its title: non-ASCII,
    // brackets, a quote and an apostrophe, all of which need the exact form.
    const name = 'Ḥikma "notes" (week 2), Fāṭima\'s.pdf';
    const pdf = await attach(TEACHER, 'manager', name, PDF);
    const link = await getAttachmentUrl.run(await as(AMINAH, 'student', { courseworkId: cwId, fileId: pdf.id }));
    const header = (await fetch(link.url)).headers.get('content-disposition') ?? '';
    expect(header).toMatch(/^inline;/);
    expect(decodeURIComponent(header.match(/filename\*=UTF-8''([^;\s]+)/)?.[1] ?? '')).toBe(name);
    expect(header).toContain('filename="_ikma _notes_ (week 2), F__ima\'s.pdf"');
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

  it.each([
    ['Week 2 notes.docx', () => WORD],
    ['Register.xlsx', () => SPREADSHEET],
    ['Old handout.doc', () => OFFICE_97],
    ['Worksheet.jpg', () => sample('jpg')],
    ['Worksheet.webp', () => sample('webp')],
  ])('%s is taken, stored as the type its name gives', async (name, bytes) => {
    const file = await attach(AMINAH, 'student', name, bytes());
    expect(file.contentType).toBe(attachmentContentType(name));
    expect(Object.keys((await draft(AMINAH))?.files ?? {})).toEqual([file.id]);
  });

  it.each([
    ['a Word file named as an old Excel file', 'Register.xls', () => WORD],
    ['an old Office file named as a new one', 'Week 2 notes.docx', () => OFFICE_97],
    ['a JPEG named as a PNG', 'Worksheet.png', () => sample('jpg')],
  ])('%s is refused', async (_what, name, bytes) => {
    await expect(attach(AMINAH, 'student', name, bytes())).rejects.toThrow(/not the (document|image)/);
    expect((await draft(AMINAH))?.files ?? {}).toEqual({});
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

  /*
   * THE TENTH, CONFIRMED TWICE AT ONCE. The second call found ten files, the
   * tenth its own, refused, and deleted the bytes the first had attached.
   */
  it('the tenth confirmed twice at once stays, bytes and all', async () => {
    for (let i = 0; i < 9; i++) await attach(AMINAH, 'student', `page ${i}.txt`, TEXT);
    const start = await startAttachmentUpload.run(await as(AMINAH, 'student', { target: 'work', courseworkId: cwId, name: 'page 9.txt', sizeBytes: TEXT.length }));
    expect((await fetch(start.url, { method: 'PUT', headers: start.headers, body: TEXT })).status).toBe(200);
    const confirm = async () => finalizeAttachment.run(await as(AMINAH, 'student', { courseworkId: cwId, fileId: start.fileId }));
    await Promise.allSettled([confirm(), confirm()]);
    const files = (await draft(AMINAH))?.files ?? {};
    expect(Object.keys(files)).toHaveLength(10);
    expect(await open(AMINAH, 'student', start.fileId, AMINAH)).toEqual(TEXT);
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

/*
 * FILES FIRST, SAVE LATER (Faisal, 2026-10-13): a teacher writing a new
 * assignment adds its files as they go, and nothing exists until they save it
 * or post it. The form reserves the assignment's id; files sent for it are held
 * until the assignment is saved at that id, and the ones the form shows join
 * it. A form left unsaved leaves nothing behind that the sweep does not clear.
 */
describe('a teacher’s files on an assignment not yet saved', () => {
  const reserved = () => db().collection(COLLECTIONS.coursework).doc().id;
  const fields = () => ({
    title: 'Letter forms, week 2',
    instructions: '',
    dueDate: addDays(today, 7),
    lateUntil: null,
    grading: { kind: 'scale' as const },
  });
  /** Add a file the way the new form does: for the reserved id, naming the class. */
  async function hold(uid: string, id: string, name: string, bytes: Uint8Array, forCourse = courseId) {
    const start = await startAttachmentUpload.run(
      await as(uid, 'manager', { target: 'coursework', courseworkId: id, courseId: forCourse, name, sizeBytes: bytes.length }),
    );
    expect((await fetch(start.url, { method: 'PUT', headers: start.headers, body: bytes })).status).toBe(200);
    return (await finalizeAttachment.run(await as(uid, 'manager', { courseworkId: id, fileId: start.fileId }))).file;
  }
  const exists = async (id: string) => (await db().collection(COLLECTIONS.coursework).doc(id).get()).exists;

  it('are kept while it is written, can be opened, and join it when it is saved', async () => {
    const id = reserved();
    const sheet = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    expect(await exists(id)).toBe(false);
    const link = await getAttachmentUrl.run(await as(TEACHER, 'manager', { courseworkId: id, fileId: sheet.id }));
    expect(new Uint8Array(await (await fetch(link.url)).arrayBuffer())).toEqual(PDF);

    await createCourseworkRecord(TEACHER, courseId, fields(), { id, held: [sheet.id] });
    const files = (await cw2(id)).files;
    expect(Object.keys(files)).toEqual([sheet.id]);
    expect(files[sheet.id]).toMatchObject({ name: 'Sheet.pdf', storageKey: sheet.storageKey });
    expect((await db().collection(COLLECTIONS.attachmentUploads).get()).size).toBe(0);
  });

  it('removed before it is saved, leave nothing — not on the assignment, not in the bucket', async () => {
    const id = reserved();
    const sheet = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    await removeAttachment.run(await as(TEACHER, 'manager', { courseworkId: id, fileId: sheet.id }));
    expect(await objectExists(sheet.storageKey)).toBe(false);
    // Listed all the same, as a form that never heard the removal went through.
    await createCourseworkRecord(TEACHER, courseId, fields(), { id, held: [sheet.id] });
    expect((await cw2(id)).files).toEqual({});
  });

  it('are refused to a teacher who does not teach the class', async () => {
    await expect(hold('att-outsider', reserved(), 'Sheet.pdf', PDF)).rejects.toThrow(/not assigned to that class/);
  });

  it('join it as the form showed them: a file the form lost track of stays off it', async () => {
    // The second was confirmed, but the answer never reached the form, which
    // showed it as failed and sent it again: it must not be on it twice.
    const id = reserved();
    const shown = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    const lost = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    await createCourseworkRecord(TEACHER, courseId, fields(), { id, held: [shown.id] });
    expect(Object.keys((await cw2(id)).files)).toEqual([shown.id]);
    // Once its assignment is saved without it, it goes on the day's clock.
    expect(await sweepAttachmentUploads(Date.now() + 25 * HOUR)).toBe(1);
    expect(await objectExists(lost.storageKey)).toBe(false);
    expect(await objectExists(shown.storageKey)).toBe(true);
  });

  it('wait thirty days for a form left open, then the sweep clears them, file and all', async () => {
    const id = reserved();
    const sheet = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    // A form written over a long weekend still has its files when it is saved.
    expect(await sweepAttachmentUploads(Date.now() + 4 * DAY)).toBe(0);
    expect(await objectExists(sheet.storageKey)).toBe(true);
    // One nobody came back to does not keep them for ever.
    expect(await sweepAttachmentUploads(Date.now() + 31 * DAY)).toBe(1);
    expect(await objectExists(sheet.storageKey)).toBe(false);
    expect((await db().collection(COLLECTIONS.attachmentUploads).get()).size).toBe(0);
  });

  it('are taken only by their own teacher saving the form, for its class', async () => {
    const id = reserved();
    const sheet = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    await db().collection(COLLECTIONS.courses).doc(courseId).update({ managerUids: [TEACHER, 'att-colleague'] });
    await createCourseworkRecord('att-colleague', courseId, fields(), { id, held: [sheet.id] });
    expect((await cw2(id)).files).toEqual({});
  });

  it('cannot be saved over an assignment that already exists: it keeps its words and its files', async () => {
    const id = reserved();
    const sheet = await hold(TEACHER, id, 'Sheet.pdf', PDF);
    await createCourseworkRecord(TEACHER, courseId, fields(), { id, held: [sheet.id] });
    await expect(createCourseworkRecord(TEACHER, courseId, { ...fields(), title: 'Over it' }, { id, held: [] })).rejects.toThrow(
      /already/i,
    );
    const kept = await cw2(id);
    expect(kept.title).toBe('Letter forms, week 2');
    expect(Object.keys(kept.files)).toEqual([sheet.id]);
  });

  it('are named by id: a form that sends anything else is refused before anything is read', async () => {
    const save = (data: Record<string, unknown>) =>
      as(TEACHER, 'manager', { courseId, ...fields(), ...data }).then((req) => createCoursework.run(req));
    await expect(save({ id: reserved() })).rejects.toThrow(/held must list/);
    await expect(save({ id: 'courses/x', held: [] })).rejects.toThrow(/not an assignment id/);
    await expect(save({ id: reserved(), held: ['../uploads'] })).rejects.toThrow(/held must list/);
    await expect(save({ id: reserved(), held: Array.from({ length: 11 }, reserved) })).rejects.toThrow(/held must list/);
    expect((await db().collection(COLLECTIONS.coursework).get()).size).toBe(1);
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

  /*
   * A FILE ON ITS WAY WHEN THE ASSIGNMENT WENT. Its link to send the bytes
   * stays good for half an hour, and they landed after the delete had removed
   * every record of them, where nothing would ever find them.
   */
  it('a file on its way when the assignment is deleted is swept once its bytes land', async () => {
    const start = await startAttachmentUpload.run(
      await as(AMINAH, 'student', { target: 'work', courseworkId: cwId, name: 'late.txt', sizeBytes: TEXT.length }),
    );
    const key = (await db().collection(COLLECTIONS.attachmentUploads).doc(start.fileId).get()).data()?.storageKey as string;
    await deleteCourseworkRecord(cwId, true);
    expect((await fetch(start.url, { method: 'PUT', headers: start.headers, body: TEXT })).status).toBe(200);
    expect(await sweepAttachmentUploads(Date.now() + 2 * 24 * 60 * 60 * 1000)).toBe(1);
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
