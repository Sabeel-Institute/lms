import { useEffect, useMemo, useRef, useState } from 'react';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer } from 'expo-video';
import type { Clip } from './clipTypes';
import { releasedSound, startedPlaying, type Sound } from './oneSound';

/**
 * Native side of an attachment's sound (web sibling: clip.web.ts). expo-video,
 * like the class player, so one engine — but a player of its own: no picture,
 * no lock-screen controls, and nothing playing on once the app is put away. It
 * is a recitation or a teacher's example, not a lecture.
 */
export function useClip(url: string, attempt: number): Clip {
  /*
   * ONE PLAYER FOR THE ROW'S LIFE. Given a new link (the last ran out; they
   * last an hour), `useVideoPlayer` would build a new player, and what this
   * hook reads from the old one would go on describing it — a row that still
   * said "failed" under a player that was fine. So the first link builds it
   * and each later attempt replaces its source, below — by attempt, not by
   * link: two links minted inside one second are the same string.
   */
  const [first] = useState(url);
  const player = useVideoPlayer(first, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.preservesPitch = true;
  });
  const sound = useMemo<Sound>(() => ({ pause: () => player.pause() }), [player]);
  useEffect(() => () => releasedSound(sound), [sound]);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  /*
   * LOADED ONCE IS ENOUGH. The engine says "idle" once it has played to the
   * end and "loading" while it buffers, and neither should grey out the place
   * bar, which only waits for the first load.
   */
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (status === 'readyToPlay') setLoaded(true);
  }, [status]);

  const [positionMs, setPositionMs] = useState(0);
  const [rate, setRateState] = useState(1);
  const place = useRef(0);
  const at = (ms: number) => {
    place.current = ms;
    setPositionMs(ms);
  };
  /*
   * AT THE END, play starts again from the beginning. The engine, once it has
   * played to the end, ignores `play()` until it is moved — so the button that
   * reads "Play" did nothing.
   */
  const ended = useRef(false);

  // Another attempt: same player, same speed, same place.
  useEffect(() => {
    if (attempt === 0) return;
    let live = true;
    setLoaded(false);
    ended.current = false;
    void player.replaceAsync(url).then(() => {
      // Not on a player released because the row went meanwhile.
      if (live) player.currentTime = place.current / 1000;
    });
    return () => {
      live = false;
    };
  }, [url, attempt, player]);

  useEventListener(player, 'playingChange', ({ isPlaying: now }) => {
    if (now) startedPlaying(sound);
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => at(currentTime * 1000));
  useEventListener(player, 'playToEnd', () => {
    ended.current = true;
    // The last time update lands a fraction short of the end.
    at(player.duration * 1000);
  });

  return {
    status: status === 'error' ? 'failed' : loaded ? 'ready' : 'loading',
    playing: isPlaying,
    positionMs,
    rate,
    toggle: () => {
      if (player.playing) {
        player.pause();
        return;
      }
      if (ended.current) {
        ended.current = false;
        player.currentTime = 0;
        at(0);
      }
      player.play();
    },
    seek: (ms) => {
      ended.current = false;
      player.currentTime = ms / 1000;
      at(ms);
    },
    setRate: (r) => {
      player.playbackRate = r;
      setRateState(r);
    },
  };
}
