import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  NOTIFICATION_KINDS,
  attendanceMissingMessage,
  dueDateMovedMessage,
  handInLastDayMessage,
  lastDayMessage,
  newAssignmentMessage,
  recordingReadyMessage,
  workReturnedMessage,
  type NotificationKind,
  type PushMessage,
} from '@sabeel/shared';
import { fcmMessage } from '../../src/fcm';

/**
 * The web push service worker (`app/public/firebase-messaging-sw.js`), run in
 * a fake worker scope.
 *
 * It is a classic script outside the bundle, so nothing else executes it. This
 * dispatches the events a browser would and asserts what the worker draws and
 * where a tap goes; `scripts/push-e2e.mjs` then delivers a real push of every
 * kind to it in Chromium and follows each tap to its screen.
 *
 * Every message the server builds is a case here, sent through `fcmMessage` —
 * the payload FCM carries to a browser — so the worker is held to what the
 * functions actually send. Here, in `functions/test/unit`, because that
 * workspace runs the repo's tests about files outside any one workspace.
 */
const source = readFileSync(resolve(import.meta.dirname, '../../../app/public/firebase-messaging-sw.js'), 'utf8');

type Listener = (event: unknown) => void;
type Win = { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };

function worker(windows: Win[] = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(() => Promise.resolve());
  const matchAll = vi.fn(() => Promise.resolve(windows));
  const openWindow = vi.fn((_url: string) => Promise.resolve(null));
  const skipWaiting = vi.fn(() => Promise.resolve());
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: { showNotification },
    location: { origin: 'https://lms.example' },
    skipWaiting,
  };
  runInNewContext(source, { self, clients: { matchAll, openWindow } });
  return { listeners, showNotification, openWindow, skipWaiting };
}
const win = (url: string, focus = vi.fn(() => Promise.resolve())): Win => ({ url, focus, postMessage: vi.fn() });

/** Every message the server sends, with the kind it is sent under and where its tap must land. */
const sent: Array<[string, NotificationKind, PushMessage, string]> = [
  ['recordingReady', 'recordingReady', recordingReadyMessage('Hikam', 'Session 3', '2026-11-02', 'r1'), '/play/r1'],
  ['lastDay', 'lastDay', lastDayMessage('Hikam', 'Session 3', '2026-11-02', 'r1'), '/play/r1'],
  ['assignmentPosted', 'assignmentPosted', newAssignmentMessage('Hikam', 'Memorize', '2026-11-02', 'cw1'), '/work/cw1'],
  ['dueDateMoved', 'assignmentPosted', dueDateMovedMessage('Hikam', 'Memorize', '2026-11-09', 'cw1'), '/work/cw1'],
  ['handInLastDay', 'handInLastDay', handInLastDayMessage('Hikam', 'Memorize', '2026-11-02', 'cw1'), '/work/cw1'],
  ['workReturned', 'workReturned', workReturnedMessage('Hikam', 'Memorize', 'cw1'), '/work/cw1'],
  ['attendanceMissing', 'attendanceMissing', attendanceMissingMessage('Hikam', 'Session 5', '2026-10-18', 'c1', 's1'), '/courses/c1/sessions/s1'],
];

function push(body: unknown) {
  const settled: Promise<unknown>[] = [];
  return { event: { data: { json: () => body }, waitUntil: (p: Promise<unknown>) => settled.push(p) }, settled };
}
function click(w: ReturnType<typeof worker>, data?: Record<string, string>) {
  const settled: Promise<unknown>[] = [];
  const notification = { close: vi.fn(), data };
  w.listeners.get('notificationclick')!({ notification, waitUntil: (p: Promise<unknown>) => settled.push(p) });
  return { notification, settled };
}

beforeEach(() => vi.clearAllMocks());

it('covers every kind of notification the server sends', () => {
  // A new kind must be added to `sent`, so its tap is held to the trip below
  // like the rest.
  expect([...new Set(sent.map(([, kind]) => kind))].sort()).toEqual([...NOTIFICATION_KINDS].sort());
});

describe('push', () => {
  it.each(sent)('shows %s, with its path as the notification data, even with a tab open', async (_, __, message) => {
    const w = worker([win('https://lms.example/')]);
    const { event, settled } = push(fcmMessage(message));
    w.listeners.get('push')!(event);
    await Promise.all(settled);
    expect(w.showNotification).toHaveBeenCalledWith(message.title, {
      body: message.body,
      icon: '/favicon.ico',
      tag: `${message.title}|${message.body}`,
      data: { path: message.path },
    });
  });

  it('ignores a push that is not FCM JSON', () => {
    const w = worker();
    const waitUntil = vi.fn();
    w.listeners.get('push')!({ data: { json: () => { throw new SyntaxError('not json'); } }, waitUntil });
    w.listeners.get('push')!({ data: null, waitUntil });
    expect(w.showNotification).not.toHaveBeenCalled();
  });

  it('takes over at once rather than waiting for every tab to close', () => {
    const w = worker();
    w.listeners.get('install')!({});
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('notificationclick', () => {
  it.each(sent)('tells an open tab of the app where %s points, and brings it forward', async (_, __, message) => {
    const mine = win('https://lms.example/');
    const other = win('https://elsewhere.example/');
    const w = worker([other, mine]);
    const data = fcmMessage(message).data;
    const { notification, settled } = click(w, data);
    await Promise.all(settled);
    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(mine.postMessage).toHaveBeenCalledWith({ type: 'push-open', data: { path: message.path } });
    expect(mine.focus).toHaveBeenCalledTimes(1);
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('still tells the tab where to go when the browser refuses to focus it', async () => {
    const mine = win('https://lms.example/', vi.fn(() => Promise.reject(new Error('not allowed'))));
    const w = worker([mine]);
    const { settled } = click(w, { path: 'work/cw1' });
    await Promise.all(settled);
    expect(mine.postMessage).toHaveBeenCalledTimes(1);
  });

  it.each(sent)('opens %s in a new tab at its path when no tab of the app is open', async (_, __, message, url) => {
    const w = worker([win('https://elsewhere.example/')]);
    const { settled } = click(w, fcmMessage(message).data);
    await Promise.all(settled);
    expect(w.openWindow).toHaveBeenCalledWith(url);
  });

  it('opens the app itself for a notification with no path (a test push)', async () => {
    for (const data of [undefined, { path: '' }]) {
      const w = worker([]);
      const { settled } = click(w, data);
      await Promise.all(settled);
      expect(w.openWindow).toHaveBeenCalledWith('/');
    }
  });

  it('keeps a path on this site, never another host', async () => {
    const w = worker([]);
    const { settled } = click(w, { path: '//elsewhere.example/x' });
    await Promise.all(settled);
    expect(w.openWindow).toHaveBeenCalledWith('/elsewhere.example/x');
  });
});
