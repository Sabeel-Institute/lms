import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WaitingRing } from './WaitingRing';
import { SKIP_BACK_MS, SKIP_FORWARD_MS } from '../playback';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The play/pause mark, drawn from borders rather than typed. A "▶" character
 * renders as a colour emoji on some Android builds, which is a different size
 * and a different colour from everything around it; see `Transport` below.
 *
 * `scale` because the docked bar's button is 44px against the player's 72px,
 * and the same glyph in both filled the small one to its edges. The mark is
 * built from borders, so it cannot simply be given a font size; it is scaled.
 */
export function PlayPauseGlyph({
  playing,
  disabled,
  scale = 1,
}: {
  playing: boolean;
  disabled?: boolean;
  scale?: number;
}) {
  const sized = scale === 1 ? null : { transform: [{ scale }] };
  return playing ? (
    <View style={[styles.pauseGlyph, sized]}>
      <View style={styles.pauseBar} />
      <View style={styles.pauseBar} />
    </View>
  ) : (
    <View style={[styles.playGlyph, disabled ? styles.playGlyphDisabled : null, sized]} />
  );
}

/**
 * Play / pause and the two skip controls.
 *
 * The glyphs are DRAWN, not typed. A "▶" character renders as a colour emoji on
 * some Android builds, which ignores the theme colour entirely and lands a blue
 * triangle in the middle of the brand palette — the `expo-firebase-stack` skill
 * calls this out. A bordered triangle and two bars are deterministic everywhere.
 */
export function Transport({
  playing,
  disabled,
  waiting,
  onPlayPause,
  onBack,
  onForward,
}: {
  playing: boolean;
  disabled?: boolean;
  /**
   * The file is on its way: the skips wait for it, but Play does not. A tap
   * now starts it the moment it can (`startWhenReady`), and a ring turns
   * around the button until then.
   */
  waiting?: boolean;
  onPlayPause: () => void;
  onBack: () => void;
  onForward: () => void;
}) {
  const playOff = disabled && !waiting;
  return (
    <View style={styles.row}>
      <Skip
        label={String(SKIP_BACK_MS / 1000)}
        direction="back"
        disabled={disabled}
        onPress={onBack}
        testID="player-back"
      />

      <View style={styles.playSlot}>
        {waiting ? <WaitingRing size={PLAY + 14} testID="player-waiting" /> : null}
        <Pressable
          testID="player-play"
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          aria-disabled={!!playOff}
          aria-busy={!!waiting}
          disabled={playOff}
          onPress={onPlayPause}
          style={({ pressed }) => [
            styles.playButton,
            pressed && !playOff ? styles.pressed : null,
            playOff ? styles.playDisabled : null,
          ]}
        >
          {/* Nudged right inside `playGlyph`: a triangle's visual centre sits
              left of its bounding box, so centring the box looks off-centre. */}
          <PlayPauseGlyph playing={playing} disabled={playOff} />
        </Pressable>
      </View>

      <Skip
        label={String(SKIP_FORWARD_MS / 1000)}
        direction="forward"
        disabled={disabled}
        onPress={onForward}
        testID="player-forward"
      />
    </View>
  );
}

export function Skip({
  label,
  direction,
  disabled,
  onPress,
  testID,
  size = 56,
}: {
  label: string;
  direction: 'back' | 'forward';
  disabled?: boolean;
  onPress: () => void;
  testID: string;
  /**
   * The ring's diameter. 56 on the player, beside a 72px play button; 44 in the
   * docked bar, beside a 44px one — where left at 56 the skips were 27% LARGER
   * than the control they flank, so the bar's primary was the smallest thing on
   * it and sat exactly at the touch-target floor.
   */
  size?: number;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={
        direction === 'back' ? `Back ${label} seconds` : `Forward ${label} seconds`
      }
      aria-disabled={!!disabled}
      disabled={disabled}
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => [
        styles.skip,
        { width: size, height: size, borderRadius: size / 2 },
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.skipDisabled : null,
      ]}
    >
      {/* THE DIRECTION IS THE POINT, so it is drawn at the size of the number
          rather than a typed guillemet three pixels wide. Two rings reading "15"
          and "30" with a hairline mark above each say nothing about which way
          they go, and the durations are asymmetric so the number cannot be read
          as the cue either. */}
      <MaterialIcons
        name="replay"
        size={18}
        color={disabled ? t.text.muted : t.text.secondary}
        style={direction === 'forward' ? styles.flip : undefined}
      />
      <Text style={[styles.skipNumber, disabled ? styles.skipTextDisabled : null]}>{label}</Text>
    </Pressable>
  );
}

const PLAY = 72;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing(7),
    marginTop: spacing(4),
  },
  // The ring sits round the button, centred on it, and takes no taps.
  playSlot: { width: PLAY, height: PLAY, alignItems: 'center', justifyContent: 'center' },
  playButton: {
    width: PLAY,
    height: PLAY,
    borderRadius: PLAY / 2,
    backgroundColor: t.accent.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playDisabled: { backgroundColor: t.bg.inset },
  pressed: { opacity: 0.85 },
  playGlyph: {
    width: 0,
    height: 0,
    marginLeft: 6,
    borderTopWidth: 13,
    borderBottomWidth: 13,
    borderLeftWidth: 22,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: t.accent.onAccent,
  },
  playGlyphDisabled: { borderLeftColor: t.text.muted },
  pauseGlyph: { flexDirection: 'row', gap: 7 },
  pauseBar: { width: 7, height: 26, borderRadius: 2, backgroundColor: t.accent.onAccent },
  // No size here: `Skip` sets it inline from its `size` prop, because the player
  // and the docked bar want different ones.
  skip: {
    borderWidth: 2,
    borderColor: t.border.strong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipDisabled: { borderColor: t.bg.inset },
  // ONE MARK, MIRRORED. `replay` is a counter-clockwise arrow, so flipped it
  // runs clockwise and the pair reads as one control in two directions. The
  // set's own `forward-30` cannot be used for the other half: it already faces
  // forward AND carries its own "30" numerals, so mirroring it produced a
  // back-facing arrow with the digits reversed above a readable "30".
  flip: { transform: [{ scaleX: -1 }] },
  skipNumber: { fontSize: 14, lineHeight: 16, color: t.text.primary, fontWeight: '700' },
  skipTextDisabled: { color: t.text.muted },
});
