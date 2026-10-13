import {
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
  type NotificationResponse,
} from 'expo-notifications';

/**
 * NATIVE (web sibling: pushTaps.web.ts). Every tap on one of this app's
 * notifications, once each, as the path it should open.
 *
 * A cold start reports the launching tap twice — once through
 * `getLastNotificationResponseAsync`, after the fact, and once through the
 * listener — so taps are counted by the notification's identifier. The path
 * is the server's `data.path` (see `messaging.ts`, and `pushPaths`).
 */
const seen = new Set<string>();

export function onPushTap(open: (path: string) => void): () => void {
  const take = (response: NotificationResponse | null) => {
    if (!response) return;
    const id = response.notification.request.identifier;
    if (seen.has(id)) return;
    seen.add(id);
    const path = response.notification.request.content.data?.path;
    if (typeof path === 'string' && path) open(path);
  };
  void getLastNotificationResponseAsync().then(take, () => undefined);
  const sub = addNotificationResponseReceivedListener(take);
  return () => sub.remove();
}
