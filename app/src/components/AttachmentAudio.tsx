import { StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getTheme } from '../theme';

const t = getTheme();

/**
 * An attached audio file, played in place (web sibling: AttachmentAudio.web.tsx):
 * a recitation handed in, or a teacher's example. Its own small player with
 * the platform's controls, speed included — not the session player, which
 * belongs to class recordings and their progress.
 */
export function AttachmentAudio({ url }: { url: string }) {
  const player = useVideoPlayer(url);
  return <VideoView player={player} style={styles.audio} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  audio: { width: '100%', height: 64, backgroundColor: t.bg.video, borderRadius: 8 },
});
