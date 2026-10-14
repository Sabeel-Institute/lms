// Native side of the error-reporting seam (web sibling: sentry.web.ts).
//
// Same discipline as web: report only from a non-dev bundle, so debug builds and
// Metro dev runs stay console-only and never pollute the production Sentry
// project. The DSN is a client value from app/.env.local, baked into the release
// bundle; absent, this is a silent console-only no-op.
//
// `@sentry/react-native` links a native module via RN autolinking (no prebuild
// needed for capture). Source-map upload — which needs a Sentry auth token and
// the Gradle plugin — is deferred; until then, release stack traces are
// minified but the errors do report.
import * as Sentry from '@sentry/react-native';
import { IS_DEV } from './env';
import { BUILD_LABEL } from './buildInfo';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN_ANDROID;
const ENABLED = !!DSN && !IS_DEV;
let started = false;

export function initSentry(): void {
  if (started || !ENABLED) return;
  // `release` is the sign-in screen's own label — version and commit — so an
  // event says which build produced it; ANDROID-3 was a student on a build
  // from 12 August, and the release is how that was known at all.
  Sentry.init({ dsn: DSN, tracesSampleRate: 0, release: BUILD_LABEL });
  started = true;
}

/** The account's role on every event from here on — never who they are; see
 *  the web sibling and `functions/test/unit/sentryIdentity.test.ts`. */
export function setSentryRole(role: string | null): void {
  if (!ENABLED) return;
  initSentry();
  Sentry.setTag('role', role ?? 'none');
}

export function captureError(
  e: unknown,
  context?: Record<string, string>,
  extra?: Record<string, unknown>,
): void {
  if (ENABLED) {
    initSentry();
    // `fingerprint`, when the caller sets one, groups the event by what it
    // names rather than by the reporting frame; everything else in `extra`
    // rides along as event data.
    const { fingerprint, ...rest } = extra ?? {};
    Sentry.captureException(e, {
      ...(context ? { tags: context } : {}),
      ...(Object.keys(rest).length ? { extra: rest } : {}),
      ...(Array.isArray(fingerprint) ? { fingerprint: fingerprint as string[] } : {}),
    });
  } else {
    console.warn('captureError', context ?? {}, extra ?? {}, e);
  }
}
