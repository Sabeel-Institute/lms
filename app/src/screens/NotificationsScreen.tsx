import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import {
  NOTIFICATION_DESCRIPTION,
  PUSH_DEVICE_MESSAGE,
  NOTIFICATION_LABEL,
  STAFF_KINDS,
  STUDENT_KINDS,
  prefEnabled,
  type NotificationKind,
} from '@sabeel/shared';
import { Button, Card, Notice, Screen, SectionTitle, SwitchRow } from '../components/ui';
import { registerThisDevice, setNotificationPref, useNotificationPrefs } from '../notifications';
import { canOpenPushSettings, openPushSettings, pushPromptState } from '../push';
import { getTheme } from '../theme';
import { errorText } from '../errors';
import { useMyCoursesState } from '../structure';

const t = getTheme();

type DeviceState = 'checking' | 'ready' | 'canAsk' | 'blocked' | 'unavailable';

/**
 * One switch per message, for whichever population is looking.
 *
 * Permission is asked on the BUTTON below, never on arrival. Opening a screen
 * is not a user gesture: the effect that runs on mount is a later task than the
 * tap that navigated here, so it carries no user activation, and Safari refuses
 * a permission request that far from a click — silently, leaving permission at
 * 'default' and the site in neither the allowed nor the blocked list. Mounting
 * therefore only registers a device that is ALREADY permitted, which needs no
 * gesture and keeps every working device working with no extra click.
 *
 * A device that cannot receive push says so rather than showing switches that
 * could never fire — an off switch and a switch with nothing behind it look
 * identical, and the second one is a lie.
 */
export function NotificationsScreen({ uid, isStudent }: { uid: string; isStudent: boolean }) {
  const prefs = useNotificationPrefs(uid);
  const [device, setDevice] = useState<DeviceState>('checking');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * ON EVERY RETURN TO THE APP, not only on mount.
   *
   * The blocked branch's only control is "Open settings", which sends people
   * out to the OS — and permission is not re-askable from in here, so coming
   * back is the whole of the recovery path. A mount-only check meant they
   * returned to a screen still saying "blocked", with the one button that had
   * just worked and nothing that would claim the token. `AppState`, not
   * `useFocusEffect`: this screen never loses focus within the navigator,
   * because the trip is out of the app entirely.
   */
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void (async () => {
        const state = await pushPromptState();
        if (cancelled) return;
        if (state !== 'granted') {
          setDevice(state === 'default' ? 'canAsk' : state === 'denied' ? 'blocked' : 'unavailable');
          return;
        }
        // Already permitted: claim the token silently so a device that granted
        // permission in an earlier visit — or in the settings app a moment ago —
        // keeps receiving without being asked again.
        const token = await registerThisDevice(uid, false).catch(() => null);
        if (!cancelled) setDevice(token ? 'ready' : 'unavailable');
      })();

    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [uid]);

  // The permission request must be the FIRST thing this handler does — see
  // resolveToken in push.web.ts. setAsking is synchronous, so it does not
  // separate the press from the request; an await here would.
  const turnOn = () => {
    setAsking(true);
    setError(null);
    void (async () => {
      const token = await registerThisDevice(uid, true).catch(() => null);
      setAsking(false);
      if (token) return setDevice('ready');
      // A null is not necessarily a refusal — permission can be granted and the
      // token still unobtainable — so re-read rather than assuming. It also
      // keeps the button when an Android dialog was dismissed rather than
      // refused, instead of sending someone to un-block what they never blocked.
      const state = await pushPromptState();
      setDevice(state === 'denied' ? 'blocked' : state === 'default' ? 'canAsk' : 'unavailable');
    })();
  };

  /*
   * THE STAFF MESSAGE GOES TO A CLASS'S MANAGERS, so only they get its switch.
   *
   * `notifyAttendanceMissing` sends to `course.managerUids` and to nobody else.
   * An admin who runs the institute but manages no class was shown a switch for
   * a message that could never arrive — a control whose only possible effect was
   * to turn off something already silent. Reading their own classes is the same
   * question the work queue asks, and it answers itself for a manager, who is by
   * definition in at least one.
   */
  const myCourses = useMyCoursesState(isStudent ? null : uid, 'notifications');
  // `null` is "not answered yet", not "none": a manager saw "You are not
  // assigned to any class" for the length of every cold load.
  const checking = !isStudent && myCourses === null;
  const managesAClass = (myCourses?.length ?? 0) > 0;
  const kinds: NotificationKind[] = isStudent
    ? STUDENT_KINDS
    : managesAClass
      ? STAFF_KINDS
      : [];

  const toggle = (kind: NotificationKind, next: boolean) =>
    void (async () => {
      setError(null);
      try {
        await setNotificationPref(uid, kind, next);
      } catch (e) {
        setError(errorText(e));
      }
    })();

  return (
    // No title of its own: the header bar above it says "Notifications", and
    // stays put while the page scrolls under it.
    <Screen>
      {error ? <Notice tone="error">{error}</Notice> : null}

      {device === 'canAsk' ? (
        <Card>
          <Notice tone="info">{PUSH_DEVICE_MESSAGE.canAsk}</Notice>
          <Button
            testID="enable-push"
            label="Enable notifications"
            onPress={turnOn}
            busy={asking}
          />
        </Card>
      ) : null}

      {device === 'ready' ? (
        <Notice tone="info">{PUSH_DEVICE_MESSAGE.ready}</Notice>
      ) : null}

      {/* THE FIX GOES IN THE BOX, not under it. The problem was tinted and the
          remedy was a grey line outside the notice — emphasis on the half
          nobody can act on. One block, and it ends with what to do.

          Native can open its own settings page and gets a card to group the
          notice with the button; a browser cannot, so there the card would wrap
          a tinted block in an empty one and contribute nothing but a ring. */}
      {device === 'blocked' ? (
        canOpenPushSettings ? (
          <Card>
            <Notice tone="info">{PUSH_DEVICE_MESSAGE.blockedNative}</Notice>
            <Button label="Open settings" variant="secondary" onPress={openPushSettings} />
          </Card>
        ) : (
          <Notice tone="info">{PUSH_DEVICE_MESSAGE.blockedWeb}</Notice>
        )
      ) : null}

      {device === 'unavailable' ? (
        <Notice tone="info">{PUSH_DEVICE_MESSAGE.unavailable}</Notice>
      ) : null}

      <SectionTitle>Send me</SectionTitle>
      <Card>
        {/* NEVER AN EMPTY CARD. An admin who manages no class has no switches,
            and a bare ring with nothing in it reads as a screen that failed to
            load rather than as an answer. */}
        {checking ? (
          <Text style={styles.none}>Checking your classes…</Text>
        ) : kinds.length === 0 ? (
          <Text style={styles.none} testID="notify-none">
            Messages about a class go to the people who manage it. You are not
            assigned to any class, so there is nothing to send you.
          </Text>
        ) : null}
        {kinds.map((kind, i) => (
          <View key={kind} style={i > 0 ? styles.divided : undefined}>
            <SwitchRow
              testID={`notify-${kind}`}
              label={NOTIFICATION_LABEL[kind]}
              description={NOTIFICATION_DESCRIPTION[kind]}
              on={prefEnabled(prefs, kind)}
              onChange={(next) => toggle(kind, next)}
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  divided: { borderTopWidth: 1, borderTopColor: t.border.subtle },
  none: { fontSize: 14, color: t.text.secondary, lineHeight: 20 },
});
