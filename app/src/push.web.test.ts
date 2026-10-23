import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rule this file exists to hold down: a permission request must be raised
 * DIRECTLY from the press that asked for it.
 *
 * This screen asked on ARRIVAL — a `useEffect`, which runs in a later task than
 * the tap that navigated there and so carries no user activation — and asked
 * only after `await isSupported()`, which awaits an IndexedDB `open()` that
 * resolves from an `onsuccess` task. Safari refuses a request that far from a
 * gesture without reporting anything: no prompt, permission left at 'default',
 * and the site in neither the allowed nor the blocked list.
 *
 * The e2e suites cannot catch a regression here — headless Chromium auto-grants
 * notification permission, so the broken and the fixed code both pass. These
 * assert the shape instead: that the silent path never asks, and that the
 * prompting path asks with nothing awaited first.
 */
vi.mock('firebase/messaging', () => ({
  isSupported: vi.fn(),
  getToken: vi.fn(),
  getMessaging: vi.fn(() => ({})),
}));
vi.mock('./firebase', () => ({ app: {} }));
vi.mock('./firebase-config', () => ({ VAPID_PUBLIC_KEY: 'test-vapid-public-key' }));

import { getToken, isSupported } from 'firebase/messaging';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

let requestPermission: ReturnType<typeof vi.fn>;

/** A browser that supports web push, in a given permission state. */
function browser(permission: 'default' | 'granted' | 'denied', answer = 'granted'): void {
  requestPermission = vi.fn(() => Promise.resolve(answer));
  const nav = {
    serviceWorker: {
      register: vi.fn(() => Promise.resolve({ scope: '/' })),
      ready: Promise.resolve({ scope: '/' }),
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'PushManager', { value: class {}, configurable: true });
  Object.defineProperty(globalThis, 'Notification', {
    value: { permission, requestPermission },
    configurable: true,
  });
}

/**
 * A fresh copy of the module per test: it memoises a successful token for the
 * life of the tab, so one test's success would otherwise answer the next before
 * it reached the code under test.
 */
async function loadPush() {
  vi.resetModules();
  return import('./push.web');
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(isSupported).mockResolvedValue(true);
  asMock(getToken).mockResolvedValue('fcm-token');
});

describe('devicePushToken(false) — the silent path', () => {
  it('never asks for permission, however supported the browser is', async () => {
    browser('default');
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(false)).resolves.toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('still hands over a token when permission was already granted', async () => {
    browser('granted');
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(false)).resolves.toBe('fcm-token');
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('devicePushToken(true) — the gesture path', () => {
  /**
   * The load-bearing test. An async function runs synchronously up to its first
   * await, so if nothing is awaited before the request, it is still inside the
   * press when it is raised. Awaiting anything first — `isSupported()`, a
   * permission read, a token lookup — moves it into a later task and this fails.
   */
  it('asks synchronously, before any promise is awaited', async () => {
    browser('default');
    const { devicePushToken } = await loadPush();
    void devicePushToken(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('asks even while the support check is still pending', async () => {
    browser('default');
    asMock(isSupported).mockReturnValue(new Promise(() => {}));
    const { devicePushToken } = await loadPush();
    void devicePushToken(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('resolves the token once permission is granted', async () => {
    browser('default');
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(true)).resolves.toBe('fcm-token');
  });

  it('gives nothing back when the prompt is declined', async () => {
    browser('default', 'denied');
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(true)).resolves.toBeNull();
  });
});

/**
 * The blocked state branches on this. A browser offers no way to open its own
 * site settings, so the screen must show instructions there rather than a
 * button that silently does nothing.
 */
/**
 * The SYNCHRONOUS half of the support check — the part that gates the prompt.
 * Every other test hands it a fully capable browser, so without these a deleted
 * capability check would pass the whole suite while letting the app call
 * requestPermission on a browser that cannot do web push at all.
 */
describe('a browser missing a capability', () => {
  it('asks nothing when PushManager is absent', async () => {
    browser('default');
    // @ts-expect-error deleting a global we installed for the test
    delete globalThis.PushManager;
    const { devicePushToken, pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('unsupported');
    await expect(devicePushToken(true)).resolves.toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks nothing when the browser has no Notification at all', async () => {
    browser('default');
    const asked = requestPermission;
    // @ts-expect-error deleting a global we installed for the test
    delete globalThis.Notification;
    const { devicePushToken, pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('unsupported');
    await expect(devicePushToken(true)).resolves.toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks nothing when there is no service worker', async () => {
    browser('default');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const { devicePushToken, pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('unsupported');
    await expect(devicePushToken(true)).resolves.toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('opening settings', () => {
  it('is not possible from a browser', async () => {
    const { canOpenPushSettings } = await loadPush();
    expect(canOpenPushSettings).toBe(false);
  });

  it('is a no-op rather than a throw, so a mis-wired caller cannot crash a screen', async () => {
    const { openPushSettings } = await loadPush();
    expect(() => openPushSettings()).not.toThrow();
  });
});

describe('pushPromptState', () => {
  it('reports a browser that can still be asked', async () => {
    browser('default');
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('default');
  });

  it('reports one that has blocked notifications', async () => {
    browser('denied');
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('denied');
  });

  it('reports an unsupported browser rather than offering a dead button', async () => {
    browser('default');
    asMock(isSupported).mockResolvedValue(false);
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('unsupported');
  });
});
