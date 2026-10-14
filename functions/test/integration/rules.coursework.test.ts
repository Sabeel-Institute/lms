import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, MAX_ANSWER_CHARS, submissionId } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';
import { setBackgroundTriggers } from '../backgroundTriggers';

/**
 * Who reads and writes assignments (docs/plans/ASSIGNMENTS.md). The promises:
 * nobody sees a student's work before it is handed in; no student sees a
 * grade before it is returned, or anyone else's work; a student reads an
 * assignment only through their own work on it; and the one thing a student
 * writes directly is the note on their own open draft.
 *
 * DENIALS ARE SHOWN TO BE ABLE TO FAIL: `assertFails` passes for any failure,
 * a broken connection included. The drafts and grades blocks were each
 * flipped to `allow read, write: if true` once, and the denials here went red.
 */
let testEnv: RulesTestEnvironment;

function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  return { host: host || '127.0.0.1', port: Number(port) };
}

/*
 * THE EMULATOR'S OWN TRIGGERS ARE OFF HERE: these tests are about the rules,
 * and a tally recompute fired by one test's seed held its locks while the
 * next test cleared the database, which then timed out.
 */
beforeAll(async () => {
  await setBackgroundTriggers(false);
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
  await setBackgroundTriggers(true);
});

const ADMIN = 'admin1';
const MINE = 'mgrMine';
const THEIRS = 'mgrTheirs';
const STUDENT = 'stu1';
const CLASSMATE = 'stu2';
const CLASS = 'classMine';
const CLASS_THEIRS = 'classTheirs';
const CW = 'cw1';
const DRAFT_CW = 'cwDraft';
const HANDED = 'cwHanded';

const submission = (studentUid: string, courseworkId: string, over: Record<string, unknown> = {}) => ({
  studentUid,
  courseworkId,
  courseId: CLASS,
  cohortId: 'c1',
  active: true,
  dueDate: '2099-01-01',
  lateUntil: null,
  closedEarly: false,
  state: 'open',
  attempt: 1,
  handedInAt: null,
  note: '',
  files: {},
  returned: null,
  attempts: [],
  notRequired: null,
  moreTime: null,
  assignedAt: 1,
  ...over,
});

const coursework = (status: 'draft' | 'posted') => ({
  courseId: CLASS,
  cohortId: 'c1',
  title: 'Reflection',
  instructions: '',
  files: {},
  dueDate: '2099-01-01',
  lateUntil: null,
  grading: { kind: 'points', outOf: 10 },
  status,
  closedAt: null,
  postedAt: status === 'posted' ? 1 : null,
  postedBy: status === 'posted' ? MINE : null,
  createdAt: 1,
  createdBy: MINE,
  updatedAt: 1,
  editedAt: null,
});

const draftOf = (studentUid: string, courseworkId: string, note = 'Half written') => ({
  studentUid,
  courseworkId,
  courseId: CLASS,
  note,
  files: {},
  updatedAt: 1,
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MINE]: 'manager', [THEIRS]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all([
      setDoc(doc(db, COLLECTIONS.courses, CLASS), { cohortId: 'c1', managerUids: [MINE] }),
      setDoc(doc(db, COLLECTIONS.courses, CLASS_THEIRS), { cohortId: 'c1', managerUids: [THEIRS] }),
      setDoc(doc(db, COLLECTIONS.coursework, CW), coursework('posted')),
      setDoc(doc(db, COLLECTIONS.coursework, DRAFT_CW), coursework('draft')),
      setDoc(doc(db, COLLECTIONS.coursework, HANDED), coursework('posted')),
      setDoc(doc(db, COLLECTIONS.submissions, submissionId(STUDENT, CW)), submission(STUDENT, CW)),
      setDoc(doc(db, COLLECTIONS.submissions, submissionId(CLASSMATE, CW)), submission(CLASSMATE, CW, { state: 'handedIn', note: 'Theirs' })),
      setDoc(doc(db, COLLECTIONS.submissions, submissionId(STUDENT, HANDED)), submission(STUDENT, HANDED, { state: 'handedIn', handedInAt: 1, note: 'Done' })),
      setDoc(doc(db, COLLECTIONS.drafts, submissionId(STUDENT, CW)), draftOf(STUDENT, CW)),
      setDoc(doc(db, COLLECTIONS.grades, submissionId(CLASSMATE, CW)), {
        studentUid: CLASSMATE,
        courseworkId: CW,
        courseId: CLASS,
        grade: { points: 9 },
        feedback: 'Good',
        gradedBy: MINE,
        gradedAt: 1,
        withoutHandIn: false,
      }),
      setDoc(doc(db, COLLECTIONS.courseworkTallies, CW), {
        courseId: CLASS,
        updatedAt: 1,
        handedIn: 1,
        late: 0,
        toGrade: 0,
        toReturn: 1,
        returned: 0,
        notRequired: 0,
        shareSum: 0,
        shareCount: 0,
        waiting: [{ dueDate: '2026-10-20', lateUntil: null, closedEarly: false, count: 1 }],
      }),
    ]);
  });
});

const ctx = (uid: string, role: string) => testEnv.authenticatedContext(uid, { role, status: 'active' });
const admin = () => ctx(ADMIN, 'admin').firestore();
const mgrMine = () => ctx(MINE, 'manager').firestore();
const mgrTheirs = () => ctx(THEIRS, 'manager').firestore();
const student = () => ctx(STUDENT, 'student').firestore();
const classmate = () => ctx(CLASSMATE, 'student').firestore();

describe('an assignment', () => {
  it('a student reads one posted to them, never a draft one or one they do not have', async () => {
    await assertSucceeds(getDoc(doc(student(), COLLECTIONS.coursework, CW)));
    await assertFails(getDoc(doc(student(), COLLECTIONS.coursework, DRAFT_CW)));
    await testEnv.withSecurityRulesDisabled((c) =>
      updateDoc(doc(c.firestore(), COLLECTIONS.submissions, submissionId(STUDENT, CW)), { active: false }),
    );
    await assertFails(getDoc(doc(student(), COLLECTIONS.coursework, CW)));
  });

  it('the class’s teachers read its assignments, drafts included; another class’s teacher does not', async () => {
    await assertSucceeds(getDocs(query(collection(mgrMine(), COLLECTIONS.coursework), where('courseId', '==', CLASS))));
    await assertSucceeds(getDoc(doc(mgrMine(), COLLECTIONS.coursework, DRAFT_CW)));
    await assertFails(getDoc(doc(mgrTheirs(), COLLECTIONS.coursework, CW)));
  });

  it('nobody writes one directly', async () => {
    await assertFails(setDoc(doc(mgrMine(), COLLECTIONS.coursework, 'x'), coursework('draft')));
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.coursework, CW), { title: 'Changed' }));
  });
});

describe('a student’s work', () => {
  it('a student reads their own work and never a classmate’s', async () => {
    await assertSucceeds(getDocs(query(collection(student(), COLLECTIONS.submissions), where('studentUid', '==', STUDENT))));
    await assertFails(getDoc(doc(student(), COLLECTIONS.submissions, submissionId(CLASSMATE, CW))));
  });

  it('a student opening an assignment that is gone, or never theirs, is told their work does not exist', async () => {
    // Deleted, never posted, or given in another class: there is no work of theirs on it.
    const gone = await getDoc(doc(student(), COLLECTIONS.submissions, submissionId(STUDENT, 'cwDeleted')));
    expect(gone.exists()).toBe(false);
  });

  it('nor can a student learn whether a classmate has work on an assignment', async () => {
    await assertFails(getDoc(doc(student(), COLLECTIONS.submissions, submissionId(CLASSMATE, 'cwDeleted'))));
  });

  it('a student cannot hand in by writing their work themselves', async () => {
    await assertFails(
      updateDoc(doc(student(), COLLECTIONS.submissions, submissionId(STUDENT, CW)), { state: 'handedIn' }),
    );
  });

  it('the class’s teachers read the class’s work; another class’s do not', async () => {
    await assertSucceeds(getDocs(query(collection(mgrMine(), COLLECTIONS.submissions), where('courseId', '==', CLASS))));
    await assertFails(getDocs(query(collection(mgrTheirs(), COLLECTIONS.submissions), where('courseId', '==', CLASS))));
  });
});

describe('grades', () => {
  it('no student reads a grade being written — not even their own', async () => {
    await assertFails(getDoc(doc(classmate(), COLLECTIONS.grades, submissionId(CLASSMATE, CW))));
    await assertFails(getDocs(query(collection(classmate(), COLLECTIONS.grades), where('studentUid', '==', CLASSMATE))));
  });

  it('the class’s teachers read them; another class’s do not; nobody writes them directly', async () => {
    await assertSucceeds(getDocs(query(collection(mgrMine(), COLLECTIONS.grades), where('courseId', '==', CLASS))));
    await assertFails(getDoc(doc(mgrTheirs(), COLLECTIONS.grades, submissionId(CLASSMATE, CW))));
    await assertFails(
      updateDoc(doc(mgrMine(), COLLECTIONS.grades, submissionId(CLASSMATE, CW)), { grade: { points: 10 } }),
    );
  });
});

/*
 * A CLASS'S FIGURES ARE ITS TEACHERS'. How many of the class have handed in,
 * are graded or missed it is what the work says, added up, and read no wider
 * than the work: its course's staff, never a student, never another class.
 */
describe('courseworkTallies', () => {
  it('the class’s teachers read them; another class’s do not; no student does', async () => {
    await assertSucceeds(getDocs(query(collection(mgrMine(), COLLECTIONS.courseworkTallies), where('courseId', '==', CLASS))));
    await assertSucceeds(getDoc(doc(admin(), COLLECTIONS.courseworkTallies, CW)));
    await assertFails(getDoc(doc(mgrTheirs(), COLLECTIONS.courseworkTallies, CW)));
    await assertFails(getDocs(query(collection(mgrTheirs(), COLLECTIONS.courseworkTallies), where('courseId', '==', CLASS))));
    await assertFails(getDoc(doc(student(), COLLECTIONS.courseworkTallies, CW)));
  });

  it('nobody writes one directly', async () => {
    await assertFails(updateDoc(doc(mgrMine(), COLLECTIONS.courseworkTallies, CW), { handedIn: 5 }));
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.courseworkTallies, CW), { handedIn: 5 }));
  });
});

describe('drafts', () => {
  it('no staff member reads a draft — not the class’s teacher, not an admin', async () => {
    await assertFails(getDoc(doc(mgrMine(), COLLECTIONS.drafts, submissionId(STUDENT, CW))));
    await assertFails(getDoc(doc(admin(), COLLECTIONS.drafts, submissionId(STUDENT, CW))));
    await assertFails(getDocs(query(collection(admin(), COLLECTIONS.drafts), where('courseId', '==', CLASS))));
  });

  it('a student writes the note on their own open work, and reads it back', async () => {
    const mine = doc(student(), COLLECTIONS.drafts, submissionId(STUDENT, CW));
    await assertSucceeds(updateDoc(mine, { note: 'Now finished', updatedAt: 2 }));
    await assertSucceeds(getDoc(mine));
    await assertFails(getDoc(doc(classmate(), COLLECTIONS.drafts, submissionId(STUDENT, CW))));
  });

  it('an answer is stored up to MAX_ANSWER_CHARS, and refused past it', async () => {
    const mine = doc(student(), COLLECTIONS.drafts, submissionId(STUDENT, CW));
    await assertSucceeds(updateDoc(mine, { note: 'ب'.repeat(MAX_ANSWER_CHARS), updatedAt: 2 }));
    await assertFails(updateDoc(mine, { note: 'ب'.repeat(MAX_ANSWER_CHARS + 1), updatedAt: 3 }));
  });

  it('a student cannot put files on a draft themselves', async () => {
    const mine = doc(student(), COLLECTIONS.drafts, submissionId(STUDENT, CW));
    await assertFails(updateDoc(mine, { files: { f: { storageKey: 'work/x' } }, updatedAt: 2 }));
  });

  it('a student starts a draft only on their own open work', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), COLLECTIONS.submissions, submissionId(CLASSMATE, HANDED)), submission(CLASSMATE, HANDED));
    });
    const fresh = doc(classmate(), COLLECTIONS.drafts, submissionId(CLASSMATE, HANDED));
    await assertSucceeds(setDoc(fresh, draftOf(CLASSMATE, HANDED, 'Starting')));
    // Handed in already: the draft is gone and the note waits for a take-back.
    await assertFails(
      setDoc(doc(student(), COLLECTIONS.drafts, submissionId(STUDENT, HANDED)), draftOf(STUDENT, HANDED)),
    );
    // Someone else's work.
    await assertFails(
      setDoc(doc(student(), COLLECTIONS.drafts, submissionId(CLASSMATE, CW)), draftOf(CLASSMATE, CW)),
    );
  });
});
