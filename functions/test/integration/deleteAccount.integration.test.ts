import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, INSTITUTE_TIMEZONE, addDays, enrollmentId, submissionId, todayInZone } from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { applyCourseManagers, createCourseRecord } from '../../src/courses';
import { createEnrollment } from '../../src/enrollments';
import { createCourseworkRecord, postCourseworkRecord } from '../../src/coursework';
import { createStudent, setStudentAccess } from '../../src/students';
import { applyStaffAccess, setStaffAccess } from '../../src/staff';
import { onUserCreate } from '../../src/authTrigger';
import { deleteAccount, deleteAccountRecord } from '../../src/deleteAccount';
import { idTokenFor } from './emulatorToken';

/*
 * DELETING AN ACCOUNT (Faisal's choice, 2026-10-14). The privacy policy's
 * promise, in its words: deleting an account removes "your ability to sign
 * in, your profile, your contact details and your notification settings", and
 * "does not remove the academic record". So each test asserts what a person
 * would check: can they still sign in, is their address anywhere, is their
 * record still there under their name.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const ADMIN = 'admin-del';
const MANAGER = 'manager-del';
const today = todayInZone(INSTITUTE_TIMEZONE);
let courseId = '';

const as = async (uid: string, role: 'admin' | 'manager', data: unknown): Promise<CallableRequest> =>
  ({ auth: { uid, token: { role, status: 'active' }, rawToken: await idTokenFor(uid) }, data }) as unknown as CallableRequest;

beforeEach(async () => {
  for (const c of [
    COLLECTIONS.cohorts,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.students,
    COLLECTIONS.staffUsers,
    COLLECTIONS.coursework,
    COLLECTIONS.submissions,
    COLLECTIONS.auditLog,
    COLLECTIONS.notifications,
  ]) {
    await db().recursiveDelete(db().collection(c));
  }
  await db().collection(COLLECTIONS.staffUsers).doc(ADMIN).set({
    displayName: 'Admin',
    email: `${ADMIN}@oursabeel.com`,
    photoUrl: null,
    role: 'admin',
    status: 'active',
    createdAt: 1,
  });
  const { id: cohortId } = await createCohortRecord(ADMIN, 'Autumn');
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'Hikam' }));
});

afterEach(() => vi.restoreAllMocks());

/** A student as staff make one: created into the class, with a posted assignment, and a phone registered. */
async function aStudent(name: string): Promise<{ uid: string; email: string }> {
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  const { uid } = (await createStudent.run(await as(ADMIN, 'admin', { displayName: name, email, courseId }))) as { uid: string };
  await db().collection(COLLECTIONS.notifications).doc(uid).set({ prefs: { assignmentPosted: true } });
  await db().collection(COLLECTIONS.notifications).doc(uid).collection('devices').doc('tok-1').set({ token: 'tok-1', platform: 'android', registeredAt: 1 });
  return { uid, email };
}

async function postedWork(): Promise<string> {
  const { id } = await createCourseworkRecord(ADMIN, courseId, {
    title: 'Reflection',
    instructions: '',
    dueDate: addDays(today, 7),
    lateUntil: null,
    grading: { kind: 'scale' },
  } as never);
  await postCourseworkRecord(ADMIN, id);
  return id;
}

const studentDoc = async (uid: string) => (await db().collection(COLLECTIONS.students).doc(uid).get()).data();
const signInGone = async (uid: string) =>
  getAuth()
    .getUser(uid)
    .then(
      () => false,
      (e: { code?: string }) => e.code === 'auth/user-not-found',
    );
/** Every audit row that still carries this address, anywhere in it. */
const rowsWithAddress = async (email: string) =>
  (await db().collection(COLLECTIONS.auditLog).get()).docs.filter((d) => JSON.stringify(d.data()).includes(email)).length;

describe('deleting a student’s account', () => {
  it('ends their sign-in and removes their address and notification settings; their name and record stay', async () => {
    const { uid, email } = await aStudent('Aminah');
    const cwId = await postedWork();
    expect(await rowsWithAddress(email)).toBeGreaterThan(0);
    await setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));

    await deleteAccount.run(await as(ADMIN, 'admin', { uid }));

    expect(await signInGone(uid)).toBe(true);
    expect(await studentDoc(uid)).toMatchObject({ displayName: 'Aminah', email: null, status: 'deleted' });
    expect(await rowsWithAddress(email)).toBe(0);
    expect((await db().collection(COLLECTIONS.notifications).doc(uid).get()).exists).toBe(false);
    expect((await db().collection(COLLECTIONS.notifications).doc(uid).collection('devices').get()).size).toBe(0);
    // They leave the class; their enrolment and their work stay as record.
    expect((await db().collection(COLLECTIONS.enrollments).doc(enrollmentId(uid, courseId)).get()).data()).toMatchObject({ active: false });
    expect((await db().collection(COLLECTIONS.submissions).doc(submissionId(uid, cwId)).get()).data()).toMatchObject({ active: false });
    // The history says so, under the key their page reads, and names no address.
    const rows = (await db().collection(COLLECTIONS.auditLog).where('targets.studentUid', '==', uid).get()).docs.map((d) => d.data());
    expect(rows.filter((r) => r.action === 'deleteAccount')).toEqual([expect.objectContaining({ detail: { account: 'student' } })]);
  });

  it('is refused while the account is active, and then nothing is removed', async () => {
    const { uid, email } = await aStudent('Bilal');
    await expect(deleteAccount.run(await as(ADMIN, 'admin', { uid }))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(await signInGone(uid)).toBe(false);
    expect(await studentDoc(uid)).toMatchObject({ email, status: 'active' });
    expect(await rowsWithAddress(email)).toBeGreaterThan(0);
    expect((await db().collection(COLLECTIONS.notifications).doc(uid).collection('devices').get()).size).toBe(1);
  });

  it('names one account, and nothing else', async () => {
    for (const bad of [null, {}, { uid: '' }, { uid: 7 }, { uid: 'x'.repeat(129) }]) {
      await expect(deleteAccount.run(await as(ADMIN, 'admin', bad))).rejects.toMatchObject({ code: 'invalid-argument' });
    }
  });

  it('is refused to a manager, and to an admin deleting themselves', async () => {
    const { uid } = await aStudent('Carol');
    await setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));
    await expect(deleteAccount.run(await as(MANAGER, 'manager', { uid }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await signInGone(uid)).toBe(false);
    await db().collection(COLLECTIONS.staffUsers).doc(ADMIN).update({ status: 'disabled' });
    await expect(deleteAccountRecord(ADMIN, ADMIN)).rejects.toThrow(/your own account/);
  });

  it('a second delete changes nothing, and is not recorded twice', async () => {
    const { uid } = await aStudent('Dawud');
    await setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));
    await deleteAccount.run(await as(ADMIN, 'admin', { uid }));
    expect(await deleteAccount.run(await as(ADMIN, 'admin', { uid }))).toMatchObject({ changed: false });
    const deletes = await db().collection(COLLECTIONS.auditLog).where('action', '==', 'deleteAccount').get();
    expect(deletes.size).toBe(1);
  });

  it('a deleted account is not re-enabled or put back in a class', async () => {
    const { uid } = await aStudent('Esa');
    await setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));
    await deleteAccount.run(await as(ADMIN, 'admin', { uid }));
    await expect(setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'active' }))).rejects.toThrow(/deleted/);
    await expect(createEnrollment.run(await as(ADMIN, 'admin', { studentUid: uid, courseId }))).rejects.toThrow(/deleted/);
    expect(await studentDoc(uid)).toMatchObject({ status: 'deleted' });
  });

  /*
   * A FAILURE PART-WAY. The directory row is written last, so until it reads
   * deleted the person still shows as disabled with Delete on offer, and the
   * second press finishes what the first began.
   */
  it('a failure part-way leaves them disabled with Delete on offer, and pressing it again finishes', async () => {
    const { uid } = await aStudent('Fatima');
    await setStudentAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));
    vi.spyOn(getAuth(), 'deleteUser').mockRejectedValueOnce(new Error('Auth unavailable'));
    await expect(deleteAccountRecord(ADMIN, uid)).rejects.toThrow(/Auth unavailable/);
    expect(await studentDoc(uid)).toMatchObject({ status: 'disabled' });
    expect(await signInGone(uid)).toBe(false);

    await deleteAccountRecord(ADMIN, uid);
    expect(await signInGone(uid)).toBe(true);
    expect(await studentDoc(uid)).toMatchObject({ status: 'deleted', email: null });
  });
});

describe('deleting a colleague’s account', () => {
  /** A colleague as they arrive: a first Google sign-in, approved, given a course. */
  async function aColleague(): Promise<{ uid: string; email: string }> {
    const uid = `colleague-${Date.now()}`;
    const email = `${uid}@oursabeel.com`;
    await getAuth().createUser({ uid, email, emailVerified: true });
    await (onUserCreate as unknown as { run: (e: unknown, ctx: unknown) => Promise<void> }).run(
      {
        uid,
        email,
        emailVerified: true,
        displayName: 'Yusuf Ali',
        photoURL: 'https://example.com/photo.jpg',
        providerData: [{ providerId: 'google.com', uid: `g-${uid}`, email }],
      },
      { eventId: `evt-${uid}` },
    );
    await applyStaffAccess(ADMIN, { uid, status: 'active', role: 'manager' });
    await applyCourseManagers({ courseId, managerUids: [uid] });
    return { uid, email };
  }

  it('ends their sign-in, takes them off their courses and removes their address; their name stays', async () => {
    const { uid, email } = await aColleague();
    expect(await rowsWithAddress(email)).toBeGreaterThan(0);
    await setStaffAccess.run(await as(ADMIN, 'admin', { uid, status: 'disabled' }));

    await deleteAccount.run(await as(ADMIN, 'admin', { uid }));

    expect(await signInGone(uid)).toBe(true);
    expect((await db().collection(COLLECTIONS.staffUsers).doc(uid).get()).data()).toMatchObject({
      displayName: 'Yusuf Ali',
      email: null,
      photoUrl: null,
      status: 'deleted',
    });
    expect((await db().collection(COLLECTIONS.courses).doc(courseId).get()).data()?.managerUids).toEqual([]);
    expect(await rowsWithAddress(email)).toBe(0);
    await expect(setStaffAccess.run(await as(ADMIN, 'admin', { uid, status: 'active' }))).rejects.toThrow(/deleted/);
  });
});
