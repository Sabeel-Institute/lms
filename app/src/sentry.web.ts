// Web side of the error-reporting seam (native sibling: sentry.ts).
//
// Reports only from a real (non-dev) bundle: `expo export` sets __DEV__ false, so
// the deployed web app reports while `expo start` and the e2e/test runs stay on
// the console. Without that gate every local run would pollute the production
// Sentry project. The DSN is a client value baked in at build time (see
// app/.env.local); if it is absent the seam is a silent console-only no-op.
import type * as SentryBrowser from '@sentry/browser';
import { IS_DEV, USE_EMULATORS } from './env';
import { BUILD_LABEL } from './buildInfo';
import { withoutIds } from './withoutIds';
import { minimalEnvelope } from './sentryEnvelope';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN_WEB;
// Off for a build pointed at the emulators too: the web suite drives the
// export `sabeel-ci build-web --emulators` makes, which takes the DSN from
// .env.local, and would otherwise file its test errors into production.
const ENABLED = !!DSN && !IS_DEV && !USE_EMULATORS;

/*
 * LOADED AT THE FIRST REPORT, NOT AT START-UP. @sentry/browser was a fifth of
 * the web bundle (632 KB, 133 KB compressed), fetched and parsed on every page
 * load, on every phone, for a library most visits never call. It is its own
 * file now, fetched when there is something to report.
 *
 * Until then this module's own listeners stand where Sentry's would: an error
 * that reaches the top of the page is reported through `captureError`, and
 * Sentry's global handlers stay off, so nothing is reported twice once it has
 * loaded.
 */
let sentry: Promise<typeof SentryBrowser> | null = null;
let role = 'none';

function loaded(): Promise<typeof SentryBrowser> {
  sentry ??= import('@sentry/browser').then((S) => {
    // `release` is the sign-in screen's own label — version and commit — so an
    // event says which build produced it. Three WEB-4 incidents arrived without
    // one, and the first question about each was "which build was that?".
    S.init({
      dsn: DSN,
      tracesSampleRate: 0,
      environment: 'production',
      release: BUILD_LABEL,
      integrations: (defaults) => defaults.filter((i) => i.name !== 'GlobalHandlers'),
      // NOBODY NAMED, as the privacy policy says: a staff page's address holds
      // a student's account id, and the SDK sends the address, and the page
      // it came from, with every event.
      beforeSend: (event) => {
        if (event.request) event.request = event.request.url ? { url: withoutIds(event.request.url) } : {};
        return event;
      },
      beforeBreadcrumb: (crumb) => {
        const data = crumb.data;
        if (data) {
          for (const key of ['url', 'from', 'to']) {
            if (typeof data[key] === 'string') data[key] = withoutIds(data[key]);
          }
        }
        return crumb;
      },
    });
    S.setTag('role', role);
    return S;
  });
  return sentry;
}

let started = false;

export function initSentry(): void {
  if (started || !ENABLED) return;
  started = true;
  window.addEventListener('error', (ev) => captureError(ev.error ?? new Error(ev.message)));
  window.addEventListener('unhandledrejection', (ev) => captureError(ev.reason));
}

/**
 * The account's ROLE on every event from here on — never who they are.
 *
 * The privacy policy promises that crash reports carry no name, no email
 * address and no account identifier, and that this is enforced in the code:
 * `functions/test/unit/sentryIdentity.test.ts` holds that line. A role is not
 * an identity, and it is the one fact that tells a refused admin read from a
 * refused manager read when the two share a listener label.
 */
export function setSentryRole(next: string | null): void {
  if (!ENABLED) return;
  role = next ?? 'none';
  // Only once it has loaded: until then the role waits here, and goes on with
  // the first report.
  void sentry?.then((S) => S.setTag('role', role)).catch(() => undefined);
}

export function captureError(
  e: unknown,
  context?: Record<string, string>,
  extra?: Record<string, unknown>,
): void {
  if (!ENABLED) {
    console.warn('captureError', context ?? {}, extra ?? {}, e);
    return;
  }
  // `fingerprint`, when the caller sets one, groups the event by what it
  // names rather than by the reporting frame; everything else in `extra`
  // rides along as event data.
  const { fingerprint, ...rest } = extra ?? {};
  loaded()
    .then((S) => {
      S.captureException(e, {
        ...(context ? { tags: context } : {}),
        ...(Object.keys(rest).length ? { extra: rest } : {}),
        ...(Array.isArray(fingerprint) ? { fingerprint: fingerprint as string[] } : {}),
      });
    })
    // NEVER A REJECTION OF ITS OWN: the listener above reports unhandled
    // rejections, so a file that failed to load (offline) would report its
    // own failure, which would load it again. The next report tries afresh,
    // and this one goes the short way.
    .catch(() => {
      sentry = null;
      console.error('captureError: Sentry could not be loaded', e);
      fallback(e, context);
    });
}

/**
 * The report without the library: a tab opened before a deploy asks for the
 * old build's Sentry file, which has gone, and every error it met after that
 * was dropped. Offline, this fails too, quietly; nothing else would get out.
 */
function fallback(e: unknown, context?: Record<string, string>): void {
  const envelope = minimalEnvelope(DSN as string, {
    error: e,
    release: BUILD_LABEL,
    role,
    page: window.location.href,
    tags: context,
    eventId: crypto.randomUUID().replace(/-/g, ''),
    now: Date.now(),
  });
  if (envelope) void fetch(envelope.url, { method: 'POST', body: envelope.body, keepalive: true }).catch(() => undefined);
}
