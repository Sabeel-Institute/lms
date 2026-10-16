import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, PASSWORD_LINK_ANSWER, type Role, type UserStatus } from '@sabeel/shared';
import {
  LINKS_PER_ADDRESS_PER_HOUR,
  LINKS_PER_HOUR,
  deliverRequestedLink,
  requestPasswordLink,
  sendMyPasswordLink,
  sendPasswordLink,
} from '../../src/passwordLinks';
import { createStudent } from '../../src/students';
import { resetMailTransport, setMailTransport, type MailOutcome, type OutgoingMail } from '../../src/mail';
import { setBackgroundTriggers } from '../backgroundTriggers';
import { parseMessage } from '../mailMessage';
import { idTokenFor } from './emulatorToken';

/*
 * PASSWORD LINKS, as a person meets them. The promises:
 *  - the sign-in screen gives every address the same answer, and a link goes
 *    to an active student's address and to nobody else: not staff, not a
 *    disabled student, not an address with no account;
 *  - the link in the email is for the account it was sent to;
 *  - asking is limited per address and in all;
 *  - staff send one only to a student they may manage.
 *
 * "Sent" is observed at the transport, which records each composed message;
 * the link in it is redeemed against the Auth emulator to see whose it is.
 * Background triggers are off for this file, so the queue is taken up here,
 * by `deliverRequestedLink`, and not by the emulator's own trigger.
 */

beforeAll(async () => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
  await setBackgroundTriggers(false);
});
afterAll(async () => {
  await setBackgroundTriggers(true);
});

const db = () => getFirestore();
const AUTH = () => `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;

let sent: { raw: string; mail: OutgoingMail }[] = [];
let answer: MailOutcome = { status: 'sent', messageId: 'm' };

const ADMIN = 'pl-admin';
const MANAGER = 'pl-manager';
const OTHER_MANAGER = 'pl-other-manager';
const COURSE = 'pl-course';
/** The staff accounts this file makes, and removes again. */
const STAFF_ADDRESSES = ['teacher@oursabeel.com', 'admin2@oursabeel.com'];

/** An account made as each population's is, with its record. Returns its uid. */
async function account(email: string, role: Role, status: UserStatus = 'active', password?: string): Promise<string> {
  const user = await getAuth().createUser({ email, displayName: email.split('@')[0] });
  if (password) await getAuth().updateUser(user.uid, { password });
  if (status === 'disabled') await getAuth().updateUser(user.uid, { disabled: true });
  await getAuth().setCustomUserClaims(user.uid, { role, status });
  if (role === 'student') {
    await db().collection(COLLECTIONS.students).doc(user.uid).set({
      displayName: email.split('@')[0], email, role, status, createdAt: 1, createdBy: ADMIN,
    });
  } else {
    await db().collection(COLLECTIONS.staffUsers).doc(user.uid).set({
      displayName: email.split('@')[0], email, photoUrl: null, role, status, createdAt: 1,
    });
  }
  return user.uid;
}

async function staffDoc(uid: string, role: 'admin' | 'manager') {
  await db().collection(COLLECTIONS.staffUsers).doc(uid).set({
    displayName: uid, email: `${uid}@oursabeel.com`, photoUrl: null, role, status: 'active', createdAt: 1,
  });
}

beforeEach(async () => {
  sent = [];
  answer = { status: 'sent', messageId: 'm' };
  setMailTransport(async (raw, mail) => {
    sent.push({ raw, mail });
    return answer;
  });
  for (const c of [
    COLLECTIONS.passwordLinkRequests,
    COLLECTIONS.passwordLinkLimits,
    COLLECTIONS.students,
    COLLECTIONS.staffUsers,
    COLLECTIONS.courses,
    COLLECTIONS.enrollments,
    COLLECTIONS.auditLog,
  ]) {
    await db().recursiveDelete(db().collection(c));
  }
  const users = await getAuth().listUsers(1000);
  await getAuth().deleteUsers(users.users.filter((u) => u.email && (u.email.endsWith('@pl.example') || STAFF_ADDRESSES.includes(u.email))).map((u) => u.uid));
  await staffDoc(ADMIN, 'admin');
  await staffDoc(MANAGER, 'manager');
  await staffDoc(OTHER_MANAGER, 'manager');
  await db().collection(COLLECTIONS.courses).doc(COURSE).set({
    cohortId: 'c', name: 'Hikam', archived: false, effectiveActive: true, archivedAccess: false,
    recordingsClosed: [], managerUids: [MANAGER], createdAt: 1, createdBy: ADMIN,
  });
});

afterEach(() => resetMailTransport());

const signedOut = (data: unknown) => ({ data }) as unknown as CallableRequest;
async function as(uid: string, role: Role, data: unknown = {}): Promise<CallableRequest> {
  return { auth: { uid, token: { role, status: 'active' }, rawToken: await idTokenFor(uid) }, data } as unknown as CallableRequest;
}
async function refusal(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const requests = async () => (await db().collection(COLLECTIONS.passwordLinkRequests).get()).docs;

/** Take up every queued request, as the trigger would. */
async function deliverAll() {
  const out: string[] = [];
  for (const r of await requests()) out.push(await deliverRequestedLink(r.id));
  return out;
}

/** The account a sent email's link sets the password of, asked of the Auth emulator. */
async function linkAccount(raw: string): Promise<string> {
  const text = parseMessage(raw).text!;
  const link = text.split(/\r\n/).find((l) => /^https?:\/\//.test(l))!;
  const oobCode = new URL(link).searchParams.get('oobCode');
  const res = await fetch(`${AUTH()}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oobCode }),
  });
  return ((await res.json()) as { email: string }).email;
}

describe('requestPasswordLink, from the sign-in screen', () => {
  it('answers every address the same, and queues each, whoever it belongs to', async () => {
    await account('student@pl.example', 'student');
    await account('teacher@oursabeel.com', 'manager');
    const answers = [];
    for (const email of ['student@pl.example', 'teacher@oursabeel.com', 'nobody@pl.example']) {
      answers.push(await requestPasswordLink.run(signedOut({ email })));
    }
    expect(answers).toEqual([1, 2, 3].map(() => ({ message: PASSWORD_LINK_ANSWER })));
    expect((await requests()).map((d) => d.data().email).sort()).toEqual(['nobody@pl.example', 'student@pl.example', 'teacher@oursabeel.com']);
    // Nothing is sent while the person waits for the answer.
    expect(sent).toHaveLength(0);
  });

  it('sends a link to an active student, for that student’s account, and to nobody else', async () => {
    const studentUid = await account('student@pl.example', 'student');
    await account('teacher@oursabeel.com', 'manager');
    await account('admin2@oursabeel.com', 'admin');
    await account('gone@pl.example', 'student', 'disabled');
    for (const email of ['student@pl.example', 'teacher@oursabeel.com', 'admin2@oursabeel.com', 'gone@pl.example', 'nobody@pl.example']) {
      await requestPasswordLink.run(signedOut({ email }));
    }
    const outcomes = await deliverAll();
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].mail.to.address).toBe('student@pl.example');
    expect(await linkAccount(sent[0].raw)).toBe('student@pl.example');
    expect((await getAuth().getUser(studentUid)).email).toBe('student@pl.example');
    // Taken up, and only once.
    expect(await requests()).toHaveLength(0);
  });

  it('takes a request up once, however often the event arrives', async () => {
    await account('student@pl.example', 'student');
    await requestPasswordLink.run(signedOut({ email: 'student@pl.example' }));
    const [r] = await requests();
    expect(await deliverRequestedLink(r.id)).toBe('sent');
    expect(await deliverRequestedLink(r.id)).toBe('no-request');
    expect(sent).toHaveLength(1);
  });

  it('sets a new student’s password, and resets one that has a password', async () => {
    await account('new@pl.example', 'student');
    await account('old@pl.example', 'student', 'active', 'OldPass123!');
    for (const email of ['new@pl.example', 'old@pl.example']) await requestPasswordLink.run(signedOut({ email }));
    await deliverAll();
    const subjects = Object.fromEntries(sent.map((s) => [s.mail.to.address, s.mail.subject]));
    expect(subjects['new@pl.example']).toBe('Set your password for the Sabeel Institute LMS');
    expect(subjects['old@pl.example']).toBe('Reset your password for the Sabeel Institute LMS');
  });

  it(`refuses an ask past ${LINKS_PER_ADDRESS_PER_HOUR} for one address in an hour, however it is typed, and queues nothing for it`, async () => {
    for (let i = 0; i < LINKS_PER_ADDRESS_PER_HOUR; i += 1) {
      await requestPasswordLink.run(signedOut({ email: i % 2 ? ' Student@PL.example ' : 'student@pl.example' }));
    }
    expect(await refusal(requestPasswordLink.run(signedOut({ email: 'STUDENT@pl.example' })))).toMatch(/Wait an hour/);
    expect(await requests()).toHaveLength(LINKS_PER_ADDRESS_PER_HOUR);
    // Another address is not held to it.
    expect(await requestPasswordLink.run(signedOut({ email: 'other@pl.example' }))).toEqual({ message: PASSWORD_LINK_ANSWER });
  });

  it(`refuses an ask past ${LINKS_PER_HOUR} in an hour across every address`, async () => {
    for (let i = 0; i < LINKS_PER_HOUR; i += 1) await requestPasswordLink.run(signedOut({ email: `n${i}@pl.example` }));
    expect(await refusal(requestPasswordLink.run(signedOut({ email: 'one-more@pl.example' })))).toMatch(/Too many password links/);
    expect(await requests()).toHaveLength(LINKS_PER_HOUR);
  });

  it('keeps no address in the limits, only a hash of it', async () => {
    await requestPasswordLink.run(signedOut({ email: 'student@pl.example' }));
    const keys = (await db().collection(COLLECTIONS.passwordLinkLimits).get()).docs.map((d) => d.id);
    expect(keys.some((k) => k.includes('student'))).toBe(false);
    expect(keys).toHaveLength(2);
  });
});

describe('sendPasswordLink, from a student’s page', () => {
  it('lets an admin send a student a link for that student’s account, and audits it', async () => {
    const uid = await account('student@pl.example', 'student');
    expect(await sendPasswordLink.run(await as(ADMIN, 'admin', { uid }))).toEqual({ mail: 'sent' });
    expect(sent).toHaveLength(1);
    expect(await linkAccount(sent[0].raw)).toBe('student@pl.example');
    const audit = (await db().collection(COLLECTIONS.auditLog).where('action', '==', 'sendPasswordLink').get()).docs.map((d) => d.data());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUid: ADMIN, targets: { studentUid: uid }, detail: { kind: 'set', mail: 'sent' } });
  });

  it('lets a manager send one for a student in a course they manage, filed under that course', async () => {
    const uid = await account('student@pl.example', 'student');
    await db().collection(COLLECTIONS.enrollments).doc(`${uid}_${COURSE}`).set({
      studentUid: uid, courseId: COURSE, cohortId: 'c', active: true, stretches: [{ from: 1, to: null }], enrolledBy: ADMIN,
    });
    expect(await sendPasswordLink.run(await as(MANAGER, 'manager', { uid }))).toEqual({ mail: 'sent' });
    const [entry] = (await db().collection(COLLECTIONS.auditLog).where('action', '==', 'sendPasswordLink').get()).docs.map((d) => d.data());
    expect(entry.courseId).toBe(COURSE);
  });

  it('sends nothing for a manager who does not manage the student', async () => {
    const uid = await account('student@pl.example', 'student');
    await db().collection(COLLECTIONS.enrollments).doc(`${uid}_${COURSE}`).set({
      studentUid: uid, courseId: COURSE, cohortId: 'c', active: true, stretches: [{ from: 1, to: null }], enrolledBy: ADMIN,
    });
    expect(await refusal(sendPasswordLink.run(await as(OTHER_MANAGER, 'manager', { uid })))).toMatch(/not in a course you manage/);
    // Nor for the course's manager once the student has left it.
    await db().collection(COLLECTIONS.enrollments).doc(`${uid}_${COURSE}`).update({ active: false });
    expect(await refusal(sendPasswordLink.run(await as(MANAGER, 'manager', { uid })))).toMatch(/not in a course you manage/);
    expect(sent).toHaveLength(0);
  });

  it('lets the staff member who made the account send one, in no course', async () => {
    const uid = await account('student@pl.example', 'student');
    await db().collection(COLLECTIONS.students).doc(uid).update({ createdBy: OTHER_MANAGER });
    expect(await sendPasswordLink.run(await as(OTHER_MANAGER, 'manager', { uid }))).toEqual({ mail: 'sent' });
  });

  it('never sends one to staff, or to a disabled student', async () => {
    const teacher = await account('teacher@oursabeel.com', 'manager');
    await db().collection(COLLECTIONS.students).doc(teacher).set({
      displayName: 'x', email: 'teacher@oursabeel.com', role: 'student', status: 'active', createdAt: 1, createdBy: ADMIN,
    });
    expect(await refusal(sendPasswordLink.run(await as(ADMIN, 'admin', { uid: teacher })))).toMatch(/Staff sign in with Google/);
    const gone = await account('gone@pl.example', 'student', 'disabled');
    expect(await refusal(sendPasswordLink.run(await as(ADMIN, 'admin', { uid: gone })))).toMatch(/disabled/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a student, and anyone signed out', async () => {
    const uid = await account('student@pl.example', 'student');
    expect(await refusal(sendPasswordLink.run(await as(uid, 'student', { uid })))).toMatch(/Staff role required/);
    expect(await refusal(sendPasswordLink.run(signedOut({ uid })))).toMatch(/Sign in required/);
    expect(sent).toHaveLength(0);
  });
});

describe('sendMyPasswordLink, from More', () => {
  it('sends a signed-in student a link for their own account, counted with the sign-in screen’s', async () => {
    const uid = await account('student@pl.example', 'student', 'active', 'Pass1234!');
    for (let i = 1; i < LINKS_PER_ADDRESS_PER_HOUR; i += 1) await requestPasswordLink.run(signedOut({ email: 'student@pl.example' }));
    expect(await sendMyPasswordLink.run(await as(uid, 'student'))).toEqual({ mail: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].mail.subject).toBe('Reset your password for the Sabeel Institute LMS');
    expect(await linkAccount(sent[0].raw)).toBe('student@pl.example');
    expect(await refusal(sendMyPasswordLink.run(await as(uid, 'student')))).toMatch(/Wait an hour/);
    expect(sent).toHaveLength(1);
  });

  it('refuses staff', async () => {
    const teacher = await account('teacher@oursabeel.com', 'manager');
    expect(await refusal(sendMyPasswordLink.run(await as(teacher, 'manager')))).toMatch(/Only a student/);
    expect(sent).toHaveLength(0);
  });
});

describe('createStudent', () => {
  it('sends the new student the set-password email, for their account', async () => {
    const out = (await createStudent.run(await as(ADMIN, 'admin', { displayName: 'New Student', email: 'new@pl.example' }))) as {
      uid: string;
      emailSent: boolean;
    };
    expect(out.emailSent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].mail.subject).toBe('Set your password for the Sabeel Institute LMS');
    expect(sent[0].mail.to).toEqual({ name: 'New Student', address: 'new@pl.example' });
    expect(await linkAccount(sent[0].raw)).toBe('new@pl.example');
  });

  it('keeps the account when the email fails, and says so', async () => {
    answer = { status: 'failed', error: 'signJwt refused (HTTP 403): no' };
    const out = (await createStudent.run(await as(ADMIN, 'admin', { displayName: 'New Student', email: 'new@pl.example' }))) as {
      uid: string;
      emailSent: boolean;
    };
    expect(out.emailSent).toBe(false);
    expect((await getAuth().getUser(out.uid)).email).toBe('new@pl.example');
  });
});
