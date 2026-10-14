import {
  browserPopupRedirectResolver,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { ALLOWED_EMAIL_DOMAIN } from '@sabeel/shared';
import { auth } from '../firebase';
import { captureError } from '../sentry';

/**
 * Staff Google sign-in on the web (native sibling: google.ts). Works against the
 * Auth emulator too — the popup shows the emulator's fake account chooser.
 *
 * `hd` restricts the account chooser to the Workspace domain. It is a UX
 * convenience ONLY — trivially bypassed, never treated as a check. The real
 * enforcement is the auth-create Cloud Function.
 *
 * Each call names `browserPopupRedirectResolver`: Auth is started without it
 * (`authInit.web.ts`), so a phone does not wait for Google's iframe before it
 * knows who is signed in.
 */

/**
 * A failed signInWithRedirect surfaces ONLY here, on the page load after the
 * bounce back. Without this call the user lands on the sign-in screen again with
 * no error shown and nothing recorded anywhere.
 */
getRedirectResult(auth, browserPopupRedirectResolver).catch((e) => captureError(e, { source: 'redirectSignIn' }));

export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_EMAIL_DOMAIN, prompt: 'select_account' });

  try {
    await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (e) {
    const code = (e as { code?: string }).code;

    // Popups are routinely blocked inside the in-app browsers people actually
    // arrive from — a link tapped in WhatsApp or Slack opens a webview, not the
    // system browser. Falling back to a full-page redirect is what makes those
    // arrivals work at all.
    if (
      code === 'auth/popup-blocked' ||
      code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
      return;
    }

    // Changing your mind is not a failure. Closing the popup, or opening a
    // second one that supersedes the first, raises these — reporting them would
    // fill the error stream with people deciding not to sign in, which is how a
    // stream stops being read and the real reports get missed.
    if (
      code === 'auth/popup-closed-by-user' ||
      code === 'auth/cancelled-popup-request' ||
      code === 'auth/user-cancelled'
    ) {
      return;
    }

    throw e;
  }
}

/** No native Google session to clear on the web; Firebase sign-out is enough. */
export async function googleSignOut(): Promise<void> {}
