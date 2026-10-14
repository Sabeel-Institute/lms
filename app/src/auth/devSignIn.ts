import {
  GoogleAuthProvider,
  signInWithCredential,
  type UserCredential,
} from 'firebase/auth';
import { ALLOWED_EMAIL_DOMAIN } from '@sabeel/shared';
import { auth } from '../firebase';
import { IS_DEV, USE_EMULATORS } from '../env';

/**
 * Emulator-only staff sign-in, so the app can be developed and SCREENSHOTTED
 * before the real Firebase project and OAuth clients exist.
 *
 * This is what makes authenticated verification possible at all. The sign-in
 * screen is the only screen an unauthenticated screenshot can reach, and it
 * exercises almost none of the app — a green sign-in shot is not evidence about
 * any other screen.
 *
 * MUST NEVER APPEAR IN A PRODUCTION BUILD. Two independent conditions gate it,
 * because either alone could be got wrong: a release build carrying a stale
 * emulator env, or a dev build pointed at production. Before publishing, export
 * the web bundle and grep it for the dev-row label to confirm it is absent.
 */
export const devSignInAvailable = IS_DEV && USE_EMULATORS;

/**
 * Signs in through the GOOGLE provider, not email/password.
 *
 * The Auth emulator accepts a JSON payload where a real Google ID token would
 * go, which mints a google.com identity with `email_verified: true`. That
 * fidelity is the point: email/password sign-up produces an UNVERIFIED address,
 * so a password-based dev path would be provisioned as a student — never
 * exercising the staff domain gate this is meant to test.
 *
 * Sign in with a non-org address and the sign-up gate refuses it before the
 * account exists, exactly as in production. That is intended, and a useful way
 * to watch the domain check work.
 */
export async function devSignIn(localPart: string): Promise<UserCredential> {
  if (!devSignInAvailable) {
    throw new Error('Dev sign-in is not available in this build.');
  }

  const email = localPart.includes('@') ? localPart : `${localPart}@${ALLOWED_EMAIL_DOMAIN}`;
  const displayName = email
    .split('@')[0]
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');

  return signInWithCredential(
    auth,
    GoogleAuthProvider.credential(
      JSON.stringify({ sub: `dev-${email}`, email, email_verified: true, name: displayName }),
    ),
  );
}
