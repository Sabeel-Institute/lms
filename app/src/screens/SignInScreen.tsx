import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { APP_NAME, FIRST_ADMIN_LOCAL_PART } from '@sabeel/shared';
import { auth } from '../firebase';
import { signInWithGoogle } from '../auth/google';
import { DISABLED_ACCOUNT, REFUSED_ACCOUNT, signInMessage } from '../auth/signInMessage';
import type { SessionEnd } from '../session';
import { devSignIn, devSignInAvailable } from '../auth/devSignIn';
import { Button, Field, Notice, Screen } from '../components/ui';
import { BUILD_LABEL } from '../buildInfo';
import { getTheme, spacing } from '../theme';
import { useOneAtATime } from '../oneAtATime';

const t = getTheme();

/**
 * The one screen both populations start from.
 *
 * Ivory, not a raspberry field: a full-bleed brand background here is the single
 * most common way to blow the palette's proportion budget. Raspberry appears
 * only on the primary button.
 */
export function SignInScreen({ ended }: { ended: SessionEnd | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { active: busy, run: once } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // WHY THE LAST SESSION ENDED, when it came after the sign-in rather than
  // inside it: refused at the door, or disabled while signed in. The session
  // learns of it as this screen comes back, or a moment later. The next
  // attempt clears it like any other error.
  useEffect(() => {
    if (ended === 'refused') setError(REFUSED_ACCOUNT);
    else if (ended === 'disabled') setError(DISABLED_ACCOUNT);
  }, [ended]);

  // `fn` is called inside the press, before any await, so the Google popup
  // still opens from the tap that asked for it.
  const run = (kind: 'google' | 'student' | 'reset' | 'dev', fn: () => Promise<void>) =>
    once(kind, async () => {
      setError(null);
      setInfo(null);
      try {
        await fn();
      } catch (e) {
        setError(signInMessage(e));
      }
    });

  return (
    <Screen title={APP_NAME}>
      {/* STUDENTS FIRST: most people signing in are students, and their form
          owns the page's one main button. */}
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
        {/* A LINK, not a second button the size of Sign in: on an empty form
            the two were identical grey bars. Muted until there is an address
            to send it to. */}
        <Pressable
          testID="signin-reset"
          accessibilityRole="button"
          accessibilityLabel="Email me a password link"
          aria-disabled={busy !== null || !email.trim()}
          disabled={busy !== null || !email.trim()}
          onPress={() =>
            void run('reset', async () => {
              await sendPasswordResetEmail(auth, email.trim().toLowerCase());
              // Deliberately the same message whether or not the address exists:
              // a differing one turns this into a way to test who has an account.
              setInfo('If that address has an account, a link is on its way.');
            })
          }
          style={styles.link}
        >
          <Text style={[styles.linkText, busy !== null || !email.trim() ? styles.linkMuted : null]}>
            {busy === 'reset' ? 'Sending the link…' : 'Email me a password link'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.divider} />

      <View style={styles.block}>
        <Text style={styles.groupHint}>Staff: sign in with your Sabeel Google account. An admin approves new accounts.</Text>
        <Button
          testID="signin-google"
          label="Sign in with Google"
          variant="secondary"
          busy={busy === 'google'}
          disabled={busy !== null}
          onPress={() => void run('google', signInWithGoogle)}
        />
      </View>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {info ? <Notice tone="info">{info}</Notice> : null}

      {devSignInAvailable ? <DevRow busy={busy !== null} run={(fn) => void run('dev', fn)} /> : null}

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
function DevRow({ busy, run }: { busy: boolean; run: (fn: () => Promise<void>) => void }) {
  // Through the screen's own `run`, as the Google door is: one press at a
  // time, and a refusal shown in the error band. Awaited on its own, the
  // outsider's — whose account the trigger deletes as it signs in — reached
  // the top of the page unhandled.
  const as = (localPart: string) => () => run(() => devSignIn(localPart).then(() => undefined));
  return (
    <View style={styles.devRow}>
      <Text style={styles.devLabel}>Emulator sign-in (dev only)</Text>
      <Button
        testID="dev-signin-first-admin"
        label={`as ${FIRST_ADMIN_LOCAL_PART} (first admin)`}
        variant="secondary"
        disabled={busy}
        onPress={as(FIRST_ADMIN_LOCAL_PART)}
      />
      <Button
        testID="dev-signin-manager"
        label="as manager"
        variant="secondary"
        disabled={busy}
        onPress={as('manager')}
      />
      <Button
        testID="dev-signin-outsider"
        label="as outsider (gets deleted)"
        variant="secondary"
        disabled={busy}
        onPress={as('someone@gmail.com')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: spacing(2) },
  groupTitle: { fontSize: 17, fontWeight: '700', color: t.text.primary, marginBottom: spacing(1) },
  groupHint: { fontSize: 14, color: t.text.secondary, marginBottom: spacing(1) },
  divider: { height: 1, backgroundColor: t.accent.gold, marginVertical: spacing(5) },
  link: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 4, justifyContent: 'center', marginTop: spacing(1) },
  // This app's link treatment (ledeLink in ui.tsx): accent and underline.
  linkText: { fontSize: 15, color: t.text.accent, textDecorationLine: 'underline' },
  linkMuted: { color: t.text.secondary, textDecorationLine: 'none' },
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
