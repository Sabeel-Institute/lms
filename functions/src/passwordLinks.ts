import { createHash } from 'node:crypto';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getFirestore, type Transaction } from 'firebase-admin/firestore';
import {
  APP_NAME,
  COLLECTIONS,
  PASSWORD_LINK_ANSWER,
  WEB_APP_URL,
  type CourseDoc,
  type EnrollmentDoc,
  type StudentDoc,
  type TokenClaims,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { isAdminCaller, requireStaff, requireStudent } from './guards';
import { reportedCall, SENTRY_DSN } from './reported';
import { reportError } from './sentry';
import { plainMessage, sendMail, type MailOutcome, type OutgoingMail } from './mail';

/**
 * PASSWORD LINKS, FROM THE INSTITUTE'S OWN ADDRESS.
 *
 * A student's account has no password until they choose one from an emailed
 * link, and the same link resets a forgotten one. The server makes the link
 * with the Admin SDK and sends it from `apps-noreply@` (`mail.ts`); Firebase's
 * own sender, `noreply@<project>.firebaseapp.com`, landed in students' spam,
 * and nothing calls it any more.
 *
 * Four ways to ask, one way to send (`sendLinkTo`):
 *
 *  - `createStudent` sends a new student the set-password email.
 *  - `sendPasswordLink`: staff, for a student they may manage. Audited.
 *  - `sendMyPasswordLink`: a signed-in student, for their own account.
 *  - `requestPasswordLink`: anyone, from the sign-in screen, for an address.
 *    It must say nothing about who has an account: the same answer for every
 *    address, and the same work before answering, which is queueing the
 *    request. Whether the address is a student's is decided afterwards, by
 *    `onPasswordLinkRequested`, which nobody waits on. Only a student is ever
 *    sent a link, never staff.
 *
 * Only an active student gets a link: a disabled account's link opens a form
 * that refuses to save, and staff sign in with Google and have no password.
 */

/** How many links one address may be asked for in an hour, from the sign-in screen and More together. */
export const LINKS_PER_ADDRESS_PER_HOUR = 3;
/** How many the sign-in screen may ask for in an hour, across every address. */
export const LINKS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Where the page that sets the password offers to go once it is saved: the
 * website's sign-in. The page itself is Firebase's, as it has always been.
 */
const ACTION_CODE_SETTINGS = { url: WEB_APP_URL };

export type LinkKind = 'set' | 'reset';

/** A new student, who has never had a password, sets one; anyone else resets theirs. */
export function linkKind(user: Pick<UserRecord, 'providerData'>): LinkKind {
  return user.providerData.some((p) => p.providerId === 'password') ? 'reset' : 'set';
}

/** An account that may be sent a link: an active student. */
export function isLinkable(user: Pick<UserRecord, 'disabled' | 'customClaims' | 'email'>): boolean {
  const claims = (user.customClaims ?? {}) as TokenClaims;
  return !!user.email && !user.disabled && claims.role === 'student' && claims.status === 'active';
}

/**
 * The email: plain institute wording, the link on a line of its own, no Reply-To
 * (the sender reads nothing), and nothing of Firebase's.
 */
export function passwordMail(kind: LinkKind, to: { name: string; email: string }, link: string): OutgoingMail {
  const hello = to.name ? `Hello ${to.name},` : 'Hello,';
  const blocks =
    kind === 'set'
      ? [
          hello,
          `Sabeel Institute has made you an account in the ${APP_NAME}, where you play the class recordings you are given and hand in your assignments. To start, choose your password:`,
          { link, label: 'Choose your password' },
          `The link works once, within an hour. After that, sign in with ${to.email} and the password you chose, in the app or at ${WEB_APP_URL}.`,
          'If the link has expired, enter your email address under Students on the sign-in screen and tap Email me a password link.',
          'This address does not receive replies. If you need help, ask your teacher.',
          'Sabeel Institute',
        ]
      : [
          hello,
          `Someone asked to reset the password of your account in the ${APP_NAME} (${to.email}). To choose a new password:`,
          { link, label: 'Choose a new password' },
          'The link works once, within an hour. Your password stays as it is unless you choose a new one.',
          'If you did not ask for this, you can ignore it.',
          'This address does not receive replies. If you need help, ask your teacher.',
          'Sabeel Institute',
        ];
  return {
    to: { name: to.name, address: to.email },
    subject: kind === 'set' ? `Set your password for the ${APP_NAME}` : `Reset your password for the ${APP_NAME}`,
    ...plainMessage(blocks),
  };
}

/**
 * Make the link and send it. Never throws: a link Google will not make is a
 * failed outcome, with the reason, like a send that does not go.
 */
export async function sendLinkTo(user: UserRecord): Promise<MailOutcome> {
  try {
    const link = await getAuth().generatePasswordResetLink(user.email!, ACTION_CODE_SETTINGS);
    return await sendMail(passwordMail(linkKind(user), { name: user.displayName ?? '', email: user.email! }, link));
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** A send that failed goes to Sentry with the account, never the address. */
async function reportFailed(outcome: MailOutcome, uid: string, source: string): Promise<void> {
  if (outcome.status === 'failed') await reportError(new Error(`Password link for ${uid} not sent: ${outcome.error}`), { source });
}

/** An address as the limits count it: trimmed, lower case. */
function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The address as a key that does not hold it: the limits' document for one address. */
export const addressKey = (email: string) => `a_${createHash('sha256').update(normalEmail(email)).digest('hex')}`;
const OVERALL_KEY = 'all';

/**
 * Take a place under the limits, inside the caller's transaction, or refuse.
 * The same reads and writes whether or not the address has an account; the
 * limits never look it up.
 */
async function takeLinkSlot(tx: Transaction, email: string, now: number, overall: boolean): Promise<void> {
  const limits = getFirestore().collection(COLLECTIONS.passwordLinkLimits);
  const mine = limits.doc(addressKey(email));
  const all = limits.doc(OVERALL_KEY);
  const [mineSnap, allSnap] = await Promise.all([tx.get(mine), overall ? tx.get(all) : Promise.resolve(null)]);
  const recent = (snap: typeof mineSnap | null) =>
    ((snap?.data()?.at as number[] | undefined) ?? []).filter((t) => t > now - HOUR_MS);
  const mineRecent = recent(mineSnap);
  const allRecent = recent(allSnap);
  if (mineRecent.length >= LINKS_PER_ADDRESS_PER_HOUR) {
    throw new HttpsError('resource-exhausted', 'Several links have been asked for this address in the last hour. Wait an hour, then ask again.');
  }
  if (overall && allRecent.length >= LINKS_PER_HOUR) {
    throw new HttpsError('resource-exhausted', 'Too many password links have been asked for just now. Try again in an hour.');
  }
  tx.set(mine, { at: [...mineRecent, now] });
  if (overall) tx.set(all, { at: [...allRecent, now] });
}

/** The address someone typed, checked at the boundary. Says nothing about accounts. */
export function validateLinkEmail(data: unknown): string {
  const raw = (data as { email?: unknown } | null)?.email;
  const email = typeof raw === 'string' ? normalEmail(raw) : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter the email address your teacher registered.');
  }
  return email;
}

/**
 * "Email me a password link", from the sign-in screen, signed in or not.
 *
 * Queues the request and answers. Nothing here looks the address up, so
 * neither the answer nor the time it takes can depend on whether it has an
 * account; `passwordLinks.timing.integration.test.ts` runs it with Auth unreachable.
 */
export const requestPasswordLink = reportedCall(async (req: CallableRequest) => {
  const email = validateLinkEmail(req.data);
  const db = getFirestore();
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    await takeLinkSlot(tx, email, now, true);
    tx.create(db.collection(COLLECTIONS.passwordLinkRequests).doc(), { email, requestedAt: now });
  });
  return { message: PASSWORD_LINK_ANSWER };
});

/**
 * Take up one queued request: claimed by removing it, so a redelivered event
 * finds nothing and sends nothing twice; then a link to the address if it is
 * an active student's, and nothing at all otherwise. What happened is
 * returned and logged, by account, never by address.
 */
export async function deliverRequestedLink(requestId: string): Promise<MailOutcome['status'] | 'no-request' | 'not-a-student'> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.passwordLinkRequests).doc(requestId);
  const email = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    return (snap.data() as { email: string }).email;
  });
  if (email === null) return 'no-request';
  const user = await getAuth()
    .getUserByEmail(email)
    .catch((e: { code?: string }) => {
      if (e.code === 'auth/user-not-found') return null;
      throw e;
    });
  if (!user || !isLinkable(user)) {
    console.log('password link requested: no student account at that address');
    return 'not-a-student';
  }
  const outcome = await sendLinkTo(user);
  console.log(`password link requested for ${user.uid}: ${outcome.status}`);
  await reportFailed(outcome, user.uid, 'onPasswordLinkRequested');
  return outcome.status;
}

export const onPasswordLinkRequested = onDocumentCreated(
  { document: `${COLLECTIONS.passwordLinkRequests}/{requestId}`, secrets: [SENTRY_DSN] },
  async (event) => {
    try {
      await deliverRequestedLink(event.params.requestId);
    } catch (e) {
      // Not retried: the request is already taken up, and a person who got
      // nothing asks again.
      await reportError(e, { source: 'onPasswordLinkRequested' });
    }
  },
);

/** The student's account, if it may be sent a link; a sentence otherwise. */
async function linkableStudent(uid: string): Promise<UserRecord> {
  const user = await getAuth()
    .getUser(uid)
    .catch((e: { code?: string }) => {
      if (e.code === 'auth/user-not-found') throw new HttpsError('not-found', 'That account no longer exists.');
      throw e;
    });
  const claims = (user.customClaims ?? {}) as TokenClaims;
  if (claims.role !== 'student') throw new HttpsError('failed-precondition', 'Only a student has a password to set. Staff sign in with Google.');
  if (!isLinkable(user)) throw new HttpsError('failed-precondition', 'That account is disabled. Re-enable it first.');
  return user;
}

/**
 * MAY THIS STAFF MEMBER MANAGE THIS STUDENT: an admin; the staff member who
 * made the account; or a manager of a course the student is in now.
 */
async function requireStudentScope(req: CallableRequest, studentUid: string): Promise<{ student: StudentDoc; courseId: string | null }> {
  const callerUid = requireStaff(req);
  const db = getFirestore();
  const snap = await db.collection(COLLECTIONS.students).doc(studentUid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such student.');
  const student = snap.data() as StudentDoc;
  if (isAdminCaller(req) || student.createdBy === callerUid) return { student, courseId: null };
  const enrolments = await db
    .collection(COLLECTIONS.enrollments)
    .where('studentUid', '==', studentUid)
    .where('active', '==', true)
    .get();
  for (const e of enrolments.docs) {
    const { courseId } = e.data() as EnrollmentDoc;
    const course = await db.collection(COLLECTIONS.courses).doc(courseId).get();
    if (((course.data() as CourseDoc | undefined)?.managerUids ?? []).includes(callerUid)) return { student, courseId };
  }
  throw new HttpsError('permission-denied', 'That student is not in a course you manage.');
}

/** Staff send a student a link: to set a password, or to reset it. */
export const sendPasswordLink = auditedCall('sendPasswordLink', async (req, audit) => {
  const uid = (req.data as { uid?: unknown } | null)?.uid;
  if (typeof uid !== 'string' || !uid) throw new HttpsError('invalid-argument', 'uid is required.');
  const { courseId } = await requireStudentScope(req, uid);
  const user = await linkableStudent(uid);
  const outcome = await sendLinkTo(user);
  await reportFailed(outcome, uid, 'sendPasswordLink');
  // Under the course that gave the manager the right, so they read it in
  // that course's history; an admin's or the creator's is the directory's.
  audit.courseId = courseId;
  audit.targets.studentUid = uid;
  audit.detail = { kind: linkKind(user), mail: outcome.status };
  return { mail: outcome.status };
});

/** A signed-in student sends a link to their own account: More → Change password. */
export const sendMyPasswordLink = reportedCall(async (req) => {
  const uid = requireStudent(req);
  const user = await linkableStudent(uid);
  const db = getFirestore();
  await db.runTransaction((tx) => takeLinkSlot(tx, user.email!, Date.now(), false));
  const outcome = await sendLinkTo(user);
  await reportFailed(outcome, uid, 'sendMyPasswordLink');
  return { mail: outcome.status };
});
