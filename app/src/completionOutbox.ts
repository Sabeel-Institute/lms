// Native side of the completion-durability seam (web sibling:
// completionOutbox.web.ts).
//
// WHY THIS EXISTS: on native the Firebase JS SDK has only a MEMORY cache (no
// IndexedDB — see firestoreInit.ts). A completion marked offline is queued in
// memory and flushes fine if the app stays open until reconnect — but a
// force-kill before reconnect loses it, and the student would reopen to find
// their completion silently reverted. That is exactly the "offline queue that
// never drains looks like one that works" failure the brief warns about.
//
// So on native, the completion STATE write goes through a small AsyncStorage
// outbox: record intent durably, fire the write, and remove the record only
// once the server acknowledges. On launch, whatever is still in the outbox is
// replayed. This is NOT a bespoke sync engine — it is a durability shim over the
// SAME direct Firestore write, idempotent because the completion doc id is
// deterministic (`${studentUid}_${recordingId}`).
//
// Only the current-state doc is outboxed. The append-only completionEvents are
// best-effort audit: a force-kill may drop one event, but the state — which
// carries `completedAt` — is preserved, and replaying events would duplicate
// them (they have generated ids).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, runTransaction, setDoc } from 'firebase/firestore';
import { COLLECTIONS, completionId, type CompletionDoc } from '@sabeel/shared';
import { db } from './firebase';
import { captureError } from './sentry';
import { readIfExists } from './documents';

const KEY = 'sabeel.completionOutbox.v1';

async function readAll(): Promise<Record<string, CompletionDoc>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, CompletionDoc>) : {};
  } catch {
    return {};
  }
}

async function writeAll(map: Record<string, CompletionDoc>): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(map));
}

/**
 * ONE MUTATION AT A TIME. Every change to the store is read-modify-write over
 * a single key, and two in flight together — a mark on one recording while
 * another's acknowledgement comes back — each wrote its own picture of the map
 * and the second landing erased the first's entry. Chained, the way
 * `playback.ts` serialises its progress writes.
 */
let mutations: Promise<void> = Promise.resolve();
function mutate(fn: (map: Record<string, CompletionDoc>) => boolean): Promise<void> {
  const next = mutations.then(async () => {
    const map = await readAll();
    if (fn(map)) await writeAll(map);
  });
  mutations = next.catch(() => undefined);
  return next;
}

/**
 * Forget an entry — but only the one that was acknowledged. Mark then un-mark
 * offline and the outbox holds the un-mark while both writes queue; the mark's
 * acknowledgement arriving first must not take the un-mark with it, or a kill
 * in that window loses the student's last word. `updatedAt` names which.
 */
function forget(id: string, updatedAt: number): Promise<void> {
  return mutate((map) => {
    if (map[id]?.updatedAt !== updatedAt) return false;
    delete map[id];
    return true;
  });
}

/**
 * A replay must not overwrite what another device wrote since.
 *
 * The outbox is the path that survives a kill, so it can replay hours or days
 * later — by which time the student may have un-marked (or re-marked) the same
 * recording on the web. A plain `setDoc` then put the older state back over the
 * newer one, and the ledger's `completedAt` went backwards. Read first, inside
 * a transaction, and yield to anything newer. A transaction needs a
 * connection; offline it rejects with a retryable code and the entry stays for
 * the next launch, which is what the outbox is for.
 */
async function replay(id: string, state: CompletionDoc): Promise<void> {
  const ref = doc(db, COLLECTIONS.completions, id);
  await runTransaction(db, async (tx) => {
    const current = readIfExists('completions', await tx.get(ref));
    if (current && current.updatedAt > state.updatedAt) return;
    tx.set(ref, state);
  });
}

/**
 * Fire the completion write, but keep a durable copy until the server confirms.
 * `setDoc` resolves only on server ack, so its resolution is the signal to
 * forget the outbox entry; offline it never resolves and the entry survives an
 * app kill.
 */
function fireAndForget(id: string, state: CompletionDoc, write: () => Promise<void>): void {
  void write()
    .then(() => forget(id, state.updatedAt))
    .catch((e: { code?: string }) => {
      /*
       * A REFUSAL IS FINAL; ANYTHING ELSE IS WORTH RETRYING.
       *
       * Retrying everything means an entry the server will never accept is
       * re-sent on every launch for the life of the install. The reachable case
       * is small but real: mark complete offline, the app is killed before it
       * syncs, and the recording is permanently deleted in the meantime — the
       * cascade takes the assignment with it, so the rule can no longer find the
       * grant the write has to name. There is nothing left to write it against.
       *
       * Everything else — offline, a dropped connection, a server hiccup — keeps
       * the entry, which is the whole point of the outbox.
       */
      if (e?.code !== 'permission-denied') return;
      /*
       * REPORTED, because this is the one path that throws away a student's own
       * record of having finished a lecture. Silent, it looks to them like the
       * app forgot: the native SDK's cache is memory-only, so after an app kill
       * there is no local copy either, and the recording simply reads as
       * incomplete again with nothing anywhere saying why.
       */
      // The recording, not the entry's id: that one is the student's account id
      // and the recording's, and a report names nobody.
      captureError(e, { source: 'completionOutbox', recordingId: state.recordingId });
      void forget(id, state.updatedAt);
    });
}

/** Persist a completion state durably (native path). */
export async function persistCompletionState(state: CompletionDoc): Promise<void> {
  const id = completionId(state.studentUid, state.recordingId);
  await mutate((map) => {
    map[id] = state;
    return true;
  });
  // The live path stays a plain `setDoc`: offline it queues in the SDK and
  // resolves on reconnect, which a transaction cannot do.
  fireAndForget(id, state, () => setDoc(doc(db, COLLECTIONS.completions, id), state));
}

/**
 * Replay any completion writes that never confirmed. Called on launch once a
 * student is signed in — scoped to that uid so a shared device never tries to
 * write one student's completion under another's auth (the rules would deny it,
 * and it would wedge the outbox).
 */
export async function drainCompletionOutbox(studentUid: string): Promise<void> {
  const map = await readAll();
  for (const [id, state] of Object.entries(map)) {
    if (state.studentUid === studentUid) fireAndForget(id, state, () => replay(id, state));
  }
}
