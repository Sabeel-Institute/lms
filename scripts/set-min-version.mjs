#!/usr/bin/env node
/**
 * Set the oldest app version allowed to run, in `config/app`.
 *
 *     node scripts/set-min-version.mjs <X.Y.Z>          # against production
 *     CHECK_PROJECT=demo-sabeel-recordings \
 *       FIRESTORE_EMULATOR_HOST="127.0.0.1:$(npx sabeel-ci ports firestore)" \
 *       node scripts/set-min-version.mjs <X.Y.Z>        # against the emulator
 *
 * Every phone build below the floor shows the update screen instead of the
 * app, before sign-in, the moment its listener sees the change. Raise it after
 * a release that older builds can no longer run against — a rules change that
 * refuses a listener they still open is the case that made it exist (a
 * student on the 12 August build, 2026-09-08).
 *
 * The floor is stored as the version's code, major * 1000000 + minor * 1000 +
 * patch (ci-tools' lib/version.mjs, which build.gradle computes too), so it
 * is given here as the version and never as a number typed by hand. Builds
 * made before the version scheme carry codes up to 39, below every code it
 * gives, so any floor retires them.
 *
 * Deliberately not part of any deploy: which builds to retire is a decision.
 */
import { createRequire } from 'node:module';
import { versionCode } from '@sabeel-institute/ci-tools/lib/version.mjs';
import { APP_CONFIG_DOC, COLLECTIONS, FIREBASE_PROJECT_ID } from '@sabeel/shared';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const version = process.argv[2];
let minVersionCode;
try {
  if (process.argv.length !== 3) throw new Error('one version, X.Y.Z');
  minVersionCode = versionCode(version);
} catch (error) {
  console.error(`usage: set-min-version.mjs <X.Y.Z>  (got "${process.argv.slice(2).join(' ')}")\n${error.message}`);
  process.exit(2);
}
const PROJECT_ID = process.env.CHECK_PROJECT ?? FIREBASE_PROJECT_ID;
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const ref = db.collection(COLLECTIONS.config).doc(APP_CONFIG_DOC);
const before = (await ref.get()).data()?.minVersionCode ?? null;
await ref.set({ minVersionCode }, { merge: true });
console.log(`${PROJECT_ID}: config/app.minVersionCode ${before ?? '(unset)'} → ${minVersionCode} (v${version})`);
process.exit(0);
