import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, type Role, type TokenClaims } from '@sabeel/shared';

/**
 * The account behind the token is still live — checked against the user
 * record, on every call.
 *
 * An ID token is a bearer credential until it expires, up to an hour: the
 * platform verifies its signature and hands the callable its claims, and
 * neither consults the user record again. So `setStaffAccess` and
 * `setStudentAccess` disabled the Auth user, wrote `status: 'disabled'` into
 * the claims, and a client holding the OLD token went on minting playback URLs
 * and submitting registers until it expired — with the manual promising
 * "immediately". The app signs itself out within seconds through the profile
 * listener; this is for whoever does not.
 *
 * `checkRevoked` re-reads the user. One Auth lookup per call. An
 * unauthenticated call has nothing to check — `accountExists` is one — and the
 * handler decides. Three answers are refusals, each in the words that are
 * true of it:
 *
 *  - DISABLED, or the account gone: "Account is not active.", the sentence
 *    `requireActive` uses. A deleted account's token is not a fault to report
 *    — rethrown, it reached the wrapper as `internal` and Sentry on every call
 *    the still-valid token made.
 *  - REVOKED: "Your session has ended. Sign in again." Revocation is what
 *    disabling does, but not only that — Firebase revokes every session when a
 *    password is reset, so a student who asked for a password link from a
 *    browser held, on their phone, a token this refuses for up to an hour.
 *    Told their account was not active, they had no reason to sign in again,
 *    which is the one thing that fixes it.
 */
export async function assertAccountLive(req: CallableRequest): Promise<void> {
  if (!req.auth) return;
  try {
    await getAuth().verifyIdToken(req.auth.rawToken, true);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/user-disabled' || code === 'auth/user-not-found') {
      throw new HttpsError('permission-denied', 'Account is not active.');
    }
    if (code === 'auth/id-token-revoked') {
      throw new HttpsError('unauthenticated', 'Your session has ended. Sign in again.');
    }
    throw e;
  }
}

/**
 * Callable authorisation, read from the TOKEN — never from a user document.
 * The mirror documents exist for UI; a stale or tampered one must not grant
 * anything.
 */

function claims(req: CallableRequest): TokenClaims {
  return (req.auth?.token ?? {}) as TokenClaims;
}

function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth.uid;
}

/** Signed in AND approved. Pending and disabled accounts get nothing. */
function requireActive(req: CallableRequest): string {
  const uid = requireAuth(req);
  if (claims(req).status !== 'active') {
    throw new HttpsError('permission-denied', 'Account is not active.');
  }
  return uid;
}

/**
 * Any active account, staff or student, acting for themselves: accepting the
 * institute's rules, reporting a problem. Pending and disabled accounts get
 * nothing, and neither does a token with no role, which no account of either
 * population carries once it is set up.
 */
export function requireMember(req: CallableRequest): { uid: string; role: Role } {
  const uid = requireActive(req);
  const role = claims(req).role;
  if (role !== 'student' && role !== 'manager' && role !== 'admin') {
    throw new HttpsError('permission-denied', 'Account is not active.');
  }
  return { uid, role };
}

/** An active student, acting on their own work. */
export function requireStudent(req: CallableRequest): string {
  const uid = requireActive(req);
  if (claims(req).role !== 'student') {
    throw new HttpsError('permission-denied', 'Only a student can do that.');
  }
  return uid;
}

/** Any active staff member: manager or admin. */
export function requireStaff(req: CallableRequest): string {
  const uid = requireActive(req);
  const role = claims(req).role;
  if (role !== 'manager' && role !== 'admin') {
    throw new HttpsError('permission-denied', 'Staff role required.');
  }
  return uid;
}

/** Admins alone approve staff, assign roles, and configure the platform. */
export function requireAdmin(req: CallableRequest): string {
  const uid = requireActive(req);
  if (claims(req).role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin required.');
  }
  return uid;
}

/**
 * Whether the caller is an admin, for a callable that lets admins do more than
 * the course scope it has already checked — not a gate on its own.
 */
export function isAdminCaller(req: CallableRequest): boolean {
  return claims(req).role === 'admin';
}

/**
 * Staff authorization for one class: an admin, or a manager assigned to it.
 *
 * Server-side, and deliberately not expressible in security rules. Every write
 * a STAFF member makes goes through a callable — the rules deny staff writes to
 * every structural collection outright — so this is where "may you touch this
 * class's roster?" is actually decided. (Students write four collections of
 * their own directly; those are gated in `firestore.rules`, which is the right
 * place for them, and none of them grants anything.) Reads the class fresh
 * rather than trusting anything the caller sent.
 */
export async function requireCourseScope(
  req: CallableRequest,
  courseId: string,
): Promise<string> {
  const uid = requireStaff(req);
  if (claims(req).role === 'admin') return uid;

  const snap = await getFirestore().collection(COLLECTIONS.courses).doc(courseId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such class.');

  const managerUids = (snap.data() as { managerUids?: string[] }).managerUids ?? [];
  if (!managerUids.includes(uid)) {
    throw new HttpsError('permission-denied', 'You are not assigned to that class.');
  }
  return uid;
}
