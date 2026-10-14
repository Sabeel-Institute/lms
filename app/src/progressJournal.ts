// The listening-progress journal: every save, recorded on the device until
// the server holds it. One implementation for both platforms; AsyncStorage is
// localStorage on the web.
//
// WHY THIS EXISTS, ON EACH:
//
// - Native. React Native stops every JavaScript timer while the app is in the
//   background (`JavaTimerManager.onHostPause`), and the Firebase JS SDK's
//   network layer runs on them. The audio keeps playing — it is a foreground
//   service — and the ticks keep arriving, but a progress write issued with
//   the screen locked does not reach the server until the app is brought
//   back. A lecture heard on the lock screen and then swiped away was lost
//   whole. Measured on the API 35 AVD against production, 2026-10-12.
// - Web. The SDK's persistent cache keeps a pending write across a page close,
//   but only the write handed to it: the playback write queue holds every
//   later save in memory behind the first one still waiting for the server.
//   Offline with minutes of lecture buffered, closing the tab lost all but the
//   first save. Measured against production, 2026-10-14.
//
// So every progress save is also recorded here, one key per progress
// document. A storage call needs no timer, and one key per document means a
// record is a single `setItem` — no read-modify-write that could itself stall
// half done. The record is forgotten once the server holds a save at least as
// new, replayed on the next launch, and merged into the session when the same
// recording is reopened on this device.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ListeningProgressDoc } from '@sabeel/shared';
import { captureError } from './sentry';

/**
 * Reported once: storage refused is the device's condition (a private window,
 * blocked site data), and saves come every few seconds.
 */
let reported = false;

const PREFIX = 'sabeel.progressJournal.v1:';

export type JournalEntry = Pick<
  ListeningProgressDoc,
  'studentUid' | 'recordingId' | 'courseId' | 'positionMs' | 'part' | 'version' | 'listenedMs' | 'updatedAt'
>;

/** Record a save before it is sent. `id` is the progress document's id. */
export function journalProgress(id: string, entry: JournalEntry): void {
  AsyncStorage.setItem(PREFIX + id, JSON.stringify(entry)).catch((e: unknown) => {
    if (reported) return;
    reported = true;
    captureError(e, { source: 'progressJournal' });
  });
}

async function read(key: string): Promise<JournalEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as JournalEntry) : null;
  } catch {
    return null;
  }
}

/** The record for one progress document, if this device holds one. */
export function journaledProgress(id: string): Promise<JournalEntry | null> {
  return read(PREFIX + id);
}

/**
 * Forget a record once the server holds a save at least as new as it. A newer
 * record — written while this save was in flight — stays for its own write.
 */
export async function forgetProgress(id: string, savedAt: number): Promise<void> {
  const entry = await read(PREFIX + id);
  if (entry && entry.updatedAt <= savedAt) await AsyncStorage.removeItem(PREFIX + id);
}

/**
 * Every record this device holds for one student. Scoped to the uid so a shared
 * device never tries to write one student's progress under another's auth.
 */
export async function journaledFor(studentUid: string): Promise<Array<[string, JournalEntry]>> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
  const out: Array<[string, JournalEntry]> = [];
  for (const key of keys) {
    const entry = await read(key);
    if (entry?.studentUid === studentUid) out.push([key.slice(PREFIX.length), entry]);
  }
  return out;
}
