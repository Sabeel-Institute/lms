import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  addDays,
  countsFromTally,
  courseworkCounts,
  submissionId,
  todayInZone,
  type CourseworkDoc,
  type CourseworkTallyDoc,
  type DraftDoc,
  type GradeDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { applyEnrollmentActive, createEnrollmentRecord } from '../../src/enrollments';
import {
  closeCourseworkRecord,
  createCourseworkRecord,
  deleteCourseworkRecord,
  giveMoreTimeRecord,
  handInWork,
  postCourseworkRecord,
  reopenCourseworkRecord,
  returnWorkRecord,
  saveGradeRecord,
  setNotRequiredRecord,
} from '../../src/coursework';
import { recomputeCourseworkTally } from '../../src/courseworkTallies';

/*
 * A COURSE'S PAGES SAY WHAT THE WORK SAYS. They read one stored tally per
 * assignment instead of every piece of work, so after any change to the work
 * the stored tally must give the same figures, on any day, as counting the
 * work itself. Walked through an assignment's whole life on the real records.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'teacher-tally';
const [A, B, C, D] = ['stu-t-a', 'stu-t-b', 'stu-t-c', 'stu-t-d'];
const today = todayInZone(INSTITUTE_TIMEZONE);
const inDays = (n: number) => addDays(today, n);
let courseId = '';

beforeEach(async () => {
  for (const c of [
    COLLECTIONS.cohorts,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.students,
    COLLECTIONS.coursework,
    COLLECTIONS.submissions,
    COLLECTIONS.drafts,
    COLLECTIONS.grades,
    COLLECTIONS.courseworkTallies,
  ]) {
    await db().recursiveDelete(db().collection(c));
  }
  const { id: cohortId } = await createCohortRecord(TEACHER, 'Autumn');
  ({ id: courseId } = await createCourseRecord(TEACHER, { cohortId, name: 'Hikam' }));
  for (const uid of [A, B, C, D]) {
    await db().collection(COLLECTIONS.students).doc(uid).set({ displayName: uid, email: `${uid}@example.com`, status: 'active' });
    await createEnrollmentRecord(TEACHER, { studentUid: uid, courseId });
  }
});

async function posted(): Promise<string> {
  const { id } = await createCourseworkRecord(TEACHER, courseId, {
    title: 'Reflection',
    instructions: '',
    dueDate: inDays(7),
    lateUntil: inDays(14),
    grading: { kind: 'points', outOf: 10 },
  } as never);
  await postCourseworkRecord(TEACHER, id);
  return id;
}

async function handedIn(uid: string, id: string) {
  const draft: DraftDoc = { studentUid: uid, courseworkId: id, courseId, note: 'Mine', files: {}, updatedAt: Date.now() };
  await db().collection(COLLECTIONS.drafts).doc(submissionId(uid, id)).set(draft);
  await handInWork(uid, id);
}

const stored = async (id: string) => (await db().collection(COLLECTIONS.courseworkTallies).doc(id).get()).data() as CourseworkTallyDoc | undefined;

/** The figures counted from the work itself, as the assignment's own page counts them. */
async function counted(id: string, day: string) {
  const cw = (await db().collection(COLLECTIONS.coursework).doc(id).get()).data() as CourseworkDoc;
  const subs = (await db().collection(COLLECTIONS.submissions).where('courseworkId', '==', id).get()).docs.map((d) => d.data() as SubmissionDoc);
  const grades = new Map(
    (await db().collection(COLLECTIONS.grades).where('courseworkId', '==', id).get()).docs.map((g) => [(g.data() as GradeDoc).studentUid, g.data() as GradeDoc]),
  );
  return courseworkCounts(cw.grading, subs, grades, day, true, INSTITUTE_TIMEZONE);
}

/** The stored tally, recomputed as a write's trigger would, against the work, today and later. */
async function agrees(id: string) {
  await recomputeCourseworkTally(db(), id);
  const tally = (await stored(id))!;
  expect(tally.courseId).toBe(courseId);
  for (const day of [today, inDays(10), inDays(20)]) {
    expect(countsFromTally(tally, day, true)).toEqual(await counted(id, day));
  }
}

describe('a stored tally', () => {
  it('says what the work says through an assignment’s whole life', async () => {
    const id = await posted();
    await agrees(id);
    await handedIn(A, id);
    await agrees(id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: A, grade: { points: 8 }, feedback: '' });
    await agrees(id);
    await returnWorkRecord(id, [A], null);
    await agrees(id);
    // Graded on paper, with nothing handed in.
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: B, grade: { points: 6 }, feedback: '' });
    await agrees(id);
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: C, dates: { dueDate: inDays(16), lateUntil: null }, reason: 'Ill' });
    await agrees(id);
    await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: D, reason: 'Joined late' });
    await agrees(id);
    await closeCourseworkRecord(id);
    await agrees(id);
    await reopenCourseworkRecord(id);
    await agrees(id);
    await applyEnrollmentActive({ studentUid: C, courseId, active: false });
    await agrees(id);
    // Today's figures, said plainly, so a fault shared by both counts shows too.
    // A returned, B graded on paper; C left with nothing in and counts
    // nowhere; D was let off.
    expect(countsFromTally((await stored(id))!, today, true)).toMatchObject({
      expected: 2,
      handedIn: 2,
      returned: 1,
      toReturn: 1,
      notRequired: 1,
      average: 0.8,
    });
  });

  it('goes when its assignment does', async () => {
    const id = await posted();
    await agrees(id);
    await deleteCourseworkRecord(id, true);
    await recomputeCourseworkTally(db(), id);
    expect(await stored(id)).toBeUndefined();
  });

  /*
   * NOBODY RECOMPUTES BY HAND IN PRODUCTION: the triggers do. With the
   * emulator's own triggers running, a hand-in reaches the stored tally.
   */
  it('follows a hand-in by itself', async () => {
    const id = await posted();
    await handedIn(A, id);
    let tally: CourseworkTallyDoc | undefined;
    for (let i = 0; i < 40; i++) {
      tally = await stored(id);
      if (tally?.toGrade === 1) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(tally).toMatchObject({ toGrade: 1, handedIn: 1 });
  });
});
