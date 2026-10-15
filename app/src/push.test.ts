import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The NATIVE half of the push seam (web sibling: push.web.ts).
 *
 * It had no tests at all. `prompt` is the whole contract here — the silent path
 * must never raise the system dialog — and nothing was holding that down on
 * this side of the seam.
 */
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: vi.fn(() => Promise.resolve()),
  deleteNotificationChannelAsync: vi.fn(() => Promise.resolve()),
  requestPermissionsAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));
/** The platform the module is loaded on; set before `loadPush()`. */
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({
  Linking: { openSettings: vi.fn(() => Promise.resolve()) },
  Platform: platform,
}));
vi.mock('expo-application', () => ({
  ApplicationReleaseType: { UNKNOWN: 0, SIMULATOR: 1, ENTERPRISE: 2, DEVELOPMENT: 3, AD_HOC: 4, APP_STORE: 5 },
  getIosPushNotificationServiceEnvironmentAsync: vi.fn(),
  getIosApplicationReleaseTypeAsync: vi.fn(),
}));

import {
  deleteNotificationChannelAsync,
  getPermissionsAsync,
  getDevicePushTokenAsync,
  requestPermissionsAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import {
  ApplicationReleaseType,
  getIosApplicationReleaseTypeAsync,
  getIosPushNotificationServiceEnvironmentAsync,
} from 'expo-application';
import { PUSH_CHANNEL_ID, PUSH_CHANNEL_NAME } from '@sabeel/shared';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function device(opts: { granted: boolean; canAskAgain?: boolean; token?: string | null }) {
  const perm = { granted: opts.granted, canAskAgain: opts.canAskAgain ?? true };
  asMock(getPermissionsAsync).mockResolvedValue(perm);
  asMock(requestPermissionsAsync).mockResolvedValue(perm);
  asMock(getDevicePushTokenAsync).mockResolvedValue({
    data: opts.token === undefined ? 'fcm-native-token' : opts.token,
  });
}

/** Fresh module per test: a successful token is memoised for the process. */
async function loadPush() {
  vi.resetModules();
  return import('./push');
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'android';
});

describe('devicePushToken(false) — the silent path', () => {
  it('never raises the system dialog, however askable the device is', async () => {
    device({ granted: false, canAskAgain: true });
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(false)).resolves.toBeNull();
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('hands over a token when permission was already granted', async () => {
    device({ granted: true });
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(true)).resolves.toBe('fcm-native-token');
  });
});

describe('devicePushToken(true) — the gesture path', () => {
  it('asks, and yields the token', async () => {
    device({ granted: false });
    asMock(requestPermissionsAsync).mockResolvedValue({ granted: true, canAskAgain: true });
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(true)).resolves.toBe('fcm-native-token');
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('gives nothing back when the dialog is refused', async () => {
    device({ granted: false });
    asMock(requestPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: false });
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(true)).resolves.toBeNull();
  });
});

describe('pushPromptState', () => {
  it('reports a device that can still be asked', async () => {
    device({ granted: false, canAskAgain: true });
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('default');
  });

  it('reports a spent prompt as denied', async () => {
    device({ granted: false, canAskAgain: false });
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('denied');
  });

  it('reports granted', async () => {
    device({ granted: true });
    const { pushPromptState } = await loadPush();
    await expect(pushPromptState()).resolves.toBe('granted');
  });
});

/**
 * The channel is a two-sided contract with `sendToFcm`, and NEITHER SIDE CAN
 * CHECK THE OTHER at runtime: a send naming a channel the app never created
 * does not fail, it is quietly posted to FCM's fallback and shown under
 * "Miscellaneous". These pin this side to the shared id; the server's half is
 * pinned in senderSelection.test.ts. Both read the same constant, so what they
 * really catch is the field being dropped or a literal creeping back in.
 */
describe('the notification channel', () => {
  it('creates the channel the server addresses, before handing over a token', async () => {
    device({ granted: true });
    const { devicePushToken } = await loadPush();
    await devicePushToken(false);

    expect(setNotificationChannelAsync).toHaveBeenCalledWith(
      PUSH_CHANNEL_ID,
      expect.objectContaining({ name: PUSH_CHANNEL_NAME, importance: 4 }),
    );
  });

  it('retires the dead channel that nothing ever posted to', async () => {
    device({ granted: true });
    const { devicePushToken } = await loadPush();
    await devicePushToken(false);

    // Left behind, it sits in Android's settings as a second, permanently
    // silent entry that someone would reasonably try to configure.
    expect(deleteNotificationChannelAsync).toHaveBeenCalledWith('default');
  });

  it('still yields a token when the old channel is not there to delete', async () => {
    // A fresh install has nothing to remove, and expo rejects on an unknown
    // channel. That must not cost the device its registration.
    device({ granted: true });
    asMock(deleteNotificationChannelAsync).mockRejectedValueOnce(new Error('no such channel'));
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(false)).resolves.toBe('fcm-native-token');
  });
});

/**
 * A push that arrives while the app is OPEN is shown. expo-notifications'
 * default with no handler is to show nothing in the foreground, so the
 * promise lives entirely in one registered handler and its answer; the
 * mutation is deleting the call, or answering false.
 */
describe('a push while the app is open', () => {
  it('is shown as a banner, without a sound, from the moment the module loads', async () => {
    await loadPush();
    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    const { handleNotification } = asMock(setNotificationHandler).mock.calls[0][0] as {
      handleNotification: (n: unknown) => Promise<Record<string, boolean>>;
    };
    await expect(handleNotification({})).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
    });
  });
});

/**
 * The row a device registers is what the server reads to choose a sender: an
 * FCM send for Android, or Apple's push service for an iPhone — and, there,
 * WHICH of Apple's two services, since each refuses the other's tokens. The
 * promise is "a push sent to this row reaches this phone", so these assert the
 * row itself, not the calls that build it.
 */
describe('the row this device registers', () => {
  it('on Android, is an FCM row and asks nothing of Apple', async () => {
    const { deviceRow } = await loadPush();
    await expect(deviceRow('fcm-native-token', 5)).resolves.toEqual({
      token: 'fcm-native-token',
      platform: 'android',
      registeredAt: 5,
    });
    expect(getIosPushNotificationServiceEnvironmentAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['an Xcode build on a phone', 'development', 'development', ApplicationReleaseType.DEVELOPMENT],
    ['a build whose profile says production', 'production', 'production', ApplicationReleaseType.AD_HOC],
    // No profile at all: the simulator's tokens are the sandbox's…
    ['the simulator', 'development', null, ApplicationReleaseType.SIMULATOR],
    // …and TestFlight and the App Store deliver the app without one, on production.
    ['a TestFlight or App Store install', 'production', null, ApplicationReleaseType.APP_STORE],
  ])('on an iPhone, from %s, names the %s service', async (_what, expected, profile, release) => {
    platform.OS = 'ios';
    asMock(getIosPushNotificationServiceEnvironmentAsync).mockResolvedValue(profile);
    asMock(getIosApplicationReleaseTypeAsync).mockResolvedValue(release);
    const { deviceRow } = await loadPush();
    await expect(deviceRow('a1b2c3', 7)).resolves.toEqual({
      token: 'a1b2c3',
      platform: 'ios',
      apnsEnvironment: expected,
      registeredAt: 7,
    });
  });
});

describe('an iPhone', () => {
  it('yields its token without touching Android channels', async () => {
    platform.OS = 'ios';
    device({ granted: true, token: 'a1b2c3' });
    const { devicePushToken } = await loadPush();
    await expect(devicePushToken(false)).resolves.toBe('a1b2c3');
    expect(setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(deleteNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
