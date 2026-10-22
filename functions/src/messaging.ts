import { getMessaging } from 'firebase-admin/messaging';
import { defineSecret, defineString } from 'firebase-functions/params';
import { type DeviceTokenDoc, type PushMessage } from '@sabeel/shared';
import { DEAD_TOKEN_CODES, fcmMessage } from './fcm';
import { sendToApns, type ApnsCredentials, type ApnsDevice } from './apns';
import { reportError } from './sentry';

/**
 * The one place a push leaves the server: FCM for Android and the web, Apple's
 * push service for iPhones (`apns.ts`).
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

export type Sender = (devices: DeviceTokenDoc[], message: PushMessage) => Promise<SendOutcome>;

/**
 * Whether a per-token failure code justifies deleting that registration: one
 * of `DEAD_TOKEN_CODES` (fcm.ts), which says why the list is so short.
 */
export function isDeadToken(code: string | undefined): boolean {
  return !!code && DEAD_TOKEN_CODES.has(code);
}

async function sendToFcm(tokens: string[], message: PushMessage): Promise<SendOutcome> {
  if (tokens.length === 0) return { stale: [], sent: 0 };
  const res = await getMessaging().sendEachForMulticast({ tokens, ...fcmMessage(message) });
  const stale: string[] = [];
  res.responses.forEach((r, i) => {
    if (!r.success && isDeadToken((r.error as { code?: string } | undefined)?.code)) {
      stale.push(tokens[i]);
    }
  });
  return { stale, sent: res.successCount };
}

/**
 * Apple's key, as a Secret Manager secret, and the two ids that go with it.
 * The ids are not secret: the team's is in every signed app, and the key's is
 * useless without the key.
 */
const APNS_KEY = defineSecret('APNS_KEY');
const APNS_KEY_ID = defineString('APNS_KEY_ID', {
  description: "The APNs key's id, from its file name (AuthKey_<id>.p8)",
});
const APPLE_TEAM_ID = defineString('APPLE_TEAM_ID', {
  description: 'The Apple developer team that owns the app and the APNs key',
});

/**
 * What a function must bind to send a push: every function that can reach
 * `notifyOnce` does, and `pushSecrets.test.ts` finds them and holds them to it.
 * A secret that is not bound reads as empty at runtime.
 */
export const PUSH_SECRETS = [APNS_KEY];

function apnsCredentials(): ApnsCredentials {
  const key = APNS_KEY.value();
  if (!key) throw new Error('APNS_KEY is not bound to this function: add PUSH_SECRETS to its secrets');
  return { key, keyId: APNS_KEY_ID.value(), teamId: APPLE_TEAM_ID.value() };
}

async function sendToApple(devices: ApnsDevice[], message: PushMessage): Promise<SendOutcome> {
  if (devices.length === 0) return { stale: [], sent: 0 };
  const sends = devices.map(({ token, apnsEnvironment }) => ({ token, apnsEnvironment, message }));
  const out = await sendToApns(sends, apnsCredentials());
  // Reasons only: a token is an address, and the log has no use for one.
  for (const f of out.failed) console.warn(`apns: not delivered (${f.reason})`);
  return { stale: out.dead, sent: out.delivered.length };
}

/**
 * Each device through its own service, both at once.
 *
 * ONE SERVICE FAILING DOES NOT UNDO THE OTHER. When neither delivered
 * anything, the first failure is thrown, as a lone FCM failure always was, so
 * `notifyOnce` releases its claim and the trigger retries. When one did
 * deliver, throwing would release the claim on a message somebody already has,
 * and the retry would tell them twice; so the failure is reported to Sentry
 * instead, and the count says what reached whom.
 */
const deviceSender: Sender = async (devices, message) => {
  const apple = devices.filter((d): d is Extract<DeviceTokenDoc, { platform: 'ios' }> => d.platform === 'ios');
  const google = devices.filter((d) => d.platform !== 'ios').map((d) => d.token);
  const settled = await Promise.allSettled([sendToFcm(google, message), sendToApple(apple, message)]);
  const outcomes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failures = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  const sent = outcomes.reduce((n, o) => n + o.sent, 0);
  if (failures.length > 0 && sent === 0) throw failures[0];
  for (const e of failures) await reportError(e, { source: 'push' });
  return { stale: outcomes.flatMap((o) => o.stale), sent };
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
const emulatorSender: Sender = async (devices) => {
  console.log(`[emulator] send suppressed for ${devices.length} device(s)`);
  return { stale: [], sent: devices.length };
};

/**
 * The sender in effect. Swapped in tests; production never touches this.
 *
 * A module-level handle rather than a parameter threaded through every call
 * site, matching how `zoomClient` is stubbed in `zoom.integration.test.ts`.
 * `FUNCTIONS_EMULATOR` is set by the emulator alone, never in a deployed
 * runtime, so production always starts on `deviceSender`.
 */
function defaultSender(): Sender {
  return process.env.FUNCTIONS_EMULATOR === 'true' ? emulatorSender : deviceSender;
}

let sender: Sender = defaultSender();

export function setSender(next: Sender): void {
  sender = next;
}

/** Put the default back, whatever it is here. Tests use this rather than naming
 *  `deviceSender`, so an `afterEach` cannot re-arm a real send under the emulator. */
export function resetSender(): void {
  sender = defaultSender();
}

export function send(devices: DeviceTokenDoc[], message: PushMessage): Promise<SendOutcome> {
  return sender(devices, message);
}
