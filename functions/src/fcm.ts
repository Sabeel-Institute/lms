import { PUSH_CHANNEL_ID, type PushMessage } from '@sabeel/shared';

/**
 * FCM as the functions speak to it: the message and the verdict on a token.
 *
 * Its own module, importing nothing relative, so ci-tools' `check-push` and
 * `send-test-push` run it from source and send exactly what a notification
 * sends (`npm run check:push`, `npx sabeel-ci send-test-push`).
 */

/**
 * FCM error codes that mean "this token will never work again".
 *
 * Anything else — a quota error, a transient unavailable — must NOT delete the
 * token: pruning on a temporary failure would silently unregister a working
 * device and the only symptom would be notifications quietly stopping.
 *
 * `messaging/invalid-argument` is deliberately NOT here, though it looks like it
 * belongs: FCM also returns it for a malformed MESSAGE, so one bad title would
 * come back against every entry in the batch and prune every recipient's tokens
 * at once. Only these two are specific to the token. `check:push` asks FCM
 * about a token that cannot exist and fails unless the answer is one of these.
 */
export const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * A notification as FCM carries it to an Android phone or a browser, less the
 * token or tokens it goes to — the Apple counterpart is `apnsPayload` in
 * apns.ts.
 */
export function fcmMessage(message: PushMessage) {
  return {
    notification: { title: message.title, body: message.body },
    // Where a tap lands, for the app to open — on a phone from the tapped
    // notification, in a browser from the service worker's click handler
    // (app/public/firebase-messaging-sw.js). NOT `body` or `title` as data
    // keys: expo-notifications reads a data key named `body` as the whole JS
    // payload when it parses as JSON, and drops every key beside it (the
    // skill's "`data.body` is intercepted"). The notification block above
    // already carries the words.
    data: { path: message.path },
    // Without this every push lands in FCM's fallback channel, which Android
    // shows as "Miscellaneous" — see PUSH_CHANNEL_ID. The app creates this
    // channel before it hands over a token, so it exists by the time anything
    // can be addressed to it.
    android: { notification: { channelId: PUSH_CHANNEL_ID } },
  };
}
