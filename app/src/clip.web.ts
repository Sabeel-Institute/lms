import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from './clipTypes';
import { releasedSound, startedPlaying, type Sound } from './oneSound';

/**
 * Web side of an attachment's sound (native sibling: clip.ts): an Audio element
 * of its own, never put on the page. The small player draws the controls, so
 * they are the same in the browser as on the phone.
 */
export function useClip(url: string, attempt: number): Clip {
  const [el] = useState(() => {
    const a = new Audio();
    a.preload = 'metadata';
    return a;
  });
  const sound = useMemo<Sound>(() => ({ pause: () => el.pause() }), [el]);
  const [status, setStatus] = useState<Clip['status']>('loading');
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [rate, setRateState] = useState(1);

  useEffect(() => {
    const on: [string, () => void][] = [
      ['loadedmetadata', () => setStatus('ready')],
      [
        'error',
        () => {
          setStatus('failed');
          setPlaying(false);
        },
      ],
      [
        'play',
        () => {
          startedPlaying(sound);
          setPlaying(true);
        },
      ],
      ['pause', () => setPlaying(false)],
      ['timeupdate', () => setPositionMs(el.currentTime * 1000)],
    ];
    on.forEach(([type, fn]) => el.addEventListener(type, fn));
    return () => {
      on.forEach(([type, fn]) => el.removeEventListener(type, fn));
      releasedSound(sound);
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, [el, sound]);

  /*
   * Each attempt loads afresh and takes up the same place: a new link, the
   * last having run out, or the same one — two links minted inside one second
   * are the same string, so the link alone cannot say "load again". The speed
   * needs nothing: it is kept in `defaultPlaybackRate`, which is what a new
   * source resets `playbackRate` to.
   */
  const place = useRef(0);
  place.current = positionMs;
  useEffect(() => {
    setStatus('loading');
    const resumeMs = place.current;
    el.src = url;
    if (resumeMs > 0) {
      el.addEventListener('loadedmetadata', () => void (el.currentTime = resumeMs / 1000), { once: true });
    }
  }, [el, url, attempt]);

  return {
    status,
    playing,
    positionMs,
    rate,
    // From the end, the element starts again at the beginning by itself.
    toggle: () => (el.paused ? void el.play() : el.pause()),
    seek: (ms) => {
      el.currentTime = ms / 1000;
      setPositionMs(ms);
    },
    setRate: (r) => {
      el.defaultPlaybackRate = r;
      el.playbackRate = r;
      setRateState(r);
    },
  };
}
