import './setup';
import * as functionsV1 from 'firebase-functions/v1';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, INSTITUTE_TIMEZONE, REGION, todayInZone, type StaffUserDoc } from '@sabeel/shared';
import { decideProvision } from './provision';
import { reportError } from './sentry';
import { writeAudit } from './audited';

/**
 * Server-side account provisioning and domain enforcement, for every new
 * Firebase Auth user. The decision is in `provision.ts`; this performs it.
 *
 * This is the ONLY gate on who gets an account, which was not the original
 * intent. The plan was to disable client-side sign-up in the console and let
 * this handle domain enforcement alone; that setting
 * (`client.permissions.disabledUserSignup`) turns out to block a staff member's
 * FIRST Google sign-in too — creating their account is a sign-up — so it fails
 * with `auth/admin-restricted-operation` before this trigger ever runs. Staff
 * self-onboarding and disabled sign-up are mutually exclusive. Verified against
 * the live project, 2026-07-22.
 *
 * Gen-1 auth trigger: `beforeUserCreated` (a blocking function) would reject
 * before the auth user exists at all, closing the seconds-long window in which a
 * rejected account exists. It needs the project upgraded to Identity Platform.
 * Worth doing now that this is the only gate — but the window is still not
 * exploitable, because an account this trigger rejects has no custom claims, and
 * every rule gates on `status == 'active'` defaulting to `''`.
 *
 * Deleting a rejected account rather than marking it `rejected` keeps
 * `staffUsers` meaningful: everything in it is someone who legitimately reached
 * the approval queue, so the admin's list is never padded with junk that has to
 * be mentally filtered.
 */
/**
 * REJECTED SIGN-UPS ARE COUNTED, ONE ROW A DAY. Anyone holding the site's
 * public key can attempt a sign-up, and a row for each let a few hundred
 * attempts push every real entry off the admin's history, which shows the
 * latest 200. The day's row says how many there were, and the latest address
 * and why it was refused.
 */
async function countRejected(uid: string, email: string | null, reason: string): Promise<void> {
  const day = todayInZone(INSTITUTE_TIMEZONE);
  await getFirestore()
    .collection(COLLECTIONS.auditLog)
    .doc(`authReject-${day}`)
    .set(
      {
        at: Date.now(),
        actorUid: uid,
        actorRole: 'system',
        action: 'authReject',
        courseId: null,
        targets: { uid },
        detail: { attempts: FieldValue.increment(1), email, reason },
      },
      { merge: true },
    );
}

/** gRPC ALREADY_EXISTS: the directory row an earlier delivery created. */
const ALREADY_EXISTS = 6;

export const onUserCreate = functionsV1
  .runWith({ secrets: ['SENTRY_DSN'] })
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    try {
      const decision = decideProvision({
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        photoURL: user.photoURL,
        providerIds: user.providerData.map((p) => p.providerId),
      });

      if (decision.action === 'ignore') {
        // A student, created by the createStudent callable, which sets its own
        // claims and document. Touching it here would race that callable.
        return;
      }

      if (decision.action === 'reject') {
        functionsV1.logger.warn('Rejected sign-up', {
          uid: user.uid,
          email: decision.email,
          reason: decision.reason,
        });
        try {
          await getAuth().deleteUser(user.uid);
        } catch (e) {
          // An earlier delivery of this event removed it, and said so.
          if ((e as { code?: string }).code === 'auth/user-not-found') return;
          throw e;
        }
        await countRejected(user.uid, decision.email, decision.reason);
        return;
      }

      const { claims, profile } = decision;

      // Delivered AT LEAST once. A second delivery, after an admin had approved
      // the colleague, set them back to pending and back in the queue. So the
      // claims are set only on an account that has none, and the directory row
      // is created, never overwritten: a row already there means an earlier
      // delivery provisioned the account, and an admin may have acted since.
      //
      // Claims BEFORE the mirror document. The token is what rules trust, so if
      // the second write failed we would have a user who can do nothing (pending
      // grants nothing) rather than one with a document but no claims — which the
      // client would misread as approved-but-broken.
      if ((await getAuth().getUser(user.uid)).customClaims?.role === undefined) {
        await getAuth().setCustomUserClaims(user.uid, claims);
      }

      const doc: StaffUserDoc = {
        displayName: profile.displayName,
        email: profile.email,
        photoUrl: profile.photoUrl,
        role: 'manager',
        status: 'pending',
        createdAt: Date.now(),
      };
      try {
        await getFirestore().collection(COLLECTIONS.staffUsers).doc(user.uid).create(doc);
      } catch (e) {
        if ((e as { code?: number }).code === ALREADY_EXISTS) return;
        throw e;
      }

      functionsV1.logger.info('Provisioned pending staff account', {
        uid: user.uid,
        email: profile.email,
      });
      await writeAudit({
        at: Date.now(),
        actorUid: user.uid,
        actorRole: 'system',
        action: 'authProvision',
        courseId: null,
        targets: { uid: user.uid },
        detail: { email: profile.email, status: 'pending' },
      });
    } catch (e) {
      // Provisioning failures are invisible (no caller) yet security-relevant —
      // a botched claims/delete leaves an account in a wrong state.
      await reportError(e, { source: 'onUserCreate' });
      throw e;
    }
  });
