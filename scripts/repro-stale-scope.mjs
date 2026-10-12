#!/usr/bin/env node
/**
 * Reproduce Sentry SABEEL-RECORDING-WEB-4: a manager's cold load refuses the
 * work queue's `courseId in [...]` listeners when the persisted cache still
 * lists a course they no longer manage.
 *
 *   node scripts/repro-stale-scope.mjs delete    # the course was deleted
 *   node scripts/repro-stale-scope.mjs remove    # the manager was taken off it
 *   node scripts/repro-stale-scope.mjs none      # control: nothing changed
 *
 * Needs the emulator suite and the e2e dev server running (the same two
 * `npm run test:e2e` needs — see docs/DEV-TOOLING.md). It RESETS the emulators.
 *
 * The mechanism: the shell builds the queue's `in` scope from the FIRST
 * courses snapshot, which on a cold load with IndexedDB persistence comes from
 * the cache. Rules judge every `in` value against live data — each value must
 * pass, and `get(courses/X)` on a course that no longer exists is an evaluation
 * error — so one stale course refuses the whole query. The server's courses
 * snapshot then changes the scope and the re-issued queries succeed: a banner
 * flash and two Sentry events per stale state, self-healing.
 *
 * `delete` and `remove` reproduced the signature (two refusals, then a rendered
 * queue); `none` is the control. Since the fix — a denial of a scope the server
 * has not yet confirmed is expected, and re-tried once it is — all three must
 * render the queue and report NO refusal, and the exit code says so.
 */
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { resetEmulators, seedWorld } from './lib/seed-world.mjs';
import { EMULATOR_PORTS, WEB_PORTS } from './lib/ports.mjs';
import { EMULATOR_PROJECT_ID } from './lib/project.mjs';

// Resolved from the functions workspace, which already depends on the Admin
// SDK — the same arrangement as `check-query-shapes.mjs`.
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.auth}`;
admin.initializeApp({ projectId: EMULATOR_PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();
const BASE = process.env.E2E_WEB ?? `http://127.0.0.1:${WEB_PORTS.e2e}/`;
const MODE = process.argv[2] ?? 'delete';
if (!['delete', 'remove', 'none'].includes(MODE)) {
  console.error(`usage: repro-stale-scope.mjs delete|remove|none (got ${MODE})`);
  process.exit(2);
}

await resetEmulators();
const browser = await chromium.launch();
await seedWorld({ db, auth, browser, base: BASE });

// The seeded manager runs sw-hikam; put them on sw-arabic as well, so there is
// a second course to take away.
const mgr = (await db.collection('staffUsers').where('email', '==', 'manager@oursabeel.com').get()).docs[0];
const managerUid = mgr.id;
await db.collection('courses').doc('sw-arabic').update({
  managerUids: admin.firestore.FieldValue.arrayUnion(managerUid),
});

// One context is one browser profile: the auth session and the Firestore cache
// survive closing the page, which is what a real person's browser does.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const logs = [];
const attach = (page, tag) =>
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') logs.push(`[${tag}] ${m.text().split('\n')[0]}`);
  });
const queueLine = async (page) =>
  (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/\d+ waiting[^A-Z]*/)?.[0] ?? '(no queue line)';

// Warm: sign in, land on Today, let the cache fill with both courses.
let page = await ctx.newPage();
attach(page, 'warm');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByTestId('dev-signin-manager').waitFor({ timeout: 60_000 });
await page.getByTestId('dev-signin-manager').click();
await page.getByTestId('tab-today').waitFor({ timeout: 60_000 });
await page.waitForTimeout(6000);
console.log(`warm: ${await queueLine(page)}`);
await page.close();

// The change happens while their browser is closed, so the cache cannot learn of it.
if (MODE === 'delete') {
  await db.collection('courses').doc('sw-arabic').delete();
} else if (MODE === 'remove') {
  await db.collection('courses').doc('sw-arabic').update({
    managerUids: admin.firestore.FieldValue.arrayRemove(managerUid),
  });
}

// Cold: reopen the app in the same profile.
page = await ctx.newPage();
attach(page, 'cold');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByTestId('tab-today').waitFor({ timeout: 60_000 });
await page.waitForTimeout(8000);
const cold = await queueLine(page);
console.log(`cold: ${cold}`);

// A denial the app marks expected — the provisional scope of a cold load — is
// logged and not reported, the same convention the e2e's listener count uses.
const refused = logs.filter(
  (l) => /today(Sessions|Recordings) listener permission-denied/.test(l) && !/expected/.test(l),
);
for (const l of logs.filter((l) => !/Require cycle/.test(l))) console.log(`  ${l}`);
console.log(`\n${MODE}: ${refused.length} queue-listener refusal(s) reported`);
await browser.close();
// All three must render the queue after the cold load, and none may report a
// refusal: a provisional scope's denial is expected and re-tried, not news.
const rendered = /\d+ waiting/.test(cold);
if (!rendered) console.log(`${MODE}: the queue did not render after the cold load`);
process.exit(refused.length === 0 && rendered ? 0 : 1);
