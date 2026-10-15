import { describe, expect, it, vi } from 'vitest';
import { PROGRESS_WRITE_INTERVAL_MS, SIGNED_URL_TTL_MS, withSitting, type MediaItem, type MediaMap } from '@sabeel/shared';

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
 * The device's storage — AsyncStorage, which holds the place this device
 * keeps in each recording and the listening it has not sent.
 *
 * DECLARED OUTSIDE `load()`, which resets every module: what is on the device
 * survives the app being killed, and that survival is what the journal tests
 * are about.
 */
const device = new Map<string, string>();
/** When set, the device refuses to store anything: a private window, blocked site data. */
let storageRefused = false;
/** When set, the next read of a kept place waits for `finishPlace()`: a slow device. */
let holdPlace = false;
let finishPlace: (() => void) | null = null;
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      const value = device.get(k) ?? null;
      if (holdPlace && k.startsWith('sabeel.place.')) {
        holdPlace = false;
        await new Promise<void>((resolve) => {
          finishPlace = resolve;
        });
      }
      return value;
    },
    setItem: async (k: string, v: string) => {
      if (storageRefused) throw new Error('QuotaExceededError');
      device.set(k, v);
    },
    removeItem: async (k: string) => {
      device.delete(k);
    },
    multiRemove: async (keys: string[]) => {
      for (const k of keys) device.delete(k);
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
interface Row {
  listenedMs: number;
  sittings: Record<string, number>;
  sitting: string;
  updatedAt: number;
  [field: string]: unknown;
}
/** The document for one recording, by the id used throughout these tests. */
const docOf = (recordingId: string) => docs.get(`listeningProgress/stu-1_${recordingId}`) as Row | undefined;
/**
 * Another device's sitting, saved to the server as that device would save it:
 * added to whatever the row already holds.
 */
const otherDevice = (recordingId: string, sitting: string, listenedMs: number, updatedAt = nowMs - 1_000) => {
  const row = docOf(recordingId);
  docs.set(`listeningProgress/stu-1_${recordingId}`, {
    studentUid: 'stu-1',
    recordingId,
    courseId: 'course-1',
    ...withSitting(row ?? null, { sitting, listenedMs, updatedAt }, nowMs),
  });
};
/** The place this device keeps in a recording. */
const placeOf = (recordingId: string) => {
  const raw = device.get(`sabeel.place.v1:stu-1:${recordingId}`);
  return raw ? (JSON.parse(raw) as { itemId: string; positionMs: number; at: number }) : undefined;
};
/** A place this device kept in an earlier sitting. */
const keptAt = (recordingId: string, itemId: string, positionMs: number) =>
  device.set(`sabeel.place.v1:stu-1:${recordingId}`, JSON.stringify({ itemId, positionMs, at: nowMs - 1_000 }));
/** The listening this device holds unsent, by sitting. */
const journalOf = (recordingId: string) =>
  [...device.entries()]
    .filter(([k]) => k.startsWith(`sabeel.progressJournal.v2:stu-1_${recordingId}:`))
    .map(([, v]) => JSON.parse(v) as { sitting: string; listenedMs: number; updatedAt: number });
/** Every read and write in order, for the tests about ordering. */
let ioLog: string[] = [];
/** A document as a snapshot holds it, SNAPSHOTTED AT CALL TIME like a real one. */
const snapshotOf = (path: string) => {
  const value = docs.get(path);
  return { exists: () => value !== undefined, data: () => value };
};
const getDoc = vi.fn((ref: { path: string }) => {
  ioLog.push('get');
  return Promise.resolve(snapshotOf(ref.path));
});
/**
 * When set, the next transaction's write waits for `finishSet()` after it
 * has landed.
 *
 * A progress write is a round trip, and what follows it touches module
 * state. Holding the write is the only way to put a NEWER session's load
 * between the two — which is the ordering the generation check after it
 * exists for, and which a resolved-immediately fake can never produce.
 */
let holdSet = false;
let finishSet: (() => void) | null = null;
/** When set, every transaction is refused the way the rules refuse a lapsed grant. */
let denySet = false;
/** Each write that landed: a committed transaction. */
const writes = vi.fn();
const runTransaction = vi.fn(
  async (fn: (tx: { get: (ref: { path: string }) => Promise<unknown>; set: (ref: { path: string }, v: Record<string, unknown>) => void }) => Promise<unknown>) => {
    let pending: { path: string; value: Record<string, unknown> } | null = null;
    const result = await fn({
      get: async (ref) => {
        ioLog.push('get');
        return snapshotOf(ref.path);
      },
      set: (ref, value) => {
        pending = { path: ref.path, value };
      },
    });
    if (denySet) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
    if (pending) {
      const { path, value } = pending;
      docs.set(path, value);
      ioLog.push('set');
      writes(path, value);
    }
    if (holdSet) {
      holdSet = false;
      await new Promise<void>((resolve) => {
        finishSet = resolve;
      });
    }
    return result;
  },
);
/** Sittings are numbered here; the app takes Firestore's random ids. */
let sittings = 0;
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ collection: name }),
  doc: (_parent: unknown, collection?: string, id?: string) =>
    collection === undefined ? { id: `sit-${(sittings += 1)}` } : { path: `${collection}/${id}` },
  getDoc: (ref: { path: string }) => getDoc(ref),
  runTransaction: (_db: unknown, fn: Parameters<typeof runTransaction>[0]) => runTransaction(fn),
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
      startedAt: null,
      unloaded: false,
      playing: false,
      finishLoad: null,
    };
    players.push(fake);
    return {
      load: (url: string, startMs: number, meta: { title: string; courseName: string }) => {
        fake.loaded = url;
        fake.startedAt = startMs;
        fake.announced = meta;
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
  holdPlace = false;
  finishPlace = null;
  denySet = false;
  getDoc.mockClear();
  runTransaction.mockClear();
  writes.mockClear();
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
    players[0].events.onProgress(29_000);
    wait(1_000);
    players[0].events.onProgress(30_000);

    pb.openPlayback(recording('rec-b'));
    await flush();
    await flush();

    expect(players).toHaveLength(2);
    expect(players[0].unloaded).toBe(true);
    expect(players[1].loaded).toBe('https://signed/audio.m4a');
    // And what the first session saved on its way out is the first
    // session's: its listening on its document, its place on the device.
    expect(docOf('rec-a')).toMatchObject({ recordingId: 'rec-a', listenedMs: 1_000 });
    expect(docOf('rec-b')).toBeUndefined();
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'rec-a-audio', positionMs: 30_000 });
  });

  it('the final write is attributed to the session that ENDED', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(44_000);
    wait(1_000);
    players[0].events.onProgress(45_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toMatchObject({ recordingId: 'rec-a', studentUid: 'stu-1', listenedMs: 1_000 });
    expect(placeOf('rec-a')?.positionMs).toBe(45_000);
  });

  it('a tick from a closed session cannot write over the open one', async () => {
    const pb = await load();
    keptAt('rec-b', 'rec-b-audio', 60_000);
    pb.openPlayback(recording('rec-a'));
    await flush();
    const first = players[0];
    pb.openPlayback(recording('rec-b'));
    await flush();

    // The old player is torn down but nothing stops a queued callback firing.
    wait(1_000);
    first.events.onProgress(9_000_000);
    await flush();
    // THE OPEN SESSION'S PLACE AND DOCUMENT, which is where a stale tick
    // would land: the closed one's are not, and asserting on them passed with
    // the guard removed.
    await pb.closePlayback();
    await flush();
    expect(placeOf('rec-b')?.positionMs).toBe(60_000);
    expect(docOf('rec-b')).toBeUndefined();
  });

  /*
   * A SLOW READ OF THE KEPT PLACE, ANSWERING AFTER ANOTHER RECORDING WAS
   * OPENED. Every other test here holds the mint; this holds the read, which
   * is where the old session would load its own file on the closed player.
   */
  it('a saved place read after another recording opened starts nothing', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 3_000_000);
    holdPlace = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.openPlayback(recording('rec-b'));
    await flush();
    finishPlace?.();
    await flush();
    await flush();
    expect(players[0].loaded).toBeNull();
    expect(players[1]).toMatchObject({ startedAt: 0 });
    expect(callable.mock.calls.map((c) => (c[0] as { recordingId: string }).recordingId)).toEqual(['rec-b']);
  });

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

  /*
   * A SESSION THAT NEVER LOADED MUST NOT OVERWRITE THE KEPT PLACE.
   *
   * `openPlayback` zeroes the position synchronously and restores the kept
   * one once the device has answered. A zero kept on the way out would be
   * the student's place in a two-hour lecture gone.
   */
  it('closing before the audio loads keeps the kept place', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 3_540_000);
    pb.openPlayback(recording('rec-a'));
    // No flush: the place, the mint and the stored listening are still in the air.
    await pb.closePlayback();
    await flush();
    expect(placeOf('rec-a')?.positionMs).toBe(3_540_000);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('a failed mint does not overwrite the kept place either', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 1_200_000);
    callable.mockRejectedValueOnce(new Error('offline'));
    pb.openPlayback(recording('rec-a'));
    await flush();
    await pb.closePlayback();
    await flush();
    expect(placeOf('rec-a')?.positionMs).toBe(1_200_000);
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
    otherDevice('rec-a', 'laptop', 3_000_000);
    keptAt('rec-a', 'rec-a-audio', 3_000_000);
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
    expect(runTransaction).not.toHaveBeenCalled();
  });
});

describe('who the progress belongs to', () => {
  it('staff listening writes NO progress document, and keeps no place', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', null));
    await flush();
    players[0].events.onProgress(59_000);
    wait(1_000);
    players[0].events.onProgress(60_000);
    await pb.closePlayback();
    expect(runTransaction).not.toHaveBeenCalled();
    expect([...device.keys()]).toEqual([]);
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
    expect(runTransaction).not.toHaveBeenCalled();
    expect(getDoc).not.toHaveBeenCalled();
    expect([...device.keys()]).toEqual([]);
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
    // halfway and closes the app keeps their listening, and their place here.
    expect(docOf('rec-a')).toMatchObject({ recordingId: 'rec-a', listenedMs: 2_000 });
    expect(placeOf('rec-a')?.positionMs).toBe(3_000);
    expect(players[0].unloaded).toBe(false);
  });

  it('a student resumes from the place this device kept', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 120_000);
    pb.openPlayback(recording('rec-a'));
    await flush();
    // HANDED TO THE PLAYER, which is the whole of "resumes": the place is
    // read, and then the audio starts there rather than at the beginning.
    expect(players[0].loaded).toBe('https://signed/audio.m4a');
    expect(players[0].startedAt).toBe(120_000);
    await pb.closePlayback();
    expect(placeOf('rec-a')?.positionMs).toBe(120_000);
  });

  /*
   * THE PLACE IS THIS DEVICE'S, and the server never holds one. A place
   * shared through the server was moved back by any device left open on an
   * older one; listening on another device adds to the total and moves
   * nothing here.
   */
  it('listening elsewhere moves nothing here, and no place is sent anywhere', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 600_000);
    otherDevice('rec-a', 'phone', 1_800_000);
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players[0].startedAt).toBe(600_000);
    pb.playback.play();
    players[0].events.onProgress(600_000);
    wait(1_000);
    players[0].events.onProgress(601_000);
    pb.playback.pause();
    await flush();
    expect(Object.keys(docOf('rec-a') ?? {}).sort()).toEqual(
      ['courseId', 'listenedMs', 'recordingId', 'sitting', 'sittings', 'studentUid', 'updatedAt'],
    );
    expect(placeOf('rec-a')?.positionMs).toBe(601_000);
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
   * that moment `position` is still the zero set at open and nothing has
   * been kept, so the very first tick keeps the zero over the student's place
   * in a two-hour lecture.
   */
  it('ignores a tick that arrives before the audio has loaded', async () => {
    const pb = await load();
    keptAt('rec-a', 'rec-a-audio', 3_540_000);
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();

    players[0].events.onProgress(0);
    await flush();
    expect(runTransaction).not.toHaveBeenCalled();
    expect(placeOf('rec-a')?.positionMs).toBe(3_540_000);

    players[0].finishLoad?.();
    await flush();
    await pb.closePlayback();
    await flush();
    expect(placeOf('rec-a')?.positionMs).toBe(3_540_000);
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
  it('shows the stored listening and the place while the file is on its way', async () => {
    const pb = await load();
    pb.usePlayback();
    keptAt('rec-a', 'rec-a-audio', 120_000);
    otherDevice('rec-a', 'laptop', 110_000);
    holdMint = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    await flush();
    expect(shown).toMatchObject({ ready: false, positionMs: 120_000, listenedMs: 110_000 });
  });

  it('offline, says so plainly and shows what this device recorded of the listening', async () => {
    const pb = await load();
    pb.usePlayback();
    device.set(
      'sabeel.progressJournal.v2:stu-1_rec-a:sit-earlier',
      JSON.stringify({ studentUid: 'stu-1', recordingId: 'rec-a', courseId: 'course-1', sitting: 'sit-earlier', listenedMs: 290_000, updatedAt: nowMs - 1000 }),
    );
    getDoc.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' })),
    );
    // What the Functions SDK makes of a call that never got an answer.
    callable.mockRejectedValueOnce(Object.assign(new Error('internal'), { code: 'functions/internal' }));
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
    expect(placeOf('rec-a')?.positionMs).toBe(3_000);
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
    // The first second heard is sent at once — there is no previous write to
    // space it from. The seconds after it fall inside one interval.
    for (const at of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      players[0].events.onProgress(at);
      wait(1_000);
    }
    await flush();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  /*
   * EVERY SECOND ON THE DEVICE, whatever the server is sent. A tab closed
   * mid-lecture lost everything since the last fifteen-second save, place
   * and listening alike: the usual way to stop on the web is to close it.
   */
  it('keeps the place and the listening on the device every second', async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    for (let at = 0; at <= 12_000; at += 1_000) {
      players[0].events.onProgress(at);
      wait(1_000);
    }
    await flush();
    // The server had the first second, and nothing since.
    expect(docOf('rec-a')?.listenedMs).toBe(1_000);
    // The tab is closed: nothing is paused, closed or sent.
    pb = await load({ killed: true });
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(players[0].startedAt).toBe(12_000);
    await pb.drainProgressJournal('stu-1');
    expect(docOf('rec-a')?.listenedMs).toBe(12_000);
  });

  /*
   * A PAUSED ANDROID PLAYER STILL TICKS. expo-video's clock reports the same
   * place every half second until the player is released, and each of those
   * ticks was news: re-rendered, kept and sent, for nothing that moved.
   */
  it('a paused player reporting the same place saves nothing', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(59_000);
    wait(1_000);
    players[0].events.onProgress(60_000);
    pb.playback.pause();
    await flush();
    const sent = writes.mock.calls.length;
    const kept = device.get('sabeel.place.v1:stu-1:rec-a');
    // A minute of the phone's paused clock.
    for (let i = 0; i < 120; i += 1) {
      wait(500);
      players[0].events.onProgress(60_000);
    }
    await flush();
    expect(writes.mock.calls.length).toBe(sent);
    expect(device.get('sabeel.place.v1:stu-1:rec-a')).toBe(kept);
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
    expect(docOf('rec-a')?.listenedMs ?? 0).toBe(0);
    expect(placeOf('rec-a')?.positionMs).toBe(601_000);
  });

  /*
   * ANOTHER DEVICE'S CLOCK A DAY FAST stamped its save a day ahead, and staff
   * read "last listened" a day in the future, whatever was played here.
   */
  it('a save stamped by a clock a day ahead does not hold "last listened" in the future', async () => {
    const pb = await load();
    otherDevice('rec-a', 'fast', 9_613, nowMs + 24 * 60 * 60 * 1000);
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(30_000);
    wait(6_000);
    players[0].events.onProgress(36_000);
    pb.playback.pause();
    await flush();
    expect(docOf('rec-a')).toMatchObject({ listenedMs: 15_613, updatedAt: nowMs });
  });

  it('adds another device’s listening to this one’s', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    wait(3_000);
    players[0].events.onProgress(4_000);
    await flush();
    // A phone that listened further saves while this session is open.
    otherDevice('rec-a', 'phone', 400_000, nowMs + 1000);
    await pb.closePlayback();
    expect(docOf('rec-a')?.listenedMs).toBe(403_000);
  });

  /*
   * A TAB LEFT OPEN AND TAKEN UP AGAIN. Its total was its own count from when
   * it opened, and the larger of that and the stored one was kept: everything
   * it played after another device had played more was lost.
   */
  it('a session taken up again after another device listened adds what it plays', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onProgress(0);
    wait(600_000);
    players[0].events.onProgress(600_000);
    pb.playback.pause();
    await flush();
    // The phone listens twenty minutes while the laptop sits paused.
    otherDevice('rec-a', 'phone', 1_200_000);
    pb.playback.play();
    wait(300_000);
    players[0].events.onProgress(900_000);
    pb.playback.pause();
    await flush();
    expect(docOf('rec-a')?.listenedMs).toBe(2_100_000);
    // And the laptop shows it.
    expect(shown).toMatchObject({ listenedMs: 2_100_000 });
  });

  /*
   * A WRITE CANNOT REACH INTO A SESSION THAT REPLACED IT.
   *
   * `writeProgress` is a round trip, so a close and a re-open can land inside
   * one. Taking what it stored into the module's counts without checking the
   * generation writes the FIRST recording's hours into the second
   * recording's ledger — "progress written for the wrong session" reached
   * through the write rather than through the open.
   */
  it('a write that finishes after its session ended does not seed the new one', async () => {
    const pb = await load();
    otherDevice('rec-a', 'laptop', 1_800_000);
    pb.openPlayback(recording('rec-a'));
    await flush();
    // A tick queues a write that rec-a's half hour is added to, and the write
    // is held open at exactly the point where what follows it would run.
    holdSet = true;
    players[0].events.onProgress(1_000);
    wait(1_000);
    players[0].events.onProgress(2_000);
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
    // And rec-a's own half hour and second are on rec-a's document.
    expect(docOf('rec-a')?.listenedMs).toBe(1_801_000);
  });

  it("does not count another device's listening once per queued write", async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(1_000);
    wait(10_000);
    players[0].events.onProgress(11_000);

    // A laptop finished the same lecture while this session was open.
    otherDevice('rec-a', 'laptop', 900_000, nowMs + 1000);

    // Writes queued back to back: a skip, and a pause.
    pb.playback.seek(20_000);
    players[0].events.onProgress(20_000);
    pb.playback.pause();
    await flush();

    // Now listen a little more, so the session's own running total is written
    // once the queue has drained — which is where an inflation would show.
    pb.playback.play();
    wait(1_000);
    players[0].events.onProgress(21_000);
    await pb.closePlayback();
    await flush();

    // The laptop's, plus the eleven seconds heard here.
    expect(docOf('rec-a')?.listenedMs).toBe(911_000);
  });

  /*
   * AND THE TICKS THAT ARRIVED DURING THE WRITE SURVIVE IT.
   *
   * A save is captured before its round trip. Taking what it stored back as
   * the running count throws away everything heard while it was in flight,
   * which over a two-hour lecture silently under-reports the number staff
   * read as evidence.
   */
  it('keeps the seconds heard while a write was in flight', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();

    players[0].events.onProgress(1_000);
    // The first save goes out carrying four seconds and is held.
    holdSet = true;
    wait(4_000);
    players[0].events.onProgress(5_000);
    await flush();
    // Four more arrive before that write comes back.
    wait(4_000);
    players[0].events.onProgress(9_000);
    finishSet?.();
    await flush();

    await pb.closePlayback();
    await flush();
    // Taking the stored figure back as this sitting's count would have kept 4.
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
    expect(placeOf('rec-a')?.positionMs).toBe(11_000);
    expect(docOf('rec-a')?.listenedMs).toBe(1_000);
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
    expect(placeOf('rec-a')?.positionMs).toBe(60_000);
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
    // HELD: inside the window the stale position is discarded, so what is
    // kept is still the seek's own target rather than the player's report.
    expect(placeOf('rec-a')?.positionMs).toBe(9_999_000);

    // Past the hold, the player's own position is believed again.
    wait(2_500);
    players[0].events.onProgress(61_000);
    wait(1_000);
    players[0].events.onProgress(62_000);
    await pb.closePlayback();
    await flush();
    expect(placeOf('rec-a')?.positionMs).toBe(62_000);
  });
});

/*
 * ONE WRITE AT A TIME. Each write is a transaction on one document, and a
 * pause persists without the throttle, so two asked for at once is routine.
 * Run concurrently they would only contend with each other.
 */
describe('the write queue', () => {
  it('never has two writes of the progress document in flight at once', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    // Discard the session's own opening read of the stored listening; what
    // is under test is the writes that follow it.
    ioLog = [];

    // The first save is held open, so the saves after it are asked for while
    // it is still in flight.
    holdSet = true;
    players[0].events.onProgress(1_000);
    wait(1_000);
    players[0].events.onProgress(2_000);
    await flush();
    wait(1_000);
    players[0].events.onProgress(3_000);
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
 * Here a held write is the stalled network and `load({ killed: true })` is
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
    // The first save goes out and stalls: the screen is off.
    holdSet = true;
    listen(players[0], 0, 1_000);
    await flush();
    // Ten minutes on the lock screen, then the lock-screen Pause.
    listen(players[0], 1_000, 607_000);
    players[0].events.onPlayingChanged(false);
    await flush();
    // Nothing has reached the server beyond the first, stalled save.
    expect(docOf('rec-a')?.listenedMs).toBeLessThanOrEqual(1_000);

    // Closed from recents, reopened later.
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(docOf('rec-a')?.listenedMs).toBe(607_000);
    expect(placeOf('rec-a')?.positionMs).toBe(607_000);
  });

  it("reopened before anything is sent, counts this device's unsent listening once", async () => {
    let pb = await load();
    otherDevice('rec-a', 'laptop', 60_000);
    keptAt('rec-a', 'rec-a-audio', 60_000);
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    holdSet = true;
    listen(players[0], 60_000, 61_000);
    await flush();
    listen(players[0], 61_000, 300_000);
    players[0].events.onPlayingChanged(false);
    await flush();

    // Reopened straight onto the same lecture, with the server still behind.
    pb = await load({ killed: true });
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    await flush();
    expect(players[0].startedAt).toBe(300_000);
    // The laptop's minute and the unsent four, once each.
    expect(shown).toMatchObject({ listenedMs: 300_000 });
    listen(players[0], 300_000, 301_000);
    await pb.closePlayback();
    await pb.drainProgressJournal('stu-1');
    expect(docOf('rec-a')?.listenedMs).toBe(301_000);
    expect(placeOf('rec-a')?.positionMs).toBe(301_000);
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
    expect(writes).toHaveBeenCalledTimes(1);

    // The app comes forward and the stalled write completes.
    finishSet?.();
    await flush();
    await flush();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(docOf('rec-a')?.listenedMs).toBeGreaterThanOrEqual(3_600_000 - PROGRESS_WRITE_INTERVAL_MS);
  });

  it('a replayed record never displaces a newer save waiting to go', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    holdSet = true;
    listen(players[0], 0, 20_000);
    pb.playback.pause();
    await flush();
    // A record of this sitting older than the waiting save, as a launch-time
    // replay can read it just before the session saves again.
    const { sitting } = docOf('rec-a')!;
    device.set(
      `sabeel.progressJournal.v2:stu-1_rec-a:${sitting}`,
      JSON.stringify({ studentUid: 'stu-1', recordingId: 'rec-a', courseId: 'course-1', sitting, listenedMs: 5_000, updatedAt: nowMs - 10_000 }),
    );
    const drained = pb.drainProgressJournal('stu-1');
    await flush();
    finishSet?.();
    await drained;
    await flush();
    expect(docOf('rec-a')?.listenedMs).toBe(20_000);
  });

  it('drops a record the server refuses, rather than replaying it for ever', async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    holdSet = true;
    listen(players[0], 0, 30_000);
    await flush();

    // Closed; meanwhile the student is un-excused, so the grant has gone.
    pb = await load({ killed: true });
    denySet = true;
    await pb.drainProgressJournal('stu-1');
    await flush();
    expect(runTransaction).toHaveBeenCalledTimes(1);

    // The next launch has nothing left to send.
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('a device that refuses to store reports it once, not at every save', async () => {
    const pb = await load();
    const { captureError } = await import('./sentry');
    vi.mocked(captureError).mockClear();
    storageRefused = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    for (let i = 0; i < 5; i += 1) {
      listen(players[0], i * PROGRESS_WRITE_INTERVAL_MS + 1_000, (i + 1) * PROGRESS_WRITE_INTERVAL_MS);
      await flush();
    }
    // Saved all along, to the server; refused every second by the device.
    expect(writes.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("forgets the device's record once the server has it", async () => {
    let pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    listen(players[0], 0, 30_000);
    await pb.closePlayback();
    await flush();
    await flush();
    expect(journalOf('rec-a')).toEqual([]);

    // So the next launch sends nothing.
    pb = await load({ killed: true });
    await pb.drainProgressJournal('stu-1');
    expect(runTransaction).not.toHaveBeenCalled();
  });

  /*
   * A RECORD OF THE FIRST KIND held a total already merged with the
   * server's, and a place. Added to the other sittings it would count the
   * same listening twice, so it is dropped rather than sent.
   */
  it('drops a record of the first kind rather than counting it twice', async () => {
    const pb = await load();
    device.set(
      'sabeel.progressJournal.v1:stu-1_rec-a',
      JSON.stringify({ studentUid: 'stu-1', recordingId: 'rec-a', courseId: 'course-1', positionMs: 5_000, listenedMs: 5_000, updatedAt: nowMs - 10_000 }),
    );
    await pb.drainProgressJournal('stu-1');
    expect(runTransaction).not.toHaveBeenCalled();
    expect(device.has('sabeel.progressJournal.v1:stu-1_rec-a')).toBe(false);
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
    expect(placeOf('rec-a')?.positionMs).toBe(40_000);
  });

  it('does not clamp to zero when the duration is unknown', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', 'stu-1', null));
    await flush();
    players[0].events.onProgress(600_000);
    pb.playback.skipForward();
    await pb.closePlayback();
    expect(placeOf('rec-a')?.positionMs).toBe(630_000);
  });

  it('never skips past the end of a recording whose duration is known', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a', 'stu-1', 20));
    await flush();
    players[0].events.onProgress(10_000);
    pb.playback.skipForward();
    await pb.closePlayback();
    expect(placeOf('rec-a')?.positionMs).toBe(20_000);
  });

  it('never skips back past the start', async () => {
    const pb = await load();
    pb.openPlayback(recording('rec-a'));
    await flush();
    players[0].events.onProgress(5_000);
    pb.playback.skipBack();
    await pb.closePlayback();
    expect(placeOf('rec-a')?.positionMs).toBe(0);
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
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 600_000, playing: true });
  });

  it('a seek after a night away fetches a new link, at the place sought', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(SIGNED_URL_TTL_MS);
    pb.playback.seek(1_800_000);
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 1_800_000, playing: false });
  });

  it('Play on the lock screen after a night away fetches a new link too', async () => {
    const pb = await load();
    realExpiry();
    await pausedAt(pb, 600_000);
    wait(SIGNED_URL_TTL_MS);
    players[0].events.onPlayingChanged(true);
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/2', startedAt: 600_000, playing: true });
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
  it('resumes in the file this device was playing, at its place', async () => {
    const pb = await load();
    keptAt('rec-a', 'p2v', 120_000);
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    expect(lastMinted()).toBe('p2v');
    expect(players[0].startedAt).toBe(120_000);
  });

  /*
   * A PART STAFF MOVED while the student was away. A place kept by part
   * number resumed in the other stretch of class; kept by the file's id it
   * resumes in the stretch it was in, wherever that is now.
   */
  it('resumes in the stretch of class it was in after staff move the parts', async () => {
    const pb = await load();
    keptAt('rec-a', 'p2a', 120_000);
    const rec = twoParts('rec-a');
    const swapped = Object.fromEntries(
      Object.entries(rec.media).map(([id, i]) => [id, { ...i, part: i.part === 1 ? 2 : 1 }]),
    ) as MediaMap;
    pb.openPlayback({ ...rec, media: swapped });
    await flush();
    expect(lastMinted()).toBe('p2a');
    expect(players[0].startedAt).toBe(120_000);
  });

  it('a place in a file staff have hidden resumes in its part, and in a file gone at the start', async () => {
    let pb = await load();
    const rec = twoParts('rec-a');
    keptAt('rec-a', 'p2v', 120_000);
    pb.openPlayback({ ...rec, media: { ...rec.media, p2v: { ...rec.media.p2v, hidden: true } } });
    await flush();
    expect(lastMinted()).toBe('p2a');
    expect(players[0].startedAt).toBe(120_000);
    await pb.closePlayback();

    pb = await load();
    keptAt('rec-a', 'gone', 120_000);
    pb.openPlayback(rec);
    await flush();
    expect(lastMinted()).toBe('p1a');
    expect(players[0].startedAt).toBe(0);
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
    expect(players[0]).toMatchObject({ startedAt: 100_000, playing: true });
    // A stale tick from the old source, and the new one's first, count nothing.
    players[0].events.onProgress(100_500);
    wait(1_000);
    players[0].events.onProgress(101_500);
    await pb.closePlayback();
    await flush();
    expect(docOf('rec-a')?.listenedMs).toBe(101_000);
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1v', positionMs: 101_500 });
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
    expect(players[0]).toMatchObject({ startedAt: 0, playing: true });
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
    expect(players[0]).toMatchObject({ startedAt: 0, playing: true });
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
    expect(docOf('rec-a')?.listenedMs).toBe(10_000);
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1v', positionMs: 10_000 });
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
    keptAt('rec-a', 'p1a', 90_000);
    pb.openPlayback(twoParts('rec-a'));
    pb.playback.selectItem('p1v');
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p1a', startedAt: 90_000 });
    await pb.closePlayback();
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1a', positionMs: 90_000 });
  });

  it('a version tapped while the file is on its way is the one that plays, at the place', async () => {
    const pb = await load();
    urlPerFile();
    keptAt('rec-a', 'p1a', 90_000);
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
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1v', positionMs: 91_500 });
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
    expect(docOf('rec-a')?.listenedMs).toBe(20_000);
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1a', positionMs: 20_000 });
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
    expect(docOf('rec-a')?.listenedMs).toBe(15_000);
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1v', positionMs: 15_000 });
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

/*
 * WHEN THIS STRETCH OF PLAYING BEGAN. A recording playing as its last day ends
 * plays on to the end of its part; one paused before midnight and started
 * after it must not. The screens tell the two apart by this alone, so it must
 * follow every stop and start, the lock screen's included.
 */
describe('when playing began', () => {
  it('is set on play, kept while playing, and gone on a pause', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    expect(shown).toMatchObject({ playingSince: null });
    pb.playback.play();
    const began = nowMs;
    expect(shown).toMatchObject({ playing: true, playingSince: began });
    wait(60_000);
    players[0].events.onBuffering(true);
    pb.playback.seek(30_000);
    expect(shown).toMatchObject({ playing: true, playingSince: began });
    pb.playback.pause();
    expect(shown).toMatchObject({ playing: false, playingSince: null });
    wait(60_000);
    pb.playback.play();
    expect(shown).toMatchObject({ playing: true, playingSince: nowMs });
  });

  it('is gone when the lock screen pauses it', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].playing = false;
    players[0].events.onPlayingChanged(false);
    expect(shown).toMatchObject({ playing: false, playingSince: null });
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

    players[0].events.onProgress(29_000);
    wait(1_000);
    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    // Nothing was heard, so nothing is written or kept — and certainly not a
    // place half a minute into a lecture that never started.
    expect(docOf('rec-a')).toBeUndefined();
    expect(placeOf('rec-a')?.positionMs).toBe(0);
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
    expect(placeOf('rec-a')?.positionMs).toBe(40_000);
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

    players[0].events.onProgress(29_000);
    wait(1_000);
    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    // The fault clearing says nothing about a load that never finished.
    expect(docOf('rec-a')).toBeUndefined();
    expect(placeOf('rec-a')?.positionMs).toBe(0);
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

    players[0].events.onProgress(29_000);
    wait(1_000);
    players[0].events.onProgress(30_000);
    await pb.closePlayback();
    expect(docOf('rec-a')).toBeUndefined();
    expect(placeOf('rec-a')?.positionMs).toBe(0);
  });
});

/*
 * PLAY TAPPED BEFORE THE FILE CAN PLAY. A long recording's index is
 * megabytes, half a minute on a slow phone connection, and Play was greyed
 * out for all of it: the student had to notice when it was ready and tap
 * again. The tap is kept, and the file starts the moment it can.
 */
describe('Play while the file is on its way', () => {
  it('starts the moment the file can play', async () => {
    const pb = await load();
    pb.usePlayback();
    holdMint = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    expect(shown).toMatchObject({ ready: false, playing: false, startWhenReady: true });
    expect(players[0].playing).toBe(false);
    finishMint?.({ data: { url: 'https://signed/audio.m4a', expiresAt: 1e15 } });
    await flush();
    await flush();
    expect(players[0].playing).toBe(true);
    expect(shown).toMatchObject({ ready: true, playing: true, startWhenReady: false });
  });

  it('Pause takes the tap back', async () => {
    const pb = await load();
    pb.usePlayback();
    holdMint = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    pb.playback.pause();
    expect(shown).toMatchObject({ startWhenReady: false });
    finishMint?.({ data: { url: 'https://signed/audio.m4a', expiresAt: 1e15 } });
    await flush();
    await flush();
    expect(players[0].playing).toBe(false);
    expect(shown).toMatchObject({ ready: true, playing: false });
  });

  it('is not kept over a file that fails as it loads', async () => {
    const pb = await load();
    pb.usePlayback();
    holdLoad = true;
    pb.openPlayback(recording('rec-a'));
    await flush();
    pb.playback.play();
    players[0].events.onError('audio error 4');
    expect(shown).toMatchObject({ ready: false, startWhenReady: false });
    players[0].finishLoad?.();
    await flush();
    expect(players[0].playing).toBe(false);
  });

  it('is not kept over a recording that could not be opened', async () => {
    const pb = await load();
    pb.usePlayback();
    callable.mockRejectedValueOnce(new Error('The due date for this recording has passed.'));
    pb.openPlayback(recording('rec-a'));
    await flush();
    await flush();
    pb.playback.play();
    expect(shown).toMatchObject({ ready: false, startWhenReady: false, error: 'The due date for this recording has passed.' });
  });

  it('a part switched to while playing plays on, and Pause during the switch holds it', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.play();
    holdMint = true;
    pb.playback.selectPart(2);
    expect(shown).toMatchObject({ ready: false, startWhenReady: true });
    pb.playback.pause();
    finishMint?.({ data: { url: 'https://signed/p2a', expiresAt: 1e15 } });
    await flush();
    await flush();
    expect(players[0]).toMatchObject({ loaded: 'https://signed/p2a', playing: false });
  });
});

/*
 * THE BOOKMARK: the place a student chose to come back to, on any device.
 * Going to it moves this session there; it never moves by itself.
 */
describe('going to a bookmark', () => {
  it('in the part playing, seeks there in the version being watched', async () => {
    const pb = await load();
    pb.usePlayback();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    const mints = callable.mock.calls.length;
    pb.playback.goTo('p1a', 300_000);
    expect(callable.mock.calls.length).toBe(mints);
    expect(shown).toMatchObject({ positionMs: 300_000 });
    await pb.closePlayback();
    expect(placeOf('rec-a')).toMatchObject({ itemId: 'p1v', positionMs: 300_000 });
  });

  it('in another part, goes to that part in the version being watched', async () => {
    const pb = await load();
    pb.openPlayback(twoParts('rec-a'));
    await flush();
    pb.playback.selectItem('p1v');
    await flush();
    pb.playback.goTo('p2a', 120_000);
    await flush();
    expect(lastMinted()).toBe('p2v');
    expect(players[0].startedAt).toBe(120_000);
  });

  it('set in a part staff have since moved, goes to the stretch it was set in', async () => {
    const pb = await load();
    const rec = twoParts('rec-a');
    const swapped = Object.fromEntries(
      Object.entries(rec.media).map(([id, i]) => [id, { ...i, part: i.part === 1 ? 2 : 1 }]),
    ) as MediaMap;
    pb.openPlayback({ ...rec, media: swapped });
    await flush();
    // Opened on the first part, which is now the old Part 2.
    expect(lastMinted()).toBe('p2a');
    pb.playback.goTo('p1a', 60_000);
    await flush();
    expect(lastMinted()).toBe('p1a');
    expect(players[0].startedAt).toBe(60_000);
  });

  it('before the place is known, goes nowhere', async () => {
    const pb = await load();
    keptAt('rec-a', 'p1a', 90_000);
    pb.openPlayback(twoParts('rec-a'));
    pb.playback.goTo('p2a', 10_000);
    await flush();
    await flush();
    expect(players[0].startedAt).toBe(90_000);
    expect(lastMinted()).toBe('p1a');
  });
});
