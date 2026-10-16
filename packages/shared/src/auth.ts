/** The Workspace domain staff sign in from. */
export const ALLOWED_EMAIL_DOMAIN = 'oursabeel.com';

/**
 * The words a refused sign-up carries out of the blocking function
 * (`functions/src/signUpGate.ts`), and the sign-in screen looks for. The
 * browser SDK reports every blocking refusal as `auth/internal-error`, with the
 * function's message inside its own; this is how the screen knows it is ours.
 */
export const SIGN_UP_REFUSED = 'SIGN_UP_REFUSED';

/**
 * The one address `bootstrapAdmin` will promote, and the account the emulator
 * dev sign-in row mints for its first admin.
 *
 * Shared because it must be the SAME address in both places, and it was not: the
 * function and the dev row each hardcoded their own local part, so correcting
 * the function to the real address left the e2e bootstrapping a user the
 * function would not promote. One constant, both consumers.
 */
export const FIRST_ADMIN_LOCAL_PART = 'faisal.shah';
export const FIRST_ADMIN_EMAIL = `${FIRST_ADMIN_LOCAL_PART}@${ALLOWED_EMAIL_DOMAIN}`;

/**
 * Roles, in one claim.
 *
 * `admin` and `manager` are staff; `student` is a learner. Deliberately a single
 * string rather than the sibling time-tracker's role + separate `admin` boolean:
 * nobody here is a manager *and* separately an admin, so one field cannot get
 * into an inconsistent pair.
 */
export type Role = 'admin' | 'manager' | 'student';

/**
 * `deleted` is a directory row's alone: the account it described is gone
 * (`deleteAccount`), and no token carries it.
 */
export type UserStatus = 'pending' | 'active' | 'disabled' | 'deleted';

/**
 * What security rules trust. Mirrored onto the user document for UI, but the
 * TOKEN is the authority — a stale or tampered mirror must never grant anything.
 */
export interface TokenClaims {
  role?: Role;
  status?: UserStatus;
}

/** Staff arriving via Google land here: signed in, permitted nothing. */
export const NEW_STAFF_ACCESS: { role: Role; status: UserStatus } = {
  role: 'manager',
  status: 'pending',
};

/**
 * Students are created by staff, so they arrive already approved — the approval
 * decision was the act of creating them.
 */
export const NEW_STUDENT_ACCESS: { role: Role; status: UserStatus } = {
  role: 'student',
  status: 'active',
};

/**
 * The staff domain gate.
 *
 * This must hold entirely on its own. The client `hd` parameter only filters the
 * Google account chooser and is trivially bypassed, and the OAuth consent screen
 * cannot be relied on either — "Internal" requires the project to belong to a
 * Cloud organization, which a personally-created project does not.
 *
 * `emailVerified` matters: an unverified address proves nothing about who owns
 * it, and Google will happily hand over an account with one.
 */
export function isAllowedStaffEmail(
  email: string | undefined | null,
  emailVerified: boolean,
): boolean {
  if (!email || !emailVerified) return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return email.slice(at + 1).toLowerCase().trim() === ALLOWED_EMAIL_DOMAIN;
}

export function isStaffRole(role: Role | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

/**
 * What the sign-in screen's "Email me a password link" answers, whatever the
 * address: an account or none, a student or staff. A different answer for an
 * address with an account would make the screen a way to test who has one
 * (`requestPasswordLink`).
 */
export const PASSWORD_LINK_ANSWER = 'If that address has a student account, a link is on its way.';
