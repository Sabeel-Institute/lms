import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, type StaffUserDoc } from '@sabeel/shared';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { applyStaffAccess, setStaffAccess, validateStaffAccess } from '../../src/staff';
import { idTokenFor } from './emulatorToken';
import {
  applyStudentAccess,
  createStudentAccount,
  validateCreateStudent,
  validateStudentAccess,
} from '../../src/students';

/**
 * The callable cores, driven directly against the emulators.
 *
 * They are deliberately separated from their onCall wrappers so this is
 * possible: the wrapper needs a live functions runtime to invoke, the logic
 * does not. What matters here is the CLAIMS — the token is what security rules
 * trust, so every one of these assertions checks the claim, not just the
 * mirror document.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';

async function clearAll() {
  const db = getFirestore();
  for (const c of [COLLECTIONS.staffUsers, COLLECTIONS.students]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const users = await getAuth().listUsers();
  await Promise.all(users.users.map((u) => getAuth().deleteUser(u.uid)));
}

async function seedStaff(uid: string, role: 'admin' | 'manager', status: string) {
  const doc: StaffUserDoc = {
    displayName: uid,
    email: `${uid}@oursabeel.com`,
    photoUrl: null,
    role,
    status: status as StaffUserDoc['status'],
    createdAt: 1,
  };
  await getFirestore().collection(COLLECTIONS.staffUsers).doc(uid).set(doc);
  await getAuth().createUser({ uid, email: doc.email, emailVerified: true });
  await getAuth().setCustomUserClaims(uid, { role, status });
}

beforeEach(async () => {
  await clearAll();
  await seedStaff(ADMIN, 'admin', 'active');
});

const claimsOf = async (uid: string) => (await getAuth().getUser(uid)).customClaims ?? {};

describe('applyStaffAccess', () => {
  it('approving sets the CLAIM, not just the document', async () => {
    await seedStaff('p1', 'manager', 'pending');
    await applyStaffAccess(ADMIN, { uid: 'p1', status: 'active' });

    // The claim is the thing rules read; a document that says active while the
    // token says pending is the exact failure this ordering prevents.
    expect(await claimsOf('p1')).toMatchObject({ role: 'manager', status: 'active' });
    const doc = (await getFirestore().collection(COLLECTIONS.staffUsers).doc('p1').get()).data();
    expect(doc?.status).toBe('active');
  });

  it('stamps who approved, and when, on the pending → active transition', async () => {
    await seedStaff('p2', 'manager', 'pending');
    await applyStaffAccess(ADMIN, { uid: 'p2', status: 'active' });
    const doc = (await getFirestore().collection(COLLECTIONS.staffUsers).doc('p2').get()).data();
    expect(doc?.approvedBy).toBe(ADMIN);
    expect(typeof doc?.approvedAt).toBe('number');
  });

  it('does not re-stamp an already-active account', async () => {
    await seedStaff('a1', 'manager', 'active');
    await applyStaffAccess(ADMIN, { uid: 'a1', role: 'admin' });
    const doc = (await getFirestore().collection(COLLECTIONS.staffUsers).doc('a1').get()).data();
    expect(doc?.approvedBy).toBeUndefined();
  });

  it('leaves unspecified fields alone', async () => {
    await seedStaff('m1', 'manager', 'active');
    await applyStaffAccess(ADMIN, { uid: 'm1', role: 'admin' });
    expect(await claimsOf('m1')).toMatchObject({ role: 'admin', status: 'active' });
  });

  /*
   * WHAT DISABLING PROMISES: "switch off access while keeping their history" —
   * one sentence in the manual, covering students and staff alike.
   *
   * Asserted on the AUTH USER, because that is what actually stops a sign-in.
   * Setting the claim alone left a removed manager working normally until their
   * token refreshed, which is up to an hour of writing to classes they had just
   * been taken off — and the student path had done both since Phase 1, so the
   * two populations quietly kept different promises.
   */
  it('disabling a staff member stops them signing in, not just their claims', async () => {
    await seedStaff('d1', 'manager', 'active');
    await applyStaffAccess(ADMIN, { uid: 'd1', status: 'disabled' });

    expect((await getAuth().getUser('d1')).disabled).toBe(true);
    expect(await claimsOf('d1')).toMatchObject({ status: 'disabled' });
  });

  it('re-enabling one lets them back in', async () => {
    await seedStaff('d2', 'manager', 'active');
    await applyStaffAccess(ADMIN, { uid: 'd2', status: 'disabled' });
    await applyStaffAccess(ADMIN, { uid: 'd2', status: 'active' });

    expect((await getAuth().getUser('d2')).disabled).toBe(false);
    expect(await claimsOf('d2')).toMatchObject({ role: 'manager', status: 'active' });
  });

  it('refuses to let an admin demote or disable THEMSELVES', async () => {
    // Without this the last admin can lock the institute out of its own user
    // management, with no way back that does not involve redeploying bootstrap.
    await expect(applyStaffAccess(ADMIN, { uid: ADMIN, role: 'manager' })).rejects.toThrow();
    await expect(applyStaffAccess(ADMIN, { uid: ADMIN, status: 'disabled' })).rejects.toThrow();
    expect(await claimsOf(ADMIN)).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('still lets an admin change someone else', async () => {
    await seedStaff('other-admin', 'admin', 'active');
    await applyStaffAccess(ADMIN, { uid: 'other-admin', role: 'manager' });
    expect(await claimsOf('other-admin')).toMatchObject({ role: 'manager' });
  });

  it('rejects an unknown uid', async () => {
    await expect(applyStaffAccess(ADMIN, { uid: 'nobody', status: 'active' })).rejects.toThrow();
  });

  /*
   * WHAT MAKING SOMEONE A MANAGER PROMISES: they are not an admin any more.
   * Every callable reads the role from the caller's token, which keeps its
   * claims for up to an hour, and nothing ended the token they held. With it a
   * demoted admin went on acting as one: making a friend an admin, and making
   * themselves one again, which outlives the token. Driven through the real
   * callable, with the token they held before the change.
   */
  it('an admin made a manager can no longer act as an admin with the token they hold', async () => {
    await seedStaff('demoted', 'admin', 'active');
    await seedStaff('friend', 'manager', 'active');
    const held = await idTokenFor('demoted');
    // Revocation is stamped to the second; a token from the same second reads as after it.
    await new Promise((r) => setTimeout(r, 1100));
    await applyStaffAccess(ADMIN, { uid: 'demoted', role: 'manager' });

    const asTheyWere = (data: unknown) =>
      ({ auth: { uid: 'demoted', token: { role: 'admin', status: 'active' }, rawToken: held }, data }) as unknown as CallableRequest;
    await expect(setStaffAccess.run(asTheyWere({ uid: 'friend', role: 'admin' }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(setStaffAccess.run(asTheyWere({ uid: 'demoted', role: 'admin' }))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await claimsOf('friend')).toMatchObject({ role: 'manager' });
    expect(await claimsOf('demoted')).toMatchObject({ role: 'manager', status: 'active' });
  });

  it('promoting a manager leaves their session alone', async () => {
    await seedStaff('promoted', 'manager', 'active');
    const held = await idTokenFor('promoted');
    await new Promise((r) => setTimeout(r, 1100));
    await applyStaffAccess(ADMIN, { uid: 'promoted', role: 'admin' });
    const before = await getAuth().verifyIdToken(held, true);
    expect(before.uid).toBe('promoted');
  });
});

describe('validateStaffAccess', () => {
  it('rejects junk input', () => {
    for (const bad of [null, {}, { uid: '' }, { uid: 'x' }, { uid: 'x', role: 'student' }]) {
      expect(() => validateStaffAccess(bad)).toThrow();
    }
  });

  it('rejects a role a staff member may not hold', () => {
    // 'student' is a real role, just not one setStaffAccess may assign — that
    // would put a student row in the staff collection.
    expect(() => validateStaffAccess({ uid: 'x', role: 'student' })).toThrow();
  });

  it('accepts a legitimate change', () => {
    expect(validateStaffAccess({ uid: 'x', status: 'active' })).toEqual({
      uid: 'x',
      status: 'active',
      role: undefined,
    });
  });
});

describe('createStudentAccount', () => {
  it('creates an ACTIVE student with student claims and no password', async () => {
    const res = await createStudentAccount(ADMIN, {
      displayName: 'Fatima Ahmed',
      email: 'fatima@example.com',
    });

    // Staff creating them IS the approval — there is no pending state.
    expect(await claimsOf(res.uid)).toMatchObject({ role: 'student', status: 'active' });
    const user = await getAuth().getUser(res.uid);
    expect(user.email).toBe('fatima@example.com');
    expect(user.emailVerified).toBe(false);
    // No password: they set their own from the emailed link. A temporary one
    // would be a working credential nobody intended to exist.
    expect(user.passwordHash).toBeUndefined();

    const doc = (await getFirestore().collection(COLLECTIONS.students).doc(res.uid).get()).data();
    expect(doc).toMatchObject({ displayName: 'Fatima Ahmed', status: 'active', createdBy: ADMIN });
  });

  it('is NOT deleted by the auth-create trigger', async () => {
    // The whole reason provision.ts branches on provider. If the trigger applied
    // the staff domain gate here, this account would vanish moments after
    // creation and the failure would look intermittent.
    const res = await createStudentAccount(ADMIN, {
      displayName: 'Survivor',
      email: 'survivor@example.com',
    });
    await new Promise((r) => setTimeout(r, 2500));
    await expect(getAuth().getUser(res.uid)).resolves.toBeDefined();
    expect(await claimsOf(res.uid)).toMatchObject({ role: 'student', status: 'active' });
  });

  it('rejects a duplicate address with a usable message', async () => {
    await createStudentAccount(ADMIN, { displayName: 'A', email: 'dup@example.com' });
    await expect(
      createStudentAccount(ADMIN, { displayName: 'B', email: 'dup@example.com' }),
    ).rejects.toThrow(/already/i);
  });
});

describe('validateCreateStudent', () => {
  it('trims and lowercases the address', () => {
    expect(validateCreateStudent({ displayName: '  Ali  ', email: '  A@Example.COM ' })).toEqual({
      displayName: 'Ali',
      email: 'a@example.com',
    });
  });

  it('rejects a missing name or a non-address', () => {
    expect(() => validateCreateStudent({ displayName: '   ', email: 'a@b.com' })).toThrow();
    expect(() => validateCreateStudent({ displayName: 'A', email: 'nope' })).toThrow();
  });
});

describe('applyStudentAccess', () => {
  it('disables the AUTH user, not only the document', async () => {
    const res = await createStudentAccount(ADMIN, {
      displayName: 'Temp',
      email: 'temp@example.com',
    });
    await applyStudentAccess({ uid: res.uid, status: 'disabled' });

    // Document-only would leave an already-signed-in session working off a
    // cached token until it expired.
    expect((await getAuth().getUser(res.uid)).disabled).toBe(true);
    expect(await claimsOf(res.uid)).toMatchObject({ status: 'disabled' });
    const doc = (await getFirestore().collection(COLLECTIONS.students).doc(res.uid).get()).data();
    expect(doc?.status).toBe('disabled');
  });

  it('re-enables cleanly, preserving the record', async () => {
    const res = await createStudentAccount(ADMIN, {
      displayName: 'Back',
      email: 'back@example.com',
    });
    await applyStudentAccess({ uid: res.uid, status: 'disabled' });
    await applyStudentAccess({ uid: res.uid, status: 'active' });
    expect((await getAuth().getUser(res.uid)).disabled).toBe(false);
    const doc = (await getFirestore().collection(COLLECTIONS.students).doc(res.uid).get()).data();
    expect(doc).toMatchObject({ displayName: 'Back', status: 'active' });
  });

  it('rejects an unknown student', async () => {
    await expect(applyStudentAccess({ uid: 'nobody', status: 'disabled' })).rejects.toThrow();
  });
});

describe('validateStudentAccess', () => {
  it('requires a uid and a real status', () => {
    for (const bad of [null, {}, { uid: 'x' }, { uid: 'x', status: 'pending' }]) {
      expect(() => validateStudentAccess(bad)).toThrow();
    }
  });
});
