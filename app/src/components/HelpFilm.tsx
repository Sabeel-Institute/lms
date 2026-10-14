import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { playback } from '../playback';
import { getTheme } from '../theme';

const t = getTheme();

/**
 * A help film on a phone (web sibling: HelpFilm.web.tsx): a player of its
 * own with the platform's controls, not the class player — a film is watched
 * here and nowhere else, so it keeps no place and draws no docked bar. ONE
 * SOUND, though: starting a film pauses a class recording playing in the
 * docked bar. Captions are the website's; on a phone the narration is the
 * film's words.
 */
export function HelpFilm({
  video,
  size,
  onError,
}: {
  video: string;
  captions: string;
  /** Drawn at this size, which keeps the film's own shape — see `fit` in HelpScreen. */
  size: { width: number; height: number };
  onError: () => void;
}) {
  const player = useVideoPlayer(video);
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  useEffect(() => {
    if (isPlaying) playback.pause();
  }, [isPlaying]);
  useEffect(() => {
    if (status === 'error') onError();
  }, [status, onError]);
  return (
    <View testID="help-film" style={[styles.frame, size]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls fullscreenOptions={{ enable: true }} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: t.bg.video, borderRadius: 8, overflow: 'hidden' },
});
