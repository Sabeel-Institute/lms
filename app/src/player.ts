import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import type { NowPlayingMeta, Player, PlayerEvents } from './playerTypes';

/**
 * Native side of the player seam (web sibling: player.web.ts), on expo-video,
 * for audio and video alike: one engine, so one foreground service and one
 * lock-screen session. `expo-av` is end-of-life and is not used; `expo-audio`
 * was, and would have been a second engine competing for the lock screen once
 * video arrived (spike V0, docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md).
 *
 * Background playback needs two things, and missing either fails quietly:
 *
 *  1. `staysActiveInBackground` on the player;
 *  2. the FOREGROUND_SERVICE permissions and expo-video's playback service in
 *     the manifest — written by hand, since config plugins do not run in the
 *     bare workflow.
 *
 * NOT the notification permission. The media controls are a MediaStyle
 * notification bound to the media session, and Android exempts those from
 * POST_NOTIFICATIONS; asking for it here put the system's "Allow
 * notifications?" dialog in front of a person who had just pressed Play.
 *
 * There must be **at most ONE player alive at a time**, for two reasons seen on
 * a real device: releasing a player that is playing in the background does not
 * reliably silence it first, and navigation can create the next player before
 * the previous one's cleanup has run. A module-level handle fixes both: creating
 * a player tears its predecessor down first, and teardown PAUSES before it
 * releases.
 */
let current: { player: VideoPlayer; detach: () => void } | null = null;

function hardStop(player: VideoPlayer, detach: () => void) {
  try { detach(); } catch { /* best-effort teardown */ }
  try { player.pause(); } catch { /* best-effort teardown */ }
  try { player.release(); } catch { /* best-effort teardown */ }
}

function stopCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  hardStop(c.player, c.detach);
}

/** The live player, for the surface that draws its picture (VideoSurface.tsx). */
export function nativeVideoPlayer(): VideoPlayer | null {
  return current?.player ?? null;
}

export function createPlayer(events: PlayerEvents): Player {
  // Kill any predecessor FIRST — this stops an orphan when a recording is
  // re-opened and guarantees a single stream from the app.
  stopCurrent();

  const player = createVideoPlayer(null);
  player.staysActiveInBackground = true;
  player.showNowPlayingNotification = true;
  /*
   * `doNotMix` — EXCLUSIVE AUDIO FOCUS. Documented as iOS-only, honoured on
   * Android too (it requests AUDIOFOCUS_GAIN). Without it a two-hour lecture
   * plays over whatever else is going, does not pause for a phone call, and has
   * no claim on the transport the OS hands to the app that owns focus.
   */
  player.audioMixingMode = 'doNotMix';
  player.preservesPitch = true;
  player.timeUpdateEventInterval = 0.5;

  /*
   * A SOURCE HAS LOADED. The player is created with none, and it reports
   * `playToEnd` for that empty source on its first load — which the session
   * would take for the end of the lecture (spike V0). Ends count only once a
   * source has loaded.
   */
  let loaded = false;
  let sourceError: string | null = null;
  const subs = [
    player.addListener('timeUpdate', ({ currentTime }) => events.onProgress(currentTime * 1000)),
    player.addListener('playingChange', ({ isPlaying }) => events.onPlayingChanged(isPlaying)),
    player.addListener('playToEnd', () => {
      if (loaded) events.onEnded();
    }),
    // ON CHANGE, IN BOTH DIRECTIONS: an error is a state that clears when a
    // source loads or playback resumes, and the session follows it.
    player.addListener('statusChange', ({ status, error }) => {
      const next = status === 'error' ? (error?.message ?? 'error') : null;
      if (next !== sourceError) {
        sourceError = next;
        events.onError(next);
      }
      // `loading` is the player waiting for data, at a load and on a slow
      // link mid-play alike; the session shows it only while playing.
      events.onBuffering(status === 'loading');
    }),
  ];
  const detach = () => subs.forEach((s) => s.remove());
  current = { player, detach };

  return {
    async load(url, startMs, now: NowPlayingMeta, keepPlaying = false) {
      /*
       * PAUSED BEFORE THE SWAP unless asked to keep going: `replaceAsync`
       * carries on playing if the player was, which a version switch wants and
       * opening a lecture does not.
       */
      if (!keepPlaying) player.pause();
      // The class is the "artist" line, which is where Android and the lock
      // screen put the second row under the title.
      await player.replaceAsync({ uri: url, metadata: { title: now.title, artist: now.courseName } });
      loaded = true;
      if (startMs > 0) player.currentTime = startMs / 1000;
      if (keepPlaying) player.play();
    },
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (ms) => {
      player.currentTime = ms / 1000;
    },
    setRate: (rate) => {
      player.playbackRate = rate;
    },
    unload: () => {
      // If a newer player already replaced this one, just stop this stale
      // instance; otherwise clear the module handle too.
      if (current?.player === player) stopCurrent();
      else hardStop(player, detach);
    },
  };
}
