/**
 * ONE SOUND AT A TIME, across every player in the app.
 *
 * A class recording plays on in the docked bar while the student opens an
 * assignment, and an assignment can carry audio of its own: a recitation
 * handed in, a teacher's example. Nothing stopped the two playing over each
 * other. The operating system shares audio focus between APPS, not between
 * players inside one — two expo-video players in this app both played on a
 * real device, and a browser plays two media elements just as happily — so
 * the app keeps the rule itself.
 *
 * Every player reports here when it starts, however it was started: its own
 * button, the lock screen, a headset. Whatever was sounding before is paused,
 * exactly as if its own pause had been pressed, so each player's screen shows
 * it stopped the way it shows any other pause.
 */

/** A player, as this rule sees it. Keep one object per player: it is the identity. */
export interface Sound {
  pause: () => void;
}

let sounding: Sound | null = null;

/** `sound` has started playing: pause whatever else was. */
export function startedPlaying(sound: Sound): void {
  const before = sounding;
  sounding = sound;
  if (before && before !== sound) before.pause();
}

/**
 * `sound`'s player is being released. Forgotten, so the next start does not
 * reach for a player that is gone.
 */
export function releasedSound(sound: Sound): void {
  if (sounding === sound) sounding = null;
}
