import { describe, expect, it, vi } from 'vitest';
import { PROGRESS_WRITE_INTERVAL_MS, SIGNED_URL_TTL_MS, type MediaItem, type MediaMap } from '@sabeel/shared';

/**
 * The app-wide playback session.
 *
 * It is the riskiest module in the app and it had no tests: one mutable session
 * at module scope, a generation counter, a serialised write queue, and a
 * progress number that staff read off the ledger as audit evidence. Every case
 * below is one an earlier revision got wrong on a real device — a second
 * recording that never started, a write landing on the wrong session, ticks
 * dropped on every save.
 *
 * The seams are mocked because they are seams: the player is a platform
 * implementation and Firestore is a network. What is under test is the
 * bookkeeping between them.
 */
vi.mock('./firebase', () => ({ db: {}, functions: {} }));
vi.mock('./sentry', () => ({ captureError: vi.fn() }));

/**
 * The device's storage — AsyncStorage, which holds the progress journal.
 *
 * DECLARED OUTSIDE `load()`, which resets every module: what is on the device
 * survives the app being killed, and that survival is what the journal tests
 * are about.
 */
const device = new Map<string, string>();
/** When set, the device refuses to store anything: a private window, blocked site data. */
let storageRefused = false;
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => device.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (storageRefused) throw new Error('QuotaExceededError');
      device.set(k, v);
    },
    removeItem: async (k: string) => {
      device.delete(k);
    },
    getAllKeys: async () => [...device.keys()],
  },
}));

const callable = vi.fn();
vi.mock('firebase/functions', () => ({ httpsCallable: () => callable }));

/**
 * WHAT THE SCREENS ARE SHOWN: the session as `usePlayback` hands it to a
 * component. React's two hooks stand in for one, so a test reads exactly what
 * the player screen would render from.
 */
let shown: Record<string, unknown> | null = null;
vi.mock('react', () => ({
  useState: (initial: unknown) => [
    initial,
    (next: Record<string, unknown>) => {
      shown = next;
    },
  ],
  useEffect: (effect: () => void) => {
    effect();
  },
}));

/**
 * The progress documents, keyed by their path.
 *
 * ONE PER RECORDING, as Firestore has them. A single shared value looked like a
 * faithful enough fixture until a test needed two sessions at once: the write a
 * closing session fires lands on ITS document, and reading the other one back
 * through the same variable turned a correct app into a failing test — and would
 * equally have hidden a real cross-session write.
 */
const docs = new Map<string, Record<string, unknown>>();
/** The document for one recording, by the id used throughout these tests. */
const docOf = (recordingId: string) => docs.get(`listeningProgress/stu-1_${recordingId}`);
/** Seed one, as another device would have left it. */
const seedDoc = (recordingId: string, value: Record<string, unknown> | undefined) => {
  const key = `listeningProgress/stu-1_${recordingId}`;
  if (value) docs.set(key, value);
  else docs.delete(key);
};
/** Every read and write in order, for the tests about ordering. */
let ioLog: string[] = [];
// SNAPSHOTTED AT CALL TIME, like a real `getDoc`. Reading the map from inside
// `data()` instead would hand a read issued minutes ago whatever the document
// says when someone finally looks at it — which is exactly the staleness the
// generation guards exist to survive, hidden from the tests that check them.
/** When set, the next `getDoc` waits for `finishGet()`: a slow read of the saved place. */
let holdGet = false;
let finishGet: (() => void) | null = null;
const getDoc = vi.fn((ref: { path: string }) => {
  const snap = docs.get(ref.path);
  ioLog.push('get');
  if (!holdGet) return Promise.resolve({ data: () => snap });
  holdGet = false;
  return new Promise((resolve) => {
    finishGet = () => resolve({ data: () => snap });
  });
});
/**
 * When set, the next `setDoc` waits for `finishSet()`.
 *
 * A progress write is two network calls long, and the merge-back that follows it
 * touches module state. Holding the write is the only way to put a NEWER
 * session's load between the two — which is the ordering the generation check
 * around that merge exists for, and which a resolved-immediately fake can never
 * produce.
 */
let holdSet = false;
let finishSet: (() => void) | null = null;
/** When set, every `setDoc` is refused the way the rules refuse a lapsed grant. */
let denySet = false;
const setDoc = vi.fn((ref: { path: string }, value: Record<string, unknown>) => {
  if (denySet) return Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
  docs.set(ref.path, value);
  ioLog.push('set');
  if (!holdSet) return Promise.resolve();
  holdSet = false;
  return new Promise<void>((resolve) => {
    finishSet = resolve;
  });
});
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, collection: string, id: string) => ({ path: `${collection}/${id}` }),
  getDoc: (ref: { path: string }) => getDoc(ref),
  setDoc: (ref: { path: string }, value: Record<string, unknown>) => setDoc(ref, value),
}));

/**
 * Every player handed out, so a test can drive the one it means.
 *
 * IT RECORDS `startMs` AND CAN BE HELD OPEN, and both matter. Without the first
 * nothing asserts that the stored position is handed to the player, so deleting
 * the restore leaves the suite green. Without the second the window between
 * `createPlayer` and `load` resolving is unreachable, and that window is where a
 * native player emits its first tick — the one that used to write a zero over an
 * hour of listening.
 */
interface Fake {
  events: {
    onProgress: (ms: number) => void;
    onEnded: () => void;
    onError: (m: string | null) => void;
    onPlayingChanged: (playing: boolean) => void;
    onBuffering: (buffering: boolean) => void;
  };
  loaded: string | null;
  /** The position `load` was asked to start at. */
  startedAt: number | null;
  /** What `load` was told the OS should display. */
  announced: { title: string; courseName: string } | null;
  /** Whether the last `load` was told to carry on playing. */
  keptPlaying: boolean;
  unloaded: boolean;
  playing: boolean;
  /** Resolves a `load` held open by `holdLoad`. */
  finishLoad: (() => void) | null;
}
const players: Fake[] = [];
/** When set, the next player's `load` waits for `fake.finishLoad()`. */
let holdLoad = false;
/**
 * When set, the next `getPlaybackUrl` waits for `finishMint()`.
 *
 * THE MINT IS THE SLOW LEG. It is a Cloud Function, so a cold start is seconds,
 * and every other test in this file settles it with `await flush()` before doing
 * anything else — which is precisely the window a person walks through when they
 * tap one lecture, change their mind, and tap another.
 */
let holdMint = false;
let finishMint: ((v: { data: Minted }) => void) | null = null;
interface Minted {
  url: string;
  expiresAt: number;
}
vi.mock('./player', () => ({
  createPlayer: (events: Fake['events']) => {
    const fake: Fake = {
      events,
      loaded: null,
      announced: null,
      keptPlaying: false,
      startedAt: null,
      unloaded: false,
      playing: false,
      finishLoad: null,
    };
    players.push(fake);
    return {
      load: (url: string, startMs: number, meta: { title: string; courseName: string }, keepPlaying = false) => {
        fake.loaded = url;
        fake.startedAt = startMs;
        fake.announced = meta;
        fake.keptPlaying = keepPlaying;
        if (!holdLoad) return Promise.resolve();
        return new Promise<void>((resolve) => {
          fake.finishLoad = resolve;
        });
      },
      play: () => {
        fake.playing = true;
      },
      pause: () => {
        fake.playing = false;
      },
      seek: () => {},
      setRate: () => {},
      unload: () => {
        fake.unloaded = true;
      },
    };
  },
}));

type Playback = typeof import('./playback');

/** Fresh module per test: the session, the URL cache and the epoch are global. */
async function load({ killed = false } = {}): Promise<Playback> {
  vi.resetModules();
  // `killed`: the app is reopened on the same device, so its storage stays —
  // and so, of course, does the server.
  if (!killed) {
    device.clear();
    docs.clear();
  }
  players.length = 0;
  storageRefused = false;
  holdLoad = false;
  ioLog = [];
  holdSet = false;
  finishSet = null;
  holdGet = false;
  finishGet = null;
  denySet = false;
  getDoc.mockClear();
  setDoc.mockClear();
  callable.mockReset();
  holdMint = false;
  finishMint = null;
  callable.mockImplementation(() => {
    if (!holdMint) {
      return Promise.resolve({ data: { url: 'https://signed/audio.m4a', expiresAt: 1e15 } });
    }
    holdMint = false;
    return new Promise((resolve) => {
      finishMint = resolve;
    });
  });
  return import('./playback');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/*
 * A CONTROLLED CLOCK, because the tick handler compares progress against
 * elapsed wall time: it counts a jump as listening only if the audio advanced
 * no faster than about real time. Three ticks fired in the same millisecond of
 * real time are indistinguishable from a seek, so a test that does not advance
 * the clock measures the seek guard rather than the counter.
 */
let nowMs = 1_700_000_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
const wait = (ms: number) => {
  nowMs += ms;
};

/** One file of a recording, ready, as an import or upload leaves it. */
const file = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  part: 1,
  version: 'audio',
  kind: 'audio',
  label: null,
  status: 'ready',
  failReason: null,
  hidden: false,
  storageKey: `media/r/${id}`,
  contentType: 'audio/mp4',
  sizeBytes: 1,
  durationSec: 3600,
  width: null,
  height: null,
  source: 'zoom',
  zoom: null,
  addedAt: 1,
  addedBy: 'adm',
  ...over,
});

/**
 * What a player screen opens: a one-part recording in two versions, audio (the
 * default) and video. `audioSec` is the audio's length — null for one whose
 * length could not be read, as a phone upload can be.
 */
const recording = (id: string, studentUid: string | null = 'stu-1', audioSec: number | null = 3600) => ({
  recordingId: id,
  itemId: null as string | null,
  courseId: 'course-1',
  title: `Session ${id}`,
  courseName: 'Hikam Foundations',
  media: {
    [`${id}-audio`]: file(`${id}-audio`, { durationSec: audioSec }),
    [`${id}-video`]: file(`${id}-video`, { version: 'speaker', kind: 'video', contentType: 'video/mp4' }),
  } as MediaMap,
  defaultVersion: 'audio' as const,
  studentUid,
  dueDate: studentUid ? '2099-01-01' : null,
});

describe('opening and closing', () => {
  it('mints a URL for the recording asked for, and loads it', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    // The player exists before the audio does — the docked bar has to appear
    // the moment someone taps, not two round trips later.
    expect(players).toHaveLength(1);
    expect(players[0].loaded).toBeNull();
    await flush();
    expect(callable).toHaveBeenCalledWith({ recordingId: 'rec-a', itemId: 'rec-a-audio' });
    expect(players[0].loaded).toBe('https://signed/audio.m4a');
  });

  /*
   * WHAT THE OS IS TOLD, not that a setter was called.
   *
   * The lock screen and the notification name what is playing, and for five
   * versions they named nothing: the metadata never left this module, so
   * `dumpsys media_session` read `metadata: null` and a two-hour lecture showed
   * transport controls over a blank title. The player seam is where the session
   * hands that over, so this asserts the handover carries both lines a person
   * reads — the session and the class it belongs to.
   *
   * It cannot see the notification itself; that stays a device check. It does
   * catch the call site dropping the argument again, which is how it was lost.
   */
  it('tells the player what the lock screen should say', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players[0].announced).toEqual({
      title: 'Session rec-a',
      courseName: 'Hikam Foundations',
    });
  });

  it('re-opening the SAME recording does not restart it', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players).toHaveLength(1);
    expect(players[0].unloaded).toBe(false);
  });

  it('opening another FILE of the same recording loads that file', async () => {
    // Staff previewing a recording's files one after another from the
    // session page: the second Play has to play the second file.
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.openPlayback({ ...recording('rec-a'), itemId: 'rec-a-video' });
    await flush();
    expect(players).toHaveLength(2);
    expect(players[0].unloaded).toBe(true);
    expect(callable).toHaveBeenLastCalledWith({ recordingId: 'rec-a', itemId: 'rec-a-video' });
  });

  /*
   * THE REGRESSION THAT KILLED "PLAY A SECOND RECORDING".
   *
   * `closePlayback` used to await its final write and null the session
   * afterwards, so `openPlayback` — which closes the old session before starting
   * the new one — had the continuation wake up and wipe the session that had
   * just started. The symptom was a transport disabled for good on "Preparing…".
   */
  it('opening a second recording leaves the SECOND one loaded', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(30_000);

    pb.openPlayback(recording('rec-b'));
    await flush();
    await flush();

    expect(players).toHaveLength(2);
    expect(players[0].unloaded).toBe(true);
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
    // And the write the first session fired on its way out landed on the first
    // session's document, not on the one that replaced it.
    expect(docOf('rec-a')?.recordingId).toBe('rec-a');
  });

  it('the final write is attributed to the session that ENDED', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(45_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ recordingId: 'rec-a', studentUid: 'stu-1' });
    expect(docOf('rec-a')?.positionMs).toBe(45_000);
  });

  it('a tick from a closed session cannot write over the open one', async () => {
    const pb = await load();
    seedDoc('rec-b', { positionMs: 60_000, listenedMs: 60_000, updatedAt: nowMs - 1_000 });
    pb.openPlayback(recording('rec-a'));
    await flush();
    const first = players[0];
    pb.openPlayback(recording('rec-b'));
    await flush();

    // The old player is torn down but nothing stops a queued callback firing.
    wait(1_000);
    first.events.onProgress(9_000_000);
    await flush();
    // THE OPEN SESSION'S DOCUMENT, which is where a stale tick would land: the
    // closed one's is not, and asserting on it passed with the guard removed.
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-b')?.positionMs).toBe(60_000);
  });

  /*
   * A SLOW READ OF THE SAVED PLACE, ANSWERING AFTER ANOTHER RECORDING WAS
   * OPENED. Every other test here holds the mint; this holds the read, which
   * is where the old session would load its own file on the closed player.
   */
  it('a saved place read after another recording opened starts nothing', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 3_000_000, listenedMs: 3_000_000, updatedAt: nowMs - 1_000 });
    holdGet = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.openPlayback(recording('rec-b'));
    await flush();
    finishGet?.();
    await flush();
    await flush();
    expect(players[0].loaded).toBeNull();
    expect(players[1]).toMatchObject({ startedAt: 0 });
    expect(callable.mock.calls.map((c) => (c[0] as { recordingId: string }).recordingId)).toEqual(['rec-b']);
  });

  /*
   * A SESSION THAT NEVER LOADED MUST NOT OVERWRITE THE STORED POSITION.
   *
   * `openPlayback` zeroes the position synchronously and restores the stored
   * one two round trips later. `mergeProgress` keeps the LARGER listenedMs but
   * the NEWER positionMs — so a zero written on the way out wins, and the
   * student's place in a two-hour lecture is gone.
   */
  /*
   * A CLOSE LANDING MID-LOAD LEAVES THE SESSION RE-OPENABLE.
   *
   * `load` is the second slow leg, and closing during it is ordinary — the
   * mini-player's × while the audio is still spooling up. What must not happen
   * is the state the failed mint used to produce: an owner and no player, where
   * re-opening takes the "already playing" path and hands back a transport that
   * drives nothing.
   *
   * (The generation check after `await p.load` is defence in depth rather than
   * the thing under test: with `state.now` null after a close, nothing reads
   * the `ready` it would set. It is held here by argument, not by assertion.)
   */
  it('re-opens cleanly after a close lands mid-load', async () => {
    const pb = await load();
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    await pb.closePlayback();
    players[0].finishLoad?.();
    await flush();

    // Nothing is loaded, so re-opening builds a NEW player rather than taking
    // the "already playing" path — which it would not if the closed session had
    // been left looking ready.
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players).toHaveLength(2);
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
  });

  it('closing before the audio loads keeps the stored position', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 3_540_000, listenedMs: 3_540_000, updatedAt: 1 });
    pb.openPlayback(recording('rec-a'));
    // No flush: the mint and the progress read are still in the air.
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(3_540_000);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed mint does not overwrite the stored position either', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 1_200_000, listenedMs: 1_200_000, updatedAt: 1 });
    callable.mockRejectedValueOnce(new Error('offline'));
    pb.openPlayback(recording('rec-a'));
    await flush();
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(1_200_000);
  });

  /*
   * A MINT THAT RESOLVES AFTER THE SESSION IT BELONGS TO HAS GONE.
   *
   * `openPlayback` reads the stored progress and assigns it to the module's
   * `listened`/`position` when its `Promise.all` settles. Tap one lecture, back
   * out while the Cloud Function is still cold, tap another, and the first
   * continuation lands inside the second session — assigning the FIRST
   * recording's totals over the one now playing, which the next tick then writes
   * to the second recording's progress document. The generation check before
   * that assignment is the only thing in the way, and it is the same failure as
   * "progress written for the wrong session" reached through a different door.
   */
  it('a mint that resolves after its session ended cannot touch the new one', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 3_000_000, listenedMs: 3_000_000, updatedAt: 1 });
    holdMint = true;
    pb.openPlayback(recording('rec-a'));
    await flush();

    // Second thoughts: a different lecture, whose own mint resolves at once and
    // whose own progress document does not exist yet.
    pb.openPlayback(recording('rec-b'));
    await flush();

    // Now the abandoned one comes back.
    finishMint?.({ data: { url: 'https://signed/stale.m4a', expiresAt: 1e15 } });
    await flush();

    // The player still holds what it was given, and the session still counts
    // from zero rather than from the other recording's hour.
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
    players[1].events.onProgress(1_000);
    wait(2_000);
    players[1].events.onProgress(3_000);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-b')).toMatchObject({ recordingId: 'rec-b', listenedMs: 2_000 });
    // And the abandoned session's own hour is still on its own document.
    expect(docOf('rec-a')?.listenedMs).toBe(3_000_000);
  });

  it('closing when nothing is open is a no-op', async () => {
    const pb = await load();
    await expect(pb.closePlayback()).resolves.toBeUndefined();
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe('who the progress belongs to', () => {
  it('staff listening writes NO progress document', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', null));
    await flush();
    players[0].events.onProgress(60_000);
    await pb.closePlayback();
    expect(setDoc).not.toHaveBeenCalled();
  });

  /*
   * AND NOT ON THE THROTTLED PATH EITHER, which is the other half of the guard.
   *
   * A tick past the write interval, a pause and a seek each persist without
   * going anywhere near `closePlayback`. Without the owner check there, a staff
   * listen writes `listeningProgress/null_<recordingId>` with a null studentUid
   * — a document for nobody, in the collection the ledger reads.
   */
  it('staff listening writes nothing when a tick, a pause or a seek persists', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', null));
    await flush();
    // Past PROGRESS_WRITE_INTERVAL_MS, so the tick itself would persist.
    players[0].events.onProgress(1_000);
    wait(20_000);
    players[0].events.onProgress(21_000);
    pb.playback.seek(30_000);
    pb.playback.pause();
    await flush();
    expect(setDoc).not.toHaveBeenCalled();
    expect(getDoc).not.toHaveBeenCalled();
  });

  it('pausing writes progress without ending the session', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    expect(players[0].playing).toBe(true);
    players[0].events.onProgress(1_000);
    wait(2_000);
    players[0].events.onProgress(3_000);
    pb.playback.pause();
    await flush();
    expect(players[0].playing).toBe(false);
    // Saved at the pause, not held until the session ends: someone who stops
    // halfway and closes the app keeps their place.
    expect(docOf('rec-a')).toMatchObject({ recordingId: 'rec-a', positionMs: 3_000, listenedMs: 2_000 });
    expect(players[0].unloaded).toBe(false);
  });

  it('a student resumes from the position already stored', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 120_000, listenedMs: 90_000, updatedAt: 1 });
    pb.openPlayback(recording('rec-a'));
    await flush();
    // HANDED TO THE PLAYER, which is the whole of "resumes": the document is
    // read, and then the audio starts there rather than at the beginning.
    expect(players[0].loaded).toBe('https://signed/audio.m4a');
    expect(players[0].startedAt).toBe(120_000);
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(120_000);
  });

  it('a session with nothing stored starts at the beginning', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players[0].startedAt).toBe(0);
  });

  /*
   * A TICK BEFORE THE AUDIO IS LOADED SAYS NOTHING ABOUT IT.
   *
   * Native emits a progress event from `replace()` before `seekTo()` lands. At
   * that moment `position` is still the zero set at open and `lastWrite` is 0,
   * so the very first tick persists immediately — and `mergeProgress` takes the
   * NEWER positionMs, so the zero wins over an hour of listening.
   */
  it('ignores a tick that arrives before the audio has loaded', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 3_540_000, listenedMs: 3_540_000, updatedAt: 1 });
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();

    players[0].events.onProgress(0);
    await flush();
    expect(setDoc).not.toHaveBeenCalled();

    players[0].finishLoad?.();
    await flush();
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(3_540_000);
  });
});

/*
 * WHAT THE STUDENT SEES BEFORE THE FILE LOADS. The bar and Mark complete read
 * the session's listening, which was published only once the file had loaded:
 * on a slow link the player said "0% played" and refused Mark complete for
 * seconds, and offline it said so for good, with the SDK's own sentence in the
 * error band.
 */
describe('before the file has loaded', () => {
  it('shows the stored listening and place while the file is on its way', async () => {
    const pb = await load();
    pb.usePlayback();
    seedDoc('rec-a', { positionMs: 120_000, listenedMs: 110_000, updatedAt: nowMs - 1000 });
    holdMint = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(shown).toMatchObject({ ready: false, positionMs: 120_000, listenedMs: 110_000 });
  });

  it('offline, says so plainly and shows what this device recorded of the listening', async () => {
    const pb = await load();
    pb.usePlayback();
    device.set(
      'sabeel.progressJournal.v1:stu-1_rec-a',
      JSON.stringify({ studentUid: 'stu-1', recordingId: 'rec-a', courseId: 'course-1', positionMs: 300_000, part: 1, version: 'audio', listenedMs: 290_000, updatedAt: nowMs - 1000 }),
    );
    getDoc.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' })),
    );
    pb.openPlayback(recording('rec-a'));
    await flush();
    await flush();
    expect(shown).toMatchObject({ ready: false, listenedMs: 290_000, error: 'Cannot reach the server. Check your connection and try again.' });
  });
});

/*
 * WAITING FOR DATA. On a slow link the player sat on Pause over silence with
 * the clock frozen, saying nothing; the session now says it is loading, and
 * only for the file it is playing.
 */
describe('waiting for data', () => {
  it('says so while the file waits, and stops saying so when it plays again', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onBuffering(true);
    expect(shown).toMatchObject({ playing: true, buffering: true });
    players[0].events.onBuffering(false);
    expect(shown).toMatchObject({ buffering: false });
  });

  it('a player already replaced says nothing about the one playing now', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    const stale = players[0].events;
    pb.openPlayback(recording('rec-b'));
    await flush();
    stale.onBuffering(true);
    expect(shown).toMatchObject({ buffering: false });
  });
});

describe('counting listening', () => {
  it('counts forward movement at real-time speed', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    wait(1_000);
    players[0].events.onProgress(2_000);
    wait(1_000);
    players[0].events.onProgress(3_000);
    await pb.closePlayback();
    // The first tick establishes the baseline; two seconds of audio followed.
    expect(docOf('rec-a')?.listenedMs).toBe(2_000);
    expect(docOf('rec-a')?.positionMs).toBe(3_000);
  });

  /*
   * ONE WRITE PER INTERVAL, not one per tick. The player reports progress several
   * times a second; persisting each would be a Firestore read AND write per tick,
   * for every listener, for the length of a two-hour lecture.
   */
  it('throttles the writes a run of ticks produces', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    // The first tick always persists — there is no previous write to space it
    // from. The four after it fall inside one interval.
    for (const at of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      players[0].events.onProgress(at);
      wait(1_000);
    }
    await flush();
    expect(setDoc).toHaveBeenCalledTimes(1);
  });

  /*
   * A PAUSED ANDROID PLAYER STILL TICKS. expo-video's clock reports the same
   * place every half second until the player is released, and each of those
   * ticks was news: every fifteen seconds the idle phone saved its stale place
   * as the newest, over the place the student had since reached elsewhere.
   */
  it('a paused player reporting the same place saves nothing over a newer place', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(59_000);
    wait(1_000);
    players[0].events.onProgress(60_000);
    pb.playback.pause();
    await flush();
    const writes = setDoc.mock.calls.length;
    // The student listens on to 20:00 on the web.
    seedDoc('rec-a', { positionMs: 1_200_000, listenedMs: 1_200_000, part: 1, version: 'audio', updatedAt: nowMs + 1 });
    // A minute of the phone's paused clock.
    for (let i = 0; i < 120; i += 1) {
      wait(500);
      players[0].events.onProgress(60_000);
    }
    await flush();
    expect(setDoc.mock.calls.length).toBe(writes);
    expect(docOf('rec-a')).toMatchObject({ positionMs: 1_200_000 });
  });

  it('a forward SEEK manufactures no listening', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    // A jump of ten minutes a second later is a seek, not ten minutes of
    // listening.
    wait(1_000);
    players[0].events.onProgress(601_000);
    await pb.closePlayback();
    expect(docOf('rec-a')?.listenedMs).toBe(0);
    expect(docOf('rec-a')?.positionMs).toBe(601_000);
  });

  it('never lets the total go backwards behind another device', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    wait(3_000);
    players[0].events.onProgress(4_000);
    // A phone that listened further writes while this session is open.
    seedDoc('rec-a', { positionMs: 500_000, listenedMs: 400_000, updatedAt: Date.now() + 1000 });
    await pb.closePlayback();
    expect(docOf('rec-a')?.listenedMs).toBe(400_000);
  });

  /*
   * THE CATCH-UP FROM ANOTHER DEVICE IS APPLIED ONCE, NOT PER QUEUED WRITE.
   *
   * `pause` and `seek` persist with no throttle, so two writes queue routinely.
   * Advancing the local total by `merged - mine` made the second write re-read
   * what the first had just stored and apply the same catch-up again — minutes
   * of listening that never happened, in the number the ledger presents as
   * evidence.
   */
  /*
   * AND IT CANNOT MERGE INTO A SESSION THAT REPLACED IT.
   *
   * `writeProgress` is two network calls long, so a close and a re-open can land
   * inside one. Merging the stored total back into the module's `listened`
   * without checking the generation writes the FIRST recording's hours into the
   * second recording's ledger — "progress written for the wrong session"
   * reached through the merge rather than through the open.
   */
  it('a write that finishes after its session ended does not seed the new one', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 1_800_000, listenedMs: 1_800_000, updatedAt: nowMs + 1000 });
    pb.openPlayback(recording('rec-a'));
    await flush();
    // A tick queues a write carrying rec-a's half hour, and the write is held
    // open at exactly the point where its merge-back would run.
    holdSet = true;
    players[0].events.onProgress(1_000);
    await flush();

    // The listener moves on, and the new session finishes loading first.
    pb.openPlayback(recording('rec-b'));
    await flush();

    // Only now does the old write come back.
    finishSet?.();
    await flush();

    // Two ticks: the first only establishes the baseline.
    players[1].events.onProgress(1_000);
    wait(2_000);
    players[1].events.onProgress(3_000);
    await pb.closePlayback();
    await flush();
    // rec-b heard two seconds. The half hour belonged to rec-a.
    expect(docOf('rec-b')).toMatchObject({ recordingId: 'rec-b', listenedMs: 2_000 });
    // And rec-a's own half hour is still on rec-a's document, untouched.
    expect(docOf('rec-a')?.listenedMs).toBe(1_800_000);
  });

  it('does not re-apply another device\'s total once per queued write', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    wait(10_000);
    players[0].events.onProgress(11_000);

    // A laptop finished the same lecture while this session was open.
    seedDoc('rec-a', { positionMs: 900_000, listenedMs: 900_000, updatedAt: nowMs + 1000 });

    // Three writes queued before any of them resolves. Neither `seek` nor
    // `pause` honours the write throttle, so a skip and a pause are enough.
    pb.playback.seek(20_000);
    players[0].events.onProgress(20_000);
    pb.playback.pause();
    await flush();

    // Now listen a little more, so the session's own running total is written
    // once the queue has drained — which is where the inflation shows up.
    pb.playback.play();
    wait(1_000);
    players[0].events.onProgress(21_000);
    await pb.closePlayback();
    await flush();

    // The laptop's total, plus the one second heard since. Adding the catch-up
    // per queued write instead reached 2,691,000 — three quarters of an hour of
    // listening that never happened, in the number the ledger presents as
    // evidence.
    expect(docOf('rec-a')?.listenedMs).toBe(901_000);
  });

  /*
   * AND THE TICKS THAT ARRIVED DURING THE WRITE SURVIVE IT.
   *
   * `mine` is captured before two round trips. Assigning the merged total back
   * — rather than taking the larger of it and the running count — throws away
   * everything heard while the write was in flight, which over a two-hour
   * lecture silently under-reports the number staff read as evidence.
   */
  it('keeps the seconds heard while a write was in flight', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();

    // The first tick always persists, and it goes out carrying 0 listened.
    players[0].events.onProgress(1_000);
    // Eight seconds of real listening arrive before that write comes back.
    wait(4_000);
    players[0].events.onProgress(5_000);
    wait(4_000);
    players[0].events.onProgress(9_000);
    await flush();

    await pb.closePlayback();
    await flush();
    // Assigning the merged total back instead would have written 0 — the whole
    // eight seconds discarded because they arrived after `mine` was captured.
    expect(docOf('rec-a')?.listenedMs).toBe(8_000);
  });

  /*
   * A SEEK PAST THE REAL END MUST NOT FREEZE THE SESSION.
   *
   * `seek` holds the displayed position at its target and discards ticks that
   * disagree, so the thumb does not snap backwards. Past the end of the file
   * that target is unreachable, and without `onEnded` clearing it every later
   * tick is discarded — position and listened time freeze, and the frozen number
   * is what the ledger shows.
   */
  it('resumes counting after a seek past the end, once the file ends', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    pb.playback.seek(9_999_000);
    players[0].events.onEnded();
    wait(1_000);
    players[0].events.onProgress(10_000);
    wait(1_000);
    players[0].events.onProgress(11_000);
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(11_000);
  });

  /*
   * AND HOLDS UNTIL IT DOES. Between the seek and the hold expiring, the player
   * keeps reporting where it WAS for a beat; showing those would snap the thumb
   * backwards the instant it is dropped.
   */
  it('discards the stale ticks a seek leaves behind', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(600_000);
    pb.playback.seek(60_000);
    // The player is still reporting the old position, well inside the hold.
    wait(200);
    players[0].events.onProgress(600_500);
    wait(200);
    players[0].events.onProgress(601_000);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(60_000);
  });

  /*
   * AND WHEN THE FILE NEVER ENDS, BECAUSE THE SEEK HAPPENED WHILE PAUSED.
   *
   * `onEnded` only fires when the end is reached WHILE PLAYING, so a forward
   * skip past the real end from a paused player leaves a target no tick can
   * ever match. Every later tick was then discarded and the session froze at a
   * position that does not exist in the file — which is both the resume point
   * and the number the ledger presents as evidence.
   */
  it('gives up on a seek target the player never reaches', async () => {
    const pb = await load();
    // No duration, so `skipForward` cannot clamp — a phone upload supplies none.
    pb.openPlayback(recording('rec-a', 'stu-1', null));
    await flush();
    players[0].events.onProgress(1_000);
    pb.playback.seek(9_999_000);
    // (Reached through `seek` rather than `skipForward`, which is exercised on
    // its own below — this test is about the hold, not the clamp.)

    // The player clamps at the real end and reports it. No `onEnded`.
    wait(500);
    players[0].events.onProgress(60_000);
    await flush();
    // HELD: inside the window the stale position is discarded, so what is on
    // disk is still the seek's own target rather than the player's report.
    expect(docOf('rec-a')?.positionMs).toBe(9_999_000);

    // Past the hold, the player's own position is believed again.
    wait(2_500);
    players[0].events.onProgress(61_000);
    wait(1_000);
    players[0].events.onProgress(62_000);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(62_000);
  });
});

/*
 * ONE WRITE AT A TIME. `writeProgress` is read-modify-write, and `pause` and
 * `seek` both persist without the throttle, so two in flight against one
 * document is routine. Run concurrently they read the same stale value and
 * whichever `setDoc` lands second wins — usually the earlier, smaller one, so
 * the last seconds of a session are the ones lost.
 */
describe('the write queue', () => {
  it('never has two reads of the progress document in flight at once', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    // Discard the session's own opening read of the stored progress; what is
    // under test is the writes that follow it.
    ioLog = [];

    // The first tick's write is held open, so the saves after it are asked
    // for while it is still in flight.
    holdSet = true;
    players[0].events.onProgress(1_000);
    await flush();
    wait(1_000);
    players[0].events.onProgress(2_000);
    pb.playback.seek(2_000);
    pb.playback.pause();
    finishSet?.();
    await pb.closePlayback();
    await flush();

    // Strictly alternating: each write reads the document its predecessor left.
    expect(ioLog.length).toBeGreaterThanOrEqual(4);
    expect(ioLog.filter((_, i) => i % 2 === 0).every((e) => e === 'get')).toBe(true);
    expect(ioLog.filter((_, i) => i % 2 === 1).every((e) => e === 'set')).toBe(true);
  });
});

/*
 * THE CLAMPS, which were argued for in a comment and exercised by nothing.
 *
 * `durationSec` is genuinely nullable — a phone upload supplies none — and
 * clamping to a zero duration turns "forward 30" into "back to the start",
 * which is the note above `skipForward`. Neither skip was called anywhere in
 * this file.
 */
/*
 * THE LOCK SCREEN. React Native stops JavaScript timers while the app is in the
 * background and the Firestore SDK's network layer runs on them, so a write
 * issued with the screen locked does not leave the device until the app comes
 * back — and never, if it is closed first. The audio and the ticks carry on.
 * Here a held `setDoc` is the stalled network and `load({ killed: true })` is
 * the app swiped away and reopened.
 */
describe('listening with the screen locked', () => {
  /** Listen from 0 to `toMs` in one-second ticks, at real-time speed. */
  const listen = (fake: Fake, fromMs: number, toMs: number) => {
    for (let at = fromMs; at <= toMs; at += 1_000) {
      fake.events.onProgress(at);
      wait(1_000);
    }
  };

  it('keeps the place and the listening when the app is closed before it syncs', async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    // The first save goes out and stalls: the screen is off. A save is of a
    // place that moved, so the first is a second in.
    holdSet = true;
    listen(players[0], 0, 1_000);
    await flush();
    // Ten minutes on the lock screen, then the lock-screen Pause — seven
    // seconds after the last throttled save, so only the pause holds them.
    listen(players[0], 1_000, 607_000);
    players[0].events.onPlayingChanged(false);
    await flush();
    // Nothing has reached the server beyond the first, stalled save.
    expect(docOf('rec-a')?.positionMs).toBeLessThanOrEqual(1_000);

    // Closed from recents, reopened later.
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(docOf('rec-a')).toMatchObject({ positionMs: 607_000, listenedMs: 607_000 });
  });

  it('resumes from this device\'s unsent place before anything is sent', async () => {
    let pb = await load();
    seedDoc('rec-a', { positionMs: 60_000, listenedMs: 60_000, updatedAt: nowMs - 1_000 });
    pb.openPlayback(recording('rec-a'));
    await flush();
    // Playing, so the lock-screen Pause below is a pause and saves the place.
    pb.playback.play();
    holdSet = true;
    listen(players[0], 60_000, 61_000);
    await flush();
    listen(players[0], 61_000, 300_000);
    players[0].events.onPlayingChanged(false);
    await flush();

    // Reopened straight onto the same lecture, with the server still behind.
    pb = await load({ killed: true });
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players[0].startedAt).toBe(300_000);
    // And the count carries on from the journal's total, not the server's.
    listen(players[0], 300_000, 301_000);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')).toMatchObject({ positionMs: 301_000, listenedMs: 301_000 });
  });

  it('sends one write, not one per interval, when the app comes back', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    holdSet = true;
    // The first save stalls; an hour of throttled saves pile up behind it.
    listen(players[0], 0, 1_000);
    await flush();
    listen(players[0], 1_000, 3_600_000);
    await flush();
    expect(setDoc).toHaveBeenCalledTimes(1);

    // The app comes forward and the stalled write completes.
    finishSet?.();
    await flush();
    await flush();
    expect(setDoc).toHaveBeenCalledTimes(2);
    expect(docOf('rec-a')?.positionMs).toBeGreaterThanOrEqual(3_600_000 - PROGRESS_WRITE_INTERVAL_MS);
  });

  it('a replayed record never displaces a newer save waiting to go', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    holdSet = true;
    listen(players[0], 0, 0);
    await flush();
    listen(players[0], 1_000, 20_000);
    pb.playback.seek(50_000);
    await flush();
    // A record older than the waiting save, as a launch-time replay can read
    // it just before the session saves again.
    device.set(
      'sabeel.progressJournal.v1:stu-1_rec-a',
      JSON.stringify({ studentUid: 'stu-1', recordingId: 'rec-a', courseId: 'course-1', positionMs: 5_000, listenedMs: 5_000, updatedAt: nowMs - 10_000 }),
    );
    const drained = pb.drainProgressJournal('stu-1');
    await flush();
    finishSet?.();
    await drained;
    await flush();
    expect(docOf('rec-a')?.positionMs).toBe(50_000);
  });

  it('drops a record the server refuses, rather than replaying it for ever', async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    holdSet = true;
    listen(players[0], 0, 0);
    await flush();
    listen(players[0], 1_000, 30_000);

    // Closed; meanwhile the student is un-excused, so the grant has gone.
    pb = await load({ killed: true });
    denySet = true;
    await pb.drainProgressJournal('stu-1');
    await flush();
    expect(setDoc).toHaveBeenCalledTimes(1);

    // The next launch has nothing left to send.
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a device that refuses to store reports it once, not at every save', async () => {
    const pb = await load();
    const { captureError } = await import('./sentry');
    storageRefused = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    for (let i = 0; i < 5; i += 1) {
      listen(players[0], i * PROGRESS_WRITE_INTERVAL_MS + 1_000, (i + 1) * PROGRESS_WRITE_INTERVAL_MS);
      await flush();
    }
    // Saved all along, to the server; refused each time by the device.
    expect(setDoc.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it('forgets the device\'s record once the server has it', async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    listen(players[0], 0, 30_000);
    await pb.closePlayback();
    await flush();
    const sent = docOf('rec-a');

    // Another device moves on; a replay of a stale record must not undo it.
    seedDoc('rec-a', { ...sent, positionMs: 5_000, updatedAt: nowMs + 60_000 });
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(docOf('rec-a')?.positionMs).toBe(5_000);
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe('the skip controls', () => {
  it('skips forward by 30 seconds', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(10_000);
    pb.playback.skipForward();
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(40_000);
  });

  it('does not clamp to zero when the duration is unknown', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', 'stu-1', null));
    await flush();
    players[0].events.onProgress(600_000);
    pb.playback.skipForward();
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(630_000);
  });

  it('never skips past the end of a recording whose duration is known', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', 'stu-1', 20));
    await flush();
    players[0].events.onProgress(10_000);
    pb.playback.skipForward();
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(20_000);
  });

  it('never skips back past the start', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(5_000);
    pb.playback.skipBack();
    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(0);
  });
});

describe('signed URLs', () => {
  /*
   * REFRESHED BEFORE IT EXPIRES, not after it fails. GCS answers an expired
   * signed URL with a 400 and an `ExpiredToken` body — not a 403 — so a retry
   * handler cannot even tell it apart from a real error, and the listener hears
   * the failure first. The cache hands back a URL only while it has more than
   * the refresh window left on it.
   */
  it('re-mints a cached URL that is close to expiring', async () => {
    const pb = await load();
    callable.mockResolvedValue({
      data: { url: 'https://signed/nearly-stale.m4a', expiresAt: nowMs + 1_000 },
    });
    pb.openPlayback(recording('rec-a'));
    await flush();
    await pb.closePlayback();

    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the cached URL would expire before the recording ends', async () => {
    // Ninety minutes left on the URL, more than the refresh window — but the
    // recording is an hour long, and an hour plus the window is more than
    // ninety minutes. The old check let this play into an ExpiredToken.
    const pb = await load();
    callable.mockResolvedValue({
      data: { url: 'https://signed/ninety-minutes.m4a', expiresAt: nowMs + 90 * 60_000 },
    });
    pb.openPlayback(recording('rec-a')); // durationMs: 3_600_000
    await flush();
    await pb.closePlayback();

    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
  });

  it('reuses a cached URL rather than minting per open', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.openPlayback(recording('rec-b'));
    await flush();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
  });

  /*
   * A signed URL is bound to a RECORDING, not to the account that asked for it,
   * and it stays good for twelve hours — so a cache that outlives the credential
   * hands the next person on a shared device a working link.
   */
  it('sign-out drops the cache, so the next open re-mints', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    await pb.closePlayback();
    pb.forgetPlaybackUrls();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
  });

  it('a mint still in flight at sign-out never re-seeds the cache', async () => {
    const pb = await load();
    let release: (v: unknown) => void = () => {};
    callable.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    pb.openPlayback(recording('rec-a'));
    // The listener's progress is read first; then the mint goes out and is held.
    await flush();
    expect(callable).toHaveBeenCalledTimes(1);
    pb.forgetPlaybackUrls();
    release({ data: { url: 'https://signed/stale.m4a', expiresAt: 1e15 } });
    await flush();
    await pb.closePlayback();

    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
    // The URL that resolved after sign-out is not the one the next session got.
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
  });

  it('a failed mint surfaces as an error rather than a silent dead transport', async () => {
    const pb = await load();
    callable.mockRejectedValueOnce(new Error('The due date for this recording has passed.'));
    pb.openPlayback(recording('rec-a'));
    await flush();
    // And the session can be retried: opening it again builds a new player
    // rather than taking the "already loaded" path.
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players).toHaveLength(2);
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
  });
});

/*
 * A LINK THAT RUNS OUT UNDER A PAUSED LECTURE. A URL is minted to outlive one
 * listen, but a lecture left paused overnight outlives the URL: Play then ran
 * the buffer dry, every range request was refused, and after half a minute of
 * silence under "Pause" the student was told to check their connection, with
 * the transport down and nothing to fetch a new link but leaving the screen.
 */
describe('a link that runs out while paused', () => {
  /** URLs valid for the real twelve hours from when they are minted. */
  const realExpiry = () => {
    let n = 0;
    callable.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ data: { url: `https://signed/${n}`, expiresAt: nowMs + SIGNED_URL_TTL_MS } });
    });
  };
  const pausedAt = async (pb: Playback, ms: number) => {
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(0);
    wait(ms);
    players[0].events.onProgress(ms);
    pb.playback.pause();
    await flush();
  };

  it('Play after a night away fetches a new link and carries on from the place', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(SIGNED_URL_TTL_MS);
    pb.playback.play();
    await flush();
    await flush();
    expect(callable).toHaveBeenCalledTimes(2);
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 600_000, keptPlaying: true });
  });

  it('a seek after a night away fetches a new link, at the place sought', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(SIGNED_URL_TTL_MS);
    pb.playback.seek(1_800_000);
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 1_800_000, keptPlaying: false });
  });

  it('Play on the lock screen after a night away fetches a new link too', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(SIGNED_URL_TTL_MS);
    players[0].events.onPlayingChanged(true);
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 600_000, keptPlaying: true });
  });

  it('a link with the rest of the lecture still in it is kept', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(60 * 60_000);
    pb.playback.play();
    pb.playback.seek(1_200_000);
    await flush();
    expect(callable).toHaveBeenCalledTimes(1);
    expect(players[0].loaded).toBe('https://signed/1');
  });
});

describe('formatClock', () => {
  it('drops the hour under an hour and pads the minutes above it', async () => {
    const { formatClock } = await load();
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9_000)).toBe('0:09');
    expect(formatClock(605_000)).toBe('10:05');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(7_384_000)).toBe('2:03:04');
  });

  it('floors, so the readout never shows a second that has not happened', async () => {
    const { formatClock } = await load();
    expect(formatClock(1_999)).toBe('0:01');
    expect(formatClock(-500)).toBe('0:00');
  });
});

/**
 * The transport moving without this app asking.
 *
 * Android's notification and lock-screen controls drive the player directly, and
 * so does the OS taking audio focus for a call. None of it goes through
 * `playback.pause()`, and the session's own flag is what `toggle` reads — so
 * these assert through `toggle`, which is what the play/pause button on both
 * surfaces actually calls.
 */
/**
 * A class recorded in two stretches, each as slides-and-speaker video and
 * audio — what a Zoom import of a restarted meeting makes.
 */
const twoParts = (id: string) => ({
  ...recording(id),
  media: {
    p1a: file('p1a', { part: 1, durationSec: 3600 }),
    p1v: file('p1v', { part: 1, version: 'speaker', kind: 'video', durationSec: 3600 }),
    p2a: file('p2a', { part: 2, durationSec: 600 }),
    p2v: file('p2v', { part: 2, version: 'speaker', kind: 'video', durationSec: 600 }),
  } as MediaMap,
});
/** The file the session last asked a URL for. */
const lastMinted = () => (callable.mock.calls.at(-1)?.[0] as { itemId: string } | undefined)?.itemId;

describe('parts and versions', () => {
  it('resumes in the part and version the student was in, at their place', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 120_000, listenedMs: 3_700_000, part: 2, version: 'speaker', updatedAt: nowMs - 1000 });
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    expect(lastMinted()).toBe('p2v');
    expect(players[0].startedAt).toBe(120_000);
  });

  it('resumes a place saved before parts existed in Part 1, as it always did', async () => {
    const pb = await load();
    seedDoc('rec-a', { positionMs: 120_000, listenedMs: 120_000, updatedAt: nowMs - 1000 });
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    expect(lastMinted()).toBe('p1a');
    expect(players[0].startedAt).toBe(120_000);
  });

  it('switching version keeps the place, plays on, and counts no listening for the swap', async () => {
    const pb = await load();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(0);
    wait(100_000);
    players[0].events.onProgress(100_000);
    pb.playback.selectItem('p1v');
    await flush();
    expect(lastMinted()).toBe('p1v');
    // The same player, the same place, still playing.
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ startedAt: 100_000, keptPlaying: true });
    // A stale tick from the old source, and the new one's first, count nothing.
    players[0].events.onProgress(100_500);
    wait(1_000);
    players[0].events.onProgress(101_500);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')).toMatchObject({ part: 1, version: 'speaker', positionMs: 101_500, listenedMs: 101_000 });
  });

  it('goes on to the next part, in the same version, when a part ends', async () => {
    const pb = await load();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    players[0].events.onEnded();
    await flush();
    expect(lastMinted()).toBe('p2v');
    expect(players[0]).toMatchObject({ startedAt: 0, keptPlaying: true });
  });

  /*
   * THE PART PLAYING HIDDEN UNDER THE STUDENT. Staff may hide a part while
   * another stays visible; the next part was looked up among the visible ones
   * by the hidden part's place in them, which is nowhere, so the recording
   * "ended" there with Part 2 unplayed.
   */
  it('goes on to the next part when the one playing was hidden under it', async () => {
    const pb = await load();
    const rec = twoParts('rec-a');
    pb.openPlayback(rec);
    await flush();
    const hide = (i: MediaItem) => ({ ...i, hidden: true });
    pb.openPlayback({ ...rec, media: { ...rec.media, p1a: hide(rec.media.p1a), p1v: hide(rec.media.p1v) } });
    players[0].events.onEnded();
    await flush();
    expect(lastMinted()).toBe('p2a');
    expect(players[0]).toMatchObject({ startedAt: 0, keptPlaying: true });
  });

  it('stops at the end of the last part, where the student marks it complete', async () => {
    const pb = await load();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.selectPart(2);
    await flush();
    const mints = callable.mock.calls.length;
    players[0].events.onEnded();
    await flush();
    expect(callable.mock.calls.length).toBe(mints);
  });

  /*
   * A TICK WHILE A SWITCH IS ON ITS WAY is the old file's last word: counted,
   * it would be listening the student did not do, saved against the new file.
   */
  it('a tick during a switch counts nothing and is not saved against the new file', async () => {
    const pb = await load();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(0);
    wait(10_000);
    players[0].events.onProgress(10_000);
    holdMint = true;
    pb.playback.selectItem('p1v');
    wait(5_000);
    players[0].events.onProgress(15_000);
    finishMint?.({ data: { url: 'https://signed/p1v', expiresAt: 1e15 } });
    await flush();
    await flush();
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')).toMatchObject({ version: 'speaker', positionMs: 10_000, listenedMs: 10_000 });
  });

  /** Each file's URL names it, so a test can tell which one the player holds. */
  const urlPerFile = () =>
    callable.mockImplementation(({ itemId }: { itemId: string }) =>
      Promise.resolve({ data: { url: `https://signed/${itemId}`, expiresAt: 1e15 } }),
    );

  /*
   * A VERSION TAPPED WHILE THE RECORDING IS STILL OPENING. Before the place is
   * read the session does not know where the student was, and a switch then
   * saved a zero over it. Once the place is known but the file is still on its
   * way, the open and the switch both loaded, and the open's file won: one
   * file played under the other's label, and the place was saved against the
   * wrong version.
   */
  it('a version tapped before the place is read is not taken, and the place is kept', async () => {
    const pb = await load();
    urlPerFile();
    seedDoc('rec-a', { positionMs: 90_000, listenedMs: 90_000, part: 1, version: 'audio', updatedAt: nowMs - 1000 });
    pb.openPlayback(twoParts('rec-a'));
    pb.playback.selectItem('p1v');
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p1a', startedAt: 90_000 });
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ version: 'audio', positionMs: 90_000 });
  });

  it('a version tapped while the file is on its way is the one that plays, at the place', async () => {
    const pb = await load();
    urlPerFile();
    seedDoc('rec-a', { positionMs: 90_000, listenedMs: 90_000, part: 1, version: 'audio', updatedAt: nowMs - 1000 });
    callable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMint = resolve;
        }),
    );
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    finishMint?.({ data: { url: 'https://signed/p1a', expiresAt: 1e15 } });
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p1v', startedAt: 90_000 });
    players[0].events.onProgress(90_500);
    wait(1_000);
    players[0].events.onProgress(91_500);
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ version: 'speaker', positionMs: 91_500 });
  });

  /*
   * A SWITCH WHOSE FILE CANNOT BE HAD. The URL for the version or part asked
   * for did not come — the connection dropped, the function failed — and the
   * old file played on behind a transport the session had taken down: Pause
   * did nothing, nothing was counted, the chip showed a version that was not
   * playing, and tapping it again did nothing because it was "already"
   * selected. The file that was loaded is still in the player.
   */
  it('a version whose file cannot be had leaves the one that was playing, paused where it was', async () => {
    const pb = await load();
    urlPerFile();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(0);
    wait(10_000);
    players[0].events.onProgress(10_000);
    callable.mockRejectedValueOnce(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    pb.playback.selectItem('p1v');
    await flush();
    await flush();
    // Not playing on behind a dead transport.
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p1a', playing: false });
    // The student presses Play, and the audio they were on carries on, counted.
    pb.playback.play();
    expect(players[0].playing).toBe(true);
    wait(10_000);
    players[0].events.onProgress(20_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ version: 'audio', positionMs: 20_000, listenedMs: 20_000 });
  });

  it('the version that could not be had can be tapped again, and then plays', async () => {
    const pb = await load();
    urlPerFile();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    players[0].events.onProgress(0);
    wait(10_000);
    players[0].events.onProgress(10_000);
    callable.mockRejectedValueOnce(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    pb.playback.selectItem('p1v');
    await flush();
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p1v', startedAt: 10_000 });
    // And the transport is back: what is heard on it is counted.
    pb.playback.play();
    players[0].events.onProgress(10_000);
    wait(5_000);
    players[0].events.onProgress(15_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ version: 'speaker', positionMs: 15_000, listenedMs: 15_000 });
  });

  it('a next part that cannot be had at a part\'s end can be asked for again', async () => {
    const pb = await load();
    urlPerFile();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    callable.mockRejectedValueOnce(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    players[0].events.onEnded();
    await flush();
    await flush();
    expect(players[0].loaded).toBe('https://signed/p1a');
    pb.playback.selectPart(2);
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p2a', startedAt: 0 });
  });

  it('does not give a student a hidden file, though staff may play it', async () => {
    const hidden = (uid: string | null) => {
      const r = twoParts('rec-a');
      return { ...r, studentUid: uid, media: { ...r.media, p1v: { ...r.media.p1v, hidden: true } } };
    };
    let pb = await load();
    pb.openPlayback(hidden('stu-1'));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    expect(lastMinted()).toBe('p1a');
    pb = await load();
    pb.openPlayback(hidden(null));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    expect(lastMinted()).toBe('p1v');
  });
});

describe('a transport change from outside the app', () => {
  it('leaves the next tap RESUMING after the player pauses itself', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    expect(players[0].playing).toBe(true);

    // The lock-screen pause: the player stopped, the session was not told.
    players[0].playing = false;
    players[0].events.onPlayingChanged(false);

    pb.playback.toggle();
    // Without the correction the session still believed it was playing, so this
    // called `pause()` on an already-paused player — a no-op — and resuming took
    // two taps with a pause glyph shown over silence in between.
    expect(players[0].playing).toBe(true);
  });

  it('leaves the next tap PAUSING after the player resumes itself', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].playing = true;
    players[0].events.onPlayingChanged(true);

    pb.playback.toggle();
    expect(players[0].playing).toBe(false);
  });

  it('ignores a report from a session that has already been replaced', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    const stale = players[0].events;
    pb.openPlayback(recording('rec-b'));
    await flush();
    pb.playback.play();
    expect(players[1].playing).toBe(true);

    // The old player winding down reports a pause. It is not this session's.
    stale.onPlayingChanged(false);
    pb.playback.toggle();
    expect(players[1].playing).toBe(false);
  });

  it('stops claiming to play when the source fails', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    // A source that dies reports the fault AND reports itself paused — the
    // session takes `playing` from the transport, never from the fault.
    players[0].events.onError('audio error 4');
    players[0].playing = false;
    players[0].events.onPlayingChanged(false);

    pb.playback.toggle();
    // A transport that thinks it is playing over a dead source answers the next
    // tap with a pause, so the student cannot even try again.
    expect(players[0].playing).toBe(true);
  });

  /*
   * AND THE TRANSPORT GOES WITH IT.
   *
   * A failed source that leaves `ready` true draws a live scrubber, two skips
   * and four rate chips over audio that will never play — the same screen as a
   * working one. `ready` is not readable from here, so it is asserted through
   * the thing it gates: `onProgress` ignores every tick until the audio is
   * loaded, so a session that still believes it is ready RECORDS a position
   * from a player that never played one.
   */
  it('takes the transport down with a failed source', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onError('audio error 4');

    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    // Nothing was heard, so nothing is written — and certainly not half a minute
    // of listening against a lecture that never started.
    expect(docOf('rec-a')).toBeUndefined();
  });

  /*
   * AND IT COMES BACK WHEN THE FAULT DOES.
   *
   * A player's error is transient — cleared when a new source loads or
   * playback resumes successfully — so a network blip forty
   * minutes into a two-hour lecture sets it and then clears it. Latched, that
   * disabled the transport for good and, through the `!ready` gate on ticks,
   * stopped counting the remaining eighty minutes while the audio kept playing:
   * the ledger then reported a third of a lecture as the evidence.
   */
  it('restores the transport when a transient fault clears', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    wait(10_000);
    players[0].events.onProgress(10_000);

    players[0].events.onError('network blip');
    wait(10_000);
    players[0].events.onProgress(20_000); // arrives while nothing is ready
    players[0].events.onError(null);
    wait(20_000);
    players[0].events.onProgress(40_000); // counted again

    await pb.closePlayback();
    expect(docOf('rec-a')?.positionMs).toBe(40_000);
    /*
     * AND THE LISTENED TOTAL, which is the number the ledger presents as
     * evidence and the one a latched `ready` froze at the moment of the blip
     * while the audio played on.
     *
     * WHAT THIS DOES AND DOES NOT PROVE, stated because the first version of
     * this comment claimed more than the assertion delivers. It fails if `ready`
     * stays false after the fault clears — the regression — because every later
     * tick is then discarded and the total stops at zero. It does NOT prove the
     * tick gate discarded the tick DURING the fault: a discarded tick leaves
     * `position` alone, so the next one measures the whole advance and the total
     * comes out the same either way. That is the gate working as designed —
     * nothing heard is lost by a fault that passes — and the gate itself is
     * covered by four other cases in this file.
     */
    expect(docOf('rec-a')?.listenedMs).toBe(40_000);
  });

  it('does not restore a transport over a source that never loaded', async () => {
    const pb = await load();
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onError('audio error 4');
    players[0].events.onError(null);

    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    // The fault clearing says nothing about a load that never finished.
    expect(docOf('rec-a')).toBeUndefined();
  });

  it('can be retried after a failed source', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onError('audio error 4');

    pb.openPlayback(recording('rec-a'));
    await flush();
    // A second player, not the early return — so the student can try again.
    expect(players).toHaveLength(2);
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
  });

  it('does not become ready when a held load resolves after an error', async () => {
    // Web's `load` settles on the element's `error` event as well as on
    // `loadedmetadata`, because a stalled request fires neither and would hang
    // the promise for ever. So the resolve carries no claim that anything
    // loaded, and must not be allowed to overwrite the error with a ready
    // transport.
    // AFTER `load()`, which resets it — the module is reloaded per test.
    const pb = await load();
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onError('audio error 4');
    players[0].finishLoad?.();
    await flush();

    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toBeUndefined();
  });
});
