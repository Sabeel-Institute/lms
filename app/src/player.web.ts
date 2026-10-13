import type { Player, PlayerEvents } from './playerTypes';
import { releasedSound, startedPlaying, type Sound } from './oneSound';

/**
 * Web side of the player seam (native sibling: player.ts).
 *
 * A plain HTMLVideoElement for audio and video alike: it streams over range
 * requests, seeks without re-downloading, needs no dependency, and an
 * audio-only file simply has no picture. The element lives here, not in a
 * view, so the sound outlives any one screen; `VideoSurface.web.tsx` borrows
 * it to show the picture while the player screen is open.
 *
 * As on native, there must be AT MOST ONE player alive at a time — if a screen
 * remounts before its cleanup runs, two elements would play at once. A
 * module-level handle enforces it: creating a player stops its predecessor.
 */
let current: { el: HTMLVideoElement; sound: Sound } | null = null;

function stop({ el, sound }: { el: HTMLVideoElement; sound: Sound }) {
  releasedSound(sound);
  el.pause();
  el.removeAttribute('src');
  el.load();
  el.remove();
}

/** The live element, for the surface that shows its picture. */
export function currentVideoElement(): HTMLVideoElement | null {
  return current?.el ?? null;
}

export function createPlayer(events: PlayerEvents): Player {
  if (current) stop(current);

  const el = document.createElement('video');
  el.preload = 'metadata';
  // Inline on a phone's browser rather than taking over the screen.
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  // One sound at a time (oneSound.ts): the browser's media keys start this
  // element too, and an attachment playing stops when they do.
  const sound: Sound = { pause: () => el.pause() };
  const mine = { el, sound };
  current = mine;
  /*
   * THE RATE IS THE SESSION'S, NOT THE SOURCE'S. A browser resets
   * `playbackRate` to 1 whenever `src` changes, so a version switch at 1.5×
   * would drop to 1× without a word (spike V0). Kept here and put back on
   * every load.
   */
  let rate = 1;
  el.addEventListener('timeupdate', () => events.onProgress(el.currentTime * 1000));
  el.addEventListener('ended', () => events.onEnded());
  let sourceError: string | null = null;
  /** Only on a CHANGE — `canplay` fires again after every seek and rebuffer. */
  const report = (message: string | null) => {
    if (message === sourceError) return;
    sourceError = message;
    events.onError(message);
  };
  el.addEventListener('error', () => {
    report(el.error ? `media error ${el.error.code}` : 'media error');
    /*
     * AND SAY IT STOPPED, which the element will not.
     *
     * A mid-stream `MEDIA_ERR_NETWORK` or `MEDIA_ERR_DECODE` sets `error` and
     * fires `error`, but leaves `paused` false and emits no `pause` event — so
     * the session, which takes `playing` from the transport, went on believing
     * a dead stream was playing.
     */
    events.onPlayingChanged(false);
  });
  // The other direction — the element recovered, so the session may re-enable
  // its transport. `canplay` fires once a source is actually playable, which
  // means the previous failure is over.
  el.addEventListener('canplay', () => report(null));
  // The element pauses itself at the end of the media and when the browser's own
  // media keys are used, neither of which goes through `playback.pause()`.
  el.addEventListener('play', () => {
    startedPlaying(sound);
    events.onPlayingChanged(true);
  });
  el.addEventListener('pause', () => events.onPlayingChanged(false));

  return {
    async load(url, startMs, now, keepPlaying = false) {
      if (!keepPlaying) el.pause();
      el.src = url;
      /*
       * The browser's own media panel and the hardware media keys read this,
       * which is the web's version of what the lock screen shows on native.
       * Guarded because Safari and older browsers ship no `mediaSession`, and a
       * missing now-playing panel must not stop a lecture loading.
       */
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: now.title,
          artist: now.courseName,
        });
      }
      /*
       * Seeking before metadata has loaded is silently dropped, so wait for it —
       * but SETTLE ON FAILURE TOO. A request that stalls or 403s fires `error`
       * and never `loadedmetadata`, so waiting on that alone left this promise
       * pending for ever and the session stuck on "Preparing…" with no way to
       * retry. The `error` listener above has already reported it; this only has
       * to stop blocking.
       */
      await new Promise<void>((resolve) => {
        if (el.readyState >= 1) return resolve();
        el.addEventListener('loadedmetadata', () => resolve(), { once: true });
        el.addEventListener('error', () => resolve(), { once: true });
      });
      el.playbackRate = rate;
      if (startMs > 0 && el.readyState >= 1) el.currentTime = startMs / 1000;
      if (keepPlaying) void el.play();
    },
    play: () => void el.play(),
    pause: () => el.pause(),
    seek: (ms) => {
      el.currentTime = ms / 1000;
    },
    setRate: (r) => {
      rate = r;
      el.playbackRate = r;
    },
    unload: () => {
      stop(mine);
      if (current === mine) current = null;
    },
  };
}
