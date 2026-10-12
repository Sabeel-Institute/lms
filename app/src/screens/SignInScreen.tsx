import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { APP_NAME, FIRST_ADMIN_LOCAL_PART } from '@sabeel/shared';
import { auth } from '../firebase';
import { signInWithGoogle } from '../auth/google';
import { signInMessage } from '../auth/signInMessage';
import { devSignIn, devSignInAvailable } from '../auth/devSignIn';
import { Button, Field, Notice, Screen } from '../components/ui';
import { BUILD_LABEL } from '../buildInfo';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The one screen both populations start from.
 *
 * Ivory, not a raspberry field: a full-bleed brand background here is the single
 * most common way to blow the palette's proportion budget. Raspberry appears
 * only on the primary button.
 */
export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<null | 'google' | 'student' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const run = async (kind: 'google' | 'student' | 'reset', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(signInMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={APP_NAME}>
      <View style={styles.block}>
        <Text style={styles.groupTitle}>Staff</Text>
        <Text style={styles.groupHint}>
          Sign in with your Sabeel Google account. New accounts need an admin to approve
          them before they can be used.
        </Text>
        <Button
          testID="signin-google"
          label="Sign in with Google"
          busy={busy === 'google'}
          disabled={busy !== null}
          onPress={() => void run('google', signInWithGoogle)}
        />
      </View>

      <View style={styles.divider} />

      <View style={styles.block}>
        <Text style={styles.groupTitle}>Students</Text>
        <Text style={styles.groupHint}>
          Use the email address your teacher registered, and the password you set from
          the emailed link.
        </Text>
        <Field
          testID="signin-email"
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
        />
        <Field
          testID="signin-password"
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <Button
          testID="signin-student"
          label="Sign in"
          busy={busy === 'student'}
          disabled={busy !== null || !email.trim() || !password}
          onPress={() =>
            void run('student', async () => {
              await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
            })
          }
        />
        <Button
          label="Email me a password link"
          variant="secondary"
          busy={busy === 'reset'}
          disabled={busy !== null || !email.trim()}
          onPress={() =>
            void run('reset', async () => {
              await sendPasswordResetEmail(auth, email.trim().toLowerCase());
              // Deliberately the same message whether or not the address exists:
              // a differing one turns this into a way to test who has an account.
              setInfo('If that address has an account, a link is on its way.');
            })
          }
        />
      </View>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {info ? <Notice tone="info">{info}</Notice> : null}

      {devSignInAvailable ? <DevRow busy={busy !== null} /> : null}

      {/* Every Sabeel app shows its version + build commit here, so a screenshot
          of a problem always identifies the exact build. See buildInfo.ts. */}
      <Text style={styles.build} testID="build-label">
        {BUILD_LABEL}
      </Text>
    </Screen>
  );
}

/**
 * Emulator-only. Present so authenticated screens can be reached by a script —
 * the sign-in screen is the only one an unauthenticated screenshot can capture,
 * and it is evidence about nothing else.
 *
 * Gated on IS_DEV *and* the emulator flag. Grepping the bundle proves nothing —
 * strings survive minification; `npm run smoke:prod` proves it does not RENDER
 * on the live site (no `dev-signin-*` rows).
 */
function DevRow({ busy }: { busy: boolean }) {
  const [pending, setPending] = useState(false);
  const as = (localPart: string) => async () => {
    setPending(true);
    try {
      await devSignIn(localPart);
    } finally {
      setPending(false);
    }
  };
  return (
    <View style={styles.devRow}>
      <Text style={styles.devLabel}>Emulator sign-in (dev only)</Text>
      <Button
        testID="dev-signin-first-admin"
        label={`as ${FIRST_ADMIN_LOCAL_PART} (first admin)`}
        variant="secondary"
        disabled={busy || pending}
        onPress={() => void as(FIRST_ADMIN_LOCAL_PART)()}
      />
      <Button
        testID="dev-signin-manager"
        label="as manager"
        variant="secondary"
        disabled={busy || pending}
        onPress={() => void as('manager')()}
      />
      <Button
        testID="dev-signin-outsider"
        label="as outsider (gets deleted)"
        variant="secondary"
        disabled={busy || pending}
        onPress={() => void as('someone@gmail.com')()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: spacing(2) },
  groupTitle: { fontSize: 17, fontWeight: '700', color: t.text.primary, marginBottom: spacing(1) },
  groupHint: { fontSize: 14, color: t.text.secondary, marginBottom: spacing(1) },
  divider: { height: 1, backgroundColor: t.accent.gold, marginVertical: spacing(6) },
  devRow: {
    marginTop: spacing(8),
    padding: spacing(3),
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: t.border.strong,
  },
  devLabel: { fontSize: 12, color: t.text.muted, marginBottom: spacing(1) },
  build: {
    marginTop: spacing(8),
    textAlign: 'center',
    fontSize: 12,
    color: t.text.muted,
  },
});
