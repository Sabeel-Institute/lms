/**
 * Seed the SAME fixture the screens sweep uses into a already-running emulator
 * suite, and leave it there — for a native debug pass on a device.
 *
 *     npm run seed:emulators
 *
 * WHY THIS EXISTS AS ITS OWN SCRIPT. Both e2e suites seed this world and then
 * tear their emulators down with them, so neither leaves anything a device can
 * be pointed at. The device pass needs the opposite: a world that outlives the
 * seeding process, because the thing doing the looking is an APK.
 *
 * It needs the Expo dev server already up (`E2E_BASE`, default 8081), because
 * staff are Google identities the Admin SDK cannot mint: `seedWorld` drives the
 * app's own emulator sign-in row so `onUserCreate` provisions them, then
 * approves them out of band. Everything else is Admin SDK.
 *
 * Prints the student's credentials and the ids the fixture is built around.
 * See "The device pass" in docs/DEPLOY.md for the whole recipe.
 */
import { fileURLToPath } from 'node:url';
import { config } from '@sabeel-institute/ci-tools/lib/config.mjs';
import { ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { resetEmulators, seedWorld } from './lib/seed-world.mjs';

// The emulator ports and project, from ci-tools.json (`npx sabeel-ci ports`).
const STACK = config(fileURLToPath(new URL('..', import.meta.url)));
const PORTS = ports(STACK);
const EMULATOR_PROJECT_ID = STACK.emulators.project;

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8081/';
process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${PORTS.auth}`;
process.env.GCLOUD_PROJECT = EMULATOR_PROJECT_ID;

admin.initializeApp({ projectId: EMULATOR_PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();

await resetEmulators();
const browser = await chromium.launch();
const world = await seedWorld({ db, auth, browser, base: BASE });
await browser.close();

console.log('\n--- seeded ---');
console.log('student      ', world.STUDENT, '/', world.STUDENT_PASSWORD);
console.log('disabled     ', world.DISABLED_STUDENT);
for (const k of ['missed', 'dueSoon', 'blocking', 'archived']) {
  if (world[k]) console.log(`${k.padEnd(13)}`, JSON.stringify(world[k]).slice(0, 160));
}
const courses = await db.collection('courses').get();
console.log('courses      ', courses.docs.map((d) => d.data().name).join(' | '));
const sessions = await db.collection('sessions').get();
console.log('sessions     ', sessions.size);
const recs = await db.collection('recordings').get();
console.log('recordings   ', recs.size, '| published:', recs.docs.filter((d) => d.data().status === 'published').length);
const asn = await db.collection('assignments').get();
const today = new Date().toISOString().slice(0, 10);
console.log('assignments  ', asn.size, '| open:', asn.docs.filter((d) => d.data().active && (d.data().dueDate ?? '') >= today).length);
process.exit(0);
