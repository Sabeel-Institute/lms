import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { ALLOWED_EMAIL_DOMAIN, EMULATOR_PROJECT_ID, SIGN_IN_REFUSED, type Role } from '@sabeel/shared';
import { setBackgroundTriggers } from '../backgroundTriggers';

/*
 * ONLY A STUDENT SIGNS IN WITH A PASSWORD. Driven as anyone holding the
 * site's public key would: the Auth REST API against the Auth emulator, which
 * calls the blocking function the Functions emulator runs. The promise is in
 * whether a session comes back: a staff account that has come to have a
 * password, an admin's, or one with no role gets none; a student gets one.
 *
 * The accounts are made as production makes them, password-less through the
 * Admin SDK and then given one, which is the shape a followed reset link
 * leaves on a Google account. Background triggers are off while they are
 * made, so `onUserCreate` cannot take a just-passworded account for a
 * client-side sign-up and delete it under the test.
 */

beforeAll(async () => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
  await setBackgroundTriggers(false);
});
afterAll(async () => {
  await setBackgroundTriggers(true);
});

const AUTH = () => `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const PASSWORD = 'Correct-horse-9';

/** An account with a password and, if given, a role. */
async function withPassword(email: string, role: Role | null): Promise<void> {
  const existing = await getAuth().getUserByEmail(email).catch(() => null);
  if (existing) await getAuth().deleteUser(existing.uid);
  const user = await getAuth().createUser({ email, emailVerified: true });
  if (role) await getAuth().setCustomUserClaims(user.uid, { role, status: 'active' });
  await getAuth().updateUser(user.uid, { password: PASSWORD });
}

/** A password sign-in, as the students' form makes one: a session, or the refusal's words. */
async function signIn(email: string): Promise<{ session: boolean; message: string }> {
  const res = await fetch(`${AUTH()}/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const json = (await res.json()) as { idToken?: string; error?: { message?: string } };
  return { session: !!json.idToken, message: json.error?.message ?? '' };
}

describe('the sign-in gate', () => {
  it('signs a student in with their password', async () => {
    await withPassword('gate-student@example.com', 'student');
    expect(await signIn('gate-student@example.com')).toEqual({ session: true, message: '' });
  });

  it('refuses a staff account that has a password, with nothing that says why', async () => {
    await withPassword(`gate-manager@${ALLOWED_EMAIL_DOMAIN}`, 'manager');
    const res = await signIn(`gate-manager@${ALLOWED_EMAIL_DOMAIN}`);
    expect(res.session).toBe(false);
    expect(res.message).toContain(SIGN_IN_REFUSED);
    expect(res.message).not.toMatch(/student|staff|manager|not-a/i);
  });

  it('refuses an admin’s password, and an account with no role', async () => {
    await withPassword(`gate-admin@${ALLOWED_EMAIL_DOMAIN}`, 'admin');
    await withPassword('gate-nobody@example.com', null);
    expect((await signIn(`gate-admin@${ALLOWED_EMAIL_DOMAIN}`)).session).toBe(false);
    expect((await signIn('gate-nobody@example.com')).session).toBe(false);
  });
});
