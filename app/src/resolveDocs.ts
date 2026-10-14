import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
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
async function readIfPermitted(collectionPath: string, id: string) {
  try {
    const snap = await getDoc(doc(db, collectionPath, id));
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
   * is empty until the whole loop finishes, and the loop is sequential, so for
   * a student with eight items across two courses that is ten serial round
   * trips with nothing to show — which is not the same as having nothing.
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
    void (async () => {
      const courseCache = new Map<string, CourseRow | null>();
      const out = new Map<string, Resolved<T>>();
      try {
        for (const id of list) {
          const snap = await readIfPermitted(collectionPath, id);
          if (!snap) continue;
          const item = { id: snap.id, ...(read(collectionPath, snap) as T) };
          if (!courseCache.has(item.courseId)) {
            const cSnap = await readIfPermitted(COLLECTIONS.courses, item.courseId);
            const course = cSnap ? readIfExists('courses', cSnap) : undefined;
            courseCache.set(item.courseId, cSnap && course ? { id: cSnap.id, ...course } : null);
          }
          const cls = courseCache.get(item.courseId);
          if (cls) out.set(id, { doc: item, cls });
        }
      } catch (e) {
        // Keep the last good list rather than showing a short one, and say so
        // off-device. STILL SETTLED, though: leaving `key` behind would leave
        // the screen on "Checking…" for ever.
        captureError(e, { source: `resolve:${collectionPath}` });
        if (!cancelled) setState((prev) => ({ key, map: prev.map }));
        return;
      }
      if (!cancelled) setState({ key, map: out });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, collectionPath]);

  return { resolved: state.map, resolving: state.key !== key };
}
