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
// - Web. A save is a transaction, and a transaction needs the server: one
//   made offline, or cut off by the tab closing, leaves nothing in the SDK's
//   cache to send later. And the server hears at most every 15 seconds, so
//   a tab closed mid-lecture lost the seconds since.
//
// So every sitting's listening is also recorded here, every second it plays,
// one key per sitting. A storage call needs no timer, and one key per sitting
// means a record is a single `setItem` — no read-modify-write that could
// itself stall half done. On the web it is synchronous, so a tab closed
// mid-lecture keeps everything up to its last second. The record is forgotten
// once the server holds a save at least as new, replayed on the next launch,
// and counted when the same recording is reopened on this device.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ListeningProgressDoc } from '@sabeel/shared';
import { storageRefused } from './deviceStorage';


const PREFIX = 'sabeel.progressJournal.v2:';
/*
 * RECORDS OF THE FIRST KIND are dropped, not sent: each held a total already
 * merged with the server's and a place, and a total cannot be added to the
 * other sittings without counting the same listening twice.
 */
const FIRST_KIND = 'sabeel.progressJournal.v1:';

/** One sitting's listening, as the device last recorded it. */
export type JournalEntry = Pick<
  ListeningProgressDoc,
  'studentUid' | 'recordingId' | 'courseId' | 'sitting' | 'listenedMs' | 'updatedAt'
>;

const keyOf = (id: string, sitting: string) => `${PREFIX}${id}:${sitting}`;

/** Record a sitting's listening before it is sent. `id` is the progress document's id. */
export function journalProgress(id: string, entry: JournalEntry): void {
  AsyncStorage.setItem(keyOf(id, entry.sitting), JSON.stringify(entry)).catch((e: unknown) => storageRefused(e, 'progressJournal'));
}

async function read(key: string): Promise<JournalEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as JournalEntry) : null;
  } catch {
    return null;
  }
}

async function entries(prefix: string): Promise<JournalEntry[]> {
  const keys = await AsyncStorage.getAllKeys();
  const stale = keys.filter((k) => k.startsWith(FIRST_KIND));
  if (stale.length) await AsyncStorage.multiRemove(stale);
  const out: JournalEntry[] = [];
  for (const key of keys.filter((k) => k.startsWith(prefix))) {
    const entry = await read(key);
    if (entry) out.push(entry);
  }
  return out;
}

/** Every sitting this device holds unsent for one progress document. */
export function journaledProgress(id: string): Promise<JournalEntry[]> {
  return entries(`${PREFIX}${id}:`);
}

/**
 * Forget a sitting's record once the server holds a save at least as new as
 * it. A newer record — written while this save was in flight — stays for its
 * own write.
 */
export async function forgetProgress(id: string, sitting: string, savedAt: number): Promise<void> {
  const entry = await read(keyOf(id, sitting));
  if (entry && entry.updatedAt <= savedAt) await AsyncStorage.removeItem(keyOf(id, sitting));
}

/**
 * Every record this device holds for one student. Scoped to the uid so a shared
 * device never tries to write one student's progress under another's auth.
 */
export async function journaledFor(studentUid: string): Promise<JournalEntry[]> {
  return (await entries(PREFIX)).filter((entry) => entry.studentUid === studentUid);
}
