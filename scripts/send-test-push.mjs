#!/usr/bin/env node
/**
 * Send one real push to one device token, from the REAL project.
 *
 *     node scripts/send-test-push.mjs <fcm-token> [title] [body]
 *
 * The device check no emulator can do: FCM has no emulator, and the functions
 * emulator's sender is a stub, so "a push is shown" is proved only by a real
 * message reaching a real device — with the app open (expo-notifications /
 * the page draws it) and then closed (FCM's own display draws it). Same shape
 * `fcmSender` sends: notification + data, the app's channel, the web link.
 *
 * Writes nothing: no Firestore document, no audit row, no notification
 * record. The token comes from wherever the device registered it — the
 * emulator's `devices` collection for a debug build signed in against the
 * emulators (the token is still a real FCM token for this project's sender),
 * or production's for a release build.
 */
import { createRequire } from 'node:module';
import { FIREBASE_PROJECT_ID, PUSH_CHANNEL_ID, WEB_APP_URL } from '@sabeel/shared';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const [token, title = 'Test push: a recording is ready', body = 'Sent by scripts/send-test-push.mjs — safe to dismiss.'] =
  process.argv.slice(2);
if (!token || token.length < 100) {
  console.error('usage: send-test-push.mjs <fcm-token> [title] [body]  (a token is ~150 characters)');
  process.exit(2);
}

admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });
const id = await admin.messaging().send({
  token,
  notification: { title, body },
  data: { title, body },
  android: { notification: { channelId: PUSH_CHANNEL_ID } },
  webpush: { fcmOptions: { link: WEB_APP_URL } },
});
console.log(`sent ${id}`);
process.exit(0);
