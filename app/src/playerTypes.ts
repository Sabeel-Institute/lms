/** The one interface both platforms implement. Position is in milliseconds
 *  everywhere, so nothing has to remember which unit a given call uses. */
export interface PlayerEvents {
  onProgress: (positionMs: number) => void;
  onEnded: () => void;
  /**
   * The CURRENT source error, or null when there is none.
   *
   * NULLABLE BECAUSE IT IS A STATE, NOT AN EVENT. A player's error is cleared
   * when a new source loads or playback resumes successfully — so a network
   * blip mid-lecture sets it and then clears it,
   * and treating the first as a one-way latch left a live session with a dead
   * transport and eighty minutes of listening uncounted. Report the change in
   * both directions and the session can recover with the player.
   *
   * SOURCE errors only. A failure to configure background audio or the
   * lock-screen controls is not one: the audio plays, the person can do nothing
   * about it, and routing it here put a native error string in a red band and
   * (once `ready` followed `error`) refused to play a recording that had loaded
   * perfectly.
   */
  onError: (message: string | null) => void;
  /**
   * The transport changed WITHOUT this app asking.
   *
   * The lock screen and the notification controls drive the player directly, and
   * a phone call or another app taking audio focus pauses it. None of that goes
   * through `playback.pause()`, so the session's own `playing` flag went on
   * saying true over silence: the docked bar and the player screen both showed
   * the pause glyph, and the first tap called `pause()` on an already-paused
   * player — a no-op — so resuming took two.
   */
  onPlayingChanged: (playing: boolean) => void;
  /**
   * Waiting for data while meant to be playing, and the data back. On a slow
   * link the transport showed Pause over silence with the clock frozen, and
   * nothing said why.
   */
  onBuffering: (buffering: boolean) => void;
  /**
   * The OS asked to skip, or to go to a place: a browser's media notification
   * and lock screen, a headset, a keyboard's media keys. Answered by the
   * session, so they move exactly as the app's own buttons do. Web only: on
   * Android the media notification is expo-video's, which seeks the player
   * itself (ten seconds, as its icons say), and the session follows the place.
   */
  onRemoteSkip: (direction: 'back' | 'forward') => void;
  onRemoteSeek: (ms: number) => void;
}

/**
 * What the OS should say is playing, on the lock screen and in the notification.
 *
 * It travels with `load` rather than through a setter of its own because the
 * only moment it is ever needed is the moment a source is swapped in, and a
 * second call would be a second thing to forget — which is how the transport
 * shipped for five versions showing controls over a blank title.
 */
export interface NowPlayingMeta {
  title: string;
  courseName: string;
}

export interface Player {
  /**
   * Swap in a source at `startMs`. Paused afterwards unless `keepPlaying`,
   * which a version switch passes so the change is seamless: the same place,
   * still playing.
   */
  load: (url: string, startMs: number, meta: NowPlayingMeta, keepPlaying?: boolean) => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  setRate: (rate: number) => void;
  unload: () => void;
}
