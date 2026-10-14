import { HttpsError } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, type Role, type UserStatus } from '@sabeel/shared';
import { requireAdmin } from './guards';
import { shutOutAccount } from './shutOut';

export interface StaffAccessInput {
  uid: string;
  status?: Extract<UserStatus, 'active' | 'disabled'>;
  role?: Extract<Role, 'admin' | 'manager'>;
}

export function validateStaffAccess(data: unknown): StaffAccessInput {
  const d = data as Partial<StaffAccessInput> | null;
  if (!d || typeof d.uid !== 'string' || d.uid.length === 0) {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }
  if (d.status !== undefined && d.status !== 'active' && d.status !== 'disabled') {
    throw new HttpsError('invalid-argument', 'status must be active or disabled.');
  }
  if (d.role !== undefined && d.role !== 'admin' && d.role !== 'manager') {
    throw new HttpsError('invalid-argument', 'role must be admin or manager.');
  }
  if (d.status === undefined && d.role === undefined) {
    throw new HttpsError('invalid-argument', 'Nothing to change.');
  }
  return { uid: d.uid, status: d.status, role: d.role };
}

/**
 * Core of setStaffAccess, callable-independent so integration tests can drive it
 * directly against the emulators.
 *
 * Merges the requested changes into the staff document and mirrors
 * { role, status } into custom claims. The document is for UI; the claims are
 * what security rules trust.
 */
export async function applyStaffAccess(callerUid: string, input: StaffAccessInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.staffUsers).doc(input.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such staff member.');

  const current = snap.data() as { role: Role; status: UserStatus };

  // An admin may not demote or disable themselves. Without this the last admin
  // can lock the institute out of its own user management, with no way back in
  // that does not involve redeploying a bootstrap function.
  if (input.uid === callerUid && (input.role === 'manager' || input.status === 'disabled')) {
    throw new HttpsError('failed-precondition', 'You cannot demote or disable yourself.');
  }

  const next = {
    role: (input.role ?? current.role) as Extract<Role, 'admin' | 'manager'>,
    status: input.status ?? current.status,
  };

  /*
   * DISABLE THE AUTH USER TOO, exactly as the student path does.
   *
   * Claims only change when a token refreshes, which is up to an hour — so
   * setting `status: 'disabled'` and stopping there left a removed manager
   * working normally for the rest of that hour, writing to their classes. The
   * manual makes one promise for both populations ("Disable a student or staff
   * member to switch off access while keeping their history"), and only one of
   * them kept it.
   *
   * ORDER: auth user, then claims, then the mirror — and the mirror LAST on
   * purpose. There are three writes and no transaction spanning Auth and
   * Firestore, so a failure between them is a state someone has to get out of.
   * Writing the mirror last makes every interim state fail SAFE and repair by
   * repetition:
   *
   *   - Disabling, claims throw → the account is already shut out of Auth while
   *     the mirror still reads active. Tighter than intended, never looser.
   *   - Enabling, claims throw → they can sign in again but every guard still
   *     reads `status: 'disabled'` from the token, so they land on the gate.
   *     Again tighter than intended.
   *
   * In both, the screen still shows the OLD status, so the admin's next move is
   * to press the same button — which re-runs all three writes idempotently and
   * lands the intended state. Writing the mirror first would invert this: the
   * screen would report the change as done while the enforcement had not
   * happened, and there would be no control left that looked like the repair.
   */
  if (next.status === 'disabled') await shutOutAccount(input.uid);
  else await getAuth().updateUser(input.uid, { disabled: false });
  await getAuth().setCustomUserClaims(input.uid, next);
  /*
   * AN ADMIN MADE A MANAGER IS SIGNED OUT, as a disabled account is. Every
   * callable reads the role from the caller's token, which keeps its claims
   * for up to an hour, so the new claim alone left them an admin for the rest
   * of it: making a friend an admin, or themselves one again, which outlasts
   * the token. Revoked after the claims are set, so the sign-in that follows
   * is a manager's (`assertAccountLive` refuses the old token; the rules ask
   * the staff record, written below). A promotion needs none of this.
   */
  if (current.role === 'admin' && next.role === 'manager') await getAuth().revokeRefreshTokens(input.uid);

  const update: Record<string, unknown> = { ...next };
  if (current.status === 'pending' && next.status === 'active') {
    update.approvedAt = Date.now();
    update.approvedBy = callerUid;
  }
  await ref.update(update);

  return next;
}

/** Only admins approve staff, change roles, or disable accounts. */
// Staff access changes are platform-level (not class-scoped) → admin-only audit.
export const setStaffAccess = auditedCall('setStaffAccess', async (req, audit) => {
  const callerUid = requireAdmin(req);
  const input = validateStaffAccess(req.data);
  audit.detail = { role: input.role, status: input.status };
  return applyStaffAccess(callerUid, input);
});
