import { describe, it, beforeAll, beforeEach, afterEach, expect } from 'vitest';
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
  type DraftDoc,
  type PushMessage,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { applyCourseUpdate, createCourseRecord } from '../../src/courses';
import { createEnrollmentRecord } from '../../src/enrollments';
import {
  createCourseworkRecord,
  giveMoreTimeRecord,
  handInWork,
  postCoursework,
  returnWork,
  returnWorkRecord,
  saveGrade,
  saveGradeRecord,
  setNotRequiredRecord,
  updateCoursework,
} from '../../src/coursework';
import { notifyHandInLastDay } from '../../src/notifyCoursework';
import { setSender, resetSender, type SendOutcome } from '../../src/messaging';
import { idTokenFor } from './emulatorToken';

/**
 * The four assignment messages: who is told what, and how many times.
 *
 * Driven through the callables a teacher's tap reaches, so what is asserted
 * is the whole path from the action to the outbox — that posting TELLS the
 * class, not only that a function which could tell them exists. Delivery
 * itself has no emulator; the sender is stubbed, as in notify.integration.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'teacher-n';
const AMINAH = 'stu-n-aminah';
const BILAL = 'stu-n-bilal';
const CAROL = 'stu-n-carol';
const today = todayInZone(INSTITUTE_TIMEZONE);
const inDays = (n: number) => addDays(today, n);

let courseId = '';
let outbox: { tokens: string[]; message: PushMessage }[] = [];
const savedAudience = process.env.NOTIFY_AUDIENCE;

/** Who was told, by device token, in send order. */
const told = () => outbox.map((o) => o.tokens[0].replace(/^tok-/, ''));

beforeEach(async () => {
  outbox = [];
  process.env.NOTIFY_AUDIENCE = 'everyone';
  setSender(async (tokens, message): Promise<SendOutcome> => {
    outbox.push({ tokens, message });
    return { stale: [], sent: tokens.length };
  });
  for (const c of [
    COLLECTIONS.cohorts,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.students,
    COLLECTIONS.coursework,
    COLLECTIONS.submissions,
    COLLECTIONS.drafts,
    COLLECTIONS.grades,
    COLLECTIONS.submissionEvents,
    COLLECTIONS.notifications,
  ]) {
    await db().recursiveDelete(db().collection(c));
  }
  const { id: cohortId } = await createCohortRecord(TEACHER, 'Autumn');
  ({ id: courseId } = await createCourseRecord(TEACHER, { cohortId, name: 'Hikam' }));
  await db().collection(COLLECTIONS.courses).doc(courseId).update({ managerUids: [TEACHER] });
  for (const uid of [AMINAH, BILAL, CAROL]) {
    await db().collection(COLLECTIONS.students).doc(uid).set({ displayName: uid, email: `${uid}@example.com`, status: 'active' });
    await createEnrollmentRecord(TEACHER, { studentUid: uid, courseId });
    await db()
      .collection(COLLECTIONS.notifications)
      .doc(uid)
      .collection('devices')
      .doc(`tok-${uid}`)
      .set({ token: `tok-${uid}`, platform: 'android', registeredAt: 1 });
  }
});

afterEach(() => {
  resetSender();
  process.env.NOTIFY_AUDIENCE = savedAudience;
});

const as = async (uid: string, data: unknown) =>
  ({ auth: { uid, token: { role: 'manager', status: 'active' }, rawToken: await idTokenFor(uid) }, data }) as unknown as CallableRequest;

const FIELDS = {
  title: 'Memorize the first hikma',
  instructions: '',
  dueDate: inDays(7),
  lateUntil: inDays(14),
  grading: { kind: 'points' as const, outOf: 10 },
};

async function postedThroughTheApp(): Promise<string> {
  const { id } = await createCourseworkRecord(TEACHER, courseId, FIELDS);
  await postCoursework.run(await as(TEACHER, { courseworkId: id }));
  return id;
}

async function handIn(uid: string, id: string) {
  const draft: DraftDoc = { studentUid: uid, courseworkId: id, courseId, note: 'Done', files: {}, updatedAt: Date.now() };
  await db().collection(COLLECTIONS.drafts).doc(submissionId(uid, id)).set(draft);
  await handInWork(uid, id);
}

describe('a new assignment', () => {
  it('POSTING TELLS THE CLASS, once each, and the tap opens the assignment', async () => {
    const id = await postedThroughTheApp();
    expect(told().sort()).toEqual([AMINAH, BILAL, CAROL].sort());
    for (const { message } of outbox) {
      expect(message.title).toBe('Hikam: new assignment');
      expect(message.body).toBe(`Memorize the first hikma. Hand it in by ${inDays(7)}.`);
      expect(message.path).toBe(`work/${id}`);
    }
  });

  it('a student who switched new assignments off is not told', async () => {
    await db().collection(COLLECTIONS.notifications).doc(BILAL).set({ assignmentPosted: false });
    await postedThroughTheApp();
    expect(told().sort()).toEqual([AMINAH, CAROL].sort());
  });
});

describe('a due date that moves', () => {
  it('tells those still working on it — not who has handed in, nor who has their own date', async () => {
    const id = await postedThroughTheApp();
    await handIn(AMINAH, id);
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate: inDays(20), lateUntil: null }, reason: 'Travel' });
    outbox = [];
    await updateCoursework.run(await as(TEACHER, { courseworkId: id, ...FIELDS, dueDate: inDays(9), lateUntil: inDays(16) }));
    expect(told()).toEqual([CAROL]);
    expect(outbox[0].message).toEqual({
      title: 'Hikam: due date moved',
      body: `Memorize the first hikma is now due ${inDays(9)}.`,
      path: `work/${id}`,
    });
    // A new date is a new message; the same edit again is not.
    await updateCoursework.run(await as(TEACHER, { courseworkId: id, ...FIELDS, dueDate: inDays(10), lateUntil: inDays(16) }));
    await updateCoursework.run(await as(TEACHER, { courseworkId: id, ...FIELDS, title: 'Memorize it', dueDate: inDays(10), lateUntil: inDays(16) }));
    expect(told()).toEqual([CAROL, CAROL]);
  });

  it('a date moved back to one already announced is announced again; another try is not told', async () => {
    const id = await postedThroughTheApp();
    await handIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 4 }, feedback: 'Again' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(20), lateUntil: null });
    outbox = [];
    await updateCoursework.run(await as(TEACHER, { courseworkId: id, ...FIELDS, dueDate: inDays(9) }));
    await updateCoursework.run(await as(TEACHER, { courseworkId: id, ...FIELDS }));
    expect(told().sort()).toEqual([BILAL, BILAL, CAROL, CAROL].sort());
    expect(outbox.map((o) => o.message.body).filter((b) => b.endsWith(`now due ${inDays(7)}.`))).toHaveLength(2);
  });
});

describe('returned work', () => {
  it('tells the student their work is back, never the grade, and again for a changed grade', async () => {
    const id = await postedThroughTheApp();
    await handIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: 'Good.' });
    outbox = [];
    await returnWork.run(await as(TEACHER, { courseworkId: id, studentUids: [AMINAH] }));
    expect(told()).toEqual([AMINAH]);
    expect(outbox[0].message).toEqual({
      title: 'Hikam: work returned',
      body: 'Your teacher returned Memorize the first hikma.',
      path: `work/${id}`,
    });
    // Feedback reworded on returned work changes no grade: nobody is told.
    await saveGrade.run(await as(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: 'Good work.' }));
    expect(told()).toEqual([AMINAH]);
    // A changed grade is a new return, so it is told — not swallowed as a repeat.
    await saveGrade.run(await as(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 10 }, feedback: 'Good work.' }));
    expect(told()).toEqual([AMINAH, AMINAH]);
    expect(outbox.every((o) => !/\b(9|10)\b/.test(o.message.body))).toBe(true);
  });
});

describe('the last day to hand in, at 7 AM', () => {
  it('tells those with nothing in, on their own date — not anyone let off, nor twice', async () => {
    const id = await postedThroughTheApp();
    // Time has passed: the class's work is due today, with no late work.
    await db().collection(COLLECTIONS.coursework).doc(id).update({ dueDate: today, lateUntil: null });
    for (const uid of [AMINAH, BILAL, CAROL]) {
      await db().collection(COLLECTIONS.submissions).doc(submissionId(uid, id)).update({ dueDate: today, lateUntil: null });
    }
    await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: 'Joined late' });
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: CAROL, dates: { dueDate: inDays(3), lateUntil: null }, reason: 'Ill' });
    outbox = [];
    await notifyHandInLastDay(db(), today);
    expect(told()).toEqual([AMINAH]);
    expect(outbox[0].message).toEqual({
      title: 'Hikam: last day to hand in',
      body: `Memorize the first hikma is due by the end of ${today}.`,
      path: `work/${id}`,
    });
    await notifyHandInLastDay(db(), today);
    expect(told()).toEqual([AMINAH]);
    // Carol's own last day comes on her own date.
    await notifyHandInLastDay(db(), inDays(3));
    expect(told()).toEqual([AMINAH, CAROL]);
  });

  it('says nothing for a course that has been archived', async () => {
    const id = await postedThroughTheApp();
    await db().collection(COLLECTIONS.submissions).doc(submissionId(AMINAH, id)).update({ dueDate: today });
    await applyCourseUpdate({ courseId, archived: true });
    outbox = [];
    await notifyHandInLastDay(db(), today);
    expect(told()).toEqual([]);
  });
});
