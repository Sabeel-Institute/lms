import { StyleSheet } from 'react-native';
import { getTheme } from '../theme';

const t = getTheme();

/** One turn of the ring round a play button that is waiting for its file. */
export const TURN_MS = 900;

/**
 * THE RING ITSELF: a circle `size` across, centred on the button it sits
 * behind, faint all round but for one arc in the accent. Drawn here rather
 * than taken from the platform's spinner: Android's draws its arc well inside
 * its bounds, so at a play button's size it landed on the button's rim.
 */
export function ringLook(size: number) {
  return [styles.ring, { width: size, height: size, borderRadius: size / 2, marginLeft: -size / 2, marginTop: -size / 2 }];
}

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderWidth: 3,
    borderColor: t.bg.inset,
    borderTopColor: t.accent.base,
  },
});
