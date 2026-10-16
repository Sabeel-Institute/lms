/**
 * Smoke checks against the DEPLOYED site. Run after every hosting deploy:
 *
 *     npm run smoke:prod
 *
 * These are the things the emulator suite structurally cannot tell you, because
 * every one of them is about the production bundle and the real project:
 * whether Hosting serves the auth handler, whether the shipped bundle talks to
 * production rather than an emulator, and whether dev-only UI leaked into it.
 *
 * Deliberately unauthenticated — it stops at the sign-in screen. Signing in
 * needs a real Google account, so anything past that is a human step. This is a
 * DEPLOY check, not a security suite; rules are covered by the emulator tests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { FIREBASE_PROJECT_ID as PROJECT_ID, WEB_APP_URL } from '@sabeel/shared';

const BASE = process.env.SMOKE_BASE ?? WEB_APP_URL.replace(/\/$/, '');
const ROOT = new URL('..', import.meta.url).pathname;

const fails = [];
function check(condition, message) {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    fails.push(message);
    console.log('  FAIL ' + message);
  }
}

// Hosting must serve /__/auth/* itself. That is the entire reason authDomain
// points at the hosting domain: it keeps the sign-in redirect same-origin, which
// storage-partitioned in-app webviews require.
const handler = await fetch(`${BASE}/__/auth/handler`);
check(handler.ok, `/__/auth/handler -> ${handler.status}`);

const init = await (await fetch(`${BASE}/__/firebase/init.json`)).json();
check(init.projectId === PROJECT_ID, `init.json projectId ${init.projectId}`);

/*
 * THE THREE PAGES A STORE REVIEWER READS, fetched the way they will fetch them:
 * anonymously, with no session and no JavaScript.
 *
 * The failure this catches is a rewrite ordering mistake, and it is silent: `**`
 * rewrites everything to the SPA, so a `/privacy` that lands after it answers
 * 200 with the app shell. Status alone therefore proves nothing — what is
 * asserted is that the POLICY is in the body and the app shell is not.
 * Apple 5.1.1(i) and Play both hang off this actually answering.
 */
for (const [path, marker] of [
  ['/privacy', 'Privacy Policy'],
  ['/support', 'Support'],
  ['/get-app', 'Get the app'],
]) {
  /*
   * RETRIED, because these three race a deploy and nothing else here does.
   * Until the first deploy that added them, `**` sent these paths to the app
   * shell, and the edge goes on serving that for a few seconds after a release
   * completes — measured on 2026-09-07, all three failed immediately after a
   * deploy and passed a minute later. Reported once as a rewrite fault, that
   * reads as a config bug and sends you to firebase.json, which is correct.
   *
   * Bounded and short so a genuine fault still fails: a rewrite behind the
   * catch-all, or a destination file nobody exported, does not start working
   * after twenty seconds. `hostingPages.test.ts` catches both of those before a
   * deploy anyway.
   */
  let ok = false;
  let sawShell = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
    const body = await res.text();
    sawShell = body.includes('/_expo/static/js/web/');
    ok = res.ok && body.includes(marker) && !sawShell;
  }
  check(
    ok,
    `${path} answers anonymously with the static page` +
      (sawShell ? ' — got the app shell, so the rewrite is behind the catch-all' : ''),
  );
}

/*
 * A BUILD'S FILE THAT IS GONE IS A 404, and every other address is the app.
 * A tab opened before a deploy asks for the old build's files; answered with
 * the shell, it ran HTML as JavaScript and its error reports stopped.
 */
{
  const gone = await fetch(`${BASE}/_expo/static/js/web/gone-0000000000000000.js`, { cache: 'no-store' });
  check(gone.status === 404, `a build file that is not there answers 404 (got ${gone.status})`);
  const deep = await fetch(`${BASE}/courses/not-a-course`, { cache: 'no-store' });
  // Never inside another site's frame: a signed-in admin's clicks steered by a page over it.
  check(deep.headers.get('x-frame-options') === 'DENY', `the app refuses to be framed (x-frame-options ${deep.headers.get('x-frame-options')})`);
  // Except Firebase's own sign-in frame, which the app itself frames: denied,
  // Google sign-in would stop working.
  const authFrame = await fetch(`${BASE}/__/auth/iframe`, { cache: 'no-store' });
  check(
    authFrame.ok && !authFrame.headers.get('x-frame-options') && !/frame-ancestors/.test(authFrame.headers.get('content-security-policy') ?? ''),
    `the sign-in frame can still be framed (${authFrame.status}, x-frame-options ${authFrame.headers.get('x-frame-options')})`,
  );
  check(deep.ok && (await deep.text()).includes('/_expo/static/js/web/'), 'a deep link still answers with the app');
}

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
const hosts = new Set();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => {
  try {
    hosts.add(new URL(r.url()).host);
  } catch {
    // Non-http requests (data:, blob:) are not interesting here.
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
const body = await page.locator('body').innerText();

// A bundle that fails to boot renders a blank white page, and every check below
// would pass vacuously against it.
const rendered = /sign in/i.test(body);
check(rendered, `sign-in screen rendered${rendered ? '' : ` (body: ${body.slice(0, 120)})`}`);

/*
 * THE BUILD THAT IS LIVE IS THE BUILD THIS CHECKOUT SAYS IT IS. The label on
 * the sign-in screen is `v<version> · <commit>`; the version comes from
 * `app/app.json` and the commit from `git rev-parse` at export. A deploy from
 * a stale checkout, a bump that was never committed, or an export that ran
 * before the bump all show up here as a label that does not match HEAD —
 * which is otherwise only noticed when a bug report names the wrong build.
 * Override with SMOKE_EXPECT_COMMIT when checking a deploy made from
 * elsewhere.
 */
const version = JSON.parse(readFileSync(`${ROOT}app/app.json`, 'utf8')).expo.version;
const commit =
  process.env.SMOKE_EXPECT_COMMIT ??
  execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
const expectedLabel = `v${version} · ${commit}`;
// Retried on the same bounded schedule as the static pages: the edge serves
// the previous index.html for a few seconds after a deploy, and this runs
// right after one. A wrong build does not become right by waiting.
let label = '';
for (let attempt = 0; attempt < 5 && label !== expectedLabel; attempt += 1) {
  if (attempt > 0) {
    await new Promise((r) => setTimeout(r, 5000));
    await page.goto(BASE, { waitUntil: 'networkidle' });
  }
  label = (await page.getByTestId('build-label').innerText().catch(() => '')).trim();
}
check(label === expectedLabel, `build label reads ${expectedLabel} (saw "${label}")`);

/*
 * The check this script exists for. A production bundle built with the emulator
 * flag still set looks completely normal until someone tries to sign in — and
 * an idle sign-in screen makes NO Auth request at all (`connectAuthEmulator`
 * only sets config), so "no emulator host contacted" was true of every bundle.
 * Provoke one request the way a person would, with no side effect: a password
 * link for an address that exists nowhere sends nothing (enumeration
 * protection), but the SDK still has to talk to SOMEBODY, and which host that
 * is decides the question.
 */
await page.getByTestId('signin-email').fill('smoke-probe@invalid.example');
await page.getByRole('button', { name: /password link/i }).click();
await page.waitForTimeout(4000);
const authHosts = [...hosts].filter((h) => /identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/.test(h));
check(authHosts.length > 0, `Auth request went to Google (${authHosts.join(', ') || 'no Auth request seen'})`);
const localHosts = [...hosts].filter((h) => /127\.0\.0\.1|localhost|10\.0\.2\.2/.test(h));
check(
  localHosts.length === 0,
  `no emulator hosts contacted${localHosts.length ? `: ${localHosts.join(', ')}` : ''}`,
);

// Grepping the bundle for this proves nothing — strings survive minification.
// It has to be shown not to RENDER. The rows are `dev-signin-<who>`; an exact
// `dev-signin` matched nothing in any bundle, so this passed on all of them.
const devRows = await page.getByTestId(/^dev-signin/).count();
check(devRows === 0, 'dev sign-in row absent');

const googleButtons = await page.getByRole('button', { name: /google/i }).count();
check(googleButtons > 0, 'Google (staff) sign-in offered');

check(
  errors.length === 0,
  `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
);

/*
 * SOURCE MAPS ARE NOT SERVED. `web-release.mjs` strips them after the Sentry
 * upload; Hosting then answers a `.map` URL with the SPA rewrite — `text/html`
 * — rather than the map. The status is 200 either way, so it is the content
 * type that says which. The bundle's own script URL names the file to ask for.
 */
const bundleSrc = await page
  .locator('script[src*="/_expo/static/js/web/"]')
  .first()
  .getAttribute('src')
  .catch(() => null);
if (bundleSrc) {
  const mapRes = await fetch(new URL(`${bundleSrc}.map`, BASE), { cache: 'no-store' });
  const type = mapRes.headers.get('content-type') ?? '';
  check(/text\/html/.test(type), `the bundle's .map is not served (content-type ${type || 'none'})`);
  /*
   * NO NATIVE-ONLY WEIGHT. react-native-keyboard-controller has no web side,
   * and imported on the web it brought all of Reanimated: 22% of the bundle,
   * fetched and run on every load for nothing (KeyboardRoot.web.tsx).
   */
  const bundle = await (await fetch(new URL(bundleSrc, BASE))).text();
  const nativeOnly = ['Reanimated', 'KeyboardControllerView'].filter((marker) => bundle.includes(marker));
  check(nativeOnly.length === 0, `the bundle carries no native-only libraries${nativeOnly.length ? ` (found ${nativeOnly.join(', ')})` : ''}`);
} else {
  check(false, 'found the bundle script tag, to ask for its .map');
}

/*
 * EVERY CALLABLE ANSWERS FOR ITSELF. A callable needs the public invoker on its
 * Cloud Run service; without it Cloud Run's front end refuses every call with
 * an HTML 401 before the code runs. A deploy that created one without it
 * (signRecordingUploadParts, 2026-10-13) broke every staff upload on the live
 * site, and nothing else looked wrong. Signed out, a callable answers JSON (its
 * own "Sign in required.", or a refusal of the empty request); Cloud Run's
 * refusal is HTML. The callables are read from the functions' index.
 */
const NOT_CALLABLES = new Set([
  'copyZoomFile', // the copy queue's, private by design: only the queue's account calls it
  'sweepAbandonedUploads', // scheduled
  'bootstrapAdmin', // the emulator's only
  'beforeSignUp', // the sign-up gate: Identity Platform calls it, the app never does
  'beforeSignIn', // the sign-in gate, the same
]);
const indexSrc = readFileSync(`${ROOT}functions/src/index.ts`, 'utf8');
const exported = [
  ...[...indexSrc.matchAll(/export\s*\{([^}]*)\}/gs)].flatMap((m) =>
    m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop().trim()),
  ),
  ...[...indexSrc.matchAll(/^export const (\w+)/gm)].map((m) => m[1]),
].filter(Boolean);
const callables = exported.filter((n) => !/^on[A-Z]/.test(n) && !NOT_CALLABLES.has(n));
const unanswered = [];
await Promise.all(
  callables.map(async (name) => {
    const r = await fetch(`https://us-central1-${PROJECT_ID}.cloudfunctions.net/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"data":{}}',
    });
    const type = r.headers.get('content-type') ?? '';
    if (!/json/.test(type)) unanswered.push(`${name} (${r.status} ${type.split(';')[0] || 'no type'})`);
  }),
);
check(
  unanswered.length === 0,
  `every callable answers for itself, ${callables.length} asked${unanswered.length ? `; Cloud Run refused ${unanswered.join(', ')}` : ''}`,
);

await page.screenshot({ path: 'e2e-shots/prod-01-signin.png', fullPage: true });
await browser.close();

console.log(fails.length ? `\n${fails.length} check(s) FAILED` : '\nall production checks passed');
process.exit(fails.length ? 1 : 0);
