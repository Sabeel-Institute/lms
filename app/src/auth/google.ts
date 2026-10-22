import {
  GoogleSignin,
  statusCodes,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';
import { GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { WEB_CLIENT_ID } from '../firebase-config';
import { auth, functions } from '../firebase';

/**
 * Staff Google sign-in on Android (web sibling: google.web.ts).
 *
 * Uses the native Google Sign-In SDK to obtain an ID token, then exchanges it
 * for a Firebase credential — the same signInWithCredential path devSignIn
 * exercises, so everything downstream of the session is identical.
 *
 * Requires BOTH of these, or Google returns an opaque DEVELOPER_ERROR that looks
 * like a code bug and is not:
 *  - the debug/release SHA-1 registered on the Firebase Android app, with
 *    `google-services.json` RE-DOWNLOADED afterwards — the re-download is what
 *    adds the `client_type: 1` entry; adding the SHA-1 in the console does not
 *    update a file you already have;
 *  - `webClientId` set to the WEB client id (client_type: 3), not the Android one.
 */
let configured = false;
function ensureConfigured() {
  if (configured) return;
  GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
  configured = true;
}

/**
 * Clear the remembered Google account.
 *
 * Without this the next signIn() silently reuses the previous account with no
 * way to switch users — on a shared or handed-over device that is the difference
 * between signing out and only appearing to.
 */
/** The web's redirect sign-in failure (google.web.ts); a phone signs in without a redirect. */
export const redirectFailure: Promise<unknown> = Promise.resolve(null);

export async function googleSignOut(): Promise<void> {
  ensureConfigured();
  await GoogleSignin.signOut().catch(() => undefined);
}

const accountExists = httpsCallable<{ idToken: string }, { exists: boolean }>(
  functions,
  'accountExists',
);

/** Refused because no account exists — `messageFor` turns this into the copy. */
class NoAccountError extends Error {
  readonly code = 'auth/no-account';
  constructor() {
    super('No account for that sign-in.');
    this.name = 'NoAccountError';
  }
}

/**
 * THIS APP DOES NOT CREATE ACCOUNTS, AND MUST NOT LEARN HOW.
 *
 * `signInWithCredential` is the line that would create one, so nothing may reach
 * it until an account is known to exist. `GoogleSignin.signIn()` above it is
 * pure Google OAuth — it yields a token and touches nothing in this Firebase
 * project — which is the only reason there is a window to check in.
 *
 * There is deliberately no sign-up affordance anywhere in this app, and the
 * refusal names no website. Both stores stop requiring in-app account deletion
 * only while the app neither creates an account nor points at somewhere that
 * does, and "sign in on the website first" is the second of those two triggers
 * stated almost verbatim. The real instruction belongs in the onboarding email,
 * out of band, where it does not count — at the cost of one support question per
 * new colleague. Read `docs/STORE-RELEASE.md` before adding anything
 * friendlier here.
 *
 * This file is the NATIVE half of the seam. `google.web.ts` is the web half and
 * keeps creating accounts, which is why nothing here has to detect a platform.
 */
export async function signInWithGoogle(): Promise<void> {
  ensureConfigured();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return; // user backed out
    const idToken = response.data.idToken;
    if (!idToken) throw new Error('Google returned no ID token.');

    try {
      const { data } = await accountExists({ idToken });
      if (!data.exists) throw new NoAccountError();
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch (e) {
      // Google still remembers the chosen account, and `signIn()` would silently
      // reuse it. After any failed exchange the next tap must open the chooser
      // again: somebody who picked the wrong account could otherwise never
      // switch, and somebody whose sign-in the server could not answer would
      // retry into the same failure with no chooser to show the tap did
      // anything (2026-10-22, when every function stopped starting).
      await googleSignOut();
      throw e;
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Cancelling is not an error — see the web sibling for why this matters.
    if (code === statusCodes.SIGN_IN_CANCELLED || code === statusCodes.IN_PROGRESS) return;
    throw e;
  }
}
