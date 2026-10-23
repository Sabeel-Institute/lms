import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import type { DeviceTokenDoc } from '@sabeel/shared';
import { app } from './firebase';
import { VAPID_PUBLIC_KEY } from './firebase-config';

/**
 * Web side of the push seam (native sibling: push.ts).
 *
 * Web push needs three things the SDK does not supply, and missing any of them
 * fails silently rather than loudly:
 *
 *  1. A **service worker** at the origin root — `/firebase-messaging-sw.js`.
 *     It lives in `app/public/`, which `expo export` copies verbatim into
 *     `dist-web`. Firebase Hosting serves a matching real file before applying
 *     the `**` → `/index.html` rewrite, so no rewrite exception is needed, but
 *     the file must genuinely be in the export — verify against the exported
 *     bundle, never the dev server. The worker shows every push itself,
 *     whether a tab is open or not, so the page listens for none.
 *  2. A **VAPID key pair**, generated in the console. The public half is not a
 *     secret and ships in the bundle; without it `getToken` throws.
 *  3. **Notification permission**, which only a user gesture may request. The
 *     home-screen nudge and the settings screen ask, both on a press; nothing
 *     here prompts on load.
 *
 * Every failure returns null. A browser with notifications blocked, an
 * unsupported one, and a build with no VAPID key are all the same answer to the
 * caller — "this device cannot receive push" — and the settings screen says so
 * rather than showing switches that could never fire.
 */

/** The row this browser registers under its token (`DeviceTokenDoc`). */
export async function deviceRow(token: string, registeredAt: number): Promise<DeviceTokenDoc> {
  return { token, platform: 'web', registeredAt };
}

/**
 * Only a SUCCESSFUL token is remembered. Caching the null too made every failure
 * permanent for the life of the tab: a service worker that lost the activation
 * race by a second, or permission granted in browser settings a moment later,
 * left the settings screen saying "this device can't receive notifications" with
 * no way back but a reload.
 */
let cached: string | null = null;

/**
 * The checks that can be made WITHOUT awaiting anything.
 *
 * This is the synchronous half of `isSupported()`, split out because of the
 * rule in `resolveToken`: nothing may be awaited before the permission request.
 * The asynchronous half — `isSupported()`'s IndexedDB probe, which only catches
 * Firefox private browsing and Safari in an iframe — runs after the prompt,
 * where an await costs nothing.
 */
function canRequestPush(): boolean {
  return (
    !!VAPID_PUBLIC_KEY &&
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/**
 * A browser deliberately offers no way to open its own site settings — the
 * permission would be worth little if a site could reach past it. So a blocked
 * browser gets told where to look instead of a button that cannot work.
 */
export const canOpenPushSettings = false;

export function openPushSettings(): void {}

/**
 * What the settings screen should offer: ask, explain, or say nothing can be
 * done here. Read on mount, never in a press handler — it awaits.
 */
export async function pushPromptState(): Promise<
  'granted' | 'denied' | 'default' | 'unsupported'
> {
  if (!canRequestPush()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return (await isSupported().catch(() => false)) ? 'default' : 'unsupported';
}

/**
 * This device's push token, or null if it cannot have one.
 *
 * `prompt` decides whether someone who has not been asked yet IS asked. Only a
 * press handler may pass true — see `resolveToken` for why that is a hard
 * requirement and not a preference. Everything else passes false: sign-out must
 * never raise a permission dialog on the way out, and a screen opening must not
 * either.
 */
export async function devicePushToken(prompt: boolean): Promise<string | null> {
  if (cached) return cached;
  cached = await resolveToken(prompt);
  return cached;
}

async function resolveToken(prompt: boolean): Promise<string | null> {
  if (!canRequestPush()) return null;

  // Everything below is inside ONE try. Entering a try block is synchronous, so
  // this still keeps the request inside the press, while making the function
  // total — a synchronous throw here used to escape, and every caller treats
  // this as "returns null on any failure".
  try {
    // NOTHING MAY BE AWAITED ABOVE THIS LINE.
    //
    // `Notification.requestPermission()` consumes transient activation in
    // WebKit, and WebKit only honours it as the direct result of a click. An
    // await in between is enough to lose that: `isSupported()` used to run
    // here, and it awaits an IndexedDB `open()` that resolves from an
    // `onsuccess` TASK, so the request landed a whole event-loop turn after the
    // press. Safari then refused silently — no prompt, permission left at
    // 'default', the site absent from both the allowed and the blocked list,
    // which is the tell-tale symptom.
    //
    // An async function runs synchronously up to its first await, so starting
    // the request here — and awaiting the promise below — keeps it in the press.
    const decision =
      prompt && Notification.permission === 'default'
        ? Notification.requestPermission()
        : Promise.resolve(Notification.permission);

    // Past the prompt, awaits are free again.
    if ((await decision) !== 'granted') return null;
    if (!(await isSupported().catch(() => false))) return null;

    await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    // `register()` resolves as soon as the script is FETCHED, not once a worker
    // is running it. Handing that registration straight to getToken fails with
    // "Subscription failed - no active Service Worker" — on a first-ever visit
    // only, because every later load already has one activated. `ready` is the
    // promise that waits for an active worker in this page's scope.
    //
    // Raced against a timeout because `ready` never REJECTS: a worker that fails
    // to activate leaves it pending forever, and the settings screen would sit
    // on "checking" with no notice and no error — the worst of the three
    // outcomes, because it looks like it is still working.
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    if (!registration) return null;
    return await getToken(getMessaging(app), {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration,
    });
  } catch {
    // A missing service worker, a revoked key, a browser in a private mode that
    // refuses registration. None of them is worth an error banner over a
    // convenience feature.
    return null;
  }
}
