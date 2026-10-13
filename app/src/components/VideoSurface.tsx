import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { VideoView } from 'expo-video';
import { nativeVideoPlayer } from '../player';
import { Button } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The picture of the file being played, when it is a video (web sibling:
 * VideoSurface.web.tsx).
 *
 * The player belongs to the playback session, not to this view, so leaving
 * the screen keeps the sound going (the docked bar) while the picture goes;
 * coming back draws it again from the same player. Fullscreen and
 * picture-in-picture are the platform's own: the app is portrait, and its
 * fullscreen activity turns with the phone.
 */
export function VideoSurface() {
  const view = useRef<VideoView>(null);
  const player = nativeVideoPlayer();
  if (!player) return null;
  return (
    <View>
      <VideoView
        ref={view}
        testID="player-video"
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture
        startsPictureInPictureAutomatically
      />
      <View style={styles.actions}>
        <Button
          testID="player-fullscreen"
          label="Full screen"
          variant="quiet"
          hug
          onPress={() => void view.current?.enterFullscreen()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: t.bg.video, borderRadius: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: spacing(2) },
});
