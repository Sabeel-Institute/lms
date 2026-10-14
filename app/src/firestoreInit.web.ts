// Web side of the Firestore-init seam (native sibling: firestoreInit.ts).
//
// The browser HAS IndexedDB, so web gets a real persistent cache: offline
// writes (a completion marked with no network) survive a full page close and
// flush on the next load. `snapshot.metadata.hasPendingWrites` is what the UI
// reads to show "Pending sync" until that flush lands.
//
// `persistentMultipleTabManager` lets several tabs share one cache instead of
// the first tab taking an exclusive lock and the rest failing to initialise —
// the default single-tab manager throws `failed-precondition` in the second tab.
import type { FirebaseApp } from 'firebase/app';
import {
  clearIndexedDbPersistence,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  type Firestore,
} from 'firebase/firestore';

export function initDb(app: FirebaseApp): Firestore {
  return initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
}

/**
 * After a sign-out: leave nothing of the person behind on a shared browser.
 *
 * The cache outlives the session. A family computer kept a student's unsent
 * answer and their grade's feedback, and an office PC an admin's whole
 * student directory and every register they opened, for whoever used the
 * browser next to find. So once nothing is left to send (`drained`) the
 * cache is cleared, and the app starts again at its root, since a terminated
 * Firestore cannot be used again. When writes are still waiting (signed out
 * offline), they are that student's listening and they stay, kept apart by
 * account, to go when they next sign in. Either way the address goes back to
 * the root, so the next person does not land on the last one's page.
 */
export async function afterSignOut(db: Firestore, drained: boolean): Promise<void> {
  if (!drained) {
    window.history.replaceState(null, '', '/');
    return;
  }
  try {
    await terminate(db);
    // Refused while another tab of the app still has it open: best effort.
    await clearIndexedDbPersistence(db);
  } catch (e) {
    console.warn('clearing the cache after sign-out', e);
  }
  window.location.replace('/');
}
