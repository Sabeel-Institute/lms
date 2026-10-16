import { NEW_STAFF_ACCESS, isAllowedStaffEmail } from '@sabeel/shared';
import type { Role, TokenClaims, UserStatus } from '@sabeel/shared';

/**
 * The decision half of new-user provisioning, kept pure so every branch can be
 * tested exhaustively without an emulator or the Admin SDK. `authTrigger.ts`
 * performs the effects.
 *
 * This app has TWO auth populations, which is what makes it differ from the
 * sibling kanban app (whose trigger deletes anything not on the org domain — a
 * rule that here would delete every student):
 *
 *  - Google sign-in is STAFF. Domain-gated, and lands pending.
 *  - Email/password is a STUDENT, and can only be minted by the Admin SDK from
 *    the createStudent callable, which sets claims and writes the document
 *    itself. The trigger must keep its hands off, or it races that callable.
 *  - Anything else is deleted.
 */

export type RejectReason = 'bad-domain' | 'unsupported-provider' | 'self-signup';

export type ProvisionDecision =
  | {
      action: 'reject';
      reason: RejectReason;
      email: string | null;
    }
  | { action: 'ignore'; reason: 'admin-sdk-provisioned' }
  | {
      action: 'provision';
      claims: { role: Role; status: UserStatus };
      profile: { email: string; displayName: string; photoUrl: string | null };
    };

export interface NewUser {
  email?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  providerIds: string[];
}

export function decideProvision(user: NewUser): ProvisionDecision {
  const { email, emailVerified = false, providerIds } = user;

  // A legitimate student has NO PROVIDER AT ALL at creation time.
  //
  // That is not an edge case, it is the normal path: `createStudent` creates the
  // user without a password so the student can set their own from the emailed
  // link, and a password-less Admin-SDK user has empty providerData until one is
  // set. Reading that as an unknown provider deleted every student account
  // moments after it was created, and the failure looked intermittent because it
  // depended on trigger timing.
  //
  // An email is what separates that case from an anonymous sign-in, which also
  // has no provider data but never has an address.
  if (providerIds.length === 0) {
    return email
      ? { action: 'ignore', reason: 'admin-sdk-provisioned' }
      : { action: 'reject', reason: 'unsupported-provider', email: null };
  }

  // ...and therefore a `password` provider AT CREATION means a client-side
  // sign-up, which no legitimate flow in this app performs. Reject it.
  //
  // This branch used to return 'ignore', on the assumption that client-side
  // sign-up was disabled in the console. It cannot be: that setting
  // (`client.permissions.disabledUserSignup`) blocks ALL client account
  // creation including a staff member's first Google sign-in, which fails with
  // `auth/admin-restricted-operation` before this trigger ever runs. Staff
  // self-onboarding and disabled sign-up are mutually exclusive, so the guard
  // has to live here instead — where it can tell the two populations apart.
  //
  // Note onCreate does not fire again when a student later sets their password,
  // so a real student is never seen with this provider.
  if (providerIds.includes('password')) {
    return { action: 'reject', reason: 'self-signup', email: email ?? null };
  }

  if (!providerIds.includes('google.com')) {
    return { action: 'reject', reason: 'unsupported-provider', email: email ?? null };
  }

  // The staff domain gate, and the only one that counts. The client `hd` hint
  // merely filters the account chooser, and the consent screen cannot be relied
  // on either — "Internal" needs the project to be in a Cloud organization.
  if (!isAllowedStaffEmail(email, emailVerified)) {
    return { action: 'reject', reason: 'bad-domain', email: email ?? null };
  }

  return {
    action: 'provision',
    claims: { ...NEW_STAFF_ACCESS },
    profile: {
      email: email as string,
      // Fall back to the local part rather than showing an empty row in the
      // approval queue — admins approve people by name and address.
      displayName: user.displayName?.trim() || (email as string).split('@')[0],
      photoUrl: user.photoURL ?? null,
    },
  };
}

/**
 * THE DOOR, BEFORE ANY ACCOUNT EXISTS: what the blocking `beforeUserCreated`
 * asks of every sign-up made from a client. One is legitimate here, a
 * colleague's first Google sign-in on the staff domain. Students are made by
 * staff through the Admin SDK, which no blocking function sees, so a password
 * sign-up is always someone holding the site's public key. Null lets it in.
 *
 * The same verdicts as `decideProvision`, which stays behind the door for
 * anything that gets past it.
 */
export function refusedSignUp(
  providerId: string | null,
  email: string | null | undefined,
  emailVerified: boolean,
): RejectReason | null {
  if (providerId === 'password') return 'self-signup';
  if (providerId !== 'google.com') return 'unsupported-provider';
  if (!isAllowedStaffEmail(email, emailVerified)) return 'bad-domain';
  return null;
}

/**
 * THE STUDENTS' DOOR TAKES STUDENTS: what the blocking `beforeUserSignedIn`
 * asks of every sign-in. A password sign-in is for a student, and for nobody
 * else. Staff sign in with Google; an account with no role has no business
 * with a password. A staff account can come to have one: a reset link sent
 * to a staff address and followed adds a password to the Google account, and
 * signing in with it would skip Google's own sign-in protections. Google
 * sign-ins pass, as they always have. Null lets it in.
 */
export function refusedSignIn(providerId: string | null, claims: TokenClaims | undefined): 'not-a-student' | null {
  if (providerId === 'password' && claims?.role !== 'student') return 'not-a-student';
  return null;
}
