import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { playback } from '../playback';
import { getTheme } from '../theme';

const t = getTheme();

/**
 * A help film on the website (native sibling: HelpFilm.tsx): the browser's
 * own `<video>`, with its own controls and the captions as a track.
 *
 * Not the class player. A film is watched here and nowhere else, so it needs
 * nothing the playback session gives a recording — no docked bar, no place
 * kept, no progress. ONE SOUND, though: starting a film pauses a class
 * recording playing in the docked bar.
 *
 * `crossOrigin`, because the captions are a track from the media bucket, and
 * a track from another origin loads only under CORS — which the bucket grants
 * the app's own origins.
 */
export function HelpFilm({
  video,
  captions,
  size,
  onError,
}: {
  video: string;
  captions: string;
  /** Drawn at this size, which keeps the film's own shape — see `fit` in HelpScreen. */
  size: { width: number; height: number };
  onError: () => void;
}) {
  const host = useRef<View>(null);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    const box = host.current as unknown as HTMLElement | null;
    if (!box) return;
    const el = document.createElement('video');
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
    el.crossOrigin = 'anonymous';
    el.src = video;
    Object.assign(el.style, { width: '100%', height: '100%', display: 'block' });
    el.setAttribute('data-testid', 'help-video');
    const track = document.createElement('track');
    track.kind = 'captions';
    track.label = 'English';
    track.srclang = 'en';
    track.src = captions;
    track.default = true;
    el.appendChild(track);
    const pauseRecording = () => playback.pause();
    const fail = () => failed.current();
    el.addEventListener('play', pauseRecording);
    el.addEventListener('error', fail);
    box.appendChild(el);
    return () => {
      el.removeEventListener('play', pauseRecording);
      el.removeEventListener('error', fail);
      el.pause();
      el.remove();
    };
  }, [video, captions]);
  return <View ref={host} testID="help-film" style={[styles.frame, size]} />;
}

const styles = StyleSheet.create({
  frame: { backgroundColor: t.bg.video, borderRadius: 8, overflow: 'hidden' },
});
