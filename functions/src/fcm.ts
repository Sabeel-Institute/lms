import { PUSH_CHANNEL_ID, WEB_APP_URL, type PushMessage } from '@sabeel/shared';

/**
 * A notification as FCM carries it to an Android phone or a browser — the
 * Apple counterpart is `apnsPayload` in apns.ts. Its own module, importing
 * nothing relative, so `scripts/send-test-push.mjs` sends exactly this.
 */
export function fcmMessage(message: PushMessage) {
  return {
    notification: { title: message.title, body: message.body },
    // Where a tap lands, for the app to open. NOT `body` or `title` as data
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
    // Where a tapped banner lands in a browser, which can only open a URL: the
    // app's address plus the same path, which the app's routes resolve. With
    // no link FCM closes the banner and does nothing — a notification with no
    // way to act on it.
    webpush: { fcmOptions: { link: `${WEB_APP_URL}${message.path}` } },
  };
}
