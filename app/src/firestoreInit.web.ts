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
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';

/*
 * EVERY TAB OF THE APP SHARES ONE CACHE, and one never clears it under the
 * others. Cleared at a sign-out or a Try again in one tab, it ended every
 * listener in the rest ("aborted"), told a student their open assignment was
 * gone, and left a sign-in there that never arrived. So the tab that clears
 * says so first: the others stop reading and let the cache go, and once it is
 * cleared they start again, at the root after a sign-out, where they were
 * after a Try again.
 */
type CacheStep = { step: 'ending' | 'ended'; to: string | null };
const otherTabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sabeel-lms-cache');
const beforeEnding: (() => void)[] = [];

/** Run before this tab lets the cache go for another's clearing: its reads are no longer live. */
export function onCacheEnding(fn: () => void): void {
  beforeEnding.push(fn);
}

export function initDb(app: FirebaseApp): Firestore {
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  otherTabs?.addEventListener('message', (ev: MessageEvent<CacheStep>) => {
    if (ev.data.step === 'ending') {
      for (const fn of beforeEnding) fn();
      void terminate(db).catch(() => undefined);
    } else if (ev.data.to) window.location.replace(ev.data.to);
    else window.location.reload();
  });
  return db;
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
  await dropCache(db, '/');
  window.location.replace('/');
}

/**
 * Draw the app again from the server's copies, for the boundary's Try again.
 *
 * A document the browser kept from before a migration broke its screen, and
 * Try again redrew it from that same cache, every time: the screen's listener
 * had gone with the screen, so nothing ever fetched the migrated copy. When
 * nothing is waiting to be sent, the cache goes and the page loads again, from
 * the server. When something is (offline, listening not yet sent), it stays,
 * and the screen is only redrawn: false.
 */
export async function reloadFromServer(db: Firestore, ending: () => void): Promise<boolean> {
  const drained = await Promise.race([
    waitForPendingWrites(db).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!drained) return false;
  ending();
  await dropCache(db, null);
  window.location.reload();
  return true;
}

/** Clear the shared cache, with every other tab of the app let go of it first and started again after. */
async function dropCache(db: Firestore, to: string | null): Promise<void> {
  try {
    otherTabs?.postMessage({ step: 'ending', to } satisfies CacheStep);
    await terminate(db);
    // Long enough for the other tabs to let go. One asleep in the background
    // lets go when it wakes, and starts again straight after.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearIndexedDbPersistence(db);
  } catch (e) {
    console.warn('clearing the cache', e);
  }
  otherTabs?.postMessage({ step: 'ended', to } satisfies CacheStep);
}
