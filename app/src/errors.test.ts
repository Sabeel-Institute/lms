import { describe, expect, it, vi } from 'vitest';
import { audioErrorText, errorText } from './errors';

/**
 * What a person reads when something fails.
 *
 * Every case here is a real shape one of this app's own dependencies produces,
 * transcribed from what they actually build: `FunctionsError` sets `message` to
 * the description with no prefix, and `@firebase/util`'s `ErrorFactory` builds
 * `Firebase: <message> (<service>/<code>).`
 */
const GENERIC = 'Something went wrong. Try again in a moment.';

describe('errorText', () => {
  it('passes a callable’s own sentence straight through', () => {
    expect(errorText(new Error('The due date for this recording has passed.'))).toBe(
      'The due date for this recording has passed.',
    );
  });

  /*
   * A callable that throws without a message surfaces its CODE in the message's
   * place — which is how `INTERNAL` came to be the entire text of a full-width
   * error band in the staff app.
   */
  it.each(['internal', 'unauthenticated', 'permission-denied', 'INTERNAL'])(
    'turns the bare code %s into a sentence',
    (code) => {
      const e = Object.assign(new Error(code), { code: `functions/${code}` });
      expect(errorText(e)).toBe(GENERIC);
    },
  );

  /*
   * OFFLINE. Firestore's own sentence for it, "Failed to get document because
   * the client is offline.", has spaces and no prefix, so it went through to a
   * student's player as written.
   */
  it('says plainly that the server cannot be reached', () => {
    const offline = Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
    expect(errorText(offline)).toBe('Cannot reach the server. Check your connection and try again.');
    expect(errorText(Object.assign(new Error('unavailable'), { code: 'functions/unavailable' }))).toBe(
      'Cannot reach the server. Check your connection and try again.',
    );
  });

  it('turns away the SDK talking to a developer', () => {
    const e = Object.assign(new Error('Firebase: Error (auth/user-not-found).'), {
      code: 'auth/user-not-found',
    });
    expect(errorText(e)).toBe(GENERIC);
  });

  it('turns away the Storage SDK too, object path and all', () => {
    const e = Object.assign(
      new Error(
        "Firebase Storage: User does not have permission to access 'recordings/abc/audio.m4a'. (storage/unauthorized)",
      ),
      { code: 'storage/unauthorized' },
    );
    expect(errorText(e)).toBe(GENERIC);
  });

  it('turns away a native module talking to a developer', () => {
    const e = new Error(
      "Call to function 'ExponentImagePicker.launchCameraAsync' has been rejected.\n" +
        '→ Caused by: java.lang.IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher',
    );
    expect(errorText(e)).toBe(GENERIC);
  });

  it('gives a listener a sentence for an audio failure, and logs the code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['audio error 2', 'Source error', 'Response code: 400']) {
      const text = audioErrorText(raw);
      expect(text).not.toContain(raw);
      expect(text).toMatch(/could not be loaded/);
    }
    expect(warn).toHaveBeenCalledWith('audio failed', 'audio error 2');
    warn.mockRestore();
  });

  it.each([undefined, null, {}, 'a string throw', new Error('')])(
    'has an answer for %s',
    (thrown) => {
      expect(errorText(thrown)).toBe(GENERIC);
    },
  );

  it('logs the raw value, whatever it was', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorText(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    expect(warn).toHaveBeenCalledWith('request failed', 'functions/internal');
    warn.mockClear();
    // No code, no message — the log still says something rather than nothing.
    errorText({});
    expect(warn).toHaveBeenCalledWith('request failed', 'unknown');
    warn.mockRestore();
  });
});
