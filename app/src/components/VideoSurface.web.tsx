import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { currentVideoElement } from '../player.web';
import { VideoFrame } from './VideoFrame';

/**
 * The picture of the file being played, when it is a video (native sibling:
 * VideoSurface.tsx).
 *
 * The `<video>` element belongs to the playback session (player.web.ts); this
 * view borrows it, moving it into the player screen while that is open. On
 * leaving it goes to a holder off screen, IN THE PAGE: taken out of the page,
 * a media element is paused by the browser (the HTML standard's steps for an
 * element removed from a document), and leaving the player stopped a video
 * while the docked bar went on showing it. In the page, the sound plays on,
 * as on a phone.
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
      if (el.parentElement === box) offscreen().appendChild(el);
    };
  }, [el]);
  if (!el) return null;
  return (
    <VideoFrame onFullscreen={() => enlarge(el)}>
      <View ref={host} testID="player-video" style={StyleSheet.absoluteFill} />
    </VideoFrame>
  );
}

/**
 * Full screen where the browser has it, and the video's own full screen on
 * an iPhone, whose Safari has no `requestFullscreen` on any element: there
 * the button did nothing, and a slide's text stayed phone-width.
 */
function enlarge(el: HTMLVideoElement): void {
  if (el.requestFullscreen) void el.requestFullscreen();
  else (el as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
}

/** Where the session's video waits while no player screen shows it: in the page, out of sight. */
function offscreen(): HTMLElement {
  const existing = document.getElementById('session-video-holder');
  if (existing) return existing;
  const holder = document.createElement('div');
  holder.id = 'session-video-holder';
  holder.setAttribute('aria-hidden', 'true');
  Object.assign(holder.style, {
    position: 'fixed',
    left: '-2px',
    top: '-2px',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(holder);
  return holder;
}
