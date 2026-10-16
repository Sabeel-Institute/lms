import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { APP_NAME, PRIVACY_URL, type Role } from '@sabeel/shared';
import { Sheet, SheetOption, SheetSection } from './Sheet';
import { signOut } from '../session';
import { sendMyPasswordReset } from '../students';
import { BUILD_LABEL } from '../buildInfo';
import { IS_DEV } from '../env';
import { getTheme, spacing } from '../theme';
import type { RootStackParamList } from '../nav';
import { errorText } from '../errors';

const t = getTheme();

/**
 * Everything behind "More" — the tail of the navigation.
 *
 * RENDERED BY THE SHELL, not by the bar, and that is not tidiness. An overlay
 * is not part of the control that opens it, and keeping it here means the bar
 * and the rail can live at different places in the tree — which is what lets
 * the bar sit AFTER the content in reading order on a phone while the rail sits
 * before it on a wide screen. Held inside the bar, crossing the breakpoint
 * unmounted the sheet and threw away whatever was open.
 *
 * What belongs here is what you need occasionally rather than daily. A screen
 * visited twice in an account's life does not earn a permanent slot, however
 * often it gets proposed for one.
 *
 * `onNavigate` closes the sheet itself, so nothing here calls `onClose` before
 * it. The rows that leave the app — the privacy policy, signing out — still do,
 * because those go nowhere the shell knows about.
 */
export function MoreSheet({
  visible,
  role,
  email,
  onClose,
  onNavigate,
}: {
  visible: boolean;
  role: Role;
  email: string;
  onClose: () => void;
  /** Always a push: a More destination is somewhere you come back from. */
  onNavigate: (route: keyof RootStackParamList) => void;
}) {
  const [sent, setSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const isStudent = role === 'student';
  const isAdmin = role === 'admin';

  return (
    <Sheet visible={visible} title="More" onClose={onClose} closeAt="corner">
      {isAdmin ? (
        <>
          <SheetSection label="Institute" />
          <SheetOption
            label="Audit history"
            detail="Every change, who made it and when"
            testID="more-audit"
            onPress={() => onNavigate('Audit')}
          />
        </>
      ) : null}

      {/* A label only when there is another section to tell it from. */}
      {isAdmin ? <SheetSection label="You" /> : null}
      {/* A MANAGER'S OWN ACTIONS, which their class-scoped audit view cannot
          show: creating a student account without naming a course produces an
          entry belonging to no course, so the one thing a manager most needs to
          be able to point at was the one thing they could not see. An admin's
          Institute view already contains it. */}
      {role === 'manager' ? (
        <SheetOption
          label="Your actions"
          detail="Everything you have changed, newest first"
          testID="more-my-audit"
          onPress={() => onNavigate('MyAudit')}
        />
      ) : null}
      <SheetOption
        label="Help"
        detail="Short films of how to use the app"
        testID="more-help"
        onPress={() => onNavigate('Help')}
      />
      {/* Where the institute's rules say it is, for staff and students alike:
          the one way to tell the administrators about something or someone in
          the app. Beside Help, where a person with a problem looks. */}
      <SheetOption
        label="Report a problem"
        detail="Tell the administrators about something or someone"
        testID="more-report"
        onPress={() => onNavigate('Report')}
      />
      <SheetOption
        label="Notifications"
        detail="Choose which messages this device receives"
        testID="more-notifications"
        onPress={() => onNavigate('Notifications')}
      />
      {/* STUDENTS ONLY, and it is a first-party reset — an emailed link, no
          third-party login service involved, so it triggers nothing under
          Guideline 4.8. Staff have no password to change: their credential is
          the institute's Google account, and offering to reset it here would be
          offering to change something this app does not own. */}
      {isStudent ? (
        <SheetOption
          label={resetError ? 'Could not send the link' : sent ? 'Reset link sent' : 'Change password'}
          detail={
            resetError ?? (sent ? `Check ${email}` : 'We email you a link to set a new one')
          }
          tone={resetError ? 'danger' : 'normal'}
          testID="more-password"
          onPress={() => {
            // Reported only once it has actually gone. Saying "sent" the instant
            // the button is pressed says it whether or not anything was sent,
            // and the person then waits for an email that is not coming.
            setSent(false);
            setResetError(null);
            void sendMyPasswordReset(email)
              .then(() => setSent(true))
              .catch((e) => setResetError(errorText(e)));
          }}
        />
      ) : null}
      {/* Required to be reachable INSIDE the app, not just in store metadata —
          Apple 5.1.1(i). Absolute URL so it opens from a phone as well as a
          browser. */}
      <SheetOption
        label="Privacy policy"
        testID="more-privacy"
        onPress={() => {
          onClose();
          void Linking.openURL(PRIVACY_URL).catch(() => undefined);
        }}
      />
      {/* Staff only, because `Tokens` is registered in the staff arm of the
          navigator alone — offered to a student it navigates nowhere. */}
      {IS_DEV && !isStudent ? (
        <SheetOption
          label="Design tokens"
          onPress={() => onNavigate('Tokens')}
        />
      ) : null}
      {/* NOT `danger`. Signing out is reversible, and this app reserves that
          register for permanent deletion — the same call already settled for
          Disable. In this very sheet `danger` also means a genuine failure
          ("Could not send the link"), so spending it on the routine way out
          left the two indistinguishable. */}
      <SheetOption
        label="Sign out"
        testID="more-sign-out"
        onPress={() => {
          onClose();
          void signOut();
        }}
      />

      {/* The running build, in the app rather than only on the sign-in screen.
          "Is that fixed for you?" is unanswerable once you are signed in if the
          only place the version appears is the screen you have already left. */}
      <View style={styles.build}>
        <Text style={styles.buildText}>
          {APP_NAME} · {BUILD_LABEL}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  build: { alignItems: 'center', paddingTop: spacing(3) },
  buildText: { fontSize: 11, color: t.text.muted },
});
