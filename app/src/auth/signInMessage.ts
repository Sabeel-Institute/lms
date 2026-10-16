import { SIGN_IN_REFUSED, SIGN_UP_REFUSED } from '@sabeel/shared';
import { errorText } from '../errors';

/**
 * What a person is told when the app refuses their account at the door: a
 * Google account outside the staff domain. The sign-up gate refuses it before
 * the account exists (`auth/internal-error`, below); the auth trigger, behind
 * it, deletes one that got past, and the screen shows this whether that
 * deletion landed inside the sign-in or a moment after it (`refused` on the
 * session).
 */
export const REFUSED_ACCOUNT = "That account can't sign in here. Staff use their Sabeel Google account.";

/** A disabled account, at the door or signed out by it (`ended: 'disabled'` on the session). Staff are disabled the same way, and a manager has no teacher to ask. */
export const DISABLED_ACCOUNT = 'That account has been disabled. Contact your teacher or an administrator.';

/** A wrong address or password; and a password sign-in refused at the door, said the same way. */
const NO_MATCH = 'That email and password do not match an account.';

/**
 * The sentence the sign-in screen shows for a failed attempt.
 *
 * Auth codes get the words a person needs; anything else goes through
 * `errorText`, which lets a real sentence through and turns a machine token
 * away. The token that matters here is the Google door's: `accountExists` is a
 * callable, and the functions SDK reports a server it could not reach as the
 * bare word `internal` — which is what this screen printed, in the error band,
 * to a colleague whose phone had simply lost signal between the Google chooser
 * and the exchange.
 */
export function signInMessage(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      // One message for all three: distinguishing them tells an attacker which
      // addresses are registered.
      return NO_MATCH;
    case 'auth/no-account':
      /*
       * NAMES NO WEBSITE, ON PURPOSE. The honest instruction — "sign in on the
       * website first" — is the exact sentence Play's second trigger forbids, and
       * saying it would oblige this app to ship an account-deletion flow. See
       * `google.ts`.
       */
      return "This account isn't set up for the app yet. Contact your administrator.";
    case 'auth/user-token-expired':
      /*
       * THE ACCOUNT WENT AS IT SIGNED IN. The auth trigger deletes an account
       * this app does not accept — a Google account outside the staff domain —
       * moments after it is created, and when that lands inside the sign-in
       * itself, this is how the sign-in fails. "Try again in a moment" sent the
       * person round the same loop.
       */
      return REFUSED_ACCOUNT;
    case 'auth/user-disabled':
      return DISABLED_ACCOUNT;
    case 'auth/account-exists-with-different-credential':
      /*
       * A STUDENT AT THE GOOGLE DOOR with their own address. The phone's
       * chooser has no domain filter; their address is verified once they set
       * a password, and Firebase then refuses a Google sign-in for it rather
       * than join the two. "Try again in a moment" could never work.
       */
      return 'Students sign in with their email address and password above.';
    case 'auth/internal-error': {
      // The gates' refusals travel inside this code's message; any other
      // internal error is not a door, and says so in its own words. A
      // password sign-in refused because the account is not a student's
      // (`beforeSignIn`) reads as a wrong password, and says nothing of why.
      const message = String((e as { message?: unknown }).message ?? '');
      if (message.includes(SIGN_IN_REFUSED)) return NO_MATCH;
      return message.includes(SIGN_UP_REFUSED) ? REFUSED_ACCOUNT : errorText(e);
    }
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection.';
    default:
      return errorText(e);
  }
}
