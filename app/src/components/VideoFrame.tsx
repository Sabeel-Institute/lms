import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The 16:9 box a video's picture sits in, with the fullscreen control drawn
 * over its corner — where every video player puts it — rather than a button
 * on a row of its own under the picture. Shared by both VideoSurface files so
 * the two platforms draw one control.
 */
export function VideoFrame({
  children,
  onFullscreen,
}: {
  children: ReactNode;
  onFullscreen: () => void;
}) {
  return (
    <View style={styles.frame}>
      {children}
      <Pressable
        testID="player-fullscreen"
        accessibilityRole="button"
        accessibilityLabel="Full screen"
        onPress={onFullscreen}
        style={({ pressed }) => [styles.fullscreen, pressed ? styles.pressed : null]}
      >
        <MaterialIcons name="fullscreen" size={26} color={t.text.inverse} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: t.bg.video,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: spacing(4),
  },
  // 44px: the touch target the sweep asks for, on a picture that is often
  // only 180px tall on a phone.
  fullscreen: {
    position: 'absolute',
    right: spacing(2),
    bottom: spacing(2),
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.effect.videoControl,
  },
  pressed: { opacity: 0.7 },
});
