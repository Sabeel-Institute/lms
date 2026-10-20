import type * as SentryNode from '@sentry/node';

// Server error reporting. The DSN is a SECRET (server-side, not shipped to any
// client) — set with `firebase functions:secrets:set SENTRY_DSN`. It reaches a
// function only when that function declares the secret (see reported.ts), so
// `process.env.SENTRY_DSN` is undefined everywhere else, including the emulator,
// where this stays a silent no-op.

/**
 * LOADED AT THE FIRST REPORT, NOT AT START-UP. @sentry/node was more than half
 * of a function's module load (about 300 of 560 ms), paid by every cold start,
 * which a person waits through, though most instances never report anything.
 */
let sentry: Promise<typeof SentryNode> | null = null;

function started(): Promise<typeof SentryNode> | null {
  const dsn = process.env.SENTRY_DSN;
  // A real DSN is an https URL. Anything else — unset, or the `disabled`
  // sentinel that `functions/.secret.local` uses so the emulator stops probing
  // Secret Manager — leaves reporting off without letting a bad value reach
  // Sentry.init (which throws on a malformed DSN).
  if (!dsn || !dsn.startsWith('https://')) return null;
  sentry ??= import('@sentry/node').then((S) => {
    S.init({
      dsn,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: {
          request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
          response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        },
        httpBodies: [],
        urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
      },
    });
    return S;
  });
  return sentry;
}

/**
 * Report an unexpected error, then FLUSH — a Cloud Functions instance can freeze
 * the moment the handler returns, so an un-flushed event is lost. Awaited by the
 * wrapper before the error propagates. Never throws: a report that fails must
 * not stand in for the error it was reporting.
 */
export async function reportError(e: unknown, context?: Record<string, string>): Promise<void> {
  const loading = started();
  if (!loading) return;
  try {
    const S = await loading;
    S.captureException(e, context ? { tags: context } : undefined);
    await S.flush(2000);
  } catch (failed) {
    sentry = null;
    console.error('error report failed', failed);
  }
}
