import { beforeUserCreated, HttpsError } from 'firebase-functions/v2/identity';
import { logger } from 'firebase-functions/v2';
import { REGION, SIGN_UP_REFUSED } from '@sabeel/shared';
import { refusedSignUp } from './provision';

/**
 * REFUSED BEFORE THE ACCOUNT EXISTS (Faisal's choice, 2026-10-14). The auth
 * trigger refuses the same sign-ups, but only after Firebase has made the
 * account: for about two seconds it existed, could ask the project to send a
 * verification email to an address of its choosing, and was removed with a
 * row in the history. Here nothing is made.
 *
 * Needs the project on Identity Platform; a blocking function will not deploy
 * to one that is not.
 *
 * The refusal reaches the browser as `auth/internal-error` with this message
 * inside the SDK's; `SIGN_UP_REFUSED` is how the sign-in screen tells it from
 * any other internal error and says the sentence a person can act on.
 *
 * WHAT IT DOES NOT CLOSE: a sign-up for an address that already has an account
 * is answered "already exists" before any function runs, so anyone holding the
 * public key can still ask whether an address has an account here. Closing that
 * would mean switching sign-up off, which also stops a colleague's first
 * Google sign-in; Faisal chose to keep self sign-up (2026-10-14).
 */
export const beforeSignUp = beforeUserCreated({ region: REGION }, (event) => {
  const refused = refusedSignUp(
    event.additionalUserInfo?.providerId ?? null,
    event.data?.email,
    event.data?.emailVerified ?? false,
  );
  if (!refused) return;
  logger.warn('Refused sign-up', { reason: refused, email: event.data?.email ?? null });
  throw new HttpsError('permission-denied', `${SIGN_UP_REFUSED}: ${refused}`);
});
