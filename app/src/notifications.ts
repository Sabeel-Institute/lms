import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import {
  COLLECTIONS,
  type DeviceTokenDoc,
  type NotificationKind,
  type NotificationPrefsDoc,
} from '@sabeel/shared';
import { db } from './firebase';
import { useLiveDocState } from './liveQuery';
import { devicePushToken, pushPlatform } from './push';
import { read } from './documents';

/**
 * A person's notification switches, and this device's registration.
 *
 * `notifications/{uid}` is the first document either population may write —
 * `students` and `staffUsers` refuse self-writes on purpose, because role and
 * status ARE the security model there. Preferences are not privilege-adjacent,
 * so they live in their own document whose rules whitelist exactly these keys.
 */

/** Absent document, or absent key, means ON — see prefEnabled in @sabeel/shared. */
export function useNotificationPrefs(uid: string | null): NotificationPrefsDoc {
  return useLiveDocState<NotificationPrefsDoc>(
    () => (uid ? doc(db, COLLECTIONS.notifications, uid) : null),
    [uid],
    {
      label: 'notificationPrefs',
      map: (snap) => read('notifications', snap),
      // An empty object is the right absent value here, not null: every switch
      // defaults to ON, so "no document" and "nothing turned off" are the same
      // state and the screen should not have to tell them apart.
      empty: {},
    },
  ).value;
}

export async function setNotificationPref(
  uid: string,
  kind: NotificationKind,
  enabled: boolean,
): Promise<void> {
  // Merge, so turning one switch off does not clear the others. The rules allow
  // exactly these keys either way.
  await setDoc(
    doc(db, COLLECTIONS.notifications, uid),
    { [kind]: enabled, updatedAt: Date.now() },
    { merge: true },
  );
}

/**
 * How long a device-registration write is waited on before the caller moves on.
 *
 * FIRESTORE DOES NOT SETTLE A WRITE UNTIL THE BACKEND ACKNOWLEDGES IT. On a
 * phone with no signal that is never — and both of the writes below were
 * awaited unbounded by callers that show a spinner meanwhile. Offline, "Enable
 * notifications" spun for ever on a device whose permission had just been
 * granted, and Sign out never reached `signOut(auth)` at all, leaving somebody
 * signed in on a shared device: the exact case that call exists to prevent.
 *
 * GIVING UP ON THE WAIT IS NOT GIVING UP ON THE WRITE — for the REGISTER. The
 * SDK keeps it queued and sends it when the connection returns, and nothing
 * drops the credential in between.
 *
 * IT IS FOR THE UNREGISTER, and that is deliberate rather than overlooked.
 * `signOut` calls it and then drops the credential four lines later, so a delete
 * that has not been acknowledged is abandoned on the previous account's queue
 * and never sent. Waiting for it instead is worse — offline the button never
 * returns, and the person stays signed in on a shared device, which is the case
 * the call exists to protect. So the client stops waiting, and the leak it
 * leaves is closed on the server: `onDeviceRegistered` removes a token from
 * every other account the moment it is registered to a new one. That also
 * covers the sign-out that never ran at all, which no client-side scheme can.
 */
const WRITE_GRACE_MS = 1000;

const bounded = (write: Promise<unknown>): Promise<unknown> =>
  Promise.race([write, new Promise((resolve) => setTimeout(resolve, WRITE_GRACE_MS))]);

/**
 * Register this device to receive push, if it can.
 *
 * Returns the token, or null when this build has no way to obtain one — no
 * permission, no browser support, or the native dependency not yet wired. A
 * null is a normal outcome, not an error: the settings screen says so rather
 * than showing switches that could never fire.
 *
 * `prompt` must be true ONLY from a press handler, and the call must be the
 * first thing that handler does — see `resolveToken` in push.web.ts. Opening a
 * screen is not a gesture: a `useEffect` runs in a later task than the tap that
 * navigated there, so it carries no activation and Safari refuses it silently.
 * That is exactly the bug this argument exists to prevent, so the mount path
 * passes false and only registers a device that is already permitted.
 *
 * Keyed BY the token, so signing in twice on the same device writes the same
 * document rather than leaking a duplicate every time.
 */
export async function registerThisDevice(uid: string, prompt: boolean): Promise<string | null> {
  const token = await devicePushToken(prompt);
  if (!token) return null;
  const row: DeviceTokenDoc = {
    token,
    platform: pushPlatform,
    registeredAt: Date.now(),
  };
  await bounded(setDoc(doc(db, COLLECTIONS.notifications, uid, 'devices', token), row));
  return token;
}

/**
 * Unregister this device.
 *
 * Called on sign-out: a shared device that kept its registration would deliver
 * one student's "a recording is ready" to whoever signed in next, which is both
 * a privacy leak and the most confusing possible notification.
 *
 * Resolves the token SILENTLY. A device that already has permission still hands
 * one over — including one registered in an earlier run of the app, which is
 * exactly the leak this exists to close — but a person who never granted it is
 * not asked mid-sign-out, and no service worker is registered and waited on to
 * unregister something that was never registered.
 */
export async function unregisterThisDevice(uid: string): Promise<void> {
  const token = await devicePushToken(false);
  if (!token) return;
  await bounded(deleteDoc(doc(db, COLLECTIONS.notifications, uid, 'devices', token)));
}
