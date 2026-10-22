import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The ORDER of two calls, which is the whole store exemption.
 *
 * `signInWithCredential` is the line that brings an account into existence. The
 * claim made to Apple and Google is that this app never reaches it for an
 * identity that has no account — so what is asserted here is that the call did
 * not happen, not that a message was returned. A refusal shown on screen while
 * the credential exchange ran anyway would look correct to a person and be a
 * false declaration to a store.
 *
 * `GoogleSignin.signIn()` is pure Google OAuth and touches nothing in the
 * Firebase project, which is the only reason there is a window to check in.
 *
 * Mocked at the module boundary rather than run against emulators because the
 * native Google SDK cannot run here at all; the callable's own behaviour is
 * covered in `functions/test/integration/accountExists.integration.test.ts`.
 */

const signIn = vi.fn();
const googleSdkSignOut = vi.fn(async (..._a: unknown[]) => undefined);
const signInWithCredential = vi.fn();
const callable = vi.fn();

vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: vi.fn(),
    hasPlayServices: vi.fn().mockResolvedValue(true),
    signIn: (...a: unknown[]) => signIn(...a),
    signOut: (...a: unknown[]) => googleSdkSignOut(...a),
  },
  statusCodes: { SIGN_IN_CANCELLED: 'CANCELLED', IN_PROGRESS: 'IN_PROGRESS' },
  isSuccessResponse: (r: unknown) => (r as { ok?: boolean })?.ok === true,
}));

vi.mock('firebase/auth', () => ({
  signInWithCredential: (...a: unknown[]) => signInWithCredential(...a),
  GoogleAuthProvider: { credential: (t: string) => ({ token: t }) },
}));

vi.mock('firebase/functions', () => ({
  httpsCallable: () => (...a: unknown[]) => callable(...a),
}));

vi.mock('../firebase', () => ({ auth: {}, functions: {} }));
vi.mock('../firebase-config', () => ({ WEB_CLIENT_ID: 'web-client-id' }));

const { signInWithGoogle } = await import('./google');

beforeEach(() => {
  vi.clearAllMocks();
  signIn.mockResolvedValue({ ok: true, data: { idToken: 'tok' } });
  // `googleSignOut()` calls `.catch()` on this, so it must be a promise.
  googleSdkSignOut.mockResolvedValue(undefined);
});

describe('the native Google door', () => {
  it('never exchanges the credential when no account exists', async () => {
    callable.mockResolvedValue({ data: { exists: false } });

    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth/no-account' });

    // THE ASSERTION THE EXEMPTION RESTS ON.
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it('clears the remembered Google account on refusal, so another can be tried', async () => {
    // Without this, `signIn()` silently reuses the account just refused and the
    // person can never switch — the refusal becomes a dead end rather than a
    // retry, on the one screen where retrying is the only thing to do.
    callable.mockResolvedValue({ data: { exists: false } });

    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth/no-account' });

    expect(googleSdkSignOut).toHaveBeenCalled();
  });

  it('clears the remembered Google account when the server cannot answer, so a retry opens the chooser', async () => {
    callable.mockRejectedValue(Object.assign(new Error('internal'), { code: 'functions/internal' }));

    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'functions/internal' });

    expect(signInWithCredential).not.toHaveBeenCalled();
    expect(googleSdkSignOut).toHaveBeenCalledTimes(1);
  });

  it('clears it too when the exchange itself fails', async () => {
    callable.mockResolvedValue({ data: { exists: true } });
    signInWithCredential.mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'auth/network-request-failed' }));

    await expect(signInWithGoogle()).rejects.toMatchObject({ code: 'auth/network-request-failed' });

    expect(googleSdkSignOut).toHaveBeenCalledTimes(1);
  });

  it('signs in normally once an account exists', async () => {
    callable.mockResolvedValue({ data: { exists: true } });

    await expect(signInWithGoogle()).resolves.toBeUndefined();

    expect(callable).toHaveBeenCalledWith({ idToken: 'tok' });
    expect(signInWithCredential).toHaveBeenCalledTimes(1);
  });

  it('asks before it exchanges, not after', async () => {
    // Ordering stated as an assertion rather than left to the reading of the
    // function: a refactor that hoisted the exchange would still satisfy every
    // other test here.
    const order: string[] = [];
    callable.mockImplementation(async () => {
      order.push('asked');
      return { data: { exists: true } };
    });
    signInWithCredential.mockImplementation(async () => {
      order.push('exchanged');
    });

    await signInWithGoogle();

    expect(order).toEqual(['asked', 'exchanged']);
  });

  it('treats backing out of the chooser as nothing happening', async () => {
    signIn.mockResolvedValue({ ok: false });

    await expect(signInWithGoogle()).resolves.toBeUndefined();

    expect(callable).not.toHaveBeenCalled();
    expect(signInWithCredential).not.toHaveBeenCalled();
  });
});
