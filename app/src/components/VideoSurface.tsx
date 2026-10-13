import { useRef } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView } from 'expo-video';
import { nativeVideoPlayer } from '../player';
import { VideoFrame } from './VideoFrame';

/**
 * The picture of the file being played, when it is a video (web sibling:
 * VideoSurface.web.tsx).
 *
 * The player belongs to the playback session, not to this view, so leaving
 * the screen keeps the sound going (the docked bar) while the picture goes;
 * coming back draws it again from the same player. Fullscreen and
 * picture-in-picture are the platform's own: the app is portrait, and its
 * fullscreen activity turns with the phone. NOT `nativeControls`, which would
 * bring a second play button and scrubber over the picture, competing with
 * the screen's own transport; the fullscreen icon is the app's (VideoFrame).
 */
export function VideoSurface() {
  const view = useRef<VideoView>(null);
  const player = nativeVideoPlayer();
  if (!player) return null;
  return (
    <VideoFrame onFullscreen={() => void view.current?.enterFullscreen()}>
      <VideoView
        ref={view}
        testID="player-video"
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture
        startsPictureInPictureAutomatically
      />
    </VideoFrame>
  );
}
