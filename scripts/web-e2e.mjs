#!/usr/bin/env node
/**
 * End-to-end walkthrough against the web dev server and the emulator suite.
 *
 * Exists because a sign-in screenshot is evidence about nothing else — it is the
 * only screen an unauthenticated script can reach, and it exercises almost none
 * of the app. This drives the real flows and screenshots the authenticated
 * screens, so a phase can be verified without re-deriving the same manual clicks
 * every time.
 *
 * Model: Cohort → Course → Session → Recording. A session owns attendance
 * (present/absent/excused). Being marked EXCUSED is the whole of a student's
 * entitlement: it grants the recording and requires listening to it, once the
 * recording is published AND attendance has been submitted, and it lapses when
 * the session's due date passes. Present and absent grant nothing. There is no
 * "catch-up" concept — a student enrolled after a session's attendance snapshot
 * is simply never in it (enrollment-onward).
 *
 * Prerequisites (see docs/DEV-TOOLING.md):
 *   firebase emulators:start --project demo-sabeel-recordings --only firestore,auth,storage,functions
 *   cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web --port 61311 --clear
 *
 * Then: npm run test:e2e
 *
 * SCOPE: this exercises real user FLOWS end to end. It is not a security suite —
 * most screens only query what the user may see, so a widened rule can leave
 * every screen looking correct. Authorization is asserted in
 * functions/test/integration/rules.*.test.ts, which are mutation-tested.
 *
 * Screenshots land in e2e-shots/ (gitignored). LOOK AT THEM — correct values in
 * palette.ts survive right up until you read the rendered screen.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readXlsx } from '@sabeel/shared';
import { EMULATOR_PORTS, WEB_PORTS } from './lib/ports.mjs';
import { EMULATOR_PROJECT_ID } from './lib/project.mjs';

const WEB = process.env.E2E_WEB ?? `http://127.0.0.1:${WEB_PORTS.e2e}/`;
const FN = `http://127.0.0.1:${EMULATOR_PORTS.functions}/${EMULATOR_PROJECT_ID}/us-central1`;
const FS = `http://127.0.0.1:${EMULATOR_PORTS.firestore}`;
const FS_READ = `${FS}/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
const FS_WIPE = `${FS}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
const AUTH = `http://127.0.0.1:${EMULATOR_PORTS.auth}`;
const SHOTS = 'e2e-shots';
const AUDIO_FIXTURE = process.env.E2E_AUDIO ?? 'e2e-shots/test-lecture.m4a';
/** The fixture's length, shared by the generator below and the metadata check,
 *  so the two cannot drift. A substitute supplied via E2E_AUDIO must match it. */
const AUDIO_SECONDS = 720;

/**
 * A real 12-minute 32 kbps mono M4A — the shape of an actual class recording
 * (a two-hour one lands near 29 MB at this bitrate).
 *
 * GENERATED rather than committed: a 3 MB binary in git is exactly what this
 * repo's "never add a binary" rule exists to prevent, and ffmpeg reproduces it
 * identically in a second.
 */
function ensureAudioFixture() {
  if (existsSync(AUDIO_FIXTURE)) return;
  try {
    execFileSync('ffmpeg', [
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${AUDIO_SECONDS},volume=0.3`,
      '-c:a', 'aac', '-b:a', '32k', '-ac', '1', AUDIO_FIXTURE, '-y',
    ], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `Could not generate ${AUDIO_FIXTURE}. Install ffmpeg, or point E2E_AUDIO at a ` +
        `${AUDIO_SECONDS}-second audio file (it must live OUTSIDE ${SHOTS}/, which this ` +
        'suite wipes on startup).',
    );
  }
}

const failures = [];
/**
 * Assert the thing the step above waited for is ON SCREEN.
 *
 * These lines used to read `check(name, true)`. The run did fail when the step
 * failed — the `waitFor` throws — but the line printed as a pass whatever
 * happened, and the summary counted thirteen passes no predicate had produced.
 * A reader scanning the transcript for what this suite proves was reading
 * thirteen sentences backed by nothing.
 */
const shows = (page, testId) =>
  page
    .getByTestId(testId)
    .filter({ visible: true })
    .first()
    .isVisible()
    .catch(() => false);

/** The same, for a screen identified by its words rather than a test id. */
const showsText = (page, text) =>
  page
    .getByText(text, { exact: false })
    .filter({ visible: true })
    .first()
    .isVisible()
    .catch(() => false);

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/**
 * Start from nothing. Leftover emulator state silently SKIPS the paths that
 * matter — a first run left an admin behind, and every later run then jumped
 * straight past the pending screen while still reporting success.
 */
async function reset() {
  for (const [what, url] of [
    ['firestore', FS_WIPE],
    ['auth', `${AUTH}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`],
  ]) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(`could not clear ${what}: ${r.status}`);
  }
}

/**
 * Out-of-band read; 'Bearer owner' bypasses rules deliberately.
 *
 * EVERY PAGE. The REST list answers thirty documents at a time and says so with
 * a `nextPageToken`, which this ignored — so once a run wrote its thirty-first
 * audit entry the audit assertions read an arbitrary thirty of them, and which
 * actions were "missing" changed from run to run.
 */
async function readCollection(name) {
  const out = [];
  let token = '';
  do {
    const url = `${FS_READ}/${name}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
    const j = await r.json();
    out.push(...(j.documents ?? []));
    token = j.nextPageToken ?? '';
  } while (token);
  return out;
}

const activeAssignments = async () =>
  (await readCollection('assignments')).filter((a) => a.fields.active?.booleanValue === true);

/**
 * Set one field on one document, out of band.
 *
 * Used to plant a due date already in the past, which no callable will do — the
 * whole point of the validators is that a deadline can only BECOME past by the
 * passage of time. The trigger still fires, so this exercises the real
 * reconcile rather than faking its output.
 */
async function patchField(name, docId, field, value, type = 'stringValue') {
  const url = `${FS_READ}/${name}/${docId}?updateMask.fieldPaths=${field}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [field]: { [type]: value } } }),
  });
  if (!r.ok) throw new Error(`patch ${name}/${docId} failed: ${r.status} ${await r.text()}`);
}

const browser = await chromium.launch();
const consoleErrors = [];

/**
 * Every live subscription that was ever refused, across every page in the run.
 *
 * `reportListenerError` emits `console.WARN`, so none of this reached
 * `consoleErrors` — three separate denials shipped in v0.3.0 while this suite
 * stayed green, because each one renders as an ordinary empty state and the
 * banner sits above the fold on screens the checks never read. A denial is
 * never correct in a flow the app itself drives, so collect them globally and
 * fail the run on any.
 */
const listenerDenials = [];

/** `who` tags the errors a page reports, so a 400 can be traced to the session
 *  that met it — the outsider's, whose account is deleted under it, is
 *  expected to see one; anybody else's is news. */
async function newSession(who) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${who}] ${m.text()}`);
    // Denials the app marks expected (a session ending) are excluded by design.
    if (m.type() === 'warning' && / listener\b/.test(m.text()) && !/expected/.test(m.text())) {
      listenerDenials.push(m.text());
    }
  });
  // TAGGED, because the two are not the same news. A `console.error` is the
  // Firebase SDK reporting something it handled; a `pageerror` is an exception
  // or an unhandled rejection that reached the top — a real defect, and one the
  // summary line used to render indistinguishably from the other.
  page.on('pageerror', (e) => consoleErrors.push(`[${who}] UNHANDLED: ${String(e)}`));
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  return page;
}

/**
 * Tap by testID — the VISIBLE one.
 *
 * `.filter({ visible: true })` is load-bearing, not decoration. React Navigation
 * keeps the screen you navigated away from MOUNTED, hidden with `display: none`,
 * and its test ids stay queryable — `getByTestId` is a plain attribute selector,
 * so unlike a role selector it matches straight into a hidden subtree. Without
 * the filter a locator can resolve to a control on the screen UNDERNEATH, which
 * will never become clickable; Playwright then retries for the full timeout and
 * the run dies at a step with nothing wrong with it. The sibling time-tracker's
 * equivalent suite was losing roughly one run in two to exactly this before it
 * was named, at clean HEAD.
 *
 * Note this is a stronger claim than the older advice in docs/DEV-TOOLING.md,
 * which said to prefer `getByTestId` over text locators. That does not help: a
 * test id matches hidden nodes just as happily. Only the visible filter excludes
 * the screen below.
 */
async function tap(page, testId, timeout = 20000) {
  const el = page.getByTestId(testId).filter({ visible: true }).first();
  await el.waitFor({ timeout });
  await el.click();
}

/** Same trap, same fix: `.first()` means document order, not "the one on screen". */
const sawText = (page, text, timeout = 20000) =>
  page
    .getByText(text, { exact: false })
    .filter({ visible: true })
    .first()
    .waitFor({ timeout });

/** Home by URL. Since the linking config landed the stack IS browser history,
 *  so goBack() works too — this goes to `/`, which is the Home path. */
async function goHome(page) {
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

/** Admin: Courses → Autumn 2026 → Hikam Foundations, from home. Reused a lot. */
async function openHikam(page) {
  await goHome(page);
  await tap(page, 'tab-courses');
  await tap(page, 'cohort-open-Autumn 2026');
  await tap(page, 'course-open-Hikam Foundations');
}

/**
 * Open one of the rows behind "More".
 *
 * Notification preferences, the audit history and sign out live in a sheet
 * rather than on a screen, so reaching them is two taps and the second one only
 * resolves once the sheet is up.
 */
async function more(page, option) {
  await tap(page, 'tab-more');
  await tap(page, option);
}

const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

/**
 * The screen's own H1 — what a pushed screen cannot share with the page before
 * it. By test id and visibility, not by role: the stack header's title is a
 * heading too, and the screens underneath keep theirs, hidden.
 */
const screenTitle = async (page) =>
  (await page.getByTestId('screen-title').filter({ visible: true }).first().innerText())
    .replace(/\s*›\s*$/, '')
    .trim();

/**
 * A page's visible text, with non-breaking punctuation normalised.
 *
 * Dates inside a sentence are rendered with non-breaking hyphens so a narrow
 * card cannot split "listen by 2026-" from "09-26" (`unbreakableDate`). They
 * look identical and read identically; they are simply not the characters an
 * assertion types. Normalising here keeps every check written the way a person
 * would write the date.
 */
const bodyText = async (page) =>
  (await page.locator('body').innerText()).replace(/\u2011/g, '-').replace(/\u00A0/g, ' ');

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
ensureAudioFixture();
await reset();

// ---------------------------------------------------------------- identity --
console.log('\nIdentity');
const admin = await newSession('admin');
await shot(admin, '01-signin');
check('sign-in screen renders', (await bodyText(admin)).includes('Sign in with Google'));

await tap(admin, 'dev-signin-first-admin');
await sawText(admin, 'Waiting for approval');
check(
  'first staff sign-in lands PENDING — domain membership grants nothing',
  await showsText(admin, 'Waiting for approval'),
);
await shot(admin, '02-pending');

const boot = await fetch(`${FN}/bootstrapAdmin`);
await admin.getByTestId('tab-courses').waitFor({ timeout: 30000 });
check('bootstrapAdmin promotes and the gate lifts LIVE, with no sign-out', boot.status === 200);
await shot(admin, '03-home-admin');

/*
 * A READY SESSION POLLS NOTHING.
 *
 * While an account is gated the app force-refreshes its token and re-reads the
 * profile every three seconds — that is how an approval is noticed at all, since
 * setting custom claims disrupts the in-flight listener. Once the gate lifts it
 * has to STOP, and it did not: the arming `else` bound to the push-registration
 * test, so every healthy session ran a forced token refresh plus a profile read
 * every three seconds for as long as it stayed open. Nothing on screen shows it,
 * which is why it is measured here rather than looked at.
 */
let tokenRefreshes = 0;
const countRefresh = (req) => {
  if (/securetoken|\/v1\/token/.test(req.url())) tokenRefreshes += 1;
};
admin.on('request', countRefresh);
await admin.waitForTimeout(9000);
admin.off('request', countRefresh);
check(
  'an approved session stops polling — no token refresh in nine idle seconds',
  tokenRefreshes === 0,
  `${tokenRefreshes} refresh(es); the gated poll runs every 3s, so a live one shows 3`,
);

const again = await fetch(`${FN}/bootstrapAdmin`);
check('bootstrapAdmin refuses a second call', again.status === 409);

// A second staff member, approved from the admin's session.
const mgr = await newSession('mgr');
await tap(mgr, 'dev-signin-manager');
await sawText(mgr, 'Waiting for approval');
await tap(admin, 'tab-people');
await tap(admin, 'segment-staff');
await tap(admin, 'approve-manager@oursabeel.com');
await mgr.getByTestId('tab-courses').waitFor({ timeout: 30000 });
check(
  'approving a pending manager un-gates THEIR session live',
  await shows(mgr, 'tab-courses'),
);

// An off-domain account must be deleted outright, not marked rejected.
const outsider = await newSession('outsider');
await tap(outsider, 'dev-signin-outsider');
/**
 * Wait for the TRANSITION, not for a duration.
 *
 * This used to sleep 6000ms and assert once, which made it load-sensitive: the
 * budget has to cover sign-in, the auth trigger running, the delete, and the
 * client re-rendering. Observed failing and passing on identical bytes, which is
 * how it was found — a check that returns both results from the same code is
 * evidence about the machine, not the app.
 *
 * The obvious repair — poll for 'Emulator sign-in' — does NOT work, and the
 * reason is worth keeping: that text is on the SIGN-IN screen, which is where
 * this starts. It is present before the click, so a wait for it succeeds
 * instantly against the pre-click state and asserts nothing at all. It is not a
 * landmark; its RETURN is.
 *
 * So: wait for the dev row to go (we left sign-in and are provisioning), then
 * for it to come back (the trigger deleted the account and dropped us out).
 * Both waits are tolerant, so a timeout surfaces as the assertion below failing
 * with the page's actual text rather than as an exception with none.
 */
const outsiderDevRow = outsider.getByText('Emulator sign-in', { exact: false }).first();
await outsiderDevRow.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
await outsiderDevRow.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
check(
  'an off-domain sign-in is deleted and lands back at sign-in',
  (await bodyText(outsider)).includes('Emulator sign-in'),
);

// A stranger self-registering with email/password must also be deleted.
//
// This is driven through the REST API rather than the UI because the app offers
// no sign-up control at all — which is exactly why it has to be tested this way:
// the absence of a button is not a control, and anyone can post to this
// endpoint with the public API key.
//
// It matters because the console setting that would block it
// (`disabledUserSignup`) cannot be used — it also blocks a staff member's first
// Google sign-in with `auth/admin-restricted-operation`. The trigger is the only
// thing standing here.
const strangerEmail = `stranger-${Date.now()}@example.com`;
const signUp = await fetch(
  `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: strangerEmail, password: 'hunter2hunter2', returnSecureToken: true }),
  },
);
check('a self-signup is not blocked at the door (so the trigger must catch it)', signUp.ok);

// Asserted by trying to USE the credential, not by listing accounts.
//
// The first version of this check polled the emulator's
// /emulator/v1/projects/*/accounts endpoint — which is DELETE-only, so the GET
// returned `{"message":"Method GET not allowed"}`, `userInfo` was undefined, and
// the check passed unconditionally. It survived a deliberate mutation of the
// rule it was written to protect, which is the only reason it was caught.
// Signing in cannot be vacuous: either the credential works or it does not.
let strangerDenied = '';
for (let i = 0; i < 20 && !strangerDenied; i++) {
  await outsider.waitForTimeout(1000);
  const r = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: strangerEmail, password: 'hunter2hunter2', returnSecureToken: true }),
    },
  );
  const body = await r.json();
  if (body.error) strangerDenied = body.error.message;
}
check(
  'a self-registered account is deleted — its credential stops working',
  strangerDenied === 'EMAIL_NOT_FOUND',
  strangerDenied || 'sign-in still succeeded',
);

// ------------------------------------------------------- academic structure --
console.log('\nAcademic structure');
await goHome(admin);
await tap(admin, 'tab-courses');
// Creating is a header action that opens a sheet, not a form pinned above the
// list — so every one of these is a tap before it is a fill. The sheet closes
// itself on success, which is what makes the next `waitFor` meaningful.
await tap(admin, 'cohorts-add');
await admin.getByTestId('cohort-name').fill('Autumn 2026');
await tap(admin, 'cohort-create');
await tap(admin, 'cohort-open-Autumn 2026');
for (const name of ['Hikam Foundations', 'Arabic I']) {
  await tap(admin, 'courses-add');
  await admin.getByTestId('course-name').fill(name);
  await tap(admin, 'course-create');
  await admin.getByTestId(`course-open-${name}`).waitFor({ timeout: 20000 });
}
// BOTH of them, and the cohort they are in: "two courses" is the claim.
check(
  'a cohort and two courses are created',
  (await shows(admin, 'course-open-Hikam Foundations')) &&
    (await shows(admin, 'course-open-Arabic I')),
);
await shot(admin, '04-courses');

// Rename the cohort from its own page. The field is seeded from the live
// document and the title reads the same document, so the heading follows the
// write without a reload — and the list, reached fresh, carries the new name.
// Renamed BACK afterwards, because every later step opens `Autumn 2026` by name.
await admin.getByTestId('cohort-rename').fill('Autumn 2026 — Term 1');
await tap(admin, 'cohort-rename-save');
await sawText(admin, 'Autumn 2026 — Term 1');
check('a cohort can be renamed, and its page follows the write live', await showsText(admin, 'Autumn 2026 — Term 1'));
await goHome(admin);
await tap(admin, 'tab-courses');
await admin.getByTestId('cohort-open-Autumn 2026 — Term 1').waitFor({ timeout: 20000 }).catch(() => {});
check(
  'the cohort list carries the new name',
  await shows(admin, 'cohort-open-Autumn 2026 — Term 1'),
);
await tap(admin, 'cohort-open-Autumn 2026 — Term 1');
await admin.getByTestId('cohort-rename').fill('Autumn 2026');
await tap(admin, 'cohort-rename-save');
// Exact, because the heading it replaces contains these words as a prefix.
await admin.getByText('Autumn 2026', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 20000 });
await goHome(admin);
await tap(admin, 'tab-courses');
await admin.getByTestId('cohort-open-Autumn 2026').waitFor({ timeout: 20000 });

// ------------------------------------------------------- browser history --
// Back used to leave the site: with no `linking` config React Navigation never
// touches history, so the whole app sat in one entry. Every screen now has a
// path, which also means the params must stay ids — a document param serialises
// to "[object Object]" in the URL and comes back as that string.
const path = () => new URL(admin.url()).pathname;
await goHome(admin);
await tap(admin, 'tab-courses');
check('navigating pushes a real URL', path() === '/cohorts', path());
await tap(admin, 'cohort-open-Autumn 2026');
await admin.waitForTimeout(1200);
const cohortUrl = admin.url();
check('a cohort is addressable', /^\/cohorts\/.+/.test(path()), path());
await tap(admin, 'course-open-Hikam Foundations');
await admin.waitForTimeout(1200);
const courseUrl = admin.url();
check('a course is addressable', /^\/courses\/.+/.test(path()), path());

await admin.goBack();
await admin.waitForTimeout(1500);
check('Back returns to the cohort rather than leaving the site', admin.url() === cohortUrl, path());
await admin.goForward();
await admin.waitForTimeout(1500);
check('Forward returns to the course', admin.url() === courseUrl, path());

// Cold-loading a deep URL must land on that screen, which only works because the
// screen resolves its documents from the id rather than a passed-in snapshot.
await admin.goto(courseUrl, { waitUntil: 'domcontentloaded' });
// The course page's own tabs, not a name the home screen lists as well.
await admin.getByTestId('nav-sessions').waitFor({ timeout: 20000 });
check(
  'a course URL opened cold renders that course',
  (await screenTitle(admin)) === 'Hikam Foundations',
  path(),
);
// A URL whose subject is gone must SAY so. The screens resolve their subject
// from the id, and a live document read is empty both while it is in flight and
// when there is nothing there — so without the resolved flag this spins for
// ever, which is what a student would see when a recording they had open is
// unpublished out from under them.
await admin.goto(`${WEB}courses/no-such-course-id`, { waitUntil: 'domcontentloaded' });
await admin.waitForTimeout(6000);
check(
  'a URL pointing at something deleted says so instead of loading for ever',
  (await bodyText(admin)).toLowerCase().includes('not available'),
);

// Leave the browser back on the cohort, where the next section starts from.
await admin.goto(cohortUrl, { waitUntil: 'domcontentloaded' });
await admin.waitForTimeout(3000);

// Scope ONE course to the manager.
//
// The toggle is asserted from the ADMIN's own screen, three times, because the
// screen used to render a CourseRow frozen at navigation time: the tick never
// moved (so the write looked like it had failed), and every toggle recomputed
// the manager list from that same pre-change array, so each one silently undid
// the last. Checking only that the manager ends up scoped would pass on the
// broken build — the first write does land. The third tap is what proves the
// list is live: computed from a stale array, "remove" sends the array that adds
// them, and they stay a manager forever.
await tap(admin, 'course-open-Hikam Foundations');
const mgrTick = admin.getByTestId('course-manager-manager@oursabeel.com');
const tickState = async () => {
  await admin.waitForTimeout(2500);
  return mgrTick.getAttribute('aria-checked');
};
await tap(admin, 'course-manager-manager@oursabeel.com');
check('assigning a manager ticks the row live, without leaving the screen', (await tickState()) === 'true');
await tap(admin, 'course-manager-manager@oursabeel.com');
check('un-assigning clears it — the next write reads the LIVE list', (await tickState()) === 'false');
await tap(admin, 'course-manager-manager@oursabeel.com');
check('re-assigning ticks it again', (await tickState()) === 'true');
await shot(admin, '05-course-detail');

await tap(mgr, 'tab-courses');
await mgr.getByTestId('course-open-Hikam Foundations').waitFor({ timeout: 20000 });
await mgr.waitForTimeout(1500);
// innerText returns only VISIBLE text, so retained nodes from the previous
// screen cannot make this pass spuriously.
const mgrSees = await bodyText(mgr);
// These two are UI checks, NOT security checks, and the distinction matters.
// useMyCourses() filters with array-contains in the QUERY, so this list would
// look correct even if the rule let any staff member read any course — verified
// by widening the rule and watching these still pass.
//
// The security boundary is asserted in functions/test/integration/
// rules.structure.test.ts, which IS mutation-tested against exactly that change.
check('the manager\'s course list shows the course they are scoped to', mgrSees.includes('Hikam Foundations'));
check('the manager\'s course list omits courses they are not scoped to', !mgrSees.includes('Arabic I'));
await shot(mgr, '06-my-courses');

// --------------------------------------------------------------- enrolment --
console.log('\nEnrolment');
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'students-add');
await admin.getByTestId('student-name').fill('Fatima Ahmed');
await admin.getByTestId('student-email').fill('fatima@example.com');
await tap(admin, 'student-course-Hikam Foundations');
await tap(admin, 'student-create');
await sawText(admin, 'Account created');
check(
  'a student is created and enrolled in one step',
  await showsText(admin, 'Account created'),
);
await shot(admin, '07-students');

await openHikam(admin);
await sawText(admin, 'Fatima Ahmed');
await admin.waitForTimeout(1200);
check('the roster shows the enrolled student', await showsText(admin, 'Fatima Ahmed'));
await shot(admin, '08-roster');

// The student sets a password from the emailed link and signs in. Redeemed
// through the same endpoint the SDK's confirmPasswordReset() calls, so this
// tests the real link rather than the emulator's own reset page markup.
const oob = await (await fetch(`${AUTH}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/oobCodes`)).json();
const reset0 = (oob.oobCodes ?? []).filter((c) => c.email === 'fatima@example.com').pop();
const redeem = await fetch(
  `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oobCode: reset0?.oobCode, newPassword: 'StudentPass123!' }),
  },
);
check('a set-password link is issued and redeemable', redeem.status === 200);

const student = await newSession('student');
await student.getByTestId('signin-email').fill('fatima@example.com');
await student.getByTestId('signin-password').fill('StudentPass123!');
await tap(student, 'signin-student');
// The student lands on their task home ("Your listening"), not a staff greeting.
await sawText(student, 'Your listening', 25000);
check('the student signs in with their own password', await showsText(student, 'Your listening'));
await shot(student, '09-home-student');

// ------------------------------------------------ session, attendance, publish --
console.log('\nSession, attendance, and the publish fan-out');
await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'sessions-add');
await admin.getByTestId('session-title').fill('Session 1');
await tap(admin, 'session-create');
// A create sheet that stays open covers the list it just added to — its
// backdrop swallows every tap, and the failure reads as "the row never
// appeared" rather than "the sheet never closed".
await admin.getByTestId('session-create').waitFor({ state: 'detached', timeout: 15000 });
check('a create sheet closes itself on success', !(await shows(admin, 'session-create')));
/*
 * THE WORK QUEUE, WITH SOMETHING BLOCKING ACCESS IN IT.
 *
 * A session exists whose attendance has not been submitted, which is exactly
 * the state Today ranks first and the only thing in the app that carries a
 * count on the navigation. Checked here, before attendance is taken, because
 * this is the one moment in the whole suite when that state exists.
 */
await goHome(admin);
await admin.getByTestId('tab-today-badge').waitFor({ timeout: 20000 });
const queueText = await bodyText(admin);
check(
  'Today counts a session whose attendance is not taken, and names it',
  (await admin.getByTestId('tab-today-badge').innerText()).trim() === '1' &&
    /attendance not taken/i.test(queueText) &&
    /Session 1/.test(queueText),
  queueText.replace(/\n+/g, ' | ').slice(0, 200),
);

await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');

// Take attendance: mark the enrolled student EXCUSED — the only mark that opens
// a recording to a student — and submit. Nobody is granted anything yet: there
// is no published recording.
await admin.getByTestId('att-Fatima Ahmed-excused').waitFor({ timeout: 15000 });
await tap(admin, 'att-Fatima Ahmed-excused');
await tap(admin, 'att-submit');
await admin.waitForTimeout(2000);
check(
  'submitting attendance before a recording exists grants nobody',
  (await activeAssignments()).length === 0,
);

// The queue is LIVE: the blocking row and its count go the moment the register
// is submitted, from a screen the reader is not even looking at. A badge that
// lingers over work already done is worse than no badge, which is why this is
// two listeners rather than a read on arrival.
await goHome(admin);
await admin.waitForTimeout(2500);
// A POSITIVE CONTROL WITH THE NEGATIVE. `count() === 0` alone passes if the bar
// failed to render, if the session signed out, or if the queue's listeners were
// refused — every way of breaking it looks like success.
check(
  'the blocking count clears once attendance is submitted',
  (await admin.getByTestId('tab-today').count()) === 1 &&
    (await admin.getByTestId('tab-today-badge').count()) === 0,
  (await bodyText(admin)).replace(/\n+/g, ' | ').slice(0, 160),
);
/*
 * A CLASS THAT WAS NOT RECORDED LEAVES THE QUEUE — and comes back if it was.
 *
 * Right here the session has its register in and no audio, which is the state
 * that used to be permanent: Today's "no recording yet" row has no expiry, and
 * the morning "attendance still not taken" message goes on regardless, so a
 * meeting nobody recorded stayed on the landing screen for the life of the
 * course. The only escape was deleting the session, which takes that day's
 * register with it.
 *
 * ASSERTED IN BOTH DIRECTIONS, from the queue rather than from the session page:
 * the row is what a manager sees every morning, and a control that changes a
 * field without changing the screen has fixed nothing.
 */
await goHome(admin);
const sessionOneId = (await readCollection('sessions')).find(
  (d) => d.fields.title?.stringValue === 'Session 1',
)?.name.split('/').pop();
check('the run knows which session it is asserting about', !!sessionOneId);
const queueRow = admin.getByTestId(`today-rec-${sessionOneId}`);
await queueRow.waitFor({ timeout: 20000 });
check('Today asks for the recording of a class that has met', await queueRow.isVisible());

await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');
await tap(admin, 'session-not-recorded');
await sawText(admin, 'This class was not recorded', 20000);
await goHome(admin);
await queueRow.waitFor({ state: 'detached', timeout: 20000 });
check(
  'marking it not recorded takes the row off Today',
  (await admin.getByTestId(`today-rec-${sessionOneId}`).count()) === 0,
);
await shot(admin, '10a-not-recorded');

// Reversible, and the upload below needs it back.
await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');
await tap(admin, 'session-recorded-after-all');
await sawText(admin, 'No recording yet', 20000);
await goHome(admin);
await queueRow.waitFor({ timeout: 20000 });
check('and "it was recorded after all" puts it back', await queueRow.isVisible());

// Back to the session — the upload continues from there.
await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');
await shot(admin, '10-attendance');

// Upload the recording to the session.
const chooser = admin.waitForEvent('filechooser');
await tap(admin, 'recording-upload');
await (await chooser).setFiles(AUDIO_FIXTURE);
// Listen appears only once `finalizeRecordingUpload` has recorded the audio
// path — the one signal on screen that the upload is complete. (This used to
// wait, with the failure swallowed, for a word the screen never shows.)
await admin.getByTestId('recording-listen').waitFor({ timeout: 90000 });
const recs = await readCollection('recordings');
const rf = recs[0]?.fields ?? {};
/*
 * Sized against the file that was actually uploaded, not a literal.
 *
 * This asserted `sizeBytes === '3049585'` — the exact byte count of one ffmpeg
 * build's output. That made the whole suite unrunnable anywhere ffmpeg is
 * missing: E2E_AUDIO is offered as the escape hatch two hundred lines up, and
 * any fixture you point it at fails here. Reading the fixture's own size keeps
 * the check strict — it still proves the app recorded the REAL file rather than
 * a default — while letting the documented escape hatch work.
 */
const fixtureBytes = statSync(AUDIO_FIXTURE).size;
check(
  'duration and size are recorded from the real file',
  rf.durationSec?.integerValue === String(AUDIO_SECONDS) &&
    rf.sizeBytes?.integerValue === String(fixtureBytes),
  `duration=${rf.durationSec?.integerValue} (want ${AUDIO_SECONDS}) ` +
    `size=${rf.sizeBytes?.integerValue} (fixture is ${fixtureBytes})`,
);
check('the recording is linked to its session', !!rf.sessionId?.stringValue);

// Publish it. The publish fan-out TRIGGER now sees a published recording AND a
// submitted attendance, so it grants the excused student. This is the one place
// the real onRecordingWritten runs (the integration tests exercise the logic).
await tap(admin, 'recording-published');
await admin.waitForTimeout(2500);
check(
  'publishing sets the status',
  (await readCollection('recordings'))[0].fields.status.stringValue === 'published',
);
let assignments = [];
for (let i = 0; i < 20 && assignments.length === 0; i++) {
  await admin.waitForTimeout(500);
  assignments = await activeAssignments();
}
check(
  'publishing fans out a grant to the EXCUSED student (real trigger)',
  assignments.length === 1,
  `${assignments.length} active assignment(s)`,
);
await shot(admin, '11-session-published');

// The student plays it. Same session that set its own password above.
// `next-up-`, not `task-`: the home screen promotes the most urgent recording
// still open to a hero card and drops it from the grouped list, so while this
// one is incomplete and in date it exists under that handle and no other.
await goHome(student);
await student.getByTestId('next-up-Session 1').waitFor({ timeout: 10000 });
await tap(student, 'next-up-Session 1');
await student.getByTestId('player-play').waitFor({ timeout: 25000 });
await student.waitForTimeout(1500);
check(
  'a student reaches the player for their required recording',
  await shows(student, 'player-play'),
);
await shot(student, '12-player');

/** Elapsed time as seconds, read from the player's own readout. */
const elapsedSeconds = async (page) => {
  const raw = (await page.getByTestId('player-elapsed').innerText()).trim();
  const [m, s] = raw.split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
};

await tap(student, 'player-play');
await student.waitForTimeout(6000);
const advanced = await elapsedSeconds(student);
check(
  'audio actually advances (a signed URL streamed)',
  advanced >= 3,
  `elapsed ${advanced}s after 6s of playback`,
);

// Skip forward, then confirm progress is persisted.
await tap(student, 'player-forward');
await student.waitForTimeout(2500);
const progressDocs = await readCollection('listeningProgress');
check('progress is persisted for the student', progressDocs.length === 1,
  `${progressDocs.length} progress docs`);

// Seek by pressing the scrubber near 75%. On web this is a hand-rolled
// PanResponder bar (the native @react-native-community/slider has no web build,
// so Scrubber.web.tsx is the seam); pressing commits a seek to that position
// through the same grant→onSeek path a drag uses. A synthetic playwright drag
// can't feed react-native-web's gesture delta, so the press is what is reliably
// driveable here — the seek itself is what we are asserting.
const midY = (b) => b.y + b.height / 2;
const bar = await student.getByTestId('player-scrubber').boundingBox();
await student.mouse.move(bar.x + bar.width * 0.75, midY(bar));
await student.mouse.down();
await student.waitForTimeout(250);
await student.mouse.up();
await student.waitForTimeout(2500);
const seekedTo = await elapsedSeconds(student);
check(
  'pressing the scrubber seeks to that position',
  seekedTo > 470 && seekedTo < 610,
  `landed at ${seekedTo}s (~75% of 720s)`,
);
await tap(student, 'player-play'); // pause, so the saved position settles

/*
 * THE DOCKED NOW-PLAYING BAR — leaving the player must not stop the audio.
 *
 * This is the whole reason playback moved out of `PlayerScreen` into an app-wide
 * session, and no other check reaches it: the sweep photographs the bar but
 * never asserts the position kept moving, and the unit suite does not touch
 * playback at all. A two-hour lecture that stops because someone checked their
 * attendance record is the bug this proves is gone.
 */
await goHome(student);
await tap(student, 'next-up-Session 1');
await student.getByTestId('player-play').waitFor({ timeout: 25000 });
await tap(student, 'player-play');
await student.waitForTimeout(2000);
const beforeLeaving = await elapsedSeconds(student);
await tap(student, 'tab-classes');
await student.getByTestId('mini-player').waitFor({ timeout: 15000 });
check(
  'leaving the player leaves the recording loaded, in a docked bar',
  await shows(student, 'mini-player'),
);
await student.waitForTimeout(4000);
await tap(student, 'mini-player-open');
await student.getByTestId('player-play').waitFor({ timeout: 15000 });
check('the docked bar reopens the player it belongs to', await shows(student, 'player-play'));
const afterReturning = await elapsedSeconds(student);
check(
  'the audio kept playing while the student was on another screen',
  afterReturning >= beforeLeaving + 2,
  `left at ${beforeLeaving}s, back at ${afterReturning}s`,
);
await tap(student, 'player-play'); // pause again
await student.waitForTimeout(1500);

/*
 * SIGNING OUT ENDS THE SESSION, and this is the only place that says so.
 *
 * Playback is app-wide now, so nothing unmounts it: `signOut` has to stop the
 * audio and drop the signed-URL cache itself. Both are one line each, both are
 * silent when they are missing, and the failure — a foreground service still
 * streaming a lecture behind a sign-in screen, and a 12-hour URL bound to a
 * recording rather than an account waiting for whoever signs in next — is
 * exactly the shared-device case the function exists for.
 */
// The bar IS on screen before we sign out — the positive control, without which
// "no bar afterwards" is a sentence about a screen that never had one.
await tap(student, 'tab-classes');
await student.getByTestId('mini-player').waitFor({ timeout: 15000 });
await more(student, 'more-sign-out');
await student.getByTestId('signin-email').waitFor({ timeout: 20000 });
await student.getByTestId('signin-email').fill('fatima@example.com');
await student.getByTestId('signin-password').fill('StudentPass123!');
await tap(student, 'signin-student');
// The TAB BAR, not a screen title: the linking config restores the route this
// student was last on, so signing back in lands them on Classes rather than
// Listening — which is the shell working, not a failure.
await student.getByTestId('tab-classes').waitFor({ timeout: 30000 });
await student.waitForTimeout(1500);
/*
 * SIGNING BACK IN IS WHAT DISCRIMINATES, not the sign-in screen itself.
 *
 * The signed-out branch renders a bare `SignInScreen` with no `Shell` in it, so
 * "no docked bar on the sign-in screen" is true whether or not the session was
 * ended. `playback.ts` holds its session at module scope and nothing reloads the
 * page between the two, so a session left running comes straight back with the
 * bar — under the next person's account.
 */
check(
  'signing out ends the playback session — nothing is playing for the next sign-in',
  (await student.getByTestId('mini-player').count()) === 0,
);

// READ AFTER EVERYTHING HAS STOPPED PLAYING. The resume check below compares a
// reopened position against this one, so anything that plays between the two
// reads shows up as a resume that missed by exactly that much.
const savedMs = Number(
  (await readCollection('listeningProgress'))[0].fields.positionMs.integerValue,
);

await goHome(student);
await tap(student, 'next-up-Session 1');
await student.getByTestId('player-play').waitFor({ timeout: 25000 });
await student.waitForTimeout(2500);
const resumedAt = await elapsedSeconds(student);
check(
  'playback RESUMES where it left off after a reload',
  resumedAt > 0 && Math.abs(resumedAt - savedMs / 1000) <= 5,
  `resumed at ${resumedAt}s, saved ${Math.round(savedMs / 1000)}s`,
);
await shot(student, '13-resumed');

// ------------------------------------------------- completion on the home --
console.log('\nCompletion');
// Mark it complete from the player — the never-played gate is already satisfied.
await tap(student, 'mark-complete');
await student.waitForTimeout(1500);
const completions = await readCollection('completions');
check(
  'marking complete writes a completion doc',
  completions.length === 1 && completions[0].fields.completed.booleanValue === true,
  `${completions.length} completion(s)`,
);
check(
  'a completion event is appended (append-only audit)',
  (await readCollection('completionEvents')).some((e) => e.fields.action?.stringValue === 'complete'),
);
await student.getByTestId('mark-incomplete').waitFor({ timeout: 8000 });
check(
  'the player reflects completion and offers unmark',
  await shows(student, 'mark-incomplete'),
);

// Back to `task-`: once complete it leaves the hero (which only ever promotes
// something still to do) and joins the grouped list under Completed.
await goHome(student);
await student.getByTestId('task-Session 1').waitFor({ timeout: 8000 });
/*
 * THE GROUP, not the word.
 *
 * `/Completed/` over the page text could only ever match the row's own chip:
 * the heading is `textTransform: 'uppercase'`, so it renders as COMPLETED and
 * the regex never saw it. The chip is present the moment the mark lands, so a
 * recording that stayed in "Due soon" — the regression this names — passed.
 * The group carries a testID for exactly this; asking whether the row is
 * INSIDE it is the actual claim.
 */
const completedGroup = student.getByTestId('group-done');
await completedGroup.waitFor({ timeout: 8000 });
check(
  'the student home moves the recording to Completed',
  await completedGroup.getByTestId('task-Session 1').isVisible(),
);
await shot(student, '14-home-completed');

// ---------------------------------------- the student's own attendance record --
// The class list holds each course in a DOCUMENT listener, because a student is
// granted `get` on their course and never `list` — the list-shaped subscription
// used on staff screens is denied here, and denial looks like an empty screen
// plus a console warning, not a crash. So the course NAME rendering is the
// assertion: it can only come from a document listener the rules allowed.
await tap(student, 'tab-classes');
await student.getByTestId('myclass-Hikam Foundations').waitFor({ timeout: 20000 });
// innerText returns RENDERED text, and SectionTitle uppercases via CSS — so this
// compares case-insensitively rather than against the source string.
const classesText = (await bodyText(student)).toLowerCase();
check(
  'a student sees their own classes — the course doc listener is permitted',
  classesText.includes('hikam foundations'),
);

await tap(student, 'myclass-Hikam Foundations');
await student.getByTestId('attendance-Session 1').waitFor({ timeout: 20000 });
/*
 * WAIT FOR THE LINE, not just for the row.
 *
 * The row is drawn from the student's attendance projection; the "completed"
 * half of it comes from a SECOND listener, on completions. Reading the body the
 * moment the row appears is a race against that second snapshot, and it is the
 * kind of race that passes on a fast day and fails on a slow one.
 */
await sawText(student, 'Recording required · completed', 20000);
const recordText = await bodyText(student);
// Their own mark, out of a session document they can never read: this can only
// have come from the attendanceRecords projection the trigger wrote.
check(
  "the student sees their own attendance mark for the session",
  /Excused/.test(recordText) && /Session 1/.test(recordText),
);
check(
  'an excused row says a recording was required and that it is done',
  /Recording required/.test(recordText) && /completed/i.test(recordText),
);
/*
 * THE PROMISE: "my record says I was excused from one session, and present at
 * none." A window regex cannot say that. `1[\s\S]{0,40}EXCUSED` matched the
 * PRESENT counter twenty characters upstream, so swapping two labels, or
 * counting every mark as present, left it green while the screen told an
 * excused student they had attended.
 *
 * Each counter is asserted against its own label instead — which is what the
 * student reads.
 */
const tally = async (label) =>
  (await student.getByTestId(`attendance-tally-${label}`).innerText()).trim();
check(
  'the tally counts the mark against the right label',
  (await tally('excused')) === '1' &&
    (await tally('present')) === '0' &&
    (await tally('absent')) === '0',
  `present ${await tally('present')} / absent ${await tally('absent')} / excused ${await tally('excused')}`,
);
await shot(student, '14b-attendance-record');

// ---------------------------------------- enrollment-onward accountability --
console.log('\nEnrollment-onward (no retroactive assignment)');
// A genuinely late student: enrolled AFTER Session 1's attendance was submitted,
// so they are not in its snapshot and get no obligation for it. This is the
// replacement for the old "catch-up" path — accountability is attendance-driven.
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'students-add');
await admin.getByTestId('student-name').fill('Bilal Khan');
await admin.getByTestId('student-email').fill('bilal@example.com');
await tap(admin, 'student-course-Hikam Foundations');
await tap(admin, 'student-create');
await admin.waitForTimeout(2500);
check(
  'a student enrolled after the snapshot is NOT assigned the past session',
  (await activeAssignments()).length === 1,
  `${(await activeAssignments()).length} active assignment(s)`,
);

await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');

// First mark him ABSENT — an unexcused miss. Under the excused-only policy that
// grants nothing at all, which is the whole change in one assertion: the same
// action that used to create an obligation now creates none.
await admin.getByTestId('att-Bilal Khan-absent').waitFor({ timeout: 15000 });
await tap(admin, 'att-Bilal Khan-absent');
await tap(admin, 'att-submit');
await admin.waitForTimeout(3000);
check(
  'marking the late student ABSENT grants them nothing',
  (await activeAssignments()).length === 1,
  `${(await activeAssignments()).length} active assignment(s)`,
);

// Now excuse him. Re-submitting reconciles via onSessionWritten, granting him
// the already-published recording — without disturbing Fatima's completion.
await tap(admin, 'att-Bilal Khan-excused');
await tap(admin, 'att-submit');
let afterResubmit = [];
for (let i = 0; i < 20 && afterResubmit.length < 2; i++) {
  await admin.waitForTimeout(500);
  afterResubmit = await activeAssignments();
}
check(
  're-submitting attendance with the late student EXCUSED grants them (onSessionWritten)',
  afterResubmit.length === 2,
  `${afterResubmit.length} active assignment(s)`,
);
check(
  'Fatima\'s completion survived the reconcile',
  (await readCollection('completions')).length === 1,
);
await shot(admin, '15-resubmit');

// ------------------------------------------------ recording ledger + override --
console.log('\nRecording ledger, override');
await tap(admin, 'recording-ledger');
await admin.getByTestId('ledger-filter-all').waitFor({ timeout: 10000 });
await tap(admin, 'ledger-filter-all');
await admin.waitForTimeout(1000);
let ledgerText = await bodyText(admin);
check(
  'the recording ledger lists the accountable roster (Fatima + Bilal, both absent)',
  /Fatima Ahmed/.test(ledgerText) && /Bilal Khan/.test(ledgerText),
);

// Override Bilal → complete, with a required reason.
await tap(admin, 'ledger-filter-notComplete');
await admin.getByTestId('override-open-Bilal Khan').waitFor({ timeout: 8000 });
await tap(admin, 'override-open-Bilal Khan');
await admin.getByTestId('override-reason-Bilal Khan').fill('Attended the class live');
await tap(admin, 'override-complete-Bilal Khan');
// POLL, do not sleep. This was a fixed 1800ms wait, which is a guess about how
// fast the machine is — and on 2026-08-28, straight after three suites had been
// hammering the box, the write had not landed and this read returned 0. The two
// checks below saw the override perfectly well, because they happen to read
// later; so it reported a failure in a feature that worked. Waiting for the
// thing you expect instead of for a duration is this repo's own rule, and it
// also makes the happy path faster than the old sleep.
let overrides = await readCollection('completionOverrides');
for (let i = 0; i < 30 && overrides.length === 0; i++) {
  await admin.waitForTimeout(500);
  overrides = await readCollection('completionOverrides');
}
/*
 * AND IT NAMES THE STUDENT IT WAS MADE FOR.
 *
 * "I overrode Bilal's completion" is the whole of what this screen promises, and
 * not one assertion said Bilal: the document checks read `completed` and
 * `reason`, and every screen check was a regex over the whole page or the whole
 * CSV. Pass `rows[0].studentUid` instead of `r.studentUid` in the override
 * editor — the row-versus-list mix-up this screen has had before — and the
 * override lands on Fatima while all of them stay green, leaving Bilal chased
 * for a recording a staff member had already excused him from.
 *
 * The uid comes from the students directory rather than being restated, so the
 * check cannot drift from whoever the run actually created.
 */
const bilalUid = (await readCollection('students')).find(
  (d) => d.fields.email?.stringValue === 'bilal@example.com',
)?.name.split('/').pop();
check('the run knows which student it overrode', !!bilalUid);
check(
  'staff override writes a completionOverrides doc, for that student, with the reason',
  overrides.length === 1 &&
    overrides[0].fields.studentUid.stringValue === bilalUid &&
    overrides[0].fields.completed.booleanValue === true &&
    overrides[0].fields.reason.stringValue === 'Attended the class live',
  `${overrides.length} override(s) for ${overrides[0]?.fields.studentUid?.stringValue}`,
);

await tap(admin, 'ledger-filter-all');
await admin.waitForTimeout(1000);
ledgerText = await bodyText(admin);
check(
  'the overridden student now shows Completed (override) on the ledger',
  // Bound to the ROW, not to the page: the ledger lists a dozen students, and a
  // page-wide regex says only that somebody somewhere is overridden.
  await admin
    .getByTestId('ledger-row-Bilal Khan')
    .filter({ hasText: 'Completed (override)' })
    .isVisible()
    .catch(() => false),
  ledgerText.slice(0, 160),
);
await shot(admin, '16-recording-ledger');


/*
 * THE STUDENT'S SIDE OF THE OVERRIDE — the half nothing proved.
 *
 * Every assertion above is staff-facing: the ledger row, the CSV, the audit
 * entry. All of them passed for weeks while the student's own screens read
 * `completions` alone and knew nothing of the mark — so a student a teacher had
 * already settled still saw the recording outstanding, still sat under Due
 * soon, and still got the last-day reminder. The staff half of a promise is not
 * the promise. The promise is the student's: "my teacher settled this, and my
 * app says so."
 *
 * A SECOND SIGNED-IN STUDENT, not Fatima. Bilal is the one who was overridden,
 * and running this against the account that was not is how the ledger check
 * above came to be bound to the row rather than to the page.
 *
 * Their context is closed at the end: this student is disabled further down,
 * and a page left listening through that would log denials the run collects.
 */
const bilalOob = await (
  await fetch(`${AUTH}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/oobCodes`)
).json();
const bilalReset = (bilalOob.oobCodes ?? []).filter((c) => c.email === 'bilal@example.com').pop();
const bilalRedeem = await fetch(
  `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake-api-key`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oobCode: bilalReset?.oobCode, newPassword: 'BilalPass123!' }),
  },
);
check('the overridden student can set their own password', bilalRedeem.status === 200);

const overridden = await newSession('overridden');
await overridden.getByTestId('signin-email').fill('bilal@example.com');
await overridden.getByTestId('signin-password').fill('BilalPass123!');
await tap(overridden, 'signin-student');
await sawText(overridden, 'Your listening', 25000);
/*
 * THE GROUP, not the word — same reasoning as Fatima's completion above. The
 * claim is that the row sits under Completed, which is what the student reads;
 * a page-wide regex would match the heading and pass with the row still due.
 */
const overriddenDone = overridden.getByTestId('group-done');
await overriddenDone.waitFor({ timeout: 20000 });
check(
  "a teacher's mark moves the recording to Completed on the STUDENT's own home",
  await overriddenDone.getByTestId('task-Session 1').isVisible(),
);
// And the player says who settled it and why — a mark that is not theirs to undo.
await tap(overridden, 'task-Session 1');
await sawText(overridden, 'marked by your teacher', 20000);
const overriddenPlayer = await bodyText(overridden);
check(
  'the player attributes the mark to the teacher, gives the reason, and offers no Unmark',
  /marked by your teacher/.test(overriddenPlayer) &&
    /Attended the class live/.test(overriddenPlayer) &&
    (await overridden.getByText('Unmark', { exact: true }).count()) === 0,
  overriddenPlayer.slice(0, 200),
);
await shot(overridden, '16b-override-student');
await overridden.context().close();

// ------------------------------------------- the same ledger, as a MANAGER --
//
// THE ADMIN RUN ABOVE IS NOT EVIDENCE ABOUT THIS ONE. Every rule the ledger
// touches — assignments, completions, completionOverrides, listeningProgress —
// answers an admin from a zero-read arm that depends on no `resource.data`, and
// answers a manager by resolving get(/courses/$(resource.data.courseId)). Only
// the second cares what the query pins, so only the second can fail closed.
//
// It did. All four listeners were denied for every manager on every recording,
// because the queries filtered on `recordingId` alone; the sweep never noticed
// because a manager had never opened this screen. The rows below are the whole
// point: a denial renders as an EMPTY ledger, not an error, so asserting the
// roster is present is what distinguishes "allowed" from "silently refused" —
// and `listenerDenials` (asserted at the end of this file) catches the rest.
await goHome(mgr);
await tap(mgr, 'tab-courses');
await tap(mgr, 'course-open-Hikam Foundations');
await tap(mgr, 'nav-sessions');
await tap(mgr, 'session-open-Session 1');
await tap(mgr, 'recording-ledger');
await mgr.getByTestId('ledger-filter-all').waitFor({ timeout: 10000 });
await tap(mgr, 'ledger-filter-all');
await mgr.waitForTimeout(1500);
const mgrLedger = await bodyText(mgr);
check(
  'a MANAGER sees the accountable roster on the recording ledger',
  /Fatima Ahmed/.test(mgrLedger) && /Bilal Khan/.test(mgrLedger),
);
check(
  'the manager ledger joins the override written by the admin',
  /Completed \(override\)/.test(mgrLedger),
);
check(
  'no live-data error is showing on the manager ledger',
  !/Live data error/.test(mgrLedger),
);
await shot(mgr, '16b-recording-ledger-manager');

// ------------------------------------------------------- attendance report --
console.log('\nAttendance report');
await openHikam(admin);
await tap(admin, 'nav-attendance');
// Defaults to the "By session" view; the two cuts are a toggle, not stacked.
await admin.getByTestId('attendance-tab-sessions').waitFor({ timeout: 10000 });
await admin.waitForTimeout(1000);
const sessionsView = await bodyText(admin);
check(
  'the by-session view shows the session and the taken state',
  /Session 1/.test(sessionsView) && /1 of 1 sessions taken/.test(sessionsView),
);
await shot(admin, '17-attendance-by-session');

// Toggle to the by-student cut; the screen updates in place.
await tap(admin, 'attendance-tab-students');
await admin.locator('[data-testid^="attendance-student-"]').first().waitFor({ timeout: 10000 });
await admin.waitForTimeout(800);
const studentsView = await bodyText(admin);
check(
  'toggling to by-student shows required listening (Bilal caught up via override)',
  /Bilal Khan/.test(studentsView) && /Required listening/.test(studentsView),
);
check(
  'the toggle swaps the view: session cards are gone, student cards are present',
  (await admin.locator('[data-testid^="attendance-session-"]').filter({ visible: true }).count()) === 0 &&
    (await admin.locator('[data-testid^="attendance-student-"]').filter({ visible: true }).count()) > 0,
);
await shot(admin, '17-attendance-by-student');

// Both cuts of the report drill down, and land on the row that was tapped —
// a report you cannot click through from is a dead end.
// NOT the first card. The list is sorted by name, so a drill-down that always
// opened the first student would pass a check that reads the first card's
// name; the last one is the one a wrong index cannot produce by accident.
const stuCard = admin
  .locator('[data-testid^="attendance-student-"]')
  .filter({ visible: true })
  .last();
const stuName = (await stuCard.innerText()).split('\n')[0].trim();
await stuCard.click();
// WAIT FOR SOMETHING ONLY THE DESTINATION HAS. The report page already
// carries every student's name and the words "required listening", so a
// body-text check after a fixed wait passed when the tap did nothing.
await admin.getByTestId('student-ledger-profile').waitFor({ timeout: 10000 });
check(
  'a by-student card opens THAT student’s listening progress',
  (await screenTitle(admin)) === stuName,
  stuName,
);

await openHikam(admin);
await tap(admin, 'nav-attendance');
await admin.getByTestId('attendance-tab-sessions').waitFor({ timeout: 10000 });
const sesCard = admin
  .locator('[data-testid^="attendance-session-"]')
  .filter({ visible: true })
  .first();
const sesName = (await sesCard.innerText()).split('\n')[0].trim();
await sesCard.click();
// Same again: the register's own controls exist on the session page alone.
await admin.getByTestId('att-submit').waitFor({ timeout: 10000 });
check(
  'a by-session card opens THAT session',
  (await screenTitle(admin)) === sesName,
  sesName,
);

// The override is in the audit trail with its reason.
await openHikam(admin);
await tap(admin, 'nav-audit');
await admin.waitForTimeout(1500);
const auditText = await bodyText(admin);
check(
  'the course audit view shows the override with its reason',
  /Overrode completion/.test(auditText) && /Attended the class live/.test(auditText),
);
await shot(admin, '18-audit');

// ---------------------------------------------------------- archive cascade --
console.log('\nArchive cascade');
const courseState = async () =>
  Object.fromEntries(
    (await readCollection('courses')).map((d) => [
      d.fields.name.stringValue,
      {
        eff: d.fields.effectiveActive.booleanValue ?? false,
        arch: d.fields.archived.booleanValue ?? false,
      },
    ]),
  );

await openHikam(admin);
await tap(admin, 'course-archive');
await admin.waitForTimeout(2500);
let s = await courseState();
check(
  'archiving one course leaves the other alone',
  s['Hikam Foundations'].eff === false && s['Arabic I'].eff === true,
  JSON.stringify(s),
);
// The student's side of an archive with listening off: a recording they had
// COMPLETED stays under Completed — done is done, and only an open grant is
// filed under Archived. (An open grant on an archived class is the seeded
// world's job; nobody here holds one at this point.)
await goHome(student);
const doneAfterArchive = student.getByTestId('group-done');
await doneAfterArchive.waitFor({ timeout: 10000 });
check(
  'archiving the course leaves a completed recording under Completed, not Archived',
  (await doneAfterArchive.getByTestId('task-Session 1').isVisible()) &&
    (await student.getByTestId('group-archived').count()) === 0,
);

// cohort-archive lives INSIDE the cohort now, mirroring a course: the list is a
// list, and the settings are on the thing they belong to.
await goHome(admin);
await tap(admin, 'tab-courses');
await tap(admin, 'cohort-open-Autumn 2026');
await tap(admin, 'cohort-archive');
await admin.waitForTimeout(3000);
s = await courseState();
check(
  'archiving the cohort deactivates every course',
  s['Hikam Foundations'].eff === false && s['Arabic I'].eff === false,
  JSON.stringify(s),
);
check(
  'the cascade does NOT write a course\'s own archived flag',
  s['Arabic I'].arch === false,
  JSON.stringify(s),
);
await shot(admin, '19-cohort-archived');

// Still on the cohort's own screen, which now reads the cohort LIVE — so the
// button has already flipped to Reactivate without a reload. Tapping the same
// testID twice is the assertion that it did.
await tap(admin, 'cohort-archive');
await admin.waitForTimeout(3000);
s = await courseState();
check(
  'reactivating restores each course to its OWN state',
  s['Arabic I'].eff === true && s['Hikam Foundations'].eff === false,
  JSON.stringify(s),
);

// ------------------------------------ an archived course is not offered --
// Hikam Foundations is archived at this point (the cascade block above left it
// so) and Arabic I is live. A new student is enrolled into something that is
// running, so the create sheet offers only the live course.
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'students-add');
await admin.getByTestId('student-course-Arabic I').waitFor({ timeout: 20000 });
check(
  'the create-student sheet offers the live course and not the archived one',
  (await admin.getByTestId('student-course-Arabic I').count()) === 1 &&
    (await admin.getByTestId('student-course-Hikam Foundations').count()) === 0,
);
await admin.getByText('Cancel', { exact: true }).filter({ visible: true }).first().click();
await admin.waitForTimeout(800);

// ------------------------------------------------------- the student's page --
// Everything about one student in one place. The courses list is the part worth
// asserting: it is a single studentUid query for an ADMIN, which only the
// zero-read admin arm of the enrollments rule permits (a manager walks their own
// courses instead — rules.structure.test.ts owns that boundary).
console.log('\nStudent page');
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'student-open-bilal@example.com');
await admin.getByTestId('student-course-open-Hikam Foundations').waitFor({ timeout: 20000 });
const stuPage = (await bodyText(admin)).toLowerCase();
check('the student page names the student and their address', stuPage.includes('bilal khan') && stuPage.includes('bilal@example.com'));
check('it lists the courses they are enrolled in', stuPage.includes('hikam foundations'));
await shot(admin, '20-student-page');

await tap(admin, 'student-course-open-Hikam Foundations');
// The student page already says both names; only the ledger has its export.
await admin.getByTestId('student-ledger-profile').waitFor({ timeout: 10000 });
check(
  'tapping a course opens THAT student\'s progress for it',
  (await screenTitle(admin)) === 'Bilal Khan' &&
    /hikam foundations/i.test(await bodyText(admin)),
);

// Disabling moves them into a section that is CLOSED, and closed means
// unmounted: the row must be unreachable until the section is expanded.
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'student-open-bilal@example.com');
await tap(admin, 'student-access');
await admin.waitForTimeout(2500);
await goHome(admin);
await tap(admin, 'tab-people');
// The Disabled section appears only once somebody is in it — that is the
// change landing; a count of zero on a list that has not loaded proves nothing.
await admin.getByTestId('students-disabled').waitFor({ timeout: 10000 });
check(
  'a disabled student leaves the main list',
  (await admin.getByTestId('student-open-bilal@example.com').count()) === 0,
);
await tap(admin, 'students-disabled');
await admin.getByTestId('student-open-bilal@example.com').waitFor({ timeout: 10000 });
check(
  '…and is found by expanding Disabled',
  await shows(admin, 'student-open-bilal@example.com'),
);
await shot(admin, '20b-students-disabled');

// Put them back, so the audit assertions below read a tidy end state.
await tap(admin, 'student-open-bilal@example.com');
await tap(admin, 'student-access');
await admin.waitForTimeout(2500);

// The MANAGER's view of the same page is a DIFFERENT query shape, and the one
// that can fail closed: they may not query a student's enrollments across
// courses, so the screen walks the courses they manage and asks about one course
// at a time. A denial here is an empty section, not an error — so assert the
// course actually appears.
await goHome(mgr);
await tap(mgr, 'tab-people');
await tap(mgr, 'student-open-fatima@example.com');
await mgr.waitForTimeout(3500);
const mgrStudent = (await bodyText(mgr)).toLowerCase();
check('a manager can open a student page', mgrStudent.includes('fatima ahmed'));
check(
  'it is scoped to the courses they manage, and says so',
  mgrStudent.includes('courses you manage') && mgrStudent.includes('hikam foundations'),
);
check(
  'the admin-only disable control is absent for them',
  (await mgr.getByTestId('student-access').count()) === 0,
);
check(
  'resending a password link is still theirs to do',
  (await mgr.getByTestId('student-resend').count()) === 1,
);
await shot(mgr, '20c-student-page-manager');

// A student in NONE of the manager's courses. Each row owns its own enrollment
// read and renders nothing when it does not match, so without an explicit empty
// state the heading stood over a blank space. Needs a student with no enrolment
// at all — one merely REMOVED from a course keeps an inactive enrolment row.
//
// This is also the ONLY place the app asks about an enrollment that does not
// exist, and the outcome check below is not enough on its own: a refused read
// and a genuine "not enrolled" both leave the row unrendered, so the empty state
// appeared either way while every non-matching course fired a permission denial
// into the banner and into Sentry. Assert the absence of the banner too.
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'students-add');
await admin.getByTestId('student-name').fill('Zayd Noor');
await admin.getByTestId('student-email').fill('zayd@example.com');
await tap(admin, 'student-create');
await admin.getByTestId('student-open-zayd@example.com').waitFor({ timeout: 20000 });

await goHome(mgr);
await tap(mgr, 'tab-people');
await tap(mgr, 'student-open-zayd@example.com');
await mgr.waitForTimeout(3500);
const mgrNoMatch = (await bodyText(mgr)).toLowerCase();
check(
  'a student in none of their courses says so, rather than showing a bare heading',
  mgrNoMatch.includes('is not in any of the courses you manage'),
);
check(
  'and answers it without a permission denial — an absent enrollment is asked as a query, never a get',
  !mgrNoMatch.includes('live data error'),
);

// ------------------------------------------------- roster removal confirms --
// The row opens the student's progress, so the × beside it must not remove
// anyone on a single tap.
await openHikam(admin);
await tap(admin, 'roster-remove-bilal@example.com');
await admin.getByTestId('roster-remove-confirm-bilal@example.com').waitFor({ timeout: 10000 });
check(
  'the roster × asks before removing',
  await shows(admin, 'roster-remove-confirm-bilal@example.com'),
);
await admin.getByText('Cancel', { exact: false }).filter({ visible: true }).first().click();
await admin.waitForTimeout(1500);
const stillEnrolled = (await readCollection('enrollments')).filter(
  (e) => e.fields.active?.booleanValue === true,
).length;
await tap(admin, 'roster-remove-bilal@example.com');
await tap(admin, 'roster-remove-confirm-bilal@example.com');
await admin.waitForTimeout(2500);
const afterRemove = (await readCollection('enrollments')).filter(
  (e) => e.fields.active?.booleanValue === true,
).length;
check(
  'cancelling keeps the enrolment, confirming ends it',
  afterRemove === stillEnrolled - 1,
  `${stillEnrolled} → ${afterRemove}`,
);

console.log('\nUp to the course');
// The header's Back arrow returns where you CAME FROM, which two screens into a
// course is the list you came through. The course name in the subtitle is the
// way to the course itself — and from a screen opened by URL there is nothing
// below it in the stack to go back to at all, so this is the only way back to
// the COURSE — the bar is still there, but it starts you over at a tab root.
await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');
const sessionUrl = admin.url();
// Named per screen, not one shared id: react-navigation keeps the screen below
// mounted, so a bare `up-to-course` matches the one on Sessions as well.
await tap(admin, 'up-to-course-from-session');
await admin.waitForTimeout(2500);
const onCourse = (page) => {
  const p = new URL(page.url()).pathname;
  return /^\/courses\/[^/]+$/.test(p) ? p : `NOT the course page: ${p}`;
};
check(
  'the course name on a session leads to the course',
  onCourse(admin).startsWith('/courses/'),
  onCourse(admin),
);

// The case that has no Back at all — no header arrow, only the bar: a session
// opened straight from its URL has nothing beneath it in the stack, so the
// header draws no back arrow. That is the whole reason this link exists rather
// than leaning on Back.
await admin.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
await admin.waitForTimeout(3500);
await tap(admin, 'up-to-course-from-session');
await admin.waitForTimeout(2500);
check(
  '…including from a session opened cold by URL, which has no Back',
  onCourse(admin).startsWith('/courses/'),
  onCourse(admin),
);

await openHikam(admin);
await tap(admin, 'nav-attendance');
await tap(admin, 'up-to-course-from-attendance');
await admin.waitForTimeout(2500);
check('and the same from the attendance report', onCourse(admin).startsWith('/courses/'), onCourse(admin));

console.log('\nRole boundaries');
// A URL is an ADDRESS, so a signed-in student can ask for a staff screen and a
// manager for a student one. Nobody types these — a browser tab outlives the
// person signed into it, so a shared device restores the last URL under the next
// account. While one navigator held every screen, both populations got the
// other's screen fully rendered, every query beneath it denied.
//
// The rules held, so the check is not about a leak: it is that the WRONG SCREEN
// rendered at all, and that the denials underneath it are what reached Sentry.
const staffSession = (await readCollection('sessions'))[0];
const staffPath =
  `${WEB}courses/${staffSession.fields.courseId.stringValue}` +
  `/sessions/${staffSession.name.split('/').pop()}`;

await student.goto(staffPath, { waitUntil: 'domcontentloaded' });
await student.waitForTimeout(3500);
const stuOnStaffUrl = (await bodyText(student)).toLowerCase();
check(
  'a student asking for a staff URL gets their OWN home, not the staff screen',
  // The negative has to name something ONLY SessionDetailScreen renders. It was
  // "listen by" for a while, which the student's own home also prints on every
  // open task — so the check passed on the accident that this student's one
  // grant was already complete, and any open assignment added above here would
  // have failed it for a reason unrelated to routing.
  stuOnStaffUrl.includes('your listening') && !stuOnStaffUrl.includes('excused students listen by'),
);
check('…so nothing on it is denied', !stuOnStaffUrl.includes('live data error'));

await mgr.goto(`${WEB}my-classes`, { waitUntil: 'domcontentloaded' });
await mgr.waitForTimeout(3500);
const mgrOnStudentUrl = (await bodyText(mgr)).toLowerCase();
check(
  'a manager asking for a student URL gets their own home too',
  // Their home is the work queue, and `Today` is a staff-only word — it is the
  // heading and the first tab. `library` pins the staff bar alongside it, so
  // this cannot pass on a student screen that happened to say "today".
  mgrOnStudentUrl.includes('today') &&
    mgrOnStudentUrl.includes('library') &&
    !mgrOnStudentUrl.includes('your attendance'),
  mgrOnStudentUrl.replace(/\n+/g, ' | ').slice(0, 200),
);
check('…so nothing on it is denied', !mgrOnStudentUrl.includes('live data error'));

// --------------------------------------------------- the deadline closes access --
console.log('\nThe deadline');
// Reactivate Hikam first (the archive-cascade block left it off). An archived
// course refuses playback for its own reason, which would mask the one under
// test — with it active, the DUE DATE is the only thing left standing between
// the student and the audio.
await openHikam(admin);
await tap(admin, 'course-archive');
await admin.waitForTimeout(2500);

/*
 * THE CONTROL FOR THE "not playable once missed" CHECK BELOW, taken here while
 * the card is still open. Same student, same card, same accessible name — so
 * the zero this run later asserts is a zero the query would have seen as a one.
 */
const PLAYABLE = 'Listen to Session 1';
await goHome(student);
await student.getByTestId('task-Session 1').waitFor({ timeout: 20000 });
const playableBefore = await student.getByRole('button', { name: PLAYABLE }).count();

// Push Session 1's due date into the past, OUT OF BAND: no callable will write
// one, because a deadline may only become past by the passage of time. The real
// onSessionWritten trigger still fires, so the date flows down to the grants
// exactly as it would on the morning after.
const sessDoc = (await readCollection('sessions'))[0];
await patchField('sessions', sessDoc.name.split('/').pop(), 'dueDate', '2020-01-01');
await new Promise((r) => setTimeout(r, 5000));
// A FLOOR AS WELL AS A PREDICATE. `[].every()` is true, so if the reconcile
// deactivated every grant instead of re-dating it — the regression this names —
// an empty array would have read as a pass.
const dated = await activeAssignments();
check(
  'the past due date reaches every grant on the session',
  dated.length > 0 && dated.every((a) => a.fields.dueDate?.stringValue === '2020-01-01'),
  `${dated.length} active grant(s)`,
);

// Fatima completed hers in time, so it must NOT be recast as missed. Completion
// is checked before the deadline — telling someone who did the work that they
// missed it would be both wrong and the tone the brief rules out.
await goHome(student);
await student.getByTestId('task-Session 1').waitFor({ timeout: 20000 });
const doneHome = await bodyText(student);
// Case-insensitive: innerText returns RENDERED text, and the group label is
// uppercased by CSS — so /Missed/ would silently never match and this would pass
// for the wrong reason.
check(
  'a completed recording is never recast as missed, however far past due',
  /completed/i.test(doneHome) && !/missed/i.test(doneHome),
  doneHome.replace(/\n+/g, ' | ').slice(0, 200),
);

// THE BOUNDARY IS THE SERVER, not a hidden button — asserted against the real
// callable rather than through the UI, because the screen now refuses first and
// would hide a server that had quietly stopped checking.
const recId = (await readCollection('recordings'))[0].name.split('/').pop();
const stuToken = await (
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'fatima@example.com',
      password: 'StudentPass123!',
      returnSecureToken: true,
    }),
  })
).json();
const mint = await fetch(`${FN}/getPlaybackUrl`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stuToken.idToken}` },
  body: JSON.stringify({ data: { recordingId: recId } }),
});
const mintBody = await mint.text();
check(
  'getPlaybackUrl REFUSES a recording whose due date has passed',
  mint.status >= 400 && /due date/i.test(mintBody),
  `${mint.status} ${mintBody.slice(0, 160)}`,
);

// And the screen says so too, without drawing a transport nobody can use.
await tap(student, 'task-Session 1');
await sawText(student, 'This recording closed on 2020-01-01', 30000);
check(
  'the player states the closure and offers no transport',
  (await student.getByTestId('player-play').count()) === 0,
);
await shot(student, '24-past-due-player');

// Unmark it out of band, so the same grant is now incomplete AND past its
// deadline — the completion control is behind the closed gate, deliberately.
await patchField('completions', `${stuToken.localId}_${recId}`, 'completed', false, 'booleanValue');
await goHome(student);
await student.getByTestId('task-Session 1').waitFor({ timeout: 20000 });
const missedHome = await bodyText(student);
check(
  'a grant past its due date reads as Missed, with the date it closed',
  /missed/i.test(missedHome) && /Closed 2020-01-01/.test(missedHome),
  missedHome.replace(/\n+/g, ' | ').slice(0, 220),
);
/*
 * Not a button: the server would refuse anyway, and a card that looks tappable
 * and then errors reads as a fault in the app rather than a deadline missed.
 *
 * AGAINST A CONTROL TAKEN WHILE THE SAME CARD WAS OPEN (`playableBefore`, above
 * the deadline change). A count of zero is also what a query looking at nothing
 * returns, and the name is hand-copied from `StudentHomeScreen` — so renaming
 * that label as ordinary a11y copy would make this permanently vacuous and
 * permanently green. Having seen the button on this very card is the only thing
 * that proves the query can find one.
 */
check(
  'the check above can see a play control at all (it saw this one open)',
  playableBefore === 1,
  `${playableBefore} play control(s) while the card was open`,
);
check(
  'a missed card is not offered as something to play',
  (await student.getByRole('button', { name: PLAYABLE }).count()) === 0,
);
await shot(student, '25-missed');

// ------------------------------------------ the record survives the archive --
console.log('\nThe archive keeps the record');
/*
 * Archiving the recording is how a term ends, and it switches every grant
 * off. The ledger read active grants alone, so the term's record — who
 * listened, who missed — rendered as `Required 0 / Missed 0` over a sentence
 * about every grant having lapsed, from the moment it was filed. Fatima
 * missed this one (above) and Bilal was overridden complete; both facts have
 * to survive.
 */
await openHikam(admin);
await tap(admin, 'nav-sessions');
await tap(admin, 'session-open-Session 1');
await tap(admin, 'recording-archived');
// Archived shows Publish as its only move, which is what says the write landed.
await admin.getByTestId('recording-published').waitFor({ timeout: 20000 });
check(
  'an archived recording still offers its listening progress',
  await shows(admin, 'recording-ledger'),
);
await tap(admin, 'recording-ledger');
await admin.getByTestId('ledger-filter-all').waitFor({ timeout: 10000 });
await tap(admin, 'ledger-filter-all');
await admin.getByTestId('ledger-row-Fatima Ahmed').waitFor({ timeout: 10000 });
check(
  'the archived ledger still lists the accountable roster, as it stood when it closed',
  (await shows(admin, 'ledger-row-Fatima Ahmed')) && (await shows(admin, 'ledger-row-Bilal Khan')),
);
check(
  'a miss stays a miss after the archive, and an override stays an override',
  (await admin.getByTestId('ledger-row-Fatima Ahmed').filter({ hasText: 'Missed' }).count()) === 1 &&
    (await admin.getByTestId('ledger-row-Bilal Khan').filter({ hasText: 'Completed (override)' }).count()) === 1,
);
check(
  'the archived ledger does not claim every grant has lapsed',
  !/every grant from this session has lapsed/.test(await bodyText(admin)),
);
await shot(admin, '25b-archived-ledger');

// -------------------------------------------------------------- workbooks --
console.log('\nThe two workbooks');
/*
 * ONE FILE PER COURSE, ONE PER STUDENT, read back cell by cell. The file is
 * what a teacher opens in Excel weeks later, so what is asserted is what they
 * would read: the tab names, the header row, and one row each whose numbers
 * this run has already established on screen — Fatima missed Session 1's
 * deadline and Bilal was overridden complete. (Session 1's recording is
 * archived at this point, so it is withdrawn from the totals: the Sessions
 * tab says so, and the grids have no column for it.)
 */
const readDownload = async (page, testId) => {
  const [download] = await Promise.all([page.waitForEvent('download'), tap(page, testId)]);
  return { name: download.suggestedFilename(), sheets: readXlsx(new Uint8Array(readFileSync(await download.path()))) };
};
const tabOf = (book, name) => book.sheets.find((s) => s.name === name);
const rowOf = (sheet, first, headerRows = 2) =>
  sheet.rows.slice(headerRows).find((r) => r[0] === first);

await openHikam(admin);
const courseBook = await readDownload(admin, 'course-export');
check(
  'the course workbook is named for the course and the term',
  courseBook.name === 'Hikam Foundations — Autumn 2026.xlsx',
  courseBook.name,
);
check(
  'it has the seven tabs, Definitions last',
  courseBook.sheets.map((s) => s.name).join(',') === 'Summary,Students,Sessions,Register,Listening,Detail,Definitions',
  courseBook.sheets.map((s) => s.name).join(','),
);
const students = tabOf(courseBook, 'Students');
check(
  'the Students tab carries the grouped header',
  students.rows[0].includes('Attendance') && students.rows[1].slice(0, 5).join(',') === 'Student,Joined,Left,Status,Held',
  students.rows[1].join(','),
);
const bilal = rowOf(students, 'Bilal Khan');
const fatima = rowOf(students, 'Fatima Ahmed');
check('every student on the roster has a row', !!bilal && !!fatima);
const sessionsTab = tabOf(courseBook, 'Sessions');
const s1 = sessionsTab.rows.slice(2).find((r) => r[1] === 'Session 1');
check(
  'the archived recording is withdrawn from the totals and the Sessions tab says so',
  !!s1 && s1[6] === 'Archived' && /withdrawn/.test(s1[13] ?? ''),
  s1 ? s1.join(' | ') : 'no Session 1 row',
);
check(
  'the Definitions tab prints the vocabulary',
  tabOf(courseBook, 'Definitions').rows.some((r) => r[0] === 'Missed deadline'),
);

await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'student-open-fatima@example.com');
const studentBook = await readDownload(admin, 'student-export-workbook');
check(
  'the student workbook is named for the student',
  /^Fatima Ahmed — \d{4}-\d{2}-\d{2}\.xlsx$/.test(studentBook.name),
  studentBook.name,
);
check(
  'it has the six tabs',
  studentBook.sheets.map((s) => s.name).join(',') === 'Summary,Courses,Sessions,Listening,History,Definitions',
  studentBook.sheets.map((s) => s.name).join(','),
);
const courseRow = rowOf(tabOf(studentBook, 'Courses'), 'Hikam Foundations');
check('the Courses tab has a row for the course she is in', !!courseRow && courseRow[1] === 'Autumn 2026');
const historyRows = tabOf(studentBook, 'History').rows.slice(1);
check(
  'the History tab starts with her enrolment',
  historyRows.length > 0 && /Enrolled in Hikam Foundations/.test(historyRows[0][2] ?? ''),
  historyRows.map((r) => r[2]).join(' | '),
);

// ------------------------------------------------------------ notifications --
console.log('\nNotifications');
// The FIRST document either population may write. `students` and `staffUsers`
// refuse self-writes because role and status ARE the security model there, so
// this is the one place the rules have to let a client through — worth driving
// end to end rather than trusting the rules test alone.
await goHome(student);
await more(student, 'more-notifications');
await student.getByTestId('notify-lastDay').waitFor({ timeout: 20000 });
const notifyText = await bodyText(student);
check(
  'a student sees their own two switches and not the staff one',
  /A recording is ready for me/.test(notifyText) &&
    /Last day to listen/.test(notifyText) &&
    !/Attendance still not taken/.test(notifyText),
);
check(
  'every switch starts ON — an absent document means nothing is turned off',
  (await student.getByTestId('notify-lastDay').getAttribute('aria-checked')) === 'true',
);

await tap(student, 'notify-lastDay');
await student.waitForTimeout(1500);
const prefs = await readCollection('notifications');
check(
  'turning one off writes it, and leaves the other alone',
  prefs.length === 1 &&
    prefs[0].fields.lastDay?.booleanValue === false &&
    prefs[0].fields.recordingReady === undefined,
  JSON.stringify(prefs[0]?.fields ?? {}),
);
check(
  'the switch reflects it without a reload',
  (await student.getByTestId('notify-lastDay').getAttribute('aria-checked')) === 'false',
);
await shot(student, '26-notifications');

await goHome(mgr);
await more(mgr, 'more-notifications');
await mgr.getByTestId('notify-attendanceMissing').waitFor({ timeout: 20000 });
const mgrNotify = await bodyText(mgr);
check(
  'staff see the attendance reminder and not the student switches',
  /Attendance still not taken/.test(mgrNotify) && !/Last day to listen/.test(mgrNotify),
);

/*
 * AND AN ADMIN WHO MANAGES NO CLASS IS OFFERED NOTHING.
 *
 * The one staff message is sent to a course's `managerUids`. An admin runs the
 * institute and is in none of them unless somebody put them there, so the switch
 * they used to see was a control whose only possible effect was to silence
 * something already silent — and turning it off would have looked like it had
 * worked. The screen says who the message goes to instead.
 */
await goHome(admin);
await more(admin, 'more-notifications');
await admin.getByTestId('notify-none').waitFor({ timeout: 20000 });
const adminNotify = await bodyText(admin);
check(
  'an admin who manages no class is told where class messages go, not offered a dead switch',
  /not assigned to any class/i.test(adminNotify) &&
    !/Attendance still not taken/.test(adminNotify) &&
    (await admin.getByTestId('notify-attendanceMissing').count()) === 0,
);

// ------------------------------------------------------------ the library --
console.log('\nRecording library');
// The cohort and course dropdowns, driven as the real web controls they are:
// `<select>`s, which is what gives them keyboard and type-ahead for free.
await goHome(admin);
await tap(admin, 'tab-library');
await admin.getByTestId('library-listen-Session 1').waitFor({ timeout: 20000 });
check('the library lists the recording with nothing chosen', await shows(admin, 'library-listen-Session 1'));
check('…and offers no clear control when nothing is narrowing', (await admin.getByTestId('library-clear').count()) === 0);
await admin.getByTestId('library-cohort').selectOption({ label: 'Autumn 2026' });
await admin.waitForTimeout(600);
check(
  'choosing the cohort alone keeps every recording in it',
  (await shows(admin, 'library-listen-Session 1')) && (await shows(admin, 'library-clear')),
);
// Inside a chosen cohort the course list carries no cohort suffix.
await admin.getByTestId('library-course').selectOption({ label: 'Arabic I' });
await admin.waitForTimeout(600);
check(
  'choosing a course narrows to that course — the other course\'s recording is gone',
  (await admin.getByTestId('library-listen-Session 1').filter({ visible: true }).count()) === 0 &&
    (await showsText(admin, 'No recordings match these filters')),
);
await admin.getByTestId('library-course').selectOption({ label: 'Hikam Foundations' });
await admin.waitForTimeout(600);
check('choosing the recording\'s own course shows it', await shows(admin, 'library-listen-Session 1'));
await admin.getByTestId('library-course').selectOption({ label: 'Arabic I' });
await admin.waitForTimeout(600);
await tap(admin, 'library-clear');
await admin.waitForTimeout(600);
check(
  'Clear filters restores the whole library and removes itself',
  (await shows(admin, 'library-listen-Session 1')) &&
    (await admin.getByTestId('library-clear').count()) === 0 &&
    (await admin.getByTestId('library-cohort').inputValue()) === '' &&
    (await admin.getByTestId('library-course').inputValue()) === '',
);
await shot(admin, '27-library-filters');

// ---------------------------------------------------- a student's history --
console.log('\nStudent history');
// Bilal has been created into a course, disabled, re-enabled and removed from
// the course over the course of this run — every kind of row the page reads,
// in that order. It is read out of the audit log the same run wrote, which is
// the only place it is recorded.
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'student-open-bilal@example.com');
await admin.getByTestId('student-history').waitFor({ timeout: 20000 });
await admin.waitForTimeout(2500);
const history = await bodyText(admin);
const order = [
  'Account created',
  'Enrolled in Hikam Foundations · Autumn 2026',
  'Account disabled',
  'Account re-enabled',
  'Removed from Hikam Foundations · Autumn 2026',
].map((line) => history.indexOf(line));
check(
  'the student\'s page tells their story in order: created, enrolled, disabled, re-enabled, removed',
  order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])),
  order.join(','),
);
check(
  'each row says who did it, by name',
  (history.match(/by Faisal Shah/g) ?? []).length >= 5,
  `${(history.match(/by Faisal Shah/g) ?? []).length} attributed row(s)`,
);
await shot(admin, '28-student-history');

// From a course's roster to a student's progress, and from the name at the top
// of that page to the same profile People opens.
await openHikam(admin);
await tap(admin, 'student-ledger-fatima@example.com');
await admin.getByTestId('student-ledger-profile').waitFor({ timeout: 20000 });
await tap(admin, 'student-ledger-profile');
await admin.getByTestId('student-history').waitFor({ timeout: 20000 });
const viaLedger = await bodyText(admin);
check(
  "the student's name on their progress page opens their profile",
  /Fatima Ahmed/.test(viaLedger) && /Account created/.test(viaLedger),
);

// A manager reads the same page pinned to their own courses: Fatima's creation
// into Hikam Foundations is in their course, so it shows; a course-less row
// never can, and the lede says what the list is.
await goHome(mgr);
await tap(mgr, 'tab-people');
await tap(mgr, 'student-open-fatima@example.com');
await mgr.getByTestId('student-history').waitFor({ timeout: 20000 });
await mgr.waitForTimeout(2500);
const mgrHistory = await bodyText(mgr);
check(
  'a manager sees the history in the courses they manage, and is told that is what it is',
  mgrHistory.includes('Enrolment changes in the courses you manage') &&
    mgrHistory.includes('Account created') &&
    mgrHistory.includes('Enrolled in Hikam Foundations · Autumn 2026'),
);
check('…without a single refused read', !mgrHistory.includes('live data error'));

// The manager's student workbook is the one export whose reads are NOT the
// admin's: a course list by managerUids, one enrolment document per course,
// and audit rows pinned to those courses. A refusal anywhere means no file.
const mgrBook = await readDownload(mgr, 'student-export-workbook').catch((e) => ({ name: String(e), sheets: [] }));
const mgrSummary = tabOf(mgrBook, 'Summary');
check(
  'a manager can export the student, and the file says which courses it covers',
  !!mgrSummary && mgrSummary.rows.some((r) => r[0] === 'Scope' && r[1] === 'the courses you manage'),
  mgrSummary ? mgrSummary.rows.map((r) => r.join(': ')).join(' | ') : mgrBook.name,
);
check(
  '…with a Courses row for the course they manage and no other',
  tabOf(mgrBook, 'Courses')?.rows.slice(2).map((r) => r[0]).join(',') === 'Hikam Foundations',
  tabOf(mgrBook, 'Courses')?.rows.slice(2).map((r) => r[0]).join(','),
);

// ----------------------------------------------------------- disabled staff --
console.log('\nDisabled staff');
// The manager's session is finished with; close it BEFORE disabling them, so
// the sign-out their own listeners would otherwise meet cannot count as a
// refused subscription below.
await mgr.close();
await goHome(admin);
await tap(admin, 'tab-people');
await tap(admin, 'segment-staff');
await tap(admin, 'staff-access-manager@oursabeel.com');
// The Disabled section appears only once somebody is in it — that is the
// change landing, not a fixed wait that a slow snapshot outlives.
await admin.getByTestId('staff-disabled').waitFor({ timeout: 10000 });
check(
  'a disabled staff member leaves the main list',
  (await admin.getByTestId('staff-role-manager@oursabeel.com').filter({ visible: true }).count()) === 0,
);
await tap(admin, 'staff-disabled');
await admin.getByTestId('staff-access-manager@oursabeel.com').waitFor({ timeout: 10000 });
check('…and is found by expanding Disabled, with Re-enable still on the card', await shows(admin, 'staff-access-manager@oursabeel.com'));
await shot(admin, '29-staff-disabled');
await tap(admin, 'staff-access-manager@oursabeel.com');
await admin.waitForTimeout(2500);
check(
  're-enabling from inside the section puts them back in the main list',
  (await admin.getByTestId('staff-disabled').count()) === 0 &&
    (await shows(admin, 'staff-role-manager@oursabeel.com')),
);

// -------------------------------------------------------------------- audit --
// The auditedCall wrapper writes one entry per staff mutation — this whole run
// has performed many, through the real functions emulator. Assert the log is
// populated and correctly attributed (comprehensiveness by construction).
console.log('\nAudit log');
const audit = await readCollection('auditLog');
const actions = new Set(audit.map((e) => e.fields.action?.stringValue));
check(
  'the audit log captured the staff mutations that happened',
  ['createCohort', 'createCourse', 'createStudent', 'createSession', 'submitAttendance', 'setRecordingStatus'].every(
    (a) => actions.has(a),
  ),
  [...actions].sort().join(', '),
);
const publish = audit.find(
  (e) =>
    e.fields.action?.stringValue === 'setRecordingStatus' &&
    e.fields.detail?.mapValue?.fields?.status?.stringValue === 'published',
);
check(
  'a course-scoped entry (publish) carries its courseId + actor + detail',
  !!publish &&
    !!publish.fields.courseId?.stringValue &&
    !!publish.fields.actorUid?.stringValue &&
    publish.fields.actorRole?.stringValue === 'admin',
);
const cohortEntry = audit.find((e) => e.fields.action?.stringValue === 'createCohort');
check(
  'a cohort-level entry is course-less (null courseId → admin-only)',
  !!cohortEntry && cohortEntry.fields.courseId?.nullValue !== undefined,
);
/*
 * AND IT SAYS WHAT IT CREATED.
 *
 * A create's target does not exist until the call has run, so there is nothing
 * in the request for the wrapper's derivation to pick up — the callable has to
 * set it itself, and until it did, the most privilege-adjacent thing a manager
 * can do audited as "somebody created a student" with no way to tell which. Only
 * a real invocation of the wrapper can prove it, which is why this lives here
 * and not in a unit test.
 */
const targetsOf = (e) => e?.fields?.targets?.mapValue?.fields ?? {};
const studentEntry = audit.find((e) => e.fields.action?.stringValue === 'createStudent');
check(
  'a createStudent entry names the student it created, under the key their history is read by',
  !!targetsOf(studentEntry).studentUid?.stringValue,
  JSON.stringify(Object.keys(targetsOf(studentEntry))),
);
// BOTH renames — there and back — each naming the cohort and the name it was
// given. `find` would return whichever of the two the list happened to put
// first, which is not a property of the log.
const renames = audit.filter((e) => e.fields.action?.stringValue === 'renameCohort');
check(
  'each renameCohort entry names the cohort and the new name',
  renames.length === 2 &&
    renames.every((e) => !!targetsOf(e).cohortId?.stringValue) &&
    renames
      .map((e) => e.fields.detail?.mapValue?.fields?.name?.stringValue)
      .sort()
      .join('|') === ['Autumn 2026', 'Autumn 2026 — Term 1'].sort().join('|'),
  renames.map((e) => e.fields.detail?.mapValue?.fields?.name?.stringValue).join(', '),
);
check(
  'a createCohort entry names the cohort it created',
  !!targetsOf(cohortEntry).cohortId?.stringValue,
  JSON.stringify(Object.keys(targetsOf(cohortEntry))),
);
const sessionEntry = audit.find((e) => e.fields.action?.stringValue === 'createSession');
check(
  'a createSession entry names the session it created',
  !!targetsOf(sessionEntry).sessionId?.stringValue,
  JSON.stringify(Object.keys(targetsOf(sessionEntry))),
);

console.log('\nLive data');
check(
  'not one live subscription was refused in the entire walkthrough',
  listenerDenials.length === 0,
  [...new Set(listenerDenials)].join(' | '),
);
// An exception or rejection that reached the top of ANY page is a defect,
// whatever else passed — it was collected and printed for months without
// failing anything. The outsider's page is the one exception: its account is
// deleted under it by design, and the SDK's reaction to that is the point.
const unhandled = consoleErrors.filter((e) => /UNHANDLED/.test(e) && !e.startsWith('[outsider]'));
check(
  'nothing reached the top of a page unhandled, except on the outsider\'s',
  unhandled.length === 0,
  unhandled.slice(0, 3).join(' | '),
);

// ------------------------------------------------------------------ result --
await browser.close();
console.log(`\nconsole errors: ${consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : 'none'}`);
console.log(`screenshots in ${SHOTS}/ — look at them`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
