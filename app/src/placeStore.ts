// WHERE THIS DEVICE WAS, in each recording: the place a recording resumes
// from when it is opened here again. Kept on the device and nowhere else
// (decision 2026-10-15): a place shared through the server was moved back by
// any device left open on an older one, so a student moves their place
// between devices on purpose, with a bookmark (`bookmarks.ts`).
//
// One key per student and recording, written every second while it plays.
// AsyncStorage is localStorage on the web, where a write is synchronous: a
// tab closed mid-lecture reopens within a second of where it stopped.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { storageRefused } from './deviceStorage';

const PREFIX = 'sabeel.place.v1:';

/** A place: a position in one file of a recording, by the file's id. */
export interface KeptPlace {
  itemId: string;
  positionMs: number;
  at: number;
}


const keyOf = (studentUid: string, recordingId: string) => `${PREFIX}${studentUid}:${recordingId}`;

export function keepPlace(studentUid: string, recordingId: string, place: KeptPlace): void {
  AsyncStorage.setItem(keyOf(studentUid, recordingId), JSON.stringify(place)).catch((e: unknown) => storageRefused(e, 'placeStore'));
}

export async function keptPlace(studentUid: string, recordingId: string): Promise<KeptPlace | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(studentUid, recordingId));
    return raw ? (JSON.parse(raw) as KeptPlace) : null;
  } catch {
    return null;
  }
}

/**
 * Forget every place on this device: at sign-out, so the next person at a
 * shared computer is not shown where the last one was in their recordings.
 * Bookmarks are on the server and come back with the account.
 */
export async function forgetEveryPlace(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // Storage refused: there is nothing kept to forget.
  }
}
