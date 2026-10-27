#!/usr/bin/env node
/**
 * EVERY KIND OF NOTIFICATION, TAPPED ON THE WEB, OPENS WHAT IT IS ABOUT.
 *
 *   npm run test:e2e:push        (bash scripts/e2e-stack.sh push)
 *
 * The real service worker (`app/public/firebase-messaging-sw.js`), in Chromium:
 * for each message the server builds (the builders in @sabeel/shared, one per
 * notification kind, and the due-date move that is sent as `assignmentPosted`),
 * a push in FCM's own JSON shape (`fcmMessage` in functions/src/fcm.ts) is
 * DELIVERED to the worker (DevTools' `ServiceWorker.deliverPushMessage`, which
 * runs the worker's real `push` handler), the banner it draws is read back with
 * its data, and a `notificationclick` is dispatched on THAT notification inside
 * the worker. The app must then land on the screen the message is about: a
 * student on the recording or the assignment, staff on the session whose
 * register is missing. A real person's click is the one step this does not
 * make: no browser lets a script click its notification tray.
 *
 * Both ends of a click are covered: with the app open (the worker posts the
 * open tab the path, `pushTaps.web.ts`) and with no tab open, where the worker
 * opens a new one at `subjectUrl` — computed by the worker's own function and
 * loaded here, since a script may not open a window from a click it dispatched
 * itself.
 *
 * Full Chromium, not the headless shell: the shell refuses notification
 * permission, so the worker could draw nothing.
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config } from '@sabeel-institute/ci-tools/lib/config.mjs';
import { emulatorProject, ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';
import { chromium } from 'playwright';
import {
  NOTIFICATION_KINDS,
  attendanceMissingMessage,
  dueDateMovedMessage,
  handInLastDayMessage,
  lastDayMessage,
  newAssignmentMessage,
  recordingReadyMessage,
  workReturnedMessage,
} from '@sabeel/shared';
import { byId, resetEmulators, seedWorld, tap } from './lib/seed-world.mjs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// The emulator ports and project, from ci-tools.json (`npx sabeel-ci ports`).
const STACK = config(fileURLToPath(new URL('..', import.meta.url)));
const PORTS = ports(STACK);
const PROJECT = emulatorProject(STACK);
const BASE = process.env.E2E_BASE ?? `http://127.0.0.1:${PORTS.web}/`;
const ORIGIN = new URL(BASE).origin;

process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${PORTS.auth}`;
process.env.GCLOUD_PROJECT = PROJECT;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}
const visible = (locator, timeout = 30_000) => locator.waitFor({ timeout }).then(() => true, () => false);
async function until(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const text = (locator) => locator.innerText({ timeout: 5_000 }).catch(() => '');
/** The screen's own heading, without the chevron a heading that links carries. */
const screenTitle = async (page) => (await text(byId(page, 'screen-title'))).replace(/\s*›\s*$/, '').trim();

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

await resetEmulators();
// Chromium's own notification centre, not the desktop's: with a notification
// daemon on the machine's session bus, Chromium hands banners to it and drops
// them from `getNotifications()` when the daemon closes them, so the banner
// this suite reads back can be gone before it looks.
const browser = await chromium.launch({ channel: 'chromium', args: ['--disable-features=NativeNotifications,SystemNotifications'] });
const world = await seedWorld({ db, auth });
const { STUDENT, STUDENT_PASSWORD, dueSoon, blocking } = world;

// ---- what the server would send, about things in the seeded world ----------
const session = (await db.doc(`sessions/${blocking.id}`).get()).data();
const courseName = (await db.doc(`courses/${session.courseId}`).get()).data().name;
async function courseworkId(title) {
  const snap = await db.collection('coursework').where('title', '==', title).get();
  if (snap.size !== 1) throw new Error(`expected one assignment titled "${title}", found ${snap.size}`);
  return snap.docs[0].id;
}
const toDo = { id: await courseworkId('Memorize the first hikma'), title: 'Memorize the first hikma' };
const pastDue = { id: await courseworkId('Letter forms, week 3'), title: 'Letter forms, week 3' };
const returned = { id: await courseworkId('Reflection on the first hikma'), title: 'Reflection on the first hikma' };

/** A student lands on the recording: its player, its title, its address. */
const onRecording = (rec) => async (page) =>
  (await visible(byId(page, 'player-scrubber')))
  && (await text(byId(page, 'player-title'))).includes(rec.title)
  && new URL(page.url()).pathname === `/play/${rec.recId}`;
/** A student lands on the assignment: the control its state offers, its title, its address. */
const onWork = (cw, anchor) => async (page) =>
  (await visible(byId(page, anchor)))
  && (await screenTitle(page)) === cw.title
  && new URL(page.url()).pathname === `/work/${cw.id}`;
/** Staff land on the session, with its register open to be submitted. */
const onSession = async (page) =>
  (await visible(byId(page, 'att-submit')))
  && (await screenTitle(page)) === blocking.title
  && new URL(page.url()).pathname === `/courses/${session.courseId}/sessions/${blocking.id}`;

const DUE = '2026-11-02';
const STUDENT_CASES = [
  { kind: 'recordingReady', message: recordingReadyMessage(courseName, dueSoon.title, DUE, dueSoon.recId), landed: onRecording(dueSoon) },
  { kind: 'lastDay', message: lastDayMessage(courseName, dueSoon.title, DUE, dueSoon.recId), landed: onRecording(dueSoon) },
  { kind: 'assignmentPosted', message: newAssignmentMessage(courseName, toDo.title, DUE, toDo.id), landed: onWork(toDo, 'work-hand-in') },
  { kind: 'assignmentPosted (due date moved)', message: dueDateMovedMessage(courseName, pastDue.title, DUE, pastDue.id), landed: onWork(pastDue, 'work-hand-in') },
  { kind: 'handInLastDay', message: handInLastDayMessage(courseName, toDo.title, DUE, toDo.id), landed: onWork(toDo, 'work-hand-in') },
  { kind: 'workReturned', message: workReturnedMessage(courseName, returned.title, returned.id), landed: onWork(returned, 'work-returned') },
];
const STAFF_CASES = [
  { kind: 'attendanceMissing', message: attendanceMissingMessage(courseName, blocking.title, session.date, session.courseId, blocking.id), landed: onSession },
];
const covered = new Set([...STUDENT_CASES, ...STAFF_CASES].map((c) => c.kind.split(' ')[0]));
check('every kind of notification has a case here', NOTIFICATION_KINDS.every((k) => covered.has(k)),
  NOTIFICATION_KINDS.filter((k) => !covered.has(k)).join(', '));

// ---- one person's browser, with the worker armed --------------------------
async function signedIn(signIn, homeAnchor) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['notifications'], { origin: ORIGIN });
  const page = await context.newPage();
  await signIn(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;
  });
  /**
   * The worker of the registration at the origin root, the one the app
   * registers and pushes are delivered to. Looked up each time rather than
   * held: the browser can hold more than one worker for the same script (a
   * second registration under another scope, or a version on its way out),
   * and a handle to the wrong one reads another registration's banners.
   */
  const worker = async () => {
    for (const w of context.serviceWorkers()) {
      const root = await w.evaluate(() => self.registration.scope === `${self.location.origin}/`
        && self.serviceWorker?.state !== 'redundant').catch(() => false);
      if (root) return w;
    }
    throw new Error('no worker at the origin root');
  };
  const cdp = await context.newCDPSession(page);
  const registrations = new Map();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: list }) => {
    for (const r of list) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId);
  });
  await cdp.send('ServiceWorker.enable');
  const registrationId = await until(() => registrations.get(`${ORIGIN}/`), 10_000);
  /** Home first, so every tap has to navigate to be seen to work. */
  const home = async (p) => {
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    return visible(byId(p, homeAnchor), 60_000);
  };
  return { context, page, worker, cdp, registrationId, home };
}

/** The banners the worker is showing, with their data. */
const shown = async (worker) =>
  (await worker()).evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, data: n.data })));

/**
 * Deliver a push to the worker and wait for the banner it draws.
 *
 * One DevTools delivery was lost in CI (one push in six, with the worker and
 * the page otherwise fine and the next push shown), so a push whose banner
 * has not come within ten seconds is delivered once more, and the run says so.
 */
async function pushed(cdp, registrationId, worker, payload, match) {
  for (const attempt of [1, 2]) {
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId, data: JSON.stringify(payload) });
    const banner = await until(async () => (await shown(worker)).find(match), 10_000);
    if (banner && attempt > 1) console.log('  ..   the push was delivered a second time');
    if (banner) return banner;
  }
  return undefined;
}

async function tapEach(who, cases, browserOf) {
  const { context, page, worker, cdp, registrationId, home } = browserOf;
  check(`${who}: the worker is registered at the origin root`, Boolean(registrationId));
  for (const c of cases) {
    console.log(`\n${who} · ${c.kind}`);
    // What FCM hands the worker: `fcmMessage`'s notification and data.
    const payload = { notification: { title: c.message.title, body: c.message.body }, data: { path: c.message.path } };
    const same = (n) => n.title === c.message.title && n.body === c.message.body;

    // -- the app open: the worker draws the push, the tap is posted to the tab --
    check(`${c.kind}: the app is on its home screen before the tap`, await home(page));
    const banner = await pushed(cdp, registrationId, worker, payload, same);
    check(`${c.kind}: the push is shown, with its words and its path`,
      Boolean(banner) && JSON.stringify(banner.data) === JSON.stringify(payload.data),
      JSON.stringify(banner ?? await shown(worker)));
    await (await worker()).evaluate(async ({ title, body }) => {
      const n = (await self.registration.getNotifications()).find((x) => x.title === title && x.body === body);
      // eslint-disable-next-line no-undef -- runs in the worker, where it is a global
      if (n) self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
    }, payload.notification);
    check(`${c.kind}: tapping it opens ${c.message.path} in the open tab`, await c.landed(page), page.url());
    check(`${c.kind}: the tapped notification is closed`, await until(async () => !(await shown(worker)).some(same)));

    // -- no tab open: the worker's own address for it, in a tab of its own ------
    // eslint-disable-next-line no-undef -- the worker's own function, run in the worker
    const url = await (await worker()).evaluate((data) => subjectUrl(data), payload.data);
    const fresh = await context.newPage();
    await fresh.goto(new URL(url, BASE).href, { waitUntil: 'domcontentloaded' });
    check(`${c.kind}: the address the worker opens lands there too (${url})`, await c.landed(fresh), fresh.url());
    await fresh.close();
  }
  await context.close();
}

try {
  await tapEach('student', STUDENT_CASES, await signedIn(async (page) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await byId(page, 'signin-email').fill(STUDENT.email);
    await byId(page, 'signin-password').fill(STUDENT_PASSWORD);
    await tap(byId(page, 'signin-student'));
    await byId(page, 'tab-todo').waitFor({ timeout: 60_000 });
  }, 'tab-todo'));

  await tapEach('staff', STAFF_CASES, await signedIn(async (page) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await tap(byId(page, 'dev-signin-first-admin'), 60_000);
    await byId(page, 'tab-today').waitFor({ timeout: 60_000 });
  }, 'tab-today'));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.name}`);
  process.exit(1);
}
