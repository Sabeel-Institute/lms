/**
 * WEB (native sibling: pushTaps.ts). A browser opens a tapped notification's
 * link itself — the app's address plus the path, which the routes resolve —
 * except when a tab of the app is already open: the service worker then
 * focuses that tab and posts it the path instead of opening a second one
 * (`firebase-messaging-sw.js`). This is the tab's end of that.
 */
export function onPushTap(open: (path: string) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return () => {};
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; path?: unknown } | null;
    if (d?.type === 'open-path' && typeof d.path === 'string' && d.path) open(d.path);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
