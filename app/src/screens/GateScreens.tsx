import { Linking, StyleSheet, Text } from 'react-native';
import { APP_NAME, DOWNLOAD_PAGE_URL } from '@sabeel/shared';
import { Button, Card, Notice, Screen } from '../components/ui';
import { BUILD_LABEL } from '../buildInfo';
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
 * A build the institute has retired.
 *
 * Shown before sign-in, in place of the whole app, so nothing behind it runs
 * on rules it no longer matches. The download page is the app's own — the
 * store rule that keeps every screen from naming a way to get an ACCOUNT does
 * not cover pointing at the app itself. Sign out is offered because the
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
          label="Open the download page"
          onPress={() => void Linking.openURL(DOWNLOAD_PAGE_URL)}
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
});
