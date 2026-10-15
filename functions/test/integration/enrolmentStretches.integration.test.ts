import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  assignmentId,
  courseStudentStats,
  todayInZone,
  type AssignmentDoc,
  type CourseDoc,
  type EnrollmentDoc,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { applyEnrollmentActive, createEnrollmentRecord } from '../../src/enrollments';
import { reconcileCourseAssignments } from '../../src/assignmentsFanout';
import { withAudio } from '../mediaFixtures';

/*
 * A STUDENT TAKEN OUT OF A CLASS TWICE IS NOT CHARGED FOR THE FIRST ABSENCE.
 *
 * The enrolment, the removals and the returns go through the real callables,
 * with the clock moved forward a day at a time; the grant is made, switched
 * off and left off by the real fan-out. Then the workbook is built from the
 * stored documents, as the export builds it. When the enrolment kept only its
 * last leaving date, the second removal made the file charge "Missed
 * deadline" for a recording whose date passed while the student was out of
 * the class, and count a register held in their absence against them.
 *
 * The clock only ever moves FORWARD of the real one: the emulator's own
 * triggers run on real time, and a fixture dated in the past would close
 * what they open.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const ADMIN = 'admin-stretch';
const STUDENT = 'stu-stretch';
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

describe('an enrolment through two removals', () => {
  it('keeps every absence, and the workbook charges neither the recording nor the register held in the first', async () => {
    clock(1);
    const { id: cohortId } = await createCohortRecord(ADMIN, 'Autumn');
    const { id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'Hikam' });
    await db().collection(COLLECTIONS.students).doc(STUDENT).set({ displayName: 'Fatima', email: 'f@example.com', role: 'student', status: 'active', createdAt: at(0), createdBy: ADMIN });
    await createEnrollmentRecord(ADMIN, { studentUid: STUDENT, courseId });

    // Week 1 meets on day 5 and is due on day 15; she is excused, and the
    // recording is published. Week 2 meets on day 20, its register taken
    // that evening without her: she is out of the class then.
    clock(5);
    const session = (date: string, dueDate: string, attendance: SessionDoc['attendance'], takenAt: number, recordingId: string | null): SessionDoc => ({
      courseId, cohortId, date, title: date, dueDate, notes: '', recordingId, attendance,
      attendanceSubmittedAt: takenAt, notRecorded: false, createdAt: at(0), createdBy: ADMIN, updatedAt: at(0),
    });
    const recording: RecordingDoc = {
      sessionId: 'w1', courseId, cohortId, title: 'Week 1', notes: '', date: dayOf(5), status: 'published', source: 'manual',
      ...withAudio('w1r', { durationSec: 60 }), createdAt: at(0), createdBy: ADMIN, updatedAt: at(0), publishedAt: at(5),
    };
    await db().collection(COLLECTIONS.recordings).doc('w1r').set(recording);
    await db().collection(COLLECTIONS.sessions).doc('w1').set(session(dayOf(5), dayOf(15), { [STUDENT]: 'excused' }, at(5.4), 'w1r'));
    await db().collection(COLLECTIONS.sessions).doc('w2').set(session(dayOf(20), dayOf(27), { other: 'present' }, at(20.4), null));
    await reconcileCourseAssignments(db(), courseId);
    const grant = async () => (await db().collection(COLLECTIONS.assignments).doc(assignmentId(STUDENT, 'w1r')).get()).data() as AssignmentDoc | undefined;
    expect((await grant())?.active).toBe(true);

    // Out on day 10, over Week 1's date; back through Add a student on day
    // 25; out again on day 30 and back on day 32.
    clock(10);
    await applyEnrollmentActive({ studentUid: STUDENT, courseId, active: false });
    clock(25);
    await createEnrollmentRecord(ADMIN, { studentUid: STUDENT, courseId });
    clock(30);
    await applyEnrollmentActive({ studentUid: STUDENT, courseId, active: false });
    clock(32);
    await applyEnrollmentActive({ studentUid: STUDENT, courseId, active: true });
    vi.spyOn(Date, 'now').mockImplementation(realNow);
    expect((await grant())?.active).toBe(false);

    // The export, from what is stored, on day 40.
    const read = async <T>(c: string) => (await db().collection(c).where('courseId', '==', courseId).get()).docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
    const course = (await db().collection(COLLECTIONS.courses).doc(courseId).get()).data() as CourseDoc;
    const stats = courseStudentStats(
      {
        course: { id: courseId, ...course },
        cohortName: 'Autumn',
        sessions: await read<SessionDoc>(COLLECTIONS.sessions),
        recordings: await read<RecordingDoc>(COLLECTIONS.recordings),
        enrollments: await read<EnrollmentDoc>(COLLECTIONS.enrollments),
        assignments: await read<AssignmentDoc>(COLLECTIONS.assignments),
        completions: [],
        overrides: [],
        progress: [],
        coursework: [],
        submissions: [],
        grades: [],
      },
      STUDENT,
      { names: new Map(), timeZone: INSTITUTE_TIMEZONE, today: dayOf(40), exportedAt: at(40), exportedBy: 'x' },
    );
    expect(stats.items.map((i) => i.outcome)).toEqual(['closed']);
    expect(stats).toMatchObject({ missed: 0, closed: 1, unmarked: 0, enrolled: true, joined: dayOf(1), left: null });
    expect(stats.marks.get('w2')).toBe('—');
    expect(stats.away).toEqual([
      { left: dayOf(10), back: dayOf(25) },
      { left: dayOf(30), back: dayOf(32) },
    ]);
  });
});
