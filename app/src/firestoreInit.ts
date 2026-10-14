// Native side of the Firestore-init seam (web sibling: firestoreInit.web.ts).
//
// The Firebase JS SDK's persistent cache is built on IndexedDB, which React
// Native does not have — the same wall the auth seam hit (see authInit.ts).
// `getFirestore` gives the default MEMORY cache, which is all native can do
// through this SDK.
//
// What that does and does not buy us for offline:
//  - WITHIN a running process, the memory cache still queues writes made while
//    offline and flushes them on reconnect — so "mark complete in airplane
//    mode, then reconnect with the app still open" works.
//  - It does NOT survive an app kill: a completion queued offline and then
//    force-closed before reconnecting is lost. That durability gap is closed by
//    a small native-only AsyncStorage backstop over the SAME direct-write path
//    (Phase 4c), not by a different write mechanism.
import type { FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

export function initDb(app: FirebaseApp): Firestore {
  return getFirestore(app);
}

/** The memory cache goes with the process, and a phone has no address to reset (see the web sibling). */
export async function afterSignOut(_db: Firestore, _drained: boolean): Promise<void> {}
