import { getFirestore } from 'firebase-admin/firestore';
import { resolveAuditNames, type AuditId } from '@sabeel/shared';

/**
 * What each id an audit entry names is called now (`resolveAuditNames`),
 * read with the Admin SDK in one `getAll` per round.
 *
 * The wrapper calls this before a change runs and again after it, so a
 * deleted session is named from before its deletion and a created one from
 * after its creation (`auditedCall`).
 */
export function nameAuditIds(ids: AuditId[]): Promise<Record<string, string>> {
  const db = getFirestore();
  return resolveAuditNames(ids, async (paths) => {
    const snaps = await db.getAll(...paths.map((p) => db.doc(p)));
    return new Map(snaps.flatMap((s, i) => (s.exists ? [[paths[i], s.data()] as const] : [])));
  });
}
