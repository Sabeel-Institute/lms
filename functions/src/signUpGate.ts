import { beforeUserCreated, beforeUserSignedIn, HttpsError } from 'firebase-functions/v2/identity';
import { logger } from 'firebase-functions/v2';
import { REGION, SIGN_IN_REFUSED, SIGN_UP_REFUSED, type TokenClaims } from '@sabeel/shared';
import { refusedSignIn, refusedSignUp } from './provision';

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

/**
 * ONLY A STUDENT SIGNS IN WITH A PASSWORD (2026-10-16). Refused here, at the
 * auth layer, so no client path and no future screen can open the students'
 * door to staff: a password on a staff account, however it got there, signs
 * nobody in (`refusedSignIn`). Students, the store reviewer among them, sign
 * in as before; Google sign-ins are untouched.
 *
 * The refusal carries `SIGN_IN_REFUSED` and nothing else: the sign-in screen
 * shows its wrong-password sentence for it, and the reason stays in the log,
 * by account, never by address.
 *
 * Like `beforeSignUp`, it needs the project on Identity Platform, and works
 * only once deployed and registered as the project's beforeSignIn trigger
 * (`docs/DEPLOY.md`). It does not run for a sign-in with a custom token or
 * on a token refresh, so a session already open is ended by disabling the
 * account, as ever.
 */
export const beforeSignIn = beforeUserSignedIn({ region: REGION }, (event) => {
  const refused = refusedSignIn(event.additionalUserInfo?.providerId ?? null, event.data?.customClaims as TokenClaims | undefined);
  if (!refused) return;
  logger.warn('Refused sign-in', { reason: refused, uid: event.data?.uid ?? null });
  throw new HttpsError('permission-denied', SIGN_IN_REFUSED);
});
