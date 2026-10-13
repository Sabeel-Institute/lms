import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  addDays,
  isLate,
  submissionId,
  todayInZone,
  workState,
  type CourseworkDoc,
  type DraftDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { applyCourseUpdate, createCourseRecord } from '../../src/courses';
import { applyEnrollmentActive, createEnrollmentRecord } from '../../src/enrollments';
import {
  closeCourseworkRecord,
  createCourseworkRecord,
  deleteCourseworkRecord,
  giveMoreTimeRecord,
  handInWork,
  postCourseworkRecord,
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

const stateOf = async (uid: string, cwId: string) => workState((await sub(uid, cwId))!, today, true);

describe('who receives an assignment', () => {
  it('a draft reaches no student; posting it gives every enrolled student their own work', async () => {
    const { id } = await createCourseworkRecord(TEACHER, courseId, fields() as never);
    expect(await sub(AMINAH, id)).toBeUndefined();
    const res = await postCourseworkRecord(TEACHER, id);
    expect(res.students).toBe(2);
    expect(await sub(AMINAH, id)).toMatchObject({ state: 'open', active: true, dueDate: inDays(7), lateUntil: inDays(14) });
    expect(await stateOf(BILAL, id)).toBe('toDo');
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

  it('coming back does not revive open work whose date passed while away', async () => {
    const id = await posted();
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: false });
    await db().collection(COLLECTIONS.coursework).doc(id).update({ dueDate: inDays(-1), lateUntil: null });
    await applyEnrollmentActive({ studentUid: BILAL, courseId, active: true });
    expect((await sub(BILAL, id))?.active).toBe(false);
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
});

describe('grading and returning', () => {
  async function handedIn(uid: string, id: string) {
    await writeNote(uid, id, `${uid}'s work`);
    await handInWork(uid, id);
  }

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

  it('another try keeps the first attempt and its feedback, and opens the work again with a new date', async () => {
    const id = await posted({ grading: { kind: 'scale' } });
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { scale: 'needsWork' }, feedback: 'Redo line 4.' });
    await returnWorkRecord(id, [AMINAH], { dueDate: inDays(10), lateUntil: null });
    const after = (await sub(AMINAH, id))!;
    expect(after).toMatchObject({ state: 'open', attempt: 2, dueDate: inDays(10), note: '', returned: { retry: true } });
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({ attempt: 1, note: `${AMINAH}'s work`, returned: { feedback: 'Redo line 4.' } });
    // The next attempt is graded from scratch.
    expect((await db().collection(COLLECTIONS.grades).doc(submissionId(AMINAH, id)).get()).exists).toBe(false);
    expect(workState(after, today, true)).toBe('toDo');
  });

  it('work done on paper can be graded and returned with nothing handed in', async () => {
    const id = await posted();
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, grade: { points: 10 }, feedback: 'Recited in class.' });
    await returnWorkRecord(id, [BILAL], null);
    expect(await sub(BILAL, id)).toMatchObject({ state: 'returned', returned: { grade: { points: 10 } } });
  });

  it('how it is graded cannot change once a grade is saved', async () => {
    const id = await posted();
    await handedIn(AMINAH, id);
    await saveGradeRecord(TEACHER, { courseworkId: id, studentUid: AMINAH, grade: { points: 5 }, feedback: '' });
    await expect(updateCourseworkRecord(id, fields({ grading: { kind: 'scale' } }))).rejects.toThrow(/cannot change/);
  });
});

describe('one student at a time', () => {
  it('moving a date re-judges late: more time makes late work on time', async () => {
    const id = await posted();
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
    await timePasses(BILAL, id, { dueDate: inDays(-9), lateUntil: inDays(-2) });
    expect(await stateOf(BILAL, id)).toBe('missed');
    await giveMoreTimeRecord(TEACHER, { courseworkId: id, studentUid: BILAL, dates: { dueDate: inDays(3), lateUntil: null }, reason: 'Travel' });
    expect(await stateOf(BILAL, id)).toBe('toDo');
    await updateCourseworkRecord(id, fields({ dueDate: inDays(20), lateUntil: null }));
    expect((await sub(BILAL, id))?.dueDate).toBe(inDays(3));
    expect((await sub(AMINAH, id))?.dueDate).toBe(inDays(20));
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
