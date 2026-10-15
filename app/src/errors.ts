/**
 * What to put on screen when something a person asked for did not happen.
 *
 * THE SENTENCES THIS CODEBASE WROTE GET THROUGH; MACHINE TOKENS DO NOT. The
 * callables here carry real messages — "The due date for this recording has
 * passed.", "Only an admin can disable an account." — and those are exactly what
 * the person needs to read. A callable that throws without one surfaces its CODE
 * in the message's place instead, so the staff app rendered a full-width error
 * band whose entire text was `INTERNAL`, on a screen that then also offered
 * "widen your filters" as if the request had merely found nothing.
 *
 * Three shapes are turned away:
 *
 *  - a bare code, which has no spaces in it (`internal`, `unauthenticated`);
 *  - the Firebase SDK's own assembled string, `Firebase: <something>
 *    (service/code).`, which has spaces but is a library talking to a developer.
 *    Staff resending a password link were reading `Firebase: Error
 *    (auth/user-not-found).` off the screen;
 *  - an Expo native module's rejection, `Call to function '<Module.fn>' has
 *    been rejected. → Caused by: java.lang.…`. A student pressing "Take a
 *    photo" read a Java exception, class names and all.
 *
 * The raw value is logged either way, because it is the thing worth having in
 * Sentry.
 */
export function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const raw = (err?.message ?? '').trim();
  // Offline, or the service down. Firestore says it in a sentence of its own
  // ("Failed to get document because the client is offline."), which would
  // otherwise pass the test below as one of ours.
  //
  // A callable that never got an answer is said the same way. The Functions
  // SDK reports a dropped connection as `internal`, in lower case, because
  // fetch failed before any response: a function that ran and failed sends
  // its own status, `INTERNAL`, in the body.
  if (
    err?.code === 'unavailable' ||
    err?.code === 'functions/unavailable' ||
    (err?.code === 'functions/internal' && raw === 'internal')
  ) {
    console.warn('request failed', err.code);
    return 'Cannot reach the server. Check your connection and try again.';
  }
  // `Firebase:` and `Firebase Storage:` alike — the Storage SDK assembles
  // "Firebase Storage: User does not have permission to access
  // 'recordings/<id>/audio.m4a'. (storage/unauthorized)", which a manager whose
  // upload was refused was reading off the screen, object path and all.
  if (raw && /\s/.test(raw) && !/^(Firebase(\s\w+)?:|Call to function ')/.test(raw)) return raw;
  console.warn('request failed', err?.code || raw || 'unknown');
  return 'Something went wrong. Try again in a moment.';
}

/**
 * What a listener reads when the MEDIA itself fails: audio or video, so it
 * names neither.
 *
 * The transport's own words are a code — `media error 2` from the web
 * element, "Source error" or "Response code: 400" from the native player — and they
 * were shown verbatim in the player's error band, while the mint failure two
 * lines away went through `errorText`. One sentence for a person, the raw
 * value logged for Sentry, like every other failure.
 */
export function audioErrorText(raw: string): string {
  console.warn('audio failed', raw || 'unknown');
  return 'The recording could not be loaded. Check your connection and try again.';
}
