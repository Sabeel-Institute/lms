import { Linking, Platform } from 'react-native';
import {
  ApplicationReleaseType,
  getIosApplicationReleaseTypeAsync,
  getIosPushNotificationServiceEnvironmentAsync,
} from 'expo-application';
import {
  AndroidImportance,
  deleteNotificationChannelAsync,
  getDevicePushTokenAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import {
  PUSH_CHANNEL_ID,
  PUSH_CHANNEL_NAME,
  type ApnsEnvironment,
  type DeviceTokenDoc,
} from '@sabeel/shared';

/**
 * Native side of the push seam (web sibling: push.web.ts).
 *
 * `getDevicePushTokenAsync` returns the platform's own DEVICE token: FCM's on
 * Android, which `admin.messaging()` sends to, and Apple's (hex) on an iPhone,
 * which the server sends straight to Apple's push service. Its neighbour
 * `getExpoPushTokenAsync` returns an ExponentPushToken, which only Expo's own
 * push service understands — sending one of those to FCM fails with an
 * invalid-token error that reads like a configuration problem and is not one.
 * This project sends from its own functions, so it is the device token or
 * nothing.
 *
 * Every failure returns null: no permission, no Play Services, a build with no
 * messaging config. The settings screen then says this device cannot receive
 * push rather than showing switches that could never fire.
 */

/**
 * The row this device registers under its token (`DeviceTokenDoc`).
 *
 * An iPhone's row also says WHICH of Apple's two push services issued the
 * token, because each refuses the other's tokens and the server must ask the
 * right one (`functions/src/apns.ts`).
 */
export async function deviceRow(token: string, registeredAt: number): Promise<DeviceTokenDoc> {
  if (Platform.OS !== 'ios') return { token, platform: 'android', registeredAt };
  return { token, platform: 'ios', apnsEnvironment: await apnsEnvironment(), registeredAt };
}

/**
 * The service is fixed by the build that minted the token, and the build's
 * provisioning profile says which: development (an Xcode build on a phone)
 * or production. Only two installs carry no profile, and they are the two
 * ends: the SIMULATOR, whose tokens come from Apple's sandbox, and an install
 * from TestFlight or the App Store, which Apple delivers without one and which
 * always uses production.
 */
async function apnsEnvironment(): Promise<ApnsEnvironment> {
  const fromProfile = await getIosPushNotificationServiceEnvironmentAsync();
  if (fromProfile === 'development' || fromProfile === 'production') return fromProfile;
  const release = await getIosApplicationReleaseTypeAsync();
  return release === ApplicationReleaseType.SIMULATOR ? 'development' : 'production';
}

/**
 * A push that arrives while the app is OPEN is shown, as a banner.
 *
 * FCM displays a message itself only when the app is in the background or
 * closed; in the foreground it hands the message to expo-notifications, whose
 * default with no handler is to show nothing — so until 2026-09-17 a push
 * that arrived while the app was open was dropped, silently. Decided that
 * day: shown whether the app is open or closed, on every surface. No sound,
 * because the person is already here; the banner is enough. Registered at
 * module scope so it is in place before the first message can arrive. The
 * icon it draws with is the manifest's `expo.modules.notifications` pair —
 * see AndroidManifest.xml, and notificationIcon.test.ts.
 */
setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});


/**
 * Only a SUCCESSFUL token is remembered. Caching the null too made every failure
 * permanent for the life of the process: someone who declined the Android prompt
 * and then enabled notifications in system settings stayed "unavailable" until
 * the app was killed.
 */
let cached: string | null = null;

/**
 * This device's push token, or null if it cannot have one.
 *
 * `prompt` decides whether someone who has not been asked yet IS asked. The
 * settings screen passes true — a user gesture, and the one moment a person has
 * plainly asked about notifications. Sign-out passes false: it must never raise
 * the permission dialog on the way out, and someone who never granted permission
 * has no registration to drop.
 */
/**
 * Native can deep-link to its own settings page, so a blocked device gets a
 * button rather than instructions. The web sibling cannot — see there.
 */
export const canOpenPushSettings = true;

export function openPushSettings(): void {
  // openSettings REJECTS when the platform cannot honour it, and a bare `void`
  // would leave that unhandled. There is nothing useful to do about it: the
  // screen has already said where the setting lives.
  void Linking.openSettings().catch(() => undefined);
}

/**
 * What the settings screen should offer: ask, explain, or say nothing can be
 * done here. Mirrors the web sibling; `canAskAgain` is Android's way of saying
 * the prompt has been spent, which is the same dead end as a browser 'denied'.
 */
export async function pushPromptState(): Promise<
  'granted' | 'denied' | 'default' | 'unsupported'
> {
  try {
    const existing = await getPermissionsAsync();
    if (existing.granted) return 'granted';
    return existing.canAskAgain ? 'default' : 'denied';
  } catch {
    return 'unsupported';
  }
}

export async function devicePushToken(prompt: boolean): Promise<string | null> {
  if (cached) return cached;
  cached = await resolveToken(prompt);
  return cached;
}

async function resolveToken(prompt: boolean): Promise<string | null> {
  try {
    // Android 13+ requires the runtime permission. The manifest declaration is
    // already there for the lock-screen media controls (see player.ts), so this
    // is only the prompt — and it is asked from the settings screen, on a user
    // gesture, rather than on launch.
    const existing = await getPermissionsAsync();
    const granted =
      existing.granted || (prompt ? (await requestPermissionsAsync()).granted : false);
    if (!granted) return null;

    if (Platform.OS === 'android') await androidChannels();

    const token = await getDevicePushTokenAsync();
    return typeof token.data === 'string' ? token.data : null;
  } catch {
    return null;
  }
}

/** Android's notification channels; iOS has none. */
async function androidChannels(): Promise<void> {
  // Created before the first message arrives, not after: a notification
  // delivered to a channel that does not exist yet is dropped silently, and
  // the only symptom is the first one never appearing. The id is shared with
  // the server, which addresses it — see PUSH_CHANNEL_ID.
  await setNotificationChannelAsync(PUSH_CHANNEL_ID, {
    name: PUSH_CHANNEL_NAME,
    importance: AndroidImportance.HIGH,
  });
  // The old channel, which nothing ever posted to because the server named no
  // channel at all. Left alone it sits in Android's notification settings as a
  // second, permanently silent "Class recordings" that someone would
  // reasonably try to configure. Failure is ignored: on a fresh install there
  // is nothing to delete, which is not a problem.
  await deleteNotificationChannelAsync('default').catch(() => undefined);
}
