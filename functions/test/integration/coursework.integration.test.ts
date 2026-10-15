import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  addDays,
  canTakeBack,
  enrollmentId,
  isLate,
  submissionId,
  staffWorkState,
  todayInZone,
  workState,
  type CourseworkDoc,
  type DraftDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { applyCourseUpdate, createCourseRecord } from '../../src/courses';
import { applyEnrollmentActive, createEnrollmentRecord, enrol } from '../../src/enrollments';
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
  takeBackWork,
  updateCourseworkRecord,
  validateDates,
} from '../../src/coursework';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TEACHER = 'teacher-uid';
const AMINAH = 'stu-aminah';
const BILAL = 'stu-bilal';
const LATECOMER = 'stu-late';
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
    COLLECTIONS.submissionEvents,
  ]) {
    const snap = await db().collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const { id: cohortId } = await createCohortRecord(TEACHER, 'Autumn');
  ({ id: courseId } = await createCourseRecord(TEACHER, { cohortId, name: 'Hikam' }));
  for (const uid of [AMINAH, BILAL, LATECOMER]) {
    await db().collection(COLLECTIONS.students).doc(uid).set({ displayName: uid, email: `${uid}@example.com`, status: 'active' });
  }
  for (const uid of [AMINAH, BILAL]) await createEnrollmentRecord(TEACHER, { studentUid: uid, courseId });
});

const fields = (over: Partial<Record<string, unknown>> = {}) => ({
  title: 'Memorize the first hikma',
  instructions: 'Recite it.',
  dueDate: inDays(7),
  lateUntil: inDays(14),
  grading: { kind: 'points' as const, outOf: 10 },
  ...over,
});

async function posted(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const f = { ...fields(), ...over } as ReturnType<typeof fields>;
  const { id } = await createCourseworkRecord(TEACHER, courseId, f as never);
  await postCourseworkRecord(TEACHER, id);
  return id;
}

const sub = async (uid: string, cwId: string) =>
  (await db().collection(COLLECTIONS.submissions).doc(submissionId(uid, cwId)).get()).data() as SubmissionDoc | undefined;
const draftOf = async (uid: string, cwId: string) =>
  (await db().collection(COLLECTIONS.drafts).doc(submissionId(uid, cwId)).get()).data() as DraftDoc | undefined;
const cw = async (id: string) => (await db().collection(COLLECTIONS.coursework).doc(id).get()).data() as CourseworkDoc | undefined;

/** What a student writes on their draft — the one thing they write directly. */
async function writeNote(uid: string, cwId: string, note: string) {
  const draft: DraftDoc = { studentUid: uid, courseworkId: cwId, courseId, note, files: {}, updatedAt: Date.now() };
  await db().collection(COLLECTIONS.drafts).doc(submissionId(uid, cwId)).set(draft);
}

/** The student's dates, moved as the passage of time moves them: the server never writes a past date. */
async function timePasses(uid: string, cwId: string, dates: { dueDate: string; lateUntil: string | null }) {
  await db().collection(COLLECTIONS.submissions).doc(submissionId(uid, cwId)).update(dates);
}

/** The class's own dates, moved the same way. */
async function classTimePasses(cwId: string, dates: { dueDate: string; lateUntil: string | null }) {
  await db().collection(COLLECTIONS.coursework).doc(cwId).update(dates);
}

const stateOf = async (uid: string, cwId: string) => workState((await sub(uid, cwId))!, today, true);

/** Something written, and handed in. */
async function handedIn(uid: string, id: string) {
  await writeNote(uid, id, `${uid}'s work`);
  await handInWork(uid, id);
}

describe('who receives an assignment', () => {
  it('a draft reaches no student; posting it gives every enrolled student their own work', async () => {
    const { id } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    expect(await sub(AMINAH, id)).toBeUndefined();
    const res = await postCourseworkRecord(TEACHER, id);
    expect(res.students).toBe(2);
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'open', active: true, dueDate: inDays(7), lateUntil: inDays(14) });
    expect(await stateOf(BILAL, id)).toBe('toDo');
  });

  it('two posts of one draft at once post it once', async () => {
    const { id } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    const outcomes = await Promise.allSettled([postCourseworkRecord(TEACHER, id), postCourseworkRecord(TEACHER, id)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already posted/);
  });

  it('a student joining by the due date gets it', async () => {
    const id = await posted({ dueDate: today, lateUntil: null });
    await createEnrollmentRecord(TEACHER, { studentUid: LATECOMER, courseId });
    expect(await stateOf(LATECOMER, id)).toBe('toDo');
  });

  it('joining after the due date owes nothing', async () => {
    const id = await posted();
    // The class's date has gone by: as time would leave it.
    await db().collection(COLLECTIONS.coursework).doc(id).update({ dueDate: inDays(-1), lateUntil: inDays(6) });
    await createEnrollmentRecord(TEACHER, { studentUid: LATECOMER, courseId });
    expect(await sub(LATECOMER, id)).toBeUndefined();
  });

  it('leaving takes it off To do and keeps the work; coming back restores what was handed in', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'My reflection');
    await handInWork(AMINAH, id);
    await applyEnrollmentActive({ studentUid: AMINAH, courseId, active: false });
    expect(await sub(AMINAH, id)).toMatchObject({ active: false, state: 'handedIn', note: 'My reflection' });
    await applyEnrollmentActive({ studentUid: AMINAH, courseId, active: true });
    expect((await sub(AMINAH, id))?.active).toBe(true);
  });

  it('coming back through Add a student keeps the day they left, which the workbook reads', async () => {
    const enrolment = () => db().collection(COLLECTIONS.enrollments).doc(enrollmentId(BILAL, courseId)).get();
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: false });
    const leftAt = (await enrolment()).data()?.unenrolledAt;
    expect(typeof leftAt).toBe('number');
    await createEnrollmentRecord(TEACHER, { studentUid: BILAL, courseId });
    expect((await enrolment()).data()).toMatchObject({ active: true, unenrolledAt: leftAt });
  });

  /*
   * THE ENROLMENT COMMITS BEFORE WHAT FOLLOWS IT. When giving the student the
   * class's work then failed, trying again was refused as "already in this
   * course", and nothing would ever give it to them.
   */
  it('trying again after the work was not given gives it, though they are in the class', async () => {
    const id = await posted();
    // Enrolled, as a first call left it, and nothing given.
    await db().collection(COLLECTIONS.enrollments).doc(enrollmentId(LATECOMER, courseId)).set({
      studentUid: LATECOMER, courseId, cohortId: 'c', active: true, enrolledAt: 1, enrolledBy: TEACHER,
    });
    expect(await sub(LATECOMER, id)).toBeUndefined();
    await expect(enrol(TEACHER, { studentUid: LATECOMER, courseId })).rejects.toThrow(/already in this course/);
    expect(await stateOf(LATECOMER, id)).toBe('toDo');
  });

  it('coming back does not revive open work whose date passed while away', async () => {
    const id = await posted();
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: false });
    await classTimePasses(id, { dueDate: inDays(-1), lateUntil: null });
    await timePasses(BILAL, id, { dueDate: inDays(-1), lateUntil: null });
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: true });
    expect((await sub(BILAL, id))?.active).toBe(false);
  });

  it('coming back keeps the more time a teacher gave, after the class\'s date has gone by', async () => {
    const id = await posted();
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate: inDays(10), lateUntil: inDays(14) }, reason: 'Travel' });
    await classTimePasses(id, { dueDate: inDays(-1), lateUntil: null });
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: false });
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: true });
    expect(await sub(BILAL, id)).toMatchObject({ active: true, dueDate: inDays(10) });
    expect(await stateOf(BILAL, id)).toBe('toDo');
  });

  it('coming back keeps another try, and the attempt before it, after the class\'s date has gone by', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'First go');
    await handInWork(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 4 }, feedback: 'Again, slowly.' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(10), lateUntil: inDays(17) });
    await classTimePasses(id, { dueDate: inDays(-1), lateUntil: null });
    await applyEnrollmentActive({ studentUid: AMINAH, courseId, active: false });
    await applyEnrollmentActive({ studentUid: AMINAH, courseId, active: true });
    const back = (await sub(AMINAH, id))!;
    expect(back).toMatchObject({ active: true, state: 'open', dueDate: inDays(10) });
    expect(back.attempts[0]).toMatchObject({ attempt: 1, returned: { grade: { points: 4 } } });
  });
});

describe('handing in', () => {
  it('moves the draft onto the work the teacher sees, and records the moment', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, '  It means hope rests on mercy.  ');
    const res = await handInWork(AMINAH, id);
    expect(res.late).toBe(false);
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'handedIn', note: 'It means hope rests on mercy.' });
    expect(await draftOf(AMINAH, id)).toBeUndefined();
    const events = await db().collection(COLLECTIONS.submissionEvents).where('studentUid', '==', AMINAH).get();
    expect(events.docs.map((e) => e.data().kind)).toEqual(['handIn']);
  });

  it('keeps a formatted answer as written, and no link the reader would refuse', async () => {
    // The draft is the student's own document, written straight to Firestore,
    // so what reaches the teacher is only what the reader can show safely.
    const id = await posted();
    await writeNote(AMINAH, id, '**Hope** rests on [mercy](javascript:alert(1))\n\n- one\n- [two](https://example.org)');
    await handInWork(AMINAH, id);
    expect((await sub(AMINAH, id))?.note).toBe('**Hope** rests on mercy\n\n- one\n- [two](https://example.org)');
  });

  it('refuses nothing at all', async () => {
    const id = await posted();
    await expect(handInWork(AMINAH, id)).rejects.toThrow(/answer or add a file/);
    await writeNote(AMINAH, id, '   ');
    await expect(handInWork(AMINAH, id)).rejects.toThrow(/answer or add a file/);
  });

  it('takes late work while the teacher accepts it, marked late', async () => {
    const id = await posted();
    await timePasses(AMINAH, id, { dueDate: inDays(-2), lateUntil: inDays(5) });
    await writeNote(AMINAH, id, 'Sorry this is late');
    expect((await handInWork(AMINAH, id)).late).toBe(true);
  });

  it('refuses once it has closed, and once the course is archived', async () => {
    const id = await posted();
    await timePasses(AMINAH, id, { dueDate: inDays(-9), lateUntil: inDays(-2) });
    await writeNote(AMINAH, id, 'Too late');
    await expect(handInWork(AMINAH, id)).rejects.toThrow(/closed/);
    await writeNote(BILAL, id, 'On time');
    await applyCourseUpdate({ courseId, archived: true });
    await expect(handInWork(BILAL, id)).rejects.toThrow(/archived/);
  });

  it('is not open to a student who does not have the assignment', async () => {
    const id = await posted();
    await expect(handInWork(LATECOMER, id)).rejects.toThrow(/not yours/);
  });
});

describe('taking work back', () => {
  it('returns it to the draft until the due date, and the teacher stops seeing it', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'First go');
    await handInWork(AMINAH, id);
    await takeBackWork(AMINAH, id);
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'open', note: '', handedInAt: null });
    expect((await draftOf(AMINAH, id))?.note).toBe('First go');
  });

  it('is refused after the due date, and once returned', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'Mine');
    await handInWork(AMINAH, id);
    await timePasses(AMINAH, id, { dueDate: inDays(-1), lateUntil: inDays(6) });
    await expect(takeBackWork(AMINAH, id)).rejects.toThrow(/due date has passed/);

    await writeNote(BILAL, id, 'His');
    await handInWork(BILAL, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 7 }, feedback: '' });
    await returnWorkRecord(id, [BILAL], null);
    await expect(takeBackWork(BILAL, id)).rejects.toThrow(/not handed in/);
  });

  /*
   * A GRADE BEING WRITTEN WAS FOR THE WORK TAKEN BACK. Kept, the new hand-in
   * read as graded and Return sent that grade and its feedback on work nobody
   * had read; saved a moment after the take-back, it was stored as paper work.
   */
  it('takes the grade being written away with it, and refuses one typed on the work it took back', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'Version one');
    await handInWork(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 8 }, feedback: 'On version one', onState: 'handedIn' });
    await takeBackWork(AMINAH, id);
    expect((await db().collection(COLLECTIONS.grades).doc(submissionId(AMINAH, id)).get()).exists).toBe(false);
    await expect(
      saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 6 }, feedback: '', onState: 'handedIn' }),
    ).rejects.toThrow(/took this work back/);
    expect((await db().collection(COLLECTIONS.grades).doc(submissionId(AMINAH, id)).get()).exists).toBe(false);
    await writeNote(AMINAH, id, 'Version two');
    await handInWork(AMINAH, id);
    expect(staffWorkState((await sub(AMINAH, id))!, undefined, today, true)).toBe('toGrade');
  });

  /*
   * ONLY WHILE IT COULD GO BACK IN. Taken back after "Stop taking work", or
   * after the course was archived, the work could never be handed in again:
   * the teacher saw it as missed and could not return it, and the answer sat
   * in a draft no member of staff reads.
   */
  it('is refused once the teacher stops taking work, and once the course is archived, and the work stays in', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'Before the stop');
    await handInWork(AMINAH, id);
    await closeCourseworkRecord(id);
    await expect(takeBackWork(AMINAH, id)).rejects.toThrow(/stopped taking work/);
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'handedIn', note: 'Before the stop' });
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: '' });
    await returnWorkRecord(id, [AMINAH], null);
    expect((await sub(AMINAH, id))?.state).toBe('returned');

    const id2 = await posted();
    await writeNote(BILAL, id2, 'Before the archive');
    await handInWork(BILAL, id2);
    await applyCourseUpdate({ courseId, archived: true });
    await expect(takeBackWork(BILAL, id2)).rejects.toThrow(/archived/);
    expect(await sub(BILAL, id2)).toMatchObject({ state: 'handedIn', note: 'Before the archive' });
  });
});

describe('grading and returning', () => {
  it('a student cannot see a grade until it is returned, then sees exactly it', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: 'Steady.' });
    // What the student reads: their submission. No grade on it yet.
    expect((await sub(AMINAH, id))?.returned).toBeNull();
    await returnWorkRecord(id, [AMINAH], null);
    expect(await sub(AMINAH, id)).toMatchObject({
      state: 'returned',
      returned: { grade: { points: 9 }, feedback: 'Steady.', seq: 1, retry: false },
    });
  });

  it('will not return ungraded work, or a grade that does not fit', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await expect(returnWorkRecord(id, [AMINAH], null)).rejects.toThrow(/Grade the work/);
    // Feedback written before the grade is not a grade.
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: null, feedback: 'Coming back to this' });
    await expect(returnWorkRecord(id, [AMINAH], null)).rejects.toThrow(/Grade the work/);
    expect((await sub(AMINAH, id))?.state).toBe('handedIn');
    await expect(
      saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 11 }, feedback: '' }),
    ).rejects.toThrow(/0 to 10/);
    await expect(
      saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { scale: 'satisfactory' }, feedback: '' }),
    ).rejects.toThrow(/0 to 10/);
  });

  it('a changed returned grade reaches the student as a new return; changed feedback alone does not', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 6 }, feedback: 'Ok' });
    await returnWorkRecord(id, [AMINAH], null);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 6 }, feedback: 'Ok, see me' });
    expect((await sub(AMINAH, id))?.returned).toMatchObject({ feedback: 'Ok, see me', seq: 1 });
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 8 }, feedback: 'Ok, see me' });
    expect((await sub(AMINAH, id))?.returned).toMatchObject({ grade: { points: 8 }, seq: 2 });
  });

  it('a returned grade can be changed but not taken away, and a save that changes nothing is no change', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: 'Good' });
    await returnWorkRecord(id, [AMINAH], null);
    await expect(
      saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: null, feedback: 'Good' }),
    ).rejects.toThrow(/cannot be removed/);
    expect((await sub(AMINAH, id))?.returned).toMatchObject({ grade: { points: 9 }, seq: 1 });
    const same = await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: 'Good' });
    expect(same.returnedChanged).toBe(false);
    expect((await sub(AMINAH, id))?.returned).toMatchObject({ grade: { points: 9 }, feedback: 'Good', seq: 1 });
  });

  it('another try keeps the first attempt and its feedback, and opens the work again with a new date', async () => {
    const id = await posted({ grading: { kind: 'scale' } });
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { scale: 'needsWork' }, feedback: 'Redo line 4.' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(10), lateUntil: inDays(17) });
    const after = (await sub(AMINAH, id))!;
    expect(after).toMatchObject({ state: 'open', attempt: 2, dueDate: inDays(10), note: '', returned: { retry: true } });
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({ attempt: 1, note: `${AMINAH}'s work`, returned: { feedback: 'Redo line 4.' } });
    // The next attempt is graded from scratch.
    expect((await db().collection(COLLECTIONS.grades).doc(submissionId(AMINAH, id)).get()).exists).toBe(false);
    expect(workState(after, today, true)).toBe('toDo');
  });

  it('WORK ALREADY BACK IS DONE: returning all graded goes on past one returned a moment earlier', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await handedIn(BILAL, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 8 }, feedback: '' });
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 9 }, feedback: '' });
    // Another teacher returns Aminah's; this one then returns everything graded.
    await returnWorkRecord(id, [AMINAH], null);
    const res = await returnWorkRecord(id, [AMINAH, BILAL], null);
    expect(res.returned.map((r) => r.studentUid)).toEqual([BILAL]);
    expect(res.refused).toEqual([]);
    expect((await sub(BILAL, id))?.state).toBe('returned');
    expect((await sub(AMINAH, id))?.returned?.seq).toBe(1);
  });

  it('returning several goes on past one that cannot be returned, and says which', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await handedIn(BILAL, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 9 }, feedback: '' });
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 7 }, feedback: '' });
    // Bilal takes his work back while the teacher is confirming Return all.
    await takeBackWork(BILAL, id);
    const res = await returnWorkRecord(id, [AMINAH, BILAL], null);
    expect(res.returned.map((r) => r.studentUid)).toEqual([AMINAH]);
    expect(res.refused).toEqual([{ studentUid: BILAL, reason: expect.stringMatching(/Grade the work|Nothing has been handed in/) }]);
    expect((await sub(AMINAH, id))?.state).toBe('returned');
    // With nothing at all to return, the call is refused, as before.
    await expect(returnWorkRecord(id, [BILAL], null)).rejects.toThrow();
  });

  it('another try on an assignment that stopped taking work opens it for that student', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await closeCourseworkRecord(id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 4 }, feedback: 'Again, please.' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(14), lateUntil: null });
    expect(await stateOf(AMINAH, id)).toBe('toDo');
    await writeNote(AMINAH, id, 'Second go');
    await handInWork(AMINAH, id);
    expect((await sub(AMINAH, id))?.state).toBe('handedIn');
  });

  it('work done on paper can be graded and returned with nothing handed in', async () => {
    const id = await posted();
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 10 }, feedback: 'Recited in class.' });
    await returnWorkRecord(id, [BILAL], null);
    expect(await sub(BILAL, id)).toMatchObject({ state: 'returned', returned: { grade: { points: 10 } } });
  });

  it('how it is graded cannot change once a grade went back with another try, either', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 8 }, feedback: '' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(10), lateUntil: inDays(17) });
    await expect(updateCourseworkRecord(id, fields({ grading: { kind: 'points', outOf: 100 } }))).rejects.toThrow(/cannot change/);
  });

  it('how it is graded cannot change once a grade is saved', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 5 }, feedback: '' });
    await expect(updateCourseworkRecord(id, fields({ grading: { kind: 'scale' } }))).rejects.toThrow(/cannot change/);
  });

  it('ANOTHER TEACHER’S EDIT IS NOT OVERWRITTEN: a form opened before it is refused', async () => {
    const id = await posted();
    // Two teachers open the same assignment; one saves first.
    const opened = fields();
    await updateCourseworkRecord(id, { ...fields({ title: 'Theirs' }), ifUnchanged: opened });
    await expect(updateCourseworkRecord(id, { ...fields({ title: 'Mine' }), ifUnchanged: opened })).rejects.toThrow(
      /Someone else changed/,
    );
    expect((await cw(id))?.title).toBe('Theirs');
  });

  /*
   * "UPDATED <date>" IS FOR A CHANGE. Every student of the class reads it on
   * their assignment page, and a Save that changed nothing, or stopping taking
   * work, said the assignment had been changed when it had not.
   */
  it('a save that changes nothing, or stopping taking work, tells no student it was updated', async () => {
    const id = await posted();
    await updateCourseworkRecord(id, fields());
    expect((await cw(id))?.editedAt).toBeNull();
    await closeCourseworkRecord(id);
    expect((await cw(id))?.editedAt).toBeNull();
    await updateCourseworkRecord(id, fields({ title: 'Memorize the second hikma' }));
    expect(typeof (await cw(id))?.editedAt).toBe('number');
  });

  it('posting and closing are not someone else’s edit: the form still saves', async () => {
    const { id } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    const opened = fields();
    await postCourseworkRecord(TEACHER, id);
    await closeCourseworkRecord(id);
    await updateCourseworkRecord(id, { ...fields({ title: 'Mine' }), ifUnchanged: opened });
    expect((await cw(id))?.title).toBe('Mine');
  });
});

/*
 * NO LESS TIME THAN THEY HAVE. Another try was offered a week from today with
 * no late work, weeks less than the class for a student who handed in early,
 * and a second "more time" from the class's date cut short a student already
 * given until later. The server now refuses both.
 */
describe('no less time than they have', () => {
  it('another try may not end before the class’s dates', async () => {
    const id = await posted(); // due in 7 days, late work until 14
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 4 }, feedback: 'Again.' });
    await expect(returnWorkRecord(id, [AMINAH], { dueDate: inDays(3), lateUntil: null })).rejects.toThrow(/cannot end before the class/);
    await expect(returnWorkRecord(id, [AMINAH], { dueDate: inDays(10), lateUntil: null })).rejects.toThrow(/cannot end before the class/);
    expect((await sub(AMINAH, id))?.state).toBe('handedIn');
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(7), lateUntil: inDays(14) });
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'open', dueDate: inDays(7), lateUntil: inDays(14) });
  });

  it('more time for a student given until later may not end before their own date', async () => {
    const id = await posted();
    const give = (dueDate: string) =>
      giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate, lateUntil: null }, reason: 'Ill' });
    await give(inDays(20));
    await expect(give(inDays(16))).rejects.toThrow(/less time than they have now/);
    expect((await sub(BILAL, id))?.dueDate).toBe(inDays(20));
    await give(inDays(25));
    expect((await sub(BILAL, id))?.dueDate).toBe(inDays(25));
  });
});

describe('one student at a time', () => {
  it('moving a date re-judges late: more time makes late work on time', async () => {
    const id = await posted();
    await classTimePasses(id, { dueDate: inDays(-2), lateUntil: inDays(5) });
    await timePasses(AMINAH, id, { dueDate: inDays(-2), lateUntil: inDays(5) });
    await writeNote(AMINAH, id, 'Was ill');
    await handInWork(AMINAH, id);
    const before = (await sub(AMINAH, id))!;
    expect(isLate(before.handedInAt!, before.dueDate, INSTITUTE_TIMEZONE)).toBe(true);
    await giveMoreTimeRecord(TEACHER, {
      courseworkId: id,
      studentUid: AMINAH,
      dates: { dueDate: today, lateUntil: null },
      reason: 'Ill all week',
    });
    const after = (await sub(AMINAH, id))!;
    expect(isLate(after.handedInAt!, after.dueDate, INSTITUTE_TIMEZONE)).toBe(false);
    expect(after.moreTime?.reason).toBe('Ill all week');
  });

  it('more time reopens missed work, and survives the class’s date moving', async () => {
    const id = await posted();
    await classTimePasses(id, { dueDate: inDays(-9), lateUntil: inDays(-2) });
    await timePasses(BILAL, id, { dueDate: inDays(-9), lateUntil: inDays(-2) });
    expect(await stateOf(BILAL, id)).toBe('missed');
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate: inDays(3), lateUntil: null }, reason: 'Travel' });
    expect(await stateOf(BILAL, id)).toBe('toDo');
    await updateCourseworkRecord(id, fields({ dueDate: inDays(20), lateUntil: null }));
    expect((await sub(BILAL, id))?.dueDate).toBe(inDays(3));
    expect((await sub(AMINAH, id))?.dueDate).toBe(inDays(20));
  });

  it('another try keeps its own date when the class’s date moves, or late work is switched off', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'First');
    await handInWork(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 5 }, feedback: '' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(20), lateUntil: null });
    await updateCourseworkRecord(id, fields({ dueDate: inDays(8), lateUntil: inDays(14) }));
    expect(await sub(AMINAH, id)).toMatchObject({ dueDate: inDays(20), lateUntil: null });
    await updateCourseworkRecord(id, fields({ dueDate: inDays(8), lateUntil: null }));
    expect(await sub(AMINAH, id)).toMatchObject({ dueDate: inDays(20), lateUntil: null });
    expect(await stateOf(AMINAH, id)).toBe('toDo');
    expect(await sub(BILAL, id)).toMatchObject({ dueDate: inDays(8), lateUntil: null });
  });

  /*
   * MORE TIME IS MORE. The form offered a week from today and no late work,
   * and the server took any date not in the past, so "more time" could leave a
   * student less time than their classmates.
   */
  it('more time never ends before the class’s due date or its last day for late work', async () => {
    const id = await posted(); // due in 7 days, late work for 14
    const give = (dueDate: string, lateUntil: string | null) =>
      giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, dates: { dueDate, lateUntil }, reason: 'Travel' });
    await expect(give(inDays(5), null)).rejects.toThrow(/cannot end before the class/);
    await expect(give(inDays(9), null)).rejects.toThrow(/cannot end before the class/);
    expect(await sub(AMINAH, id)).toMatchObject({ dueDate: inDays(7), lateUntil: inDays(14), moreTime: null });
    await give(inDays(9), inDays(16));
    expect(await sub(AMINAH, id)).toMatchObject({ dueDate: inDays(9), lateUntil: inDays(16) });
  });

  it('making required a student never let off is no change, so nothing is recorded', async () => {
    const id = await posted();
    expect((await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: null })).changed).toBe(false);
    expect((await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: 'Away' })).changed).toBe(true);
    expect((await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: 'Away' })).changed).toBe(false);
  });

  it('not required counts nowhere and can be undone', async () => {
    const id = await posted();
    await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: 'Joined after the visit' });
    expect(await stateOf(BILAL, id)).toBe('notRequired');
    await expect(
      saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 3 }, feedback: '' }),
    ).rejects.toThrow(/not required/);
    await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: null });
    expect(await stateOf(BILAL, id)).toBe('toDo');
  });
});

describe('closing and archiving', () => {
  it('stopping early closes the work of everyone with nothing in', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'In time');
    await handInWork(AMINAH, id);
    await closeCourseworkRecord(id);
    expect(await stateOf(BILAL, id)).toBe('missed');
    expect(await stateOf(AMINAH, id)).toBe('handedIn');
  });

  /*
   * STOPPING KEEPS A PROMISE MADE TO ONE STUDENT (decided 2026-10-14). A
   * student given more time, or another try, was marked missed with the rest
   * of the class the moment work stopped, days before the date they had been
   * given.
   */
  it('stopping early leaves anyone given more time or another try open, until their own date', async () => {
    const id = await posted();
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate: inDays(15), lateUntil: null }, reason: 'Travel' });
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 4 }, feedback: 'Again, please.' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(14), lateUntil: null });
    await createEnrollmentRecord(TEACHER, { studentUid: LATECOMER, courseId });
    await closeCourseworkRecord(id);
    expect(await stateOf(LATECOMER, id)).toBe('missed');
    expect(await stateOf(BILAL, id)).toBe('toDo');
    expect(await stateOf(AMINAH, id)).toBe('toDo');
    // And they can hand in, by their own date.
    await writeNote(BILAL, id, 'Back from travel');
    await handInWork(BILAL, id);
    await writeNote(AMINAH, id, 'Second go');
    await handInWork(AMINAH, id);
    expect((await sub(BILAL, id))?.state).toBe('handedIn');
    expect((await sub(AMINAH, id))?.state).toBe('handedIn');
  });

  /*
   * TAKING WORK AGAIN (decided 2026-10-14): stopping, undone. Before it, a
   * stop pressed by mistake, or too early, could only be answered student by
   * student with more time.
   */
  it('taking work again puts the students it closed back on the assignment’s dates', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await closeCourseworkRecord(id);
    expect(await stateOf(BILAL, id)).toBe('missed');
    expect(canTakeBack((await sub(AMINAH, id))!, today, true)).toBe(false);
    expect((await reopenCourseworkRecord(id)).changed).toBe(true);
    expect((await cw(id))?.closedAt).toBeNull();
    expect(await stateOf(BILAL, id)).toBe('toDo');
    await writeNote(BILAL, id, 'Now');
    await handInWork(BILAL, id);
    expect((await sub(BILAL, id))?.state).toBe('handedIn');
    // Work in before the stop can be taken back again while it is open.
    expect(canTakeBack((await sub(AMINAH, id))!, today, true)).toBe(true);
  });

  it('taking work again keeps a student’s own dates, and the class’s dates still decide the rest', async () => {
    const id = await posted();
    await closeCourseworkRecord(id);
    // More time given while it was closed: the student's own dates.
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, dates: { dueDate: inDays(15), lateUntil: null }, reason: 'Ill' });
    // The class's due date has gone by while it was closed; late work is still taken.
    await classTimePasses(id, { dueDate: inDays(-1), lateUntil: inDays(6) });
    await timePasses(BILAL, id, { dueDate: inDays(-1), lateUntil: inDays(6) });
    await reopenCourseworkRecord(id);
    expect(await sub(AMINAH, id)).toMatchObject({ dueDate: inDays(15), lateUntil: null, closedEarly: false });
    expect(await stateOf(AMINAH, id)).toBe('toDo');
    expect(await stateOf(BILAL, id)).toBe('pastDue');
  });

  it('a student who joined while it was closed receives it when work is taken again, if its due date has not gone', async () => {
    const id = await posted();
    await closeCourseworkRecord(id);
    await createEnrollmentRecord(TEACHER, { studentUid: LATECOMER, courseId });
    expect(await sub(LATECOMER, id)).toBeUndefined();
    expect((await reopenCourseworkRecord(id)).given).toBe(1);
    expect(await stateOf(LATECOMER, id)).toBe('toDo');
    // Past its due date, a joiner owes nothing: as for anyone joining late.
    const late = await posted();
    await closeCourseworkRecord(late);
    await db().collection(COLLECTIONS.students).doc('stu-later').set({ displayName: 'Later', email: 'later@example.com', status: 'active' });
    await createEnrollmentRecord(TEACHER, { studentUid: 'stu-later', courseId });
    await classTimePasses(late, { dueDate: inDays(-1), lateUntil: inDays(6) });
    expect((await reopenCourseworkRecord(late)).given).toBe(0);
    expect(await sub('stu-later', late)).toBeUndefined();
  });

  it('taking work again is refused on a draft or an archived course, and changes nothing on open work', async () => {
    const { id: draft } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    await expect(reopenCourseworkRecord(draft)).rejects.toThrow(/Only a posted assignment/);
    const id = await posted();
    expect(await reopenCourseworkRecord(id)).toMatchObject({ changed: false });
    await closeCourseworkRecord(id);
    await applyCourseUpdate({ courseId, archived: true });
    await expect(reopenCourseworkRecord(id)).rejects.toThrow(/archived/);
    expect(typeof (await cw(id))?.closedAt).toBe('number');
  });

  it('archiving the course closes open work rather than marking it missed', async () => {
    const id = await posted();
    await applyCourseUpdate({ courseId, archived: true });
    expect(workState((await sub(BILAL, id))!, today, false)).toBe('closed');
  });
});

describe('dates', () => {
  it('are never written in the past, and late work never ends before the due date', () => {
    expect(() => validateDates({ dueDate: inDays(-1), lateUntil: null }, today)).toThrow(/past/);
    expect(() => validateDates({ dueDate: inDays(3), lateUntil: inDays(2) }, today)).toThrow(/before the due date/);
    expect(() => validateDates({ dueDate: '2026-02-30', lateUntil: null }, today)).toThrow(/YYYY-MM-DD/);
    expect(validateDates({ dueDate: inDays(3), lateUntil: null }, today)).toEqual({ dueDate: inDays(3), lateUntil: null });
  });

  it('an edit may resend a date that has since passed, but not move one into the past', () => {
    const current = { dueDate: inDays(-3), lateUntil: inDays(4) };
    expect(validateDates(current, today, current)).toEqual(current);
    expect(() => validateDates({ dueDate: inDays(-2), lateUntil: inDays(4) }, today, current)).toThrow(/past/);
  });

  it('posting refuses a draft whose due date has gone by', async () => {
    const { id } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    await db().collection(COLLECTIONS.coursework).doc(id).update({ dueDate: inDays(-1) });
    await expect(postCourseworkRecord(TEACHER, id)).rejects.toThrow(/Move it/);
    expect(await sub(AMINAH, id)).toBeUndefined();
  });
});

describe('deleting', () => {
  it('a teacher deletes one no student has started, and everything goes', async () => {
    const id = await posted();
    await deleteCourseworkRecord(id, false);
    expect(await cw(id)).toBeUndefined();
    expect(await sub(AMINAH, id)).toBeUndefined();
  });

  it('a refused delete destroys nothing: once a student has a draft, only an admin may', async () => {
    const id = await posted();
    await writeNote(AMINAH, id, 'Half written');
    await expect(deleteCourseworkRecord(id, false)).rejects.toThrow(/only an admin/);
    expect(await cw(id)).toBeDefined();
    expect((await draftOf(AMINAH, id))?.note).toBe('Half written');
    expect(await sub(AMINAH, id)).toBeDefined();

    await deleteCourseworkRecord(id, true);
    expect(await cw(id)).toBeUndefined();
    expect(await draftOf(AMINAH, id)).toBeUndefined();
  });

  it('a teacher’s mark on one student’s work counts as started', async () => {
    const id = await posted();
    await setNotRequiredRecord(TEACHER, { courseworkId: id, studentUid: BILAL, reason: 'Away' });
    await expect(deleteCourseworkRecord(id, false)).rejects.toThrow(/only an admin/);
  });
});
