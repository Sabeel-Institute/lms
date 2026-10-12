#!/usr/bin/env node
/**
 * Set the oldest Android build allowed to run, in `config/app`.
 *
 *     node scripts/set-min-version.mjs <versionCode>          # against production
 *     CHECK_PROJECT=demo-sabeel-recordings FIRESTORE_EMULATOR_HOST=127.0.0.1:61300 \
 *       node scripts/set-min-version.mjs <versionCode>        # against the emulator
 *
 * Every Android build below the floor shows the update screen instead of the
 * app, before sign-in, the moment its listener sees the change. Raise it after
 * a release that older builds can no longer run against — a rules change that
 * refuses a listener they still open is the case that made it exist (a
 * student on the 12 August build, 2026-09-08). The floor is a `versionCode`,
 * not a version name: `app/android/app/build.gradle` has the current one.
 *
 * Deliberately not part of any deploy: which builds to retire is a decision,
 * and the number is typed by hand.
 */
import { createRequire } from 'node:module';
import { APP_CONFIG_DOC, COLLECTIONS, FIREBASE_PROJECT_ID } from '@sabeel/shared';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const raw = process.argv[2];
const minVersionCode = Number(raw);
if (!raw || !Number.isInteger(minVersionCode) || minVersionCode < 1) {
  console.error(`usage: set-min-version.mjs <versionCode>  (got "${raw ?? ''}")`);
  process.exit(2);
}
const PROJECT_ID = process.env.CHECK_PROJECT ?? FIREBASE_PROJECT_ID;
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const ref = db.collection(COLLECTIONS.config).doc(APP_CONFIG_DOC);
const before = (await ref.get()).data()?.minVersionCode ?? null;
await ref.set({ minVersionCode }, { merge: true });
console.log(`${PROJECT_ID}: config/app.minVersionCode ${before ?? '(unset)'} → ${minVersionCode}`);
process.exit(0);
