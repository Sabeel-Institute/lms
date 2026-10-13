import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { useIsFocused, usePreventRemove, useNavigation, type NavigationAction } from '@react-navigation/native';
import { Sheet } from './Sheet';
import { Button } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

export interface LeavePrompt {
  title: string;
  message: string;
  /** The safe choice; it closes the prompt and keeps the screen. */
  stay: string;
  leave: string;
}

/**
 * Hold a screen that has something unfinished.
 *
 * `when` says there is something. `settle`, if given, is tried first — finish a
 * save, wait for a post already on its way — and the screen is left as soon as
 * it succeeds, with nothing asked. With no `settle`, or when it fails, the
 * person is asked, and only the leave choice lets the navigation they asked for
 * through.
 *
 * Every way out comes here: the header's Back, Android's back button, the
 * browser's back button (React Navigation rolls the address back when a
 * removal is prevented) and a tab, which resets the stack. Closing or reloading
 * the browser tab cannot be held this way, so it gets the browser's own warning.
 *
 * `leaveFreely()` is for the screen's own navigation once its work is done —
 * "posted, now show it" — which must not be stopped by the guard it just
 * satisfied a moment before the re-render that turns it off.
 */
export function useLeaveGuard({
  when,
  settle,
  prompt,
}: {
  when: boolean;
  settle?: () => Promise<boolean>;
  prompt: LeavePrompt;
}): { element: ReactNode; leaveFreely: () => void } {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const [asking, setAsking] = useState<NavigationAction | null>(null);
  const settling = useRef(false);
  const free = useRef(false);
  // This screen's address, read when the guard switches on or the screen comes
  // back into view — never on a re-render during a held leave, by when the
  // browser has already moved to the page being left for.
  const here = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web' && focused && when) here.current = window.location.href;
  }, [focused, when]);

  /*
   * THE ADDRESS COMES BACK WITH THE SCREEN. When the browser's Back is held,
   * React Navigation rolls the address back — but only for history it
   * recorded, and a reload starts its record afresh. Held after a reload, the
   * screen stayed while the address showed the page before it: a refresh then
   * lost the form, and a second Back went two pages back. So when the person
   * chooses to stay and the address has moved without the screen, it is moved
   * forward again — at that choice, not on a timer, which a quick second Back
   * outran.
   */
  const stay = () => {
    setAsking(null);
    if (Platform.OS === 'web' && here.current && window.location.href !== here.current) window.history.forward();
  };

  usePreventRemove(when, ({ data }) => {
    if (free.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (!settle) {
      setAsking(data.action);
      return;
    }
    // A second Back while the first is settling would dispatch its action
    // twice, and a second GO_BACK takes the screen under this one with it.
    if (settling.current) return;
    settling.current = true;
    void settle().then((ok) => {
      settling.current = false;
      if (ok) {
        free.current = true;
        navigation.dispatch(data.action);
      } else {
        setAsking(data.action);
      }
    });
  });

  useEffect(() => {
    if (Platform.OS !== 'web' || !when) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers show the prompt only when this is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);

  const element = (
    <Sheet visible={asking !== null} title={prompt.title} onClose={stay} closeLabel={prompt.stay} closeTestID="leave-stay">
      <Text style={styles.message}>{prompt.message}</Text>
      <Button
        testID="leave-confirm"
        label={prompt.leave}
        variant="danger"
        block
        onPress={() => {
          const action = asking;
          setAsking(null);
          if (!action) return;
          free.current = true;
          navigation.dispatch(action);
        }}
      />
    </Sheet>
  );
  return {
    element,
    leaveFreely: () => {
      free.current = true;
    },
  };
}

const styles = StyleSheet.create({
  message: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginBottom: spacing(4) },
});
