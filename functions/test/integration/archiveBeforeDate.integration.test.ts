import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  courseStudentStats,
  grantOutcome,
  todayInZone,
  type AssignmentDoc,
  type CourseDoc,
  type EnrollmentDoc,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import { applyCohortArchived, createCohortRecord } from '../../src/cohorts';
import { applyCourseUpdate, createCourseRecord } from '../../src/courses';
import { createEnrollmentRecord } from '../../src/enrollments';
import { reconcileCourseAssignments } from '../../src/assignmentsFanout';
import { withAudio } from '../mediaFixtures';

/*
 * A CLASS ARCHIVED WITH ITS RECORDINGS CLOSED, BEFORE A STUDENT'S DATE, LEFT
 * THEM NOTHING TO MISS.
 *
 * The term ends; the admin archives the class (recordings closed, the
 * default) while a student excused on its last session still had days to
 * listen, and from that moment the server refuses the audio. On the day,
 * every view said Closed. Once the date passed with nothing else changed,
 * the ledger, the course page and the workbook said "Missed deadline", while
 * the student's own home said the recording was archived and no longer
 * required. A class archived after the date has gone leaves the miss as it
 * was: the student had the whole of their time.
 *
 * The archive goes through the real callables, with the clock moved forward
 * a day at a time (forward only: the emulator's triggers run on real time).
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const ADMIN = 'admin-archive';
const STUDENT = 'stu-archive';
const DAY = 86_400_000;
const START = Date.now();
const at = (days: number) => START + days * DAY;
const dayOf = (days: number) => todayInZone(INSTITUTE_TIMEZONE, at(days));
const realNow = Date.now.bind(Date);
const clock = (days: number) => vi.spyOn(Date, 'now').mockReturnValue(at(days));

beforeEach(async () => {
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.enrollments, COLLECTIONS.students, COLLECTIONS.sessions, COLLECTIONS.recordings, COLLECTIONS.assignments]) {
    await db().recursiveDelete(db().collection(c));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A class with one excused student on a session due on day 5; `then` closes it somehow, before or after. */
async function term(then: (ids: { cohortId: string; courseId: string }) => Promise<unknown>) {
  clock(1);
  const { id: cohortId } = await createCohortRecord(ADMIN, 'Autumn');
  const { id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'Hikam' });
  await db().collection(COLLECTIONS.students).doc(STUDENT).set({ displayName: 'Fatima', email: 'f@example.com', role: 'student', status: 'active', createdAt: at(0), createdBy: ADMIN });
  await createEnrollmentRecord(ADMIN, { studentUid: STUDENT, courseId });
  clock(2);
  const recording: RecordingDoc = {
    sessionId: 'last', courseId, cohortId, title: 'Last week', notes: '', date: dayOf(2), status: 'published', source: 'manual',
    ...withAudio('lastr', { durationSec: 60 }), createdAt: at(0), createdBy: ADMIN, updatedAt: at(0), publishedAt: at(2),
  };
  const session: SessionDoc = {
    courseId, cohortId, date: dayOf(2), title: 'Last week', dueDate: dayOf(5), notes: '', recordingId: 'lastr',
    attendance: { [STUDENT]: 'excused' }, attendanceSubmittedAt: at(2.3), notRecorded: false, createdAt: at(0), createdBy: ADMIN, updatedAt: at(0),
  };
  await db().collection(COLLECTIONS.recordings).doc('lastr').set(recording);
  await db().collection(COLLECTIONS.sessions).doc('last').set(session);
  await reconcileCourseAssignments(db(), courseId);
  await then({ cohortId, courseId });
  vi.spyOn(Date, 'now').mockImplementation(realNow);

  // What every view reads, on day 10, from what is stored.
  const read = async <T>(c: string) => (await db().collection(c).where('courseId', '==', courseId).get()).docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  const course = { id: courseId, ...((await db().collection(COLLECTIONS.courses).doc(courseId).get()).data() as CourseDoc) };
  const assignments = await read<AssignmentDoc>(COLLECTIONS.assignments);
  const stats = courseStudentStats(
    {
      course,
      cohortName: 'Autumn',
      sessions: await read<SessionDoc>(COLLECTIONS.sessions),
      recordings: await read<RecordingDoc>(COLLECTIONS.recordings),
      enrollments: await read<EnrollmentDoc>(COLLECTIONS.enrollments),
      assignments,
      completions: [],
      overrides: [],
      progress: [],
      coursework: [],
      submissions: [],
      grades: [],
    },
    STUDENT,
    { names: new Map(), timeZone: INSTITUTE_TIMEZONE, today: dayOf(10), exportedAt: at(10), exportedBy: 'x' },
  );
  // The staff ledger's row, from the grant as the ledger reads it.
  const ledger = grantOutcome({ completed: false, dueDate: assignments[0].dueDate }, dayOf(10), course, INSTITUTE_TIMEZONE);
  return { workbook: stats.items.map((i) => i.outcome), ledger };
}

describe('a class archived with its recordings closed', () => {
  it('before the date: closed in the workbook and the ledger once the date has passed', async () => {
    clock(3);
    const seen = await term(({ courseId }) => (clock(3), applyCourseUpdate({ courseId, archived: true })));
    expect(seen).toEqual({ workbook: ['closed'], ledger: 'closed' });
  });

  it('by its cohort, before the date: closed the same way', async () => {
    const seen = await term(({ cohortId }) => (clock(3), applyCohortArchived({ cohortId, archived: true })));
    expect(seen).toEqual({ workbook: ['closed'], ledger: 'closed' });
  });

  it('after the date had gone: missed, as it was', async () => {
    const seen = await term(({ courseId }) => (clock(7), applyCourseUpdate({ courseId, archived: true })));
    expect(seen).toEqual({ workbook: ['missed'], ledger: 'missed' });
  });

  it('before the date but with its recordings kept open: missed, since the student could still play it', async () => {
    const seen = await term(({ courseId }) => (clock(3), applyCourseUpdate({ courseId, archived: true, archivedAccess: true })));
    expect(seen).toEqual({ workbook: ['missed'], ledger: 'missed' });
  });

  it('before the date, and opened again after it: closed, since the date passed while it was shut', async () => {
    const seen = await term(async ({ courseId }) => {
      clock(3);
      await applyCourseUpdate({ courseId, archived: true });
      clock(8);
      await applyCourseUpdate({ courseId, archived: false });
    });
    expect(seen).toEqual({ workbook: ['closed'], ledger: 'closed' });
  });
});
