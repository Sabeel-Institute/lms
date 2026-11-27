/**
 * An audit entry with the `names` the server would write for it
 * (`resolveAuditNames`, the server's own lookup), for the seeded worlds,
 * which write their history straight to Firestore and must hold what
 * production holds. Call it once the documents it names exist.
 */
import { auditIds, resolveAuditNames } from '@sabeel/shared';

export async function namedAuditEntry(db, entry) {
  const names = await resolveAuditNames(auditIds(entry), async (paths) => {
    const snaps = await db.getAll(...paths.map((p) => db.doc(p)));
    return new Map(snaps.flatMap((s, i) => (s.exists ? [[paths[i], s.data()]] : [])));
  });
  return Object.keys(names).length ? { ...entry, names } : entry;
}
