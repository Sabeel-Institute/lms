// The answer journal: what a student typed, kept on the device until the
// server holds it.
//
// WHY: on Android, Firestore's cache is in memory, so an answer typed with no
// signal waited in memory for the connection, the screen said "Saving…", and
// an app killed before the signal came back took the answer with it. The web
// keeps such a write in IndexedDB, but nothing is lost by keeping it here too.
// One key per assignment, written on every change; forgotten once the server
// holds exactly that text; put back when the assignment is opened again and
// the server's copy is older.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureError } from './sentry';

const PREFIX = 'sabeel.answerJournal.v1:';
const key = (uid: string, courseworkId: string) => `${PREFIX}${uid}_${courseworkId}`;

export interface JournaledAnswer {
  note: string;
  /** When it was typed, by this device's clock. */
  at: number;
}

/** Reported once: storage refused is the device's condition, and every keystroke would report it. */
let reported = false;

/** Keep what was typed. Fire and forget: a keystroke never waits for storage. */
export function journalAnswer(uid: string, courseworkId: string, note: string): void {
  const entry: JournaledAnswer = { note, at: Date.now() };
  AsyncStorage.setItem(key(uid, courseworkId), JSON.stringify(entry)).catch((e: unknown) => {
    if (reported) return;
    reported = true;
    captureError(e, { source: 'answerJournal' });
  });
}

export async function journaledAnswer(uid: string, courseworkId: string): Promise<JournaledAnswer | null> {
  try {
    const raw = await AsyncStorage.getItem(key(uid, courseworkId));
    return raw ? (JSON.parse(raw) as JournaledAnswer) : null;
  } catch {
    return null;
  }
}

/** Forget the device's copy once the server holds exactly it; newer typing stays. */
export async function forgetAnswer(uid: string, courseworkId: string, saved: string): Promise<void> {
  try {
    const entry = await journaledAnswer(uid, courseworkId);
    if (entry && entry.note === saved) await AsyncStorage.removeItem(key(uid, courseworkId));
  } catch {
    // Kept, then: at worst it is put back over the same words.
  }
}

/**
 * Whether the device's copy should be put back over the stored answer: it
 * says something else, and it is newer than the stored answer, which another
 * device may have written since.
 */
export function restorable(entry: JournaledAnswer | null, stored: { note: string; updatedAt: number } | null): entry is JournaledAnswer {
  if (!entry) return false;
  if (!stored) return entry.note.trim() !== '';
  return entry.note !== stored.note && entry.at > stored.updatedAt;
}

/**
 * Forget every answer kept on this device: at sign-out, once everything has
 * been sent. On a shared computer the journal is the browser's storage, and
 * the next person to sign in could read a private answer from it.
 */
export async function forgetEveryAnswer(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // Storage refused: nothing more this device can do about it.
  }
}
