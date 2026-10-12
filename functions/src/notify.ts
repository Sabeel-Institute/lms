import { type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  prefEnabled,
  sentNotificationId,
  type DeviceTokenDoc,
  type NotificationKind,
  type NotificationPrefsDoc,
  type PushMessage,
  type SentNotificationDoc,
} from '@sabeel/shared';
import { send } from './messaging';
import { inNotifyAudience } from './notifyAudience';

/**
 * Deliver one message to one person, once.
 *
 * The one path every notification takes, so the rules that make push bearable
 * live in one place rather than several:
 *
 *  0. **Only the people this deployment may notify** (`notifyAudience.ts`):
 *     testers until switchover day, everyone after it. Checked before the
 *     "sent" marker is claimed, so a delivery is never used up on someone
 *     outside it.
 *  1. **Their switch decides.** A missing preferences document means ON — a
 *     person who has never opened the settings screen should still hear about a
 *     recording, and defaulting the absent document to OFF would mean nobody is
 *     ever notified until they visit a screen whose purpose is turning
 *     notifications off.
 *  2. **Once.** Trigger delivery is at-least-once and the scheduled job runs
 *     every morning regardless of whether yesterday's finished, so without a
 *     durable marker a student would be told twice about the same recording. The
 *     marker is written BEFORE the send, and a create that loses the race is
 *     what stops the second delivery — checking first and writing after would
 *     leave a window two invocations can both pass through. It is claimed only
 *     once there is somewhere to send: claiming it for a person with no
 *     registered device would spend the one delivery on nobody, permanently.
 *     And only ALREADY_EXISTS means "someone else claimed it" — any other create
 *     failure is rethrown, so the trigger retries rather than reporting a
 *     success that dropped the message.
 *  3. **Dead tokens are pruned, transient failures are not.** Deleting on any
 *     failure would unregister working devices during an outage, and the only
 *     symptom would be notifications quietly stopping.
 *
 * Returns whether anything was actually sent, which is what the tests assert on.
 */

/** gRPC ALREADY_EXISTS — the one create failure that means "someone else won". */
const ALREADY_EXISTS = 6;
export async function notifyOnce(
  db: Firestore,
  uid: string,
  kind: NotificationKind,
  targetId: string,
  message: PushMessage,
): Promise<boolean> {
  if (!(await inNotifyAudience(uid))) return false;

  const person = db.collection(COLLECTIONS.notifications).doc(uid);

  const prefs = (await person.get()).data() as NotificationPrefsDoc | undefined;
  if (!prefEnabled(prefs, kind)) return false;

  // Devices first. Someone who has never opened the settings screen has none,
  // and claiming the marker for them would burn the single delivery this
  // notification ever gets — registering a device an hour later would then hear
  // nothing about a recording already published.
  const devices = await person.collection('devices').get();
  const tokens = devices.docs.map((d) => (d.data() as DeviceTokenDoc).token);
  if (tokens.length === 0) return false;

  // Claim the send. `create` fails if the document exists, which is exactly the
  // "someone already did this" answer, and it is atomic — so two concurrent
  // invocations cannot both win.
  const marker = person.collection('sent').doc(sentNotificationId(kind, targetId));
  const record: SentNotificationDoc = { kind, targetId, at: Date.now() };
  try {
    await marker.create(record);
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === ALREADY_EXISTS || code === 'already-exists') return false;
    // Unavailable, deadline exceeded, a permission problem: none of them is
    // proof this was already sent. Swallowing them here would drop the message
    // and report success, so there is nothing left to retry.
    throw e;
  }

  /*
   * THE MARKER IS RELEASED IF NOTHING WAS DELIVERED. Claimed before the send so
   * two invocations cannot both win, it was also kept when the send then
   * failed: FCM unreachable, or every token refused for a transient reason —
   * and the one delivery this notification ever gets had been spent on
   * nobody. Only "every token is dead" keeps the claim, since there is nowhere
   * to deliver and pruning is the whole outcome. A send that throws is
   * rethrown after the release, so the trigger's retry — and tomorrow's sweep
   * — find the claim open again.
   */
  let outcome;
  try {
    outcome = await send(tokens, message);
  } catch (e) {
    await marker.delete().catch(() => undefined);
    throw e;
  }
  const { stale, sent } = outcome;
  for (const token of stale) {
    await person.collection('devices').doc(token).delete();
  }
  if (sent === 0 && stale.length < tokens.length) {
    await marker.delete().catch(() => undefined);
    throw new Error(`push delivered to none of ${tokens.length} device(s) for ${kind} ${targetId}`);
  }
  return sent > 0;
}
