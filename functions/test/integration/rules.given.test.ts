import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  completionId,
  enrollmentId,
  givenRecordingId,
  type GivenRecordingDoc,
} from '@sabeel/shared';
import { withAudio } from '../mediaFixtures';
import { seedStaffRecords, seedStudentRecords } from './staffRecords';

/**
 * A RECORDING STAFF GAVE ONE STUDENT, as the rules judge it.
 *
 * The promise, in a student's words: "a recording my teacher gave me, I can
 * open and listen to, and my listening reaches my teacher; it never counts as
 * work I owe, and once it is taken back, or I leave the class, or the
 * recording is withdrawn, it is closed to me". And in a teacher's: "only the
 * server writes these, and only the class's staff and the student read them".
 *
 * Its date is not the rules' business: the deadline is enforced at the audio
 * (`getPlaybackUrl`), as it is for the excused, so nothing here varies a date.
 *
 * The rules pass runs with no Functions emulator, so nothing written here
 * fires a trigger: the documents below are the world the rules judge, exactly
 * as seeded. Every recording is given to STUDENT, who was PRESENT at its
 * session (attendance submitted) and so holds no grant: the production state a
 * given recording exists for.
 */

let testEnv: RulesTestEnvironment;

function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  return { host: host || '127.0.0.1', port: Number(port) };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      ...hostPort('FIRESTORE_EMULATOR_HOST'),
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

const ADMIN = 'admin1';
const MINE = 'mgrMine';
const THEIRS = 'mgrTheirs';
const STUDENT = 'stu1';
const OUTSIDER = 'stu2';
const CLASS = 'classMine';
const OTHER_CLASS = 'classTheirs';
const GIVEN = 'recGiven';
/** Published in the student's class, never given to them nor excused. */
const NOT_GIVEN = 'recNotGiven';
/** Given, then unpublished. */
const UNPUBLISHED = 'recUnpublished';
/** In another class, given to the student, who is not enrolled there. */
const ELSEWHERE = 'recElsewhere';

const given = (studentUid: string, recordingId: string, courseId: string): GivenRecordingDoc => ({
  studentUid,
  recordingId,
  courseId,
  openUntil: '2099-01-01',
  givenAt: 1,
  givenBy: MINE,
});

async function seed(enrolled = true) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const cls = (id: string, managerUids: string[]) =>
      setDoc(doc(db, COLLECTIONS.courses, id), {
        cohortId: 'c1',
        name: id,
        archived: false,
        effectiveActive: true,
        archivedAccess: false,
        managerUids,
        createdAt: 1,
        createdBy: ADMIN,
      });
    const sess = (recordingId: string, courseId: string) =>
      setDoc(doc(db, COLLECTIONS.sessions, `${recordingId}-s`), {
        courseId,
        cohortId: 'c1',
        date: '2026-07-06',
        title: recordingId,
        dueDate: '2099-01-01',
        notes: '',
        recordingId,
        attendance: { [STUDENT]: 'present' },
        attendanceSubmittedAt: 1,
        notRecorded: false,
        createdAt: 1,
        createdBy: ADMIN,
        updatedAt: 1,
      });
    const rec = (id: string, courseId: string, status: string) =>
      setDoc(doc(db, COLLECTIONS.recordings, id), {
        sessionId: `${id}-s`,
        cohortId: 'c1',
        courseId,
        title: id,
        status,
        source: 'manual',
        recordedAt: 1,
        notes: '',
        ...withAudio(id, { durationSec: 60 }),
        createdAt: 1,
        createdBy: ADMIN,
        updatedAt: 1,
      });
    const give = (recordingId: string, courseId: string, studentUid = STUDENT) =>
      setDoc(doc(db, COLLECTIONS.givenRecordings, givenRecordingId(studentUid, recordingId)), given(studentUid, recordingId, courseId));
    await Promise.all([
      cls(CLASS, [MINE]),
      cls(OTHER_CLASS, [THEIRS]),
      sess(GIVEN, CLASS),
      sess(NOT_GIVEN, CLASS),
      sess(UNPUBLISHED, CLASS),
      sess(ELSEWHERE, OTHER_CLASS),
      rec(GIVEN, CLASS, 'published'),
      rec(NOT_GIVEN, CLASS, 'published'),
      rec(UNPUBLISHED, CLASS, 'unpublished'),
      rec(ELSEWHERE, OTHER_CLASS, 'published'),
      give(GIVEN, CLASS),
      give(UNPUBLISHED, CLASS),
      give(ELSEWHERE, OTHER_CLASS),
      give(GIVEN, CLASS, OUTSIDER),
      setDoc(doc(db, COLLECTIONS.enrollments, enrollmentId(STUDENT, CLASS)), {
        studentUid: STUDENT,
        courseId: CLASS,
        cohortId: 'c1',
        active: enrolled,
        stretches: enrolled ? [{ from: 1, to: null }] : [{ from: 1, to: 2 }],
        enrolledBy: ADMIN,
      }),
    ]);
  });
}

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager', [THEIRS]: 'manager' });
  await seedStudentRecords(testEnv, [STUDENT, OUTSIDER]);
  await seed();
});

const ctx = (uid: string, role: string) => testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin').firestore();
const mine = () => ctx(MINE, 'manager').firestore();
const theirs = () => ctx(THEIRS, 'manager').firestore();
const student = () => ctx(STUDENT, 'student').firestore();
const outsider = () => ctx(OUTSIDER, 'student').firestore();

const takeBack = (recordingId: string) =>
  testEnv.withSecurityRulesDisabled((c) =>
    deleteDoc(doc(c.firestore(), COLLECTIONS.givenRecordings, givenRecordingId(STUDENT, recordingId))),
  );
const unpublish = (recordingId: string) =>
  testEnv.withSecurityRulesDisabled((c) =>
    updateDoc(doc(c.firestore(), COLLECTIONS.recordings, recordingId), { status: 'unpublished' }),
  );

describe('givenRecordings: who reads them', () => {
  const mineRef = (db = student()) => doc(db, COLLECTIONS.givenRecordings, givenRecordingId(STUDENT, GIVEN));

  it('lets a student read their own, and ask about one they were not given', async () => {
    await assertSucceeds(getDoc(mineRef()));
    // The player asks before anything is known; absence is an answer.
    await assertSucceeds(getDoc(doc(student(), COLLECTIONS.givenRecordings, givenRecordingId(STUDENT, NOT_GIVEN))));
    await assertSucceeds(getDocs(query(collection(student(), COLLECTIONS.givenRecordings), where('studentUid', '==', STUDENT))));
  });

  it("never tells a student whether a classmate was given one, existing or not", async () => {
    await assertFails(getDoc(doc(outsider(), COLLECTIONS.givenRecordings, givenRecordingId(STUDENT, GIVEN))));
    await assertFails(getDoc(doc(outsider(), COLLECTIONS.givenRecordings, givenRecordingId(STUDENT, NOT_GIVEN))));
    await assertFails(getDocs(query(collection(outsider(), COLLECTIONS.givenRecordings), where('courseId', '==', CLASS))));
    await assertFails(getDocs(collection(student(), COLLECTIONS.givenRecordings)));
  });

  it("lets the class's staff list the class's, and nobody else's", async () => {
    const byClass = (db: ReturnType<typeof admin>, courseId: string) =>
      getDocs(query(collection(db, COLLECTIONS.givenRecordings), where('courseId', '==', courseId), where('recordingId', '==', GIVEN)));
    await assertSucceeds(byClass(mine(), CLASS));
    await assertSucceeds(byClass(admin(), CLASS));
    await assertSucceeds(getDocs(query(collection(mine(), COLLECTIONS.givenRecordings), where('courseId', '==', CLASS))));
    await assertSucceeds(getDoc(mineRef(mine())));
    await assertFails(byClass(theirs(), CLASS));
    await assertFails(getDoc(mineRef(theirs())));
    // A manager's query must name one class: unconstrained, it spans classes they do not manage.
    await assertFails(getDocs(collection(mine(), COLLECTIONS.givenRecordings)));
  });

  it('takes no client write from anyone', async () => {
    const id = givenRecordingId(STUDENT, NOT_GIVEN);
    for (const db of [student(), mine(), admin()]) {
      await assertFails(setDoc(doc(db, COLLECTIONS.givenRecordings, id), given(STUDENT, NOT_GIVEN, CLASS)));
      await assertFails(updateDoc(mineRef(db), { openUntil: '2099-12-31' }));
      await assertFails(deleteDoc(mineRef(db)));
    }
  });
});

describe('recordings: a student reads one given to them', () => {
  const read = (id: string, db = student()) => getDoc(doc(db, COLLECTIONS.recordings, id));

  it('opens a published recording given to them, in their class', async () => {
    await assertSucceeds(read(GIVEN));
  });

  it('opens nothing they were not given, and nothing given to someone else', async () => {
    await assertFails(read(NOT_GIVEN));
    // OUTSIDER holds GIVEN too, but is not enrolled in its class.
    await assertFails(read(GIVEN, outsider()));
  });

  it('closes it once taken back, unpublished, or when they leave the class', async () => {
    await assertFails(read(UNPUBLISHED));
    await assertFails(read(ELSEWHERE));
    await takeBack(GIVEN);
    await assertFails(read(GIVEN));
  });

  it('closes it for a student whose enrolment ended', async () => {
    await seed(false);
    await assertFails(read(GIVEN));
  });
});

describe('listening progress and bookmarks under a given recording', () => {
  const progressId = (rid = GIVEN) => `${STUDENT}_${rid}`;
  const row = (rid = GIVEN, courseId = CLASS) => ({
    studentUid: STUDENT,
    recordingId: rid,
    courseId,
    listenedMs: 1000,
    sittings: { s1: 1000 },
    sitting: 's1',
    updatedAt: 1,
  });
  const further = (rid = GIVEN) => ({ ...row(rid), listenedMs: 5000, sittings: { s1: 5000 } });
  const mark = (rid = GIVEN, courseId = CLASS) => ({
    studentUid: STUDENT,
    recordingId: rid,
    courseId,
    itemId: 'audio-1',
    positionMs: 754_000,
    setAt: 1,
  });
  const progress = (rid = GIVEN) => doc(student(), COLLECTIONS.listeningProgress, progressId(rid));
  const bookmark = (rid = GIVEN) => doc(student(), COLLECTIONS.bookmarks, progressId(rid));

  it('saves their listening and their place, filed under the class, and grows it', async () => {
    await assertSucceeds(setDoc(progress(), row()));
    await assertSucceeds(setDoc(progress(), further()));
    await assertSucceeds(setDoc(bookmark(), mark()));
    await assertSucceeds(setDoc(bookmark(), { ...mark(), positionMs: 800_000 }));
  });

  it('refuses a row filed under a class that is not the recording’s', async () => {
    // Staff read listening class by class, so a wrong class hides it from them.
    await assertFails(setDoc(progress(), row(GIVEN, OTHER_CLASS)));
    await assertFails(setDoc(bookmark(), mark(GIVEN, OTHER_CLASS)));
  });

  it('refuses listening on a recording not given, or given and since unpublished', async () => {
    await assertFails(setDoc(progress(NOT_GIVEN), row(NOT_GIVEN)));
    await assertFails(setDoc(progress(UNPUBLISHED), row(UNPUBLISHED)));
    await assertFails(setDoc(bookmark(NOT_GIVEN), mark(NOT_GIVEN)));
  });

  it('stops a row growing after take back, unpublishing, or leaving the class', async () => {
    await assertSucceeds(setDoc(progress(), row()));
    await assertSucceeds(setDoc(bookmark(), mark()));
    await takeBack(GIVEN);
    await assertFails(setDoc(progress(), further()));
    await assertFails(setDoc(bookmark(), { ...mark(), positionMs: 800_000 }));
  });

  it('stops a row growing once the recording is unpublished', async () => {
    await assertSucceeds(setDoc(progress(), row()));
    await unpublish(GIVEN);
    await assertFails(setDoc(progress(), further()));
  });

  it('stops a row growing once the student leaves the class', async () => {
    await assertSucceeds(setDoc(progress(), row()));
    await seed(false);
    await assertFails(setDoc(progress(), further()));
  });
});

describe('a given recording is never work owed', () => {
  it('takes no completion and no completion event from a student it was only given to', async () => {
    // Completions stay excused-only: Mark complete is not drawn for a given
    // recording, and the rules refuse it if anything sends one.
    await assertFails(
      setDoc(doc(student(), COLLECTIONS.completions, completionId(STUDENT, GIVEN)), {
        studentUid: STUDENT,
        recordingId: GIVEN,
        courseId: CLASS,
        completed: true,
        completedAt: 1,
        updatedAt: 1,
      }),
    );
    await assertFails(
      addDoc(collection(student(), COLLECTIONS.completionEvents), {
        studentUid: STUDENT,
        recordingId: GIVEN,
        courseId: CLASS,
        action: 'complete',
        actor: 'student',
        at: 1,
      }),
    );
  });
});
