// Web side of the listening-progress durability seam (native sibling:
// progressJournal.ts).
//
// A browser keeps running a hidden tab's timers (throttled, not stopped), and
// the SDK's persistent IndexedDB cache (firestoreInit.web.ts) keeps a pending
// write across a page close. Nothing is held outside Firestore, so there is
// nothing to record, merge or replay.
import type { JournalEntry } from './progressJournal';

export function journalProgress(_id: string, _entry: JournalEntry): void {}

export async function journaledProgress(_id: string): Promise<JournalEntry | null> {
  return null;
}

export async function forgetProgress(_id: string, _savedAt: number): Promise<void> {}

export async function journaledFor(_studentUid: string): Promise<Array<[string, JournalEntry]>> {
  return [];
}
