import { describe, it, beforeAll, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { ALLOWED_EMAIL_DOMAIN, EMULATOR_PROJECT_ID, SIGN_UP_REFUSED } from '@sabeel/shared';

/*
 * THE DOOR HOLDS BEFORE ANY ACCOUNT EXISTS. Driven the way an outsider would:
 * the public Auth REST API with the site's key, against the Auth emulator,
 * which calls the blocking function the Functions emulator runs. The promise
 * is in what is left behind, not in an error code: a refused sign-up leaves
 * no account at all, and a colleague's first Google sign-in still makes one.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;

async function rest(method: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${AUTH}/${method}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  return { ok: res.ok, message: json.error?.message ?? '' };
}

const passwordSignUp = (email: string) => rest('accounts:signUp', { email, password: 'hunter2hunter2', returnSecureToken: true });

/** A first Google sign-in as the emulator takes one: an unsigned ID token. */
const googleSignIn = (email: string, verified: boolean) =>
  rest('accounts:signInWithIdp', {
    requestUri: 'http://localhost',
    postBody: `id_token=${encodeURIComponent(JSON.stringify({ sub: `g-${email}`, email, email_verified: verified }))}&providerId=google.com`,
    returnSecureToken: true,
    returnIdpCredential: true,
  });

const accountFor = (email: string) =>
  getAuth()
    .getUserByEmail(email)
    .then(
      (u) => u.uid,
      () => null,
    );

describe('the sign-up gate', () => {
  it('refuses a password sign-up, and no account is made', async () => {
    const email = `stranger-${Date.now()}@example.com`;
    const res = await passwordSignUp(email);
    expect(res.ok).toBe(false);
    expect(res.message).toContain(SIGN_UP_REFUSED);
    expect(await accountFor(email)).toBeNull();
  });

  it('refuses a Google account off the staff domain, and no account is made', async () => {
    const email = `outsider-${Date.now()}@gmail.com`;
    const res = await googleSignIn(email, true);
    expect(res.ok).toBe(false);
    expect(res.message).toContain(SIGN_UP_REFUSED);
    expect(await accountFor(email)).toBeNull();
  });

  it('lets a colleague’s first Google sign-in make their account', async () => {
    const email = `colleague-${Date.now()}@${ALLOWED_EMAIL_DOMAIN}`;
    const res = await googleSignIn(email, true);
    expect(res).toMatchObject({ ok: true, message: '' });
    expect(await accountFor(email)).not.toBeNull();
  });
});
