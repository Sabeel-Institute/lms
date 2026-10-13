import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { currentVideoElement } from '../player.web';
import { VideoFrame } from './VideoFrame';

/**
 * The picture of the file being played, when it is a video (native sibling:
 * VideoSurface.tsx).
 *
 * The `<video>` element belongs to the playback session (player.web.ts); this
 * view borrows it, moving it into the page while the player screen is open.
 * Taking it out again on leaving does not stop it — a playing element outside
 * the document plays on — so the docked bar keeps the sound, as on a phone.
 */
export function VideoSurface() {
  const host = useRef<View>(null);
  const el = currentVideoElement();
  useEffect(() => {
    const box = host.current as unknown as HTMLElement | null;
    if (!el || !box) return;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    box.appendChild(el);
    return () => {
      if (el.parentElement === box) box.removeChild(el);
    };
  }, [el]);
  if (!el) return null;
  return (
    <VideoFrame onFullscreen={() => void el.requestFullscreen?.()}>
      <View ref={host} testID="player-video" style={StyleSheet.absoluteFill} />
    </VideoFrame>
  );
}
