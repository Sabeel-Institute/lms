#!/usr/bin/env node
/**
 * Send one real push to one device, from the REAL project's credentials.
 *
 *     node scripts/send-test-push.mjs <fcm-token> [path]
 *     node scripts/send-test-push.mjs --apple <development|production> <iphone-token> [path]
 *
 * The device check no emulator can do: FCM has no emulator, Apple's service
 * has none either, and the functions emulator's sender is a stub, so "a push
 * is shown, and a tap opens its subject" is proved only by a real message
 * reaching a real device — with the app open and then closed. `path` is an
 * app path (`pushPaths` in @sabeel/shared); left out, a tap opens the app.
 *
 * The message is built by the functions' own code (`functions/src/fcm.ts`,
 * `functions/src/apns.ts`), imported from source, so this sends exactly what
 * a notification sends.
 *
 * An iPhone's token goes to the Apple service it came from: `development` for
 * a debug build from Xcode (an Apple-silicon simulator receives these too),
 * `production` for TestFlight and the App Store. The key is read from
 * APNS_KEY_FILE, or `~/.config/sabeel-lms/AuthKey_<APNS_KEY_ID>.p8`; its id
 * and the team id from `functions/.env.oursabeel-lms`.
 *
 * FCM sends authenticate as Application Default Credentials, or as
 * CHECK_ACCESS_TOKEN when that is set (see `check:push`).
 *
 * Writes nothing: no Firestore document, no audit row, no notification
 * record. The token is in the `devices` collection of whichever Firestore the
 * device registered with.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { fcmMessage } from '../functions/src/fcm.ts';
import { sendToApns } from '../functions/src/apns.ts';

const USAGE = `usage: send-test-push.mjs <fcm-token> [path]
       send-test-push.mjs --apple <development|production> <iphone-token> [path]`;

const message = (path = '') => ({
  title: 'Test push: a recording is ready',
  body: 'Sent by scripts/send-test-push.mjs. Safe to dismiss.',
  path,
});

const args = process.argv.slice(2);

if (args[0] === '--apple') {
  const [, environment, token, path] = args;
  if (environment !== 'development' && environment !== 'production') {
    console.error(`--apple needs the service the token came from: development or production\n${USAGE}`);
    process.exit(2);
  }
  if (!token || !/^[0-9a-f]{64,200}$/i.test(token)) {
    console.error(`an iPhone's token is hex, at least 64 characters\n${USAGE}`);
    process.exit(2);
  }
  const env = Object.fromEntries(
    readFileSync(resolve(import.meta.dirname, '..', 'functions', `.env.${FIREBASE_PROJECT_ID}`), 'utf8')
      .split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const keyFile = process.env.APNS_KEY_FILE || resolve(homedir(), '.config', 'sabeel-lms', `AuthKey_${env.APNS_KEY_ID}.p8`);
  let key;
  try {
    key = readFileSync(keyFile, 'utf8');
  } catch {
    console.error(`no push key at ${keyFile} (set APNS_KEY_FILE)`);
    process.exit(2);
  }
  const out = await sendToApns([{ token, apnsEnvironment: environment }], message(path), {
    key,
    keyId: env.APNS_KEY_ID,
    teamId: env.APPLE_TEAM_ID,
  });
  if (out.delivered.length) console.log(`accepted by Apple (${environment})`);
  else if (out.dead.length) console.log('Apple says this token will never work (wrong service, another app, or the app was removed)');
  else console.log(`not delivered: ${out.failed[0]?.reason}`);
  process.exit(out.delivered.length ? 0 : 1);
}

const [token, path] = args;
if (!token || token.length < 100) {
  console.error(`an FCM token is ~150 characters\n${USAGE}`);
  process.exit(2);
}
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');
// CHECK_ACCESS_TOKEN, as `check:push` takes it: a user token for the project's
// owner (`gcloud auth print-access-token --account=<owner>`), when Application
// Default Credentials on this machine belong to another Google account.
const accessToken = process.env.CHECK_ACCESS_TOKEN;
admin.initializeApp({
  projectId: FIREBASE_PROJECT_ID,
  ...(accessToken
    ? { credential: { getAccessToken: async () => ({ access_token: accessToken, expires_in: 3000 }) } }
    : {}),
});
const id = await admin.messaging().send({ token, ...fcmMessage(message(path)) });
console.log(`sent ${id}`);
process.exit(0);
