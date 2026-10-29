import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text } from 'react-native';
import { APP_NAME, APP_STORE_URL, PLAY_STORE_URL } from '@sabeel/shared';
import { Button, Card, Notice, Screen } from '../components/ui';
import { BUILD_LABEL } from '../buildInfo';
import { acceptRules } from '../conduct';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import { signOut } from '../session';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Where a signed-in but unusable account waits.
 *
 * These update live: the session polls while gated, so approval un-gates without
 * a sign-out. That poll exists because setting custom claims disrupts the user's
 * in-flight listener — the document snapshot announcing approval may never
 * arrive, and without the poll this screen would sit here looking broken.
 */
export function PendingScreen({ email }: { email: string }) {
  return (
    <Screen title="Waiting for approval" subtitle={email}>
      <Card>
        <Notice tone="info">
          Your Sabeel account has been recognised, but an administrator still needs to
          approve it. This page updates by itself once they do — you do not need to sign
          in again.
        </Notice>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}

export function DisabledScreen({ email }: { email: string }) {
  return (
    <Screen title="Account disabled" subtitle={email}>
      <Card>
        <Notice tone="error">
          This account no longer has access. Your listening history and records are kept;
          contact an administrator if you think this is a mistake.
        </Notice>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}

/**
 * Signed in, but no mirror document and no claims yet.
 *
 * Normally a blink: the auth-create trigger provisions within a second or two.
 * It persists only if the trigger failed or rejected the account — and a
 * rejected account is deleted outright, which signs the user straight back out.
 */
export function ProvisioningScreen() {
  return (
    <Screen title="Setting up your account">
      <Card>
        <Notice tone="info">
          One moment. If this does not clear within a few seconds, sign out and try again
          — staff accounts must use a Sabeel address.
        </Notice>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}

/**
 * THE INSTITUTE'S RULES, once per account, before anything in the app.
 *
 * In place of the whole navigator, like the gates above it, so no screen —
 * none of the places a person posts, and no URL to one — exists until the
 * account has agreed. It comes after them: an account still waiting for
 * approval has nothing to agree to yet. The server records the agreement on
 * the account's own record (`acceptRules`), and the profile listener lifts
 * this screen when it lands, on every device the account uses.
 *
 * The words are the institute's (decided 2026-10-16, `docs/STORE-RELEASE.md`
 * decision 4). They state no minimum age, on purpose: an age above the one
 * Apple calculates would force the rating up.
 */
export function RulesScreen() {
  const { active, run } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);
  // Held busy after the server has the agreement, until the listener swaps
  // this screen out: an "I agree" that comes back to life reads as refused.
  const [agreed, setAgreed] = useState(false);
  return (
    <Screen title="Before you continue">
      <Card>
        <Text style={styles.rules} testID="rules-text">
          {APP_NAME} is for Sabeel Institute’s staff and students, and what you post is seen only by members of
          your class. By continuing you agree to the institute’s rules: post only what belongs to your work or
          class, post nothing abusive, harassing, hateful, sexual or otherwise objectionable, and never abuse
          another member. The institute tolerates neither. Administrators may remove content and suspend accounts
          that break these rules. To report something or someone, use{' '}
          <Text style={styles.strong}>Report a problem</Text> in More; administrators respond within 24 hours.
        </Text>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button
          testID="rules-agree"
          label="I agree"
          busy={active === 'agree' || agreed}
          onPress={() =>
            void run('agree', async () => {
              setError(null);
              try {
                await acceptRules();
                setAgreed(true);
              } catch (e) {
                setError(errorText(e));
              }
            })
          }
        />
        <Button
          testID="rules-sign-out"
          label="Sign out"
          variant="secondary"
          disabled={agreed}
          onPress={() => void run('signOut', signOut)}
        />
      </Card>
    </Screen>
  );
}

/** Each phone updates from its own store; the web has no floor, so never shows the update screen. */
const UPDATE_STORE =
  Platform.OS === 'ios'
    ? { label: 'Open the App Store', url: APP_STORE_URL }
    : { label: 'Open Google Play', url: PLAY_STORE_URL };

/**
 * A build the institute has retired.
 *
 * Shown before sign-in, in place of the whole app, so nothing behind it runs
 * on rules it no longer matches. Sign out is offered because the
 * person may be signed in already and on a shared phone.
 */
export function UpdateScreen({ signedIn }: { signedIn: boolean }) {
  return (
    <Screen title="Update needed" subtitle={`This version of ${APP_NAME} is out of date`}>
      <Card>
        <Notice tone="info">
          Install the current build to keep using the app. Your listening records are kept;
          nothing is lost by updating.
        </Notice>
        <Button
          testID="update-open-download"
          label={UPDATE_STORE.label}
          onPress={() => void Linking.openURL(UPDATE_STORE.url)}
        />
        {signedIn ? (
          <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
        ) : null}
        <Text style={styles.build} testID="update-build-label">
          Installed: {BUILD_LABEL}
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  build: { marginTop: spacing(3), fontSize: 12, color: t.text.secondary, textAlign: 'center' },
  rules: { fontSize: 15, lineHeight: 23, color: t.text.primary, marginBottom: spacing(4) },
  strong: { fontWeight: '600' },
});
