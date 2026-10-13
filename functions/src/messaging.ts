import { getMessaging } from 'firebase-admin/messaging';
import { PUSH_CHANNEL_ID, WEB_APP_URL, type PushMessage } from '@sabeel/shared';

/**
 * The one place FCM is actually called.
 *
 * A SEAM, for the reason `zoom.ts` and `mediaUrl.ts` are seams: there is no FCM
 * emulator — none exists — so every test in this repo has to run with the send
 * stubbed. Keeping the network call behind one swappable function means the
 * decision logic above it is fully testable and only this file is unverified
 * until a real device confirms delivery.
 *
 * It also means a send failure cannot take down a trigger: per-token failures
 * come back as results, not throws, so the caller can prune dead tokens.
 */

/** Which tokens the send failed for, and are therefore dead. */
export interface SendOutcome {
  /** Tokens the transport rejected as unregistered/invalid — safe to delete. */
  stale: string[];
  /** How many messages were accepted. */
  sent: number;
}

export type Sender = (tokens: string[], message: PushMessage) => Promise<SendOutcome>;

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
 * at once. Only these two are specific to the token.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Whether a per-token failure code justifies deleting that registration. */
export function isDeadToken(code: string | undefined): boolean {
  return !!code && DEAD_TOKEN_CODES.has(code);
}

const fcmSender: Sender = async (tokens, message) => {
  if (tokens.length === 0) return { stale: [], sent: 0 };
  const res = await getMessaging().sendEachForMulticast({
    tokens,
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
  });
  const stale: string[] = [];
  res.responses.forEach((r, i) => {
    if (!r.success && isDeadToken((r.error as { code?: string } | undefined)?.code)) {
      stale.push(tokens[i]);
    }
  });
  return { stale, sent: res.successCount };
};

/**
 * Under the emulator, send nothing and prune nothing.
 *
 * There is no FCM emulator, so a send from the emulated FUNCTIONS process cannot
 * succeed — but it does not fail quietly either. It runs in its own process, so
 * a test's `setSender` cannot reach it, and whatever the Admin SDK returns for a
 * credential-less project is then interpreted as a verdict on real tokens: a
 * dead-token code would DELETE the device rows the test that triggered it is
 * still using. That is a cross-process race with a live trigger on one side, and
 * it fails as a plain assertion mismatch three tests later with nothing in the
 * log to explain it.
 *
 * Reports no stale tokens, so no device can be deleted — and reports every
 * token as delivered, so the "sent once" marker stands the way it does after a
 * real delivery. Reporting zero would read as "delivered to nobody", which
 * `notifyOnce` now treats as a failure to retry.
 */
const emulatorSender: Sender = async (tokens) => {
  console.log(`[emulator] send suppressed for ${tokens.length} token(s)`);
  return { stale: [], sent: tokens.length };
};

/**
 * The sender in effect. Swapped in tests; production never touches this.
 *
 * A module-level handle rather than a parameter threaded through every call
 * site, matching how `zoomClient` is stubbed in `zoom.integration.test.ts`.
 * `FUNCTIONS_EMULATOR` is set by the emulator alone, never in a deployed
 * runtime, so production always starts on `fcmSender`.
 */
function defaultSender(): Sender {
  return process.env.FUNCTIONS_EMULATOR === 'true' ? emulatorSender : fcmSender;
}

let sender: Sender = defaultSender();

export function setSender(next: Sender): void {
  sender = next;
}

/** Put the default back, whatever it is here. Tests use this rather than naming
 *  `fcmSender`, so an `afterEach` cannot re-arm a real send under the emulator. */
export function resetSender(): void {
  sender = defaultSender();
}

export function send(tokens: string[], message: PushMessage): Promise<SendOutcome> {
  return sender(tokens, message);
}
