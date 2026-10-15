import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, getDocFromCache } from 'firebase/firestore';
import { COLLECTIONS, type StoredCollection, type StoredDocs } from '@sabeel/shared';
import { read, readIfExists } from './documents';
import { db } from './firebase';
import { captureError } from './sentry';
import type { CourseRow } from './structure';

/**
 * Read one document, treating a refusal as an answer.
 *
 * `permission-denied` is not a failure here: a student may read a recording
 * only while it is PUBLISHED, and an assignment only while they hold it, so a
 * grant pointing at one staff have just withdrawn comes back refused rather
 * than absent. That is the same "it is not available to you" the missing-
 * document branch already handles, so it skips the row the same way.
 *
 * Anything else rethrows on purpose. An offline or failed read must never be
 * mistaken for an empty list — the caller keeps its last good one instead of
 * publishing a short one.
 */
async function readIfPermitted(collectionPath: string, id: string, from: 'cache' | 'server') {
  try {
    const ref = doc(db, collectionPath, id);
    const snap = await (from === 'cache' ? getDocFromCache(ref) : getDoc(ref));
    return snap.exists() ? snap : null;
  } catch (e) {
    if ((e as { code?: string }).code === 'permission-denied') return null;
    throw e;
  }
}

export interface Resolved<T> {
  doc: T & { id: string };
  cls: CourseRow;
}

/**
 * Resolve each id's document and its course, for a student's lists: their
 * recordings and their assignments.
 *
 * A plain get per id (not a live subscription): titles and course names change
 * rarely, and what DOES change — grants, completions, work — is already live.
 * Deduplicated, with each course read once.
 *
 * Every read is individually survivable. When one throw could abandon the loop,
 * a single unpublished recording emptied the ENTIRE screen: the rejection
 * escaped before the state was set, so nothing resolved and the student read
 * "Nothing required right now".
 */
/** The collections whose documents name the course they belong to. */
type InACourse = { [C in StoredCollection]: StoredDocs[C] extends { courseId: string } ? C : never }[StoredCollection];

export function useResolvedDocs<C extends InACourse, T extends StoredDocs[C] & { courseId: string } = StoredDocs[C] & { courseId: string }>(
  collectionPath: C,
  ids: string[],
): {
  resolved: Map<string, Resolved<T>>;
  /**
   * Whether the reads for the CURRENT set of ids are still in flight. The map
   * is empty until they all land: two round trips, the items and then their
   * courses, each set read at once, which is not the same as having nothing.
   */
  resolving: boolean;
} {
  // KEYED BY THE IDS IT ANSWERS FOR. A bare map cannot say whether it
  // describes the current request or the previous one.
  const [state, setState] = useState<{ key: string; map: Map<string, Resolved<T>> }>({ key: '', map: new Map() });
  const key = useMemo(() => [...new Set(ids)].sort().join(','), [ids]);

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(',') : [];
    // Every item and its course, from one source, or a throw.
    const resolve = async (from: 'cache' | 'server') => {
      const out = new Map<string, Resolved<T>>();
      // AT ONCE, NOT ONE AFTER ANOTHER. Read in a loop, a student with a
      // term's work waited for a round trip per item and per course, 27 in a
      // row for the median student on the live site, about three seconds of
      // "Checking…" on a phone every time they came back to To do.
      const snaps = await Promise.all(list.map((id) => readIfPermitted(collectionPath, id, from)));
      const items = snaps.flatMap((snap) => (snap ? [{ id: snap.id, ...(read(collectionPath, snap) as T) }] : []));
      const courseIds = [...new Set(items.map((i) => i.courseId))];
      const courseSnaps = await Promise.all(courseIds.map((id) => readIfPermitted(COLLECTIONS.courses, id, from)));
      const courseOf = new Map<string, CourseRow | null>();
      courseIds.forEach((id, n) => {
        const cSnap = courseSnaps[n];
        const course = cSnap ? readIfExists('courses', cSnap) : undefined;
        courseOf.set(id, cSnap && course ? { id: cSnap.id, ...course } : null);
      });
      for (const item of items) {
        const cls = courseOf.get(item.courseId);
        if (cls) out.set(item.id, { doc: item, cls });
      }
      return out;
    };
    void (async () => {
      /*
       * FROM THIS DEVICE FIRST, when it holds every one: a get waits for the
       * server, so To do said "Checking what you have to do…" on every visit
       * until the connection was up and two rounds had come back, with the
       * documents in the browser all along. The server's answer follows.
       */
      const cached = await resolve('cache').catch(() => null);
      if (cached && !cancelled) setState({ key, map: cached });
      try {
        const fresh = await resolve('server');
        if (!cancelled) setState({ key, map: fresh });
      } catch (e) {
        // Keep the last good list rather than showing a short one, and say so
        // off-device. STILL SETTLED, though: leaving `key` behind would leave
        // the screen on "Checking…" for ever.
        captureError(e, { source: `resolve:${collectionPath}` });
        if (!cancelled) setState((prev) => ({ key, map: prev.map }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, collectionPath]);

  return { resolved: state.map, resolving: state.key !== key };
}
