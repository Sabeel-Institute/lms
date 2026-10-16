import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_WEB_CLIENT_ID } from '@sabeel/shared';
import { isEmulatorProject } from './env';
import { reportedCall } from './reported';

/**
 * Does an account already exist for the holder of this Google token?
 *
 * THE PHONE APPS MUST NEVER CREATE AN ACCOUNT. Not a preference: both stores
 * require in-app account DELETION only if an app *supports account creation* —
 * Apple 5.1.1(v), and Play, which also triggers if the app "directs the user to
 * an app account creation flow outside of the app". Satisfy neither trigger and
 * neither requirement is engaged, which is what lets this app ship without a
 * deletion flow that would have to decide what happens to a student's academic
 * record when they delete themselves. Records are retained, on institutional
 * and contractual grounds. `docs/STORE-RELEASE.md` is the decision record.
 *
 * `signInWithCredential` is the line that creates an account, so the native
 * sign-in path asks this first and never reaches that line for an identity with
 * no account. Creation happens on the WEB app only, where staff sign-in stays
 * self-service and the existing flow already is the creation flow.
 *
 * ONLY THE GOOGLE DOOR NEEDS THIS. A student signs in with email and password,
 * and `signInWithEmailAndPassword` cannot bring an account into existence — it
 * fails when there is none. `createUserWithEmailAndPassword` is the call that
 * would, and this app has never had it on any surface.
 *
 * UNAUTHENTICATED, necessarily — there is no session yet; establishing one is
 * the thing being gated. Safe here because the caller has already proved they
 * control the address by presenting a Google-signed token for it, so this is not
 * an oracle that can be pointed at an arbitrary email.
 *
 * It also cannot be done on the client: `fetchSignInMethodsForEmail` returns an
 * empty array for every project created after 15 September 2023, because email
 * enumeration protection is on by default. An Admin SDK callable is Firebase's
 * documented replacement.
 */

/**
 * Verifies GOOGLE's ID token, not Firebase's.
 *
 * `getAuth().verifyIdToken()` is the wrong tool and fails confusingly here: it
 * verifies tokens FIREBASE issued (`iss: securetoken.google.com/<project>`), and
 * what arrives at this callable is issued by `accounts.google.com` for the OAuth
 * client — because the user has not signed in to Firebase yet, which is the
 * entire point.
 */
const oauth = new OAuth2Client();

/**
 * The address this token belongs to, or `null` if it proves nothing.
 *
 * The emulator branch exists because no test can mint a Google-signed token, and
 * it mirrors what `devSignIn.ts` already does on the client — the Auth emulator
 * accepts a plain JSON payload where a real ID token would go, so tests and dev
 * sign-in speak the same dialect.
 *
 * Keyed off `isEmulatorProject()`, which reads the running project id rather
 * than an env flag a shell could carry into a deploy.
 */
async function verifiedEmail(idToken: string): Promise<string | null> {
  if (isEmulatorProject()) {
    // THROWS on unreadable input rather than returning null, so the emulator
    // branch rejects a garbage token exactly as production does. Swallowing it
    // into `exists: false` would make the two halves of this seam disagree, and
    // the tests would then assert behaviour that only exists in tests.
    const payload = JSON.parse(idToken) as { email?: string; email_verified?: boolean };
    return payload.email_verified === true && payload.email ? payload.email : null;
  }

  // Pinning the audience is what stops a token minted for a DIFFERENT OAuth
  // client being replayed here. Without it any valid Google token would pass.
  const ticket = await oauth.verifyIdToken({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
  const payload = ticket.getPayload();
  // An unverified address proves nothing about who holds it, so it can never be
  // matched against an account.
  return payload?.email_verified === true && payload.email ? payload.email : null;
}

/**
 * The core, separated from its `onCall` wrapper so the tests can drive it: the
 * wrapper needs a live functions runtime, this does not. Same reason every other
 * callable in this codebase is split the same way.
 */
export async function checkAccountExists(idToken: unknown): Promise<{ exists: boolean }> {
  if (typeof idToken !== 'string' || idToken === '') {
    throw new HttpsError('invalid-argument', 'A Google ID token is required.');
  }

  let email: string | null;
  try {
    email = await verifiedEmail(idToken);
  } catch {
    // Deliberately opaque, and deliberately not reported: a bad token is an
    // ordinary thing for a public endpoint to receive, not an incident.
    throw new HttpsError('unauthenticated', 'That sign-in could not be verified.');
  }
  if (!email) return { exists: false };

  try {
    await getAuth().getUserByEmail(email);
    return { exists: true };
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/user-not-found') {
      return { exists: false };
    }
    // Anything else is a real failure. Returning `false` here would tell a
    // legitimate colleague their account is gone because Auth had a bad minute,
    // so it must surface rather than be swallowed.
    throw e;
  }
}

export const accountExists = reportedCall(async (request: CallableRequest) =>
  checkAccountExists((request.data as { idToken?: unknown } | null)?.idToken),
);
