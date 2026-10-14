import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  COLLECTIONS,
  PROGRESS_WRITE_INTERVAL_MS,
  SIGNED_URL_REFRESH_MS,
  mediaParts,
  mergeProgress,
  progressId,
  startingItem,
  isPlayable,
  type MediaItem,
  type MediaMap,
  type MediaVersion,
} from '@sabeel/shared';
import { audioErrorText, errorText } from './errors';
import { db, functions } from './firebase';
import { createPlayer } from './player';
import { forgetProgress, journaledFor, journaledProgress, journalProgress } from './progressJournal';
import type { Player } from './playerTypes';
import { readIfExists } from './documents';

interface Minted {
  url: string;
  expiresAt: number;
}

const mintUrl = (recordingId: string, itemId: string) =>
  httpsCallable<{ recordingId: string; itemId: string }, Minted>(functions, 'getPlaybackUrl')({
    recordingId,
    itemId,
  }).then((r) => r.data);

/**
 * Cached playback URLs, by media item, refreshed BEFORE they expire.
 *
 * Re-minting only after a failure would mean a seek near the boundary fails
 * audibly first — and it would not even be catchable by status code: GCS
 * returns 400 with `ExpiredToken` on an expired signed URL, not 403. Proactive
 * refresh sidesteps that entirely, which is why it is the rule rather than a
 * retry handler.
 */
const cache = new Map<string, Minted>();
/** Bumped by `forgetPlaybackUrls`; a mint from an older epoch is discarded. */
let cacheEpoch = 0;

/**
 * Drop every cached URL. Called on sign-out.
 *
 * A signed URL is valid for 12 hours and is bound to a recording, not to the
 * account that asked for it — so a cache that outlives the credential hands the
 * next person on a shared device a working link to something they were never
 * entitled to, without `getPlaybackUrl` ever being consulted.
 */
export function forgetPlaybackUrls(): void {
  cache.clear();
  // The epoch, not just the map: a mint started moments before sign-out resolves
  // afterwards and would otherwise re-seed the cache with a URL good for another
  // twelve hours — the exact hole clearing it is meant to close.
  cacheEpoch += 1;
}

/**
 * When the duration is unknown, assume a lecture this long before trusting a
 * cached URL — the longest class the institute records, with room.
 */
const UNKNOWN_DURATION_MS = 3 * 60 * 60 * 1000;

/**
 * A cached URL is reused only if it will outlive THIS listen.
 *
 * The refresh window alone assumed a fresh mint per session: a two-hour
 * lecture opened at 20:00 (URL good until 08:00), closed after twenty minutes
 * and reopened at 06:40 found 80 minutes left — more than the hour the window
 * asks for — and played on into an expiry at 08:00 with twenty minutes to go.
 * The next range request got `ExpiredToken`, the transport went dead and the
 * error band came up, on the one listen it was meant to spare. So the cache
 * answers only when what is left covers the whole recording plus the window.
 */
async function playbackUrl(recordingId: string, itemId: string, durationMs: number): Promise<string> {
  const hit = cache.get(itemId);
  const need = (durationMs > 0 ? durationMs : UNKNOWN_DURATION_MS) + SIGNED_URL_REFRESH_MS;
  if (hit && hit.expiresAt - Date.now() > need) return hit.url;
  const epoch = cacheEpoch;
  const fresh = await mintUrl(recordingId, itemId);
  if (epoch === cacheEpoch) cache.set(itemId, fresh);
  return fresh.url;
}

/** What is loaded, so any surface can name it without re-fetching. */
export interface NowPlaying {
  recordingId: string;
  /** The file being played: one media item of the recording. */
  itemId: string;
  /**
   * The recording's media as the caller last read it: what parts and versions
   * there are to move between. Refreshed by every `openPlayback` for the same
   * recording, so a file staff hide or add reaches a session already open.
   */
  media: MediaMap;
  /** The version a student starts on, and falls back to between parts. */
  defaultVersion: MediaVersion;
  /** The course, so any surface can re-check that it may still be played. */
  courseId: string;
  title: string;
  courseName: string;
  /** The length of the file being played: a part, not the whole recording. */
  durationMs: number;
  /**
   * Whose deadline `dueDate` is, or null when staff are listening.
   *
   * The deadline closes a STUDENT's access and nobody else's — the server says
   * the same, returning no due date for staff before it checks one. Any surface
   * acting on `dueDate` has to consult this first, or a manager reviewing a
   * lecture from last term is cut off the moment they leave the player.
   */
  studentUid: string | null;
  /** The listener's deadline, for the surfaces that state it. Null for staff. */
  dueDate: string | null;
}

/**
 * What `openPlayback` is asked for. `itemId` names a file — staff previewing it
 * — or is null for wherever this listener left off: the part and version
 * their progress says, else the recording's starting file.
 */
export type OpenRequest = Omit<NowPlaying, 'itemId' | 'durationMs'> & { itemId: string | null };

export interface PlaybackState {
  ready: boolean;
  /** The last part came to its end: the moment to offer marking it complete. */
  ended: boolean;
  playing: boolean;
  positionMs: number;
  listenedMs: number;
  rate: number;
  error: string | null;
  /** Null until something is opened, and again after it is closed. */
  now: NowPlaying | null;
}

/**
 * Nothing playing. Exported because the player screen needs the same shape: the
 * session is app-wide, so on the first render after arriving it may still
 * describe the PREVIOUS recording, and the screen substitutes this until the
 * session is about the one it is showing. A second copy there drifted the moment
 * `PlaybackState` gained a field.
 */
export const IDLE: PlaybackState = {
  ready: false,
  ended: false,
  playing: false,
  positionMs: 0,
  listenedMs: 0,
  rate: 1,
  error: null,
  now: null,
};

/**
 * ONE PLAYBACK SESSION FOR THE WHOLE APP, held at module scope rather than in
 * the screen that started it.
 *
 * This is what makes background audio navigable. While the player lived in
 * `PlayerScreen`'s state, leaving the screen unmounted the hook and tore the
 * audio down — so a student could not check their attendance record, or answer
 * a message, without stopping a two-hour lecture and losing their place. Every
 * audio product solves this the same way: playback belongs to the app, and the
 * player screen is one of several VIEWS onto it.
 *
 * It also collapses an invariant that `player.ts` previously had to defend by
 * hand. That module keeps a module-level handle so a second player can never
 * outlive the first; with the session itself held here there is only ever one
 * caller, so "at most one player" stops being a rule and becomes the shape.
 *
 * Teardown is EXPLICIT (`closePlayback`), not a side effect of unmounting — and
 * that is a bill every involuntary end has to pay too. A session ends when a
 * different recording is opened, when the listener closes it, when access is
 * revoked under it (the recording unpublished, the course archived, the
 * student's own deadline passing), and on every way out of an account: signing
 * out, being disabled mid-lecture, or the credential being rejected. Miss one
 * and a foreground service keeps streaming with nothing on screen to stop it.
 */
let state: PlaybackState = IDLE;
let player: Player | null = null;
const listeners = new Set<(s: PlaybackState) => void>();

// Progress bookkeeping. Module-level rather than refs for the same reason the
// refs existed: the throttled writer reads them from inside a closure that must
// not be rebuilt on every tick.
let listened = 0;
let position = 0;
let lastTick: number | null = null;
let lastWrite = 0;
let dirty = false;
// After a seek the player keeps emitting the OLD position for a beat. Hold the
// displayed position at the target and ignore those stale ticks, so the thumb
// does not snap backwards right after it is dropped.
let seekTarget: number | null = null;
/**
 * Whether THIS session's `load()` call has come back.
 *
 * Not "the audio is playable", and the difference is worth being exact about:
 * on web `load` deliberately settles on a failed source too (a stalled request
 * fires neither `loadedmetadata` nor anything else, so waiting on success alone
 * hangs for ever), and on native it does not await `replace()` at all. What this
 * excludes is therefore the narrow case of a load still IN FLIGHT — which is
 * exactly the one that matters here: `onError` restores `ready` when a fault
 * clears, and without this a `canplay`-driven clear arriving before the load
 * returned would enable the transport over a session that had not started.
 */
let loadedOk = false;
/*
 * WHEN THE HOLD WAS SET, because a target the player can never report would
 * otherwise hold for ever.
 *
 * `durationSec` is genuinely nullable — a phone upload supplies none — so
 * `skipForward` cannot clamp, and a stored duration longer than the file has
 * the same effect: the seek lands clamped at the real end and no tick ever
 * comes within 1500ms of the target. Every later tick was then discarded, so
 * position and listened time froze for the rest of the session and the frozen
 * numbers are what the ledger shows. `onEnded` clears the hold too, but only
 * fires when the end is reached WHILE PLAYING — seeking past it while paused
 * never gets there.
 */
let seekAt = 0;
/** How long a seek may hold the display before stale ticks are accepted again. */
const SEEK_HOLD_MS = 2_000;
// Who the progress belongs to. Staff listen with no student uid and write none.
let owner: { studentUid: string | null; recordingId: string; courseId: string } | null = null;
// Bumped on every open; a load that resolves after a newer open is discarded.
let generation = 0;

function set(next: Partial<PlaybackState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l(state));
}

/** Whose progress document a write is for. */
interface Subject {
  studentUid: string;
  recordingId: string;
  courseId: string;
}

/** Where a listener is: a position in a part, in a version. */
interface Place {
  positionMs: number;
  part: number;
  version: MediaVersion;
}

/** One save, captured when it was asked for. */
interface Save {
  gen: number;
  who: Subject;
  place: Place;
  listenedMs: number;
  updatedAt: number;
}

/**
 * The write queue: ONE WRITE IN FLIGHT, AND AT MOST ONE WAITING PER DOCUMENT.
 *
 * One in flight because `writeProgress` is read-modify-write, and two against
 * the same document race: the throttled tick and the write on the way out both
 * read the same stale value, and whichever `setDoc` lands second wins — usually
 * the throttled one, so the LAST seconds of a session are the ones lost.
 *
 * One waiting per document because a newer save of the same document makes the
 * older one worthless, and a write can stall for as long as the app is in the
 * background (progressJournal.ts). Chained instead, a two-hour lecture on the
 * lock screen queued a read and a write per throttle interval — 480 of each,
 * sent back to back the moment the app came forward. A waiting save is only
 * replaced by a NEWER one, so a replayed journal record cannot displace the
 * open session's own.
 */
const waiting = new Map<string, Save>();
let draining: Promise<void> | null = null;

function enqueue(save: Save): Promise<void> {
  const id = progressId(save.who.studentUid, save.who.recordingId);
  const queued = waiting.get(id);
  if (!queued || queued.updatedAt <= save.updatedAt) waiting.set(id, save);
  // On a microtask, as the chain it replaced did: never a network call from
  // inside the tick, seek or pause that asked for the save.
  draining ??= Promise.resolve().then(drain);
  return draining;
}

async function drain(): Promise<void> {
  try {
    for (let next = waiting.entries().next(); !next.done; next = waiting.entries().next()) {
      const [key, save] = next.value;
      waiting.delete(key);
      await writeProgress(save);
    }
  } finally {
    draining = null;
  }
}

/** Resolves once nothing is in flight or waiting. */
const settled = (): Promise<void> => draining ?? Promise.resolve();

/**
 * Write one save. TAKES ITS SUBJECT, rather than reading the module's.
 *
 * Every number was captured when the save was asked for, and the generation is
 * checked before anything module-level is touched again. That is what makes a
 * write belonging to the recording you just left unable to land on the one you
 * just opened: the round trip is two network calls long, and in that window
 * `owner`, `position` and `listened` can all belong to something else. Writing
 * the wrong `listenedMs` here is not a cosmetic bug — that number is the audit
 * evidence staff read on the ledger.
 */
async function writeProgress(save: Save): Promise<void> {
  const { gen, who } = save;
  const id = progressId(who.studentUid, who.recordingId);
  const ref = doc(db, COLLECTIONS.listeningProgress, id);
  const mine = {
    positionMs: Math.round(save.place.positionMs),
    part: save.place.part,
    version: save.place.version,
    listenedMs: Math.round(save.listenedMs),
    updatedAt: save.updatedAt,
  };
  try {
    // Merge against whatever is already there rather than overwriting: another
    // device may have listened further, and total listening must never go
    // backwards.
    const existing = readIfExists('listeningProgress', await getDoc(ref));
    const merged = existing ? mergeProgress(mine, existing) : mine;
    await setDoc(ref, { ...who, ...merged });
    void forgetProgress(id, mine.updatedAt);
    // TAKE THE LARGER, never add the difference. `mine` was captured before two
    // round trips and the ticks that arrived during them are already in
    // `listened`, so assigning the merged total would throw them away — but
    // ADDING the catch-up is worse, because `pause` and `seek` persist with no
    // throttle and two writes queue routinely: the second re-reads the document
    // the first just wrote and applies the same catch-up again. Measured, that
    // turned a laptop's 15 minutes into 44, in the number the ledger presents as
    // evidence. `max` keeps the in-flight ticks and cannot double-count.
    if (generation === gen) listened = Math.max(listened, merged.listenedMs);
  } catch (e) {
    // A REFUSAL IS FINAL. The grant the rules check on every write has gone —
    // the student un-excused, the recording unpublished or deleted — and a
    // journal record kept for it would be refused on every launch for the life
    // of the install.
    if ((e as { code?: string } | null)?.code === 'permission-denied') {
      void forgetProgress(id, mine.updatedAt);
      return;
    }
    // A failed write must not break playback. The next tick retries — but only
    // for the session that is still open; a session already ended keeps its
    // journal record for the next launch.
    if (generation === gen) dirty = true;
  }
}

/** Record a save on the device, then queue it for the server. */
function save(gen: number, who: Subject, place: Place, listenedMs: number): Promise<void> {
  const updatedAt = Date.now();
  journalProgress(progressId(who.studentUid, who.recordingId), {
    ...who,
    positionMs: Math.round(place.positionMs),
    part: place.part,
    version: place.version,
    listenedMs: Math.round(listenedMs),
    updatedAt,
  });
  return enqueue({ gen, who, place, listenedMs, updatedAt });
}

/** Where the open session is, from the file it is playing. */
function currentPlace(): Place | null {
  const item = state.now ? state.now.media[state.now.itemId] : undefined;
  return item ? { positionMs: position, part: item.part, version: item.version } : null;
}

/** Persist the CURRENT session, if it has anything to write. */
function persist(): void {
  const place = currentPlace();
  if (!owner?.studentUid || !dirty || !place) return;
  dirty = false;
  lastWrite = Date.now();
  void save(
    generation,
    { studentUid: owner.studentUid, recordingId: owner.recordingId, courseId: owner.courseId },
    place,
    listened,
  );
}

/**
 * Send whatever this device saved for a student and never confirmed — the
 * listening done in the background before the app was closed. Called on launch
 * once the student is signed in, so the writes carry their auth. A no-op on web.
 *
 * Generation -1 matches no session, so a replay never touches the open one's
 * running total; reopening the recording merges the record in instead.
 */
export async function drainProgressJournal(studentUid: string): Promise<void> {
  for (const [, entry] of await journaledFor(studentUid)) {
    const { positionMs, part, version, listenedMs, updatedAt, ...who } = entry;
    // A record from before parts existed is a place in Part 1's audio.
    void enqueue({ gen: -1, who, place: { positionMs, part: part ?? 1, version: version ?? 'audio' }, listenedMs, updatedAt });
  }
  return settled();
}

/**
 * Start (or re-focus) a playback session.
 *
 * ONE ARGUMENT, because `NowPlaying` already carries the course and the listener
 * — passing them again alongside it gave the same two facts two sources that
 * were free to disagree, and the session would then be owned by one student
 * while every surface named another.
 *
 * Idempotent for the recording already loaded, which is what lets the player
 * screen be opened, left and re-opened without interrupting the audio: arriving
 * at a screen for something already playing must not restart it at zero.
 */
export function openPlayback(req: OpenRequest): void {
  /*
   * Re-entering the screen for what is ALREADY PLAYING must not restart it —
   * and must not be mistaken for a session that cannot play.
   *
   * `player` as well as `owner`, because an owner with no player is a torn-down
   * session and returning early would leave a play button that never works. And
   * `!state.error`, because a failed mint leaves the player assigned but never
   * loaded: without it, coming back to retry hits this branch and the transport
   * is disabled for good, with no way back but closing the docked bar.
   */
  if (
    player &&
    !state.error &&
    state.now &&
    owner?.recordingId === req.recordingId &&
    (req.itemId === null || req.itemId === state.now.itemId)
  ) {
    // Same recording, same file — refresh only what the caller may know
    // better (a staff visit has no due date; the student's own grant does;
    // staff may have hidden or added a file since).
    set({ now: { ...req, itemId: state.now.itemId, durationMs: state.now.durationMs } });
    return;
  }
  closePlayback();

  // A FILE TO SHOW AT ONCE: the one asked for, else the starting file. Where
  // this listener left off can move it to another part or version once their
  // progress has been read, before anything is loaded.
  const provisional = req.itemId ? req.media[req.itemId] : startingItem(req.media, req.defaultVersion);
  if (!provisional) {
    state = { ...IDLE, error: 'Nothing in this recording can be played yet.' };
    listeners.forEach((l) => l(state));
    return;
  }
  const now: NowPlaying = { ...req, itemId: provisional.id, durationMs: itemMs(provisional) };

  const gen = ++generation;
  owner = { studentUid: now.studentUid, recordingId: now.recordingId, courseId: now.courseId };
  listened = 0;
  position = 0;
  lastTick = null;
  lastWrite = 0;
  dirty = false;
  seekTarget = null;
  seekAt = 0;
  loadedOk = false;
  state = { ...IDLE, now };
  listeners.forEach((l) => l(state));

  const p = createPlayer({
    onProgress: (ms) => {
      if (generation !== gen) return;
      // Before the audio is loaded a tick reports nothing about this recording,
      // and acting on one is not harmless: `position` is still the zero set at
      // open, `lastWrite` is 0 so the very first tick persists immediately, and
      // `mergeProgress` takes the NEWER positionMs — so a tick that arrives
      // between `replace()` and `seekTo()` writes a zero over the student's
      // saved place in a two-hour lecture.
      if (!state.ready) return;
      if (seekTarget !== null) {
        if (Math.abs(ms - seekTarget) <= 1500) {
          seekTarget = null;
        } else if (Date.now() - seekAt < SEEK_HOLD_MS) {
          return;
        } else {
          // Unreachable target. Take the player's word for where it is.
          seekTarget = null;
          lastTick = Date.now();
          position = ms;
          set({ positionMs: ms });
          return;
        }
      }
      const at = Date.now();
      // A PAUSED ANDROID PLAYER STILL TICKS: expo-video's clock reports the
      // same place every half second until the player is released. Taken as
      // news, each tick re-rendered the screen and, every write interval,
      // saved the stale place as the newest, over the place the student had
      // since reached on another device. Nothing moved, so there is nothing
      // to show or save; the tick still marks the time, as every tick does.
      if (ms === position) {
        lastTick = at;
        return;
      }
      // Count only forward movement at roughly real-time speed as "listened".
      // A seek forward must not manufacture listening that never happened.
      if (lastTick !== null) {
        const advanced = ms - position;
        const elapsed = at - lastTick;
        if (advanced > 0 && advanced <= elapsed * 3) listened += advanced;
      }
      lastTick = at;
      position = ms;
      dirty = true;
      set({ positionMs: ms, listenedMs: listened });
      if (at - lastWrite >= PROGRESS_WRITE_INTERVAL_MS) persist();
    },
    onEnded: () => {
      if (generation !== gen) return;
      // CLEAR THE SEEK HOLD. A forward skip past the real end — reachable when
      // `durationSec` is null, or when the stored duration is longer than the
      // file — leaves a target the player can never reach, and every later tick
      // is then discarded as stale. Position and listened time freeze for the
      // rest of the session, and the frozen number is what the ledger shows.
      seekTarget = null;
      set({ playing: false });
      persist();
      // ON TO THE NEXT PART, in the same version if it has one: one class
      // recorded in two stretches plays as one class. At the last part, the
      // recording has ended — the moment the player offers to mark it done.
      const cur = state.now;
      const item = cur ? cur.media[cur.itemId] : undefined;
      const next = cur && item ? nextPart(cur.media, item.part) : null;
      const target = cur && item && next !== null ? fileInPart(cur.media, next, item.version, cur.defaultVersion) : null;
      if (target) switchTo(target, 0, true);
      else set({ ended: true });
    },
    onError: (message) => {
      if (generation !== gen) return;
      /*
       * THE TRANSPORT FOLLOWS THE SOURCE, IN BOTH DIRECTIONS.
       *
       * `ready` false while there is an error, because the two failure paths
       * have to agree: a mint that throws leaves the player screen on
       * "Preparing…" with everything disabled, while an audio error used to
       * leave a fully enabled scrubber, two skips and four rate chips over a
       * source that never loaded.
       *
       * And `ready` BACK when the error clears, because a player's error is
       * transient — cleared when a new source loads or playback resumes
       * successfully. Latched, a single network blip forty
       * minutes into a two-hour lecture disabled the transport for good and, via
       * the `!state.ready` gate on ticks, stopped counting the remaining eighty
       * minutes while the audio kept playing.
       *
       * `playing` is NOT touched here: the player reports that itself through
       * `onPlayingChanged`, and a source that has genuinely died reports it
       * paused. Guessing here contradicted that on the recovery path.
       *
       * `openPlayback`'s idempotency guard keys on `!state.error`, so a session
       * left in the failed state stays retryable: leaving the screen and coming
       * back builds a new player rather than taking the early return.
       */
      set({ error: message === null ? null : audioErrorText(message), ready: message === null && loadedOk });
    },
    onPlayingChanged: (playing) => {
      // The lock screen, the notification controls, a phone call taking audio
      // focus. `playback.play`/`pause` already set this optimistically, so this
      // is only ever correcting it — never the other way round.
      if (generation === gen && state.playing !== playing) {
        if (!playing) lastTick = null;
        set({ playing });
        // Saved like an in-app pause. The lock-screen Pause is the one a
        // background listener actually presses.
        if (!playing) persist();
      }
    },
    onRemoteSkip: (direction) => {
      if (generation === gen) (direction === 'back' ? playback.skipBack : playback.skipForward)();
    },
    onRemoteSeek: (ms) => {
      if (generation === gen) playback.seek(ms);
    },
  });
  player = p;

  void (async () => {
    try {
      const id = now.studentUid ? progressId(now.studentUid, now.recordingId) : null;
      const [saved, journaled] = await Promise.all([
        id ? getDoc(doc(db, COLLECTIONS.listeningProgress, id)) : Promise.resolve(null),
        id ? journaledProgress(id) : Promise.resolve(null),
      ]);
      if (generation !== gen) return;
      // THIS DEVICE'S OWN UNSENT SAVE COUNTS. Listening done on the lock screen
      // and then closed is in the journal, not on the server, until something
      // sends it — and resuming from the server alone put the student back
      // where the screen went off.
      const stored = saved ? readIfExists('listeningProgress', saved) : undefined;
      const prior = stored && journaled ? mergeProgress(stored, journaled) : (stored ?? journaled);
      // RESUME WHERE THEY WERE: their part, in their version if that part
      // still has it — unless a particular file was asked for. A row from
      // before parts existed is a place in Part 1.
      let item = provisional;
      if (!req.itemId && prior?.part !== undefined) {
        item = fileInPart(now.media, prior.part, prior.version ?? now.defaultVersion, now.defaultVersion) ?? provisional;
      }
      if (item.id !== now.itemId) set({ now: { ...now, itemId: item.id, durationMs: itemMs(item) } });
      listened = prior?.listenedMs ?? 0;
      position = prior && (prior.part ?? 1) === item.part ? prior.positionMs : 0;
      const url = await playbackUrl(now.recordingId, item.id, itemMs(item));
      if (generation !== gen) return;
      await p.load(url, position, { title: now.title, courseName: now.courseName });
      if (generation !== gen) return;
      // THE SOURCE IS LOADED — remembered, so `onError` can put the transport
      // back when a transient fault clears. NOT ready while an error stands:
      // `load` resolves on a failed source as well as a loaded one (on web it
      // has to, or a stalled request leaves the promise pending for ever), so
      // the error the player already reported would otherwise be overwritten
      // here by a ready transport.
      loadedOk = true;
      if (state.error) return;
      set({ ready: true, positionMs: position, listenedMs: listened });
    } catch (e) {
      // `errorText`, like every other failure a person reads: an offline tap on
      // a lecture, or any unhandled throw in `getPlaybackUrl`, otherwise put the
      // bare word "internal" in a full-width red band on the student's player.
      if (generation === gen) set({ error: errorText(e) });
    }
  })();
}

/** A file's length, as the transport counts it. */
const itemMs = (item: MediaItem) => (item.durationSec ?? 0) * 1000;

/**
 * The file to play in a part: the version asked for if the part has it ready
 * and visible, else the recording's default, else its audio, else whatever it
 * has. Null when nothing in the part can be played.
 */
function fileInPart(
  media: MediaMap,
  part: number,
  version: MediaVersion,
  defaultVersion: MediaVersion,
): MediaItem | null {
  const inPart = Object.values(media).filter((i) => i.part === part && isPlayable(i));
  return (
    inPart.find((i) => i.version === version) ??
    inPart.find((i) => i.version === defaultVersion) ??
    inPart.find((i) => i.version === 'audio') ??
    inPart[0] ??
    null
  );
}

/** The part after the one being played, in play order, or null at the last. */
function nextPart(media: MediaMap, part: number): number | null {
  const parts = mediaParts(Object.values(media).filter(isPlayable)).map((p) => p.part);
  const at = parts.indexOf(part);
  return at >= 0 && at < parts.length - 1 ? parts[at + 1] : null;
}

/** Bumped on every switch of file; a switch overtaken by a newer one is dropped. */
let switches = 0;

/**
 * Move the open session to another file of the same recording: another
 * version of this part, keeping the place, or another part, from its start.
 *
 * The session stays the same session — same generation, same listened total —
 * because it is the same recording and the same obligation. Only the source
 * changes. The transport is not ready while the new source loads, which is
 * also what stops the old file's last ticks being counted against the new one.
 */
function switchTo(item: MediaItem, startMs: number, play: boolean): void {
  const now = state.now;
  const p = player;
  if (!now || !p) return;
  // Save the place being left: it is the last word on the part it was in.
  dirty = true;
  persist();
  const gen = generation;
  const mine = ++switches;
  position = startMs;
  lastTick = null;
  seekTarget = null;
  set({ now: { ...now, itemId: item.id, durationMs: itemMs(item) }, positionMs: startMs, ready: false, ended: false });
  void (async () => {
    try {
      const url = await playbackUrl(now.recordingId, item.id, itemMs(item));
      if (generation !== gen || switches !== mine) return;
      await p.load(url, startMs, { title: now.title, courseName: now.courseName }, play);
      if (generation !== gen || switches !== mine) return;
      if (state.error) return;
      set({ ready: true, playing: play });
      // The new file is where the listener now is.
      dirty = true;
      persist();
    } catch (e) {
      if (generation === gen && switches === mine) set({ error: errorText(e) });
    }
  })();
}

/**
 * End the session and release the audio. Safe to call when nothing is open.
 *
 * EVERY STATE CHANGE IS SYNCHRONOUS, AND IT HAS TO BE. `openPlayback` calls this
 * and then sets up the next recording; if any part of the teardown resumed after
 * an await, it would wake up and wipe the session that had just started, and the
 * symptom is a permanently disabled transport stuck on "Preparing…" with nothing
 * to recover it but leaving the screen. An await on an already-resolved promise
 * is enough to cause it, so it happens every time rather than under load.
 *
 * So: every mutation happens in one tick, and the final write is handed its own
 * snapshot and fired detached. The returned promise is only that write, for the
 * one caller that must not race it — signing out drops the credential, and a
 * write still in flight is refused. Fire and forget everywhere else.
 */
export function closePlayback(): Promise<void> {
  const p = player;
  const dying = owner;
  const finalPlace = currentPlace();
  const finalListened = listened;
  /*
   * NOTHING HEARD, NOTHING WRITTEN — and this is the guard, not an optimisation.
   *
   * `openPlayback` zeroes the position synchronously and restores the stored one
   * two round trips later, so a session closed before it loads still has
   * `position === 0`. Writing that zero is not harmless: `mergeProgress` takes
   * `listenedMs` as a max but `positionMs` from whichever record is NEWER, and
   * the zero is newer — so tapping a lecture and immediately closing the bar,
   * or opening one while offline so the mint fails, threw away the student's
   * place in a two-hour recording. `dirty` is only ever set by a tick or a seek,
   * which is exactly "this session went somewhere".
   */
  const moved = dirty;
  /*
   * A GENERATION THAT CAN NEVER MATCH AGAIN: take the current one for the dying
   * session, then move past it. The final write's `generation === gen` guard is
   * false however this was reached — including a bare close with no `openPlayback`
   * behind it, which is the mini player's ×, sign-out, and a revoked recording.
   */
  const gen = generation;
  generation += 1;

  player = null;
  owner = null;
  dirty = false;
  lastTick = null;
  seekTarget = null;
  seekAt = 0;
  if (state.now || state.ready || state.playing) {
    state = IDLE;
    listeners.forEach((l) => l(state));
  }

  if (p) p.unload();
  // Whatever happened since the last tick would otherwise be lost exactly at the
  // moment someone stops listening. It cannot write the wrong session's numbers:
  // `gen` is stale by construction, so nothing module-level is touched when it
  // lands.
  if (!dying?.studentUid || !finalPlace) return Promise.resolve();
  // Nothing new since the last throttled save — but one may still be in flight,
  // and the caller that awaits this is about to drop the credential.
  if (!moved) return settled();
  return save(
    gen,
    { studentUid: dying.studentUid, recordingId: dying.recordingId, courseId: dying.courseId },
    finalPlace,
    finalListened,
  );
}

/**
 * How far the skip controls move. ONE definition: the player screen and the
 * docked bar are two views of the same session, and a 15 in one and a 15 in the
 * other are the same 15 — right up until somebody changes one of them.
 */
export const SKIP_BACK_MS = 15_000;
export const SKIP_FORWARD_MS = 30_000;

/** The speeds offered: the player's chips, and an attachment's speed button, which steps through the same ones. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

/**
 * `h:mm:ss` (or `m:ss` under an hour) for a position in a recording.
 *
 * Lives here rather than in either view, because it was in BOTH and the two
 * copies disagreed — one floored the seconds and the other rounded them, so the
 * same audio read a second apart depending on which surface you looked at.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const playback = {
  play: () => {
    lastTick = Date.now();
    player?.play();
    set({ playing: true, ended: false });
  },
  pause: () => {
    player?.pause();
    lastTick = null;
    set({ playing: false });
    persist();
  },
  seek: (ms: number) => {
    player?.seek(ms);
    position = ms;
    seekTarget = ms;
    seekAt = Date.now();
    lastTick = Date.now();
    dirty = true;
    set({ positionMs: ms, ended: false });
    persist();
  },
  /**
   * Play another file of the open recording. Another version of the same part
   * keeps the place and plays on if it was playing — switching from the video
   * to its audio to save data loses nothing. Another part starts from its
   * beginning. A file students may not see is refused here as the server would
   * refuse its URL; staff may play any ready file, which is how they check one.
   */
  selectItem: (itemId: string) => {
    const now = state.now;
    if (!now || itemId === now.itemId) return;
    const target = now.media[itemId];
    const current = now.media[now.itemId];
    if (!target || target.status !== 'ready' || (target.hidden && now.studentUid !== null)) return;
    const samePart = current !== undefined && target.part === current.part;
    const length = itemMs(target);
    switchTo(target, samePart ? (length > 0 ? Math.min(position, length) : position) : 0, state.playing);
  },
  /** Play another part from its start, in the version being played if it has it. */
  selectPart: (part: number) => {
    const now = state.now;
    if (!now) return;
    const current = now.media[now.itemId];
    const target = fileInPart(now.media, part, current?.version ?? now.defaultVersion, now.defaultVersion);
    if (!target || target.id === now.itemId) return;
    switchTo(target, 0, state.playing);
  },
  setRate: (rate: number) => {
    player?.setRate(rate);
    set({ rate });
  },
  toggle: () => (state.playing ? playback.pause() : playback.play()),
  // Clamped here rather than at each call site, so neither view has to know the
  // duration or the amounts.
  skipBack: () => playback.seek(Math.max(0, state.positionMs - SKIP_BACK_MS)),
  skipForward: () => {
    // `durationSec` is genuinely nullable — a phone upload supplies none — and
    // clamping to a zero duration turned "forward 30" into "back to the start".
    const end = state.now?.durationMs ?? 0;
    const target = state.positionMs + SKIP_FORWARD_MS;
    playback.seek(end > 0 ? Math.min(end, target) : target);
  },
};

/** Subscribe a component to the one session. */
export function usePlayback(): PlaybackState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
