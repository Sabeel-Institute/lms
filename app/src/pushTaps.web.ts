/**
 * WEB (native sibling: pushTaps.ts). Every tap on one of this app's
 * notifications, as the path it should open.
 *
 * The service worker (`public/firebase-messaging-sw.js`) handles both ends of
 * a click: with a tab of the app open it posts that tab
 * `{ type: 'push-open', data: { path } }` and brings it forward; with none, it
 * opens a new one at the app's address plus the path, which the web routes
 * resolve on their own (`linkPaths.ts`). This is the open tab's end.
 *
 * A tap posted before anything subscribed is held: a tab sitting on sign-in or
 * the rules is still a tab of the app, so the worker sends it the tap, and the
 * signed-in shell opens it once it mounts.
 */
let queued: string[] = [];
let listener: ((path: string) => void) | null = null;

if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type?: unknown; data?: { path?: unknown } } | null;
    if (message?.type !== 'push-open') return;
    const path = message.data?.path;
    if (typeof path !== 'string' || !path) return;
    if (listener) listener(path);
    else queued.push(path);
  });
}

export function onPushTap(open: (path: string) => void): () => void {
  listener = open;
  const waiting = queued;
  queued = [];
  for (const path of waiting) open(path);
  return () => {
    if (listener === open) listener = null;
  };
}
