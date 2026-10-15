import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { captureError } from '../sentry';
import { db } from '../firebase';
import { reloadFromServer } from '../firestoreInit';
import { setLiveDataSession } from '../liveQuery';
import { signOut } from '../session';
import { Button, Row } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * A PAGE THAT CANNOT BE DRAWN SAYS SO, and the rest of the app stays.
 *
 * Without a boundary, one error while drawing unmounts everything React has
 * drawn: the live site went white — bar, rail and all — on a staff phone,
 * over one recording read from an old cache (SABEEL-RECORDING-WEB-7), with no
 * way out but closing the tab. Each screen is wrapped (the stack's
 * `screenLayout`), so its header's Back and the app's bar still work; the
 * app as a whole is wrapped too, for anything drawn outside a screen.
 *
 * Reported here, because a caught error never reaches the global handler that
 * reports everything else. "Try again" draws it from the server's copies: on
 * the web the browser's cache is dropped and the page loaded again when
 * nothing is waiting to be sent (`reloadFromServer`), since a copy kept from
 * before a migration would only break the screen again; otherwise, and on a
 * phone, the screen is redrawn.
 */
export class ScreenBoundary extends Component<{ where: 'screen' | 'app'; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    captureError(error, { boundary: this.props.where });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View testID="page-failed" style={styles.box}>
        <Text style={styles.title}>This page could not be shown</Text>
        <Text style={styles.text}>
          {this.props.where === 'screen'
            ? 'Something on it did not load as it should. Try again, or go back.'
            : 'Something did not load as it should. Try again.'}
        </Text>
        <Row>
          <Button
            testID="page-failed-retry"
            label="Try again"
            variant="secondary"
            hug
            // Ending Firestore ends every listener with it: expected, not a fault.
            onPress={() =>
              void reloadFromServer(db, () => setLiveDataSession(false)).then((reloading) => !reloading && this.setState({ failed: false }))
            }
          />
          {/* The whole app is this message: with no bar and no More, it is
              the only way to sign out. */}
          {this.props.where === 'app' ? (
            <Button testID="page-failed-sign-out" label="Sign out" variant="secondary" hug onPress={() => void signOut()} />
          ) : null}
        </Row>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  box: { flex: 1, padding: spacing(6), gap: spacing(3), backgroundColor: t.bg.canvas },
  title: { fontSize: 20, fontWeight: '700', color: t.text.primary },
  text: { fontSize: 15, lineHeight: 22, color: t.text.secondary },
});
