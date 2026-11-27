#!/usr/bin/env node
/**
 * Give every audit entry written before names existed its `names`.
 *
 * An entry records the ids it touched, and the audit screen now shows what
 * each was called (`describeAuditEntry`), from `names` the server writes with
 * the entry. Migrated, not accommodated: an entry from before gets the names
 * its ids have now (`resolveAuditNames`, the same lookup the server makes),
 * and an id that resolves to nothing, something deleted since, stays
 * unnamed, which the screen says in words. Run after the Functions that write
 * names are deployed, so no unnamed entry is written after it.
 *
 * ONLY OVER THE ENTRY IT READ: each write carries the update time it was read
 * at (`authReject` rows are counted into all day), so one changed meanwhile is
 * left, and named, for a second run. Dry run unless --yes, printing what the
 * screen will say for a few entries:
 *
 *     node scripts/backfill-audit-names.mjs          # says what it would do
 *     node scripts/backfill-audit-names.mjs --yes    # does it
 *
 * Reads and writes with the oursabeel.com account's token; prints none.
 */
import { execFileSync } from 'node:child_process';
import { FIREBASE_PROJECT_ID, auditIds, describeAuditEntry, resolveAuditNames } from '@sabeel/shared';
import { decodeFields, encodeValue, listDocuments } from './lib/firestore-rest.mjs';

const ACCOUNT = 'faisal.shah@oursabeel.com';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node scripts/backfill-audit-names.mjs [--yes]`);
  process.exit(2);
}
const write = args.includes('--yes');
const token = execFileSync('gcloud', ['auth', 'print-access-token', `--account=${ACCOUNT}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const headers = { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' };

/** Documents by path, for `resolveAuditNames`: the ones that exist. */
const cache = new Map();
async function read(paths) {
  const out = new Map();
  const todo = paths.filter((p) => !cache.has(p));
  for (let i = 0; i < todo.length; i += 100) {
    const res = await fetch(`https://firestore.googleapis.com/v1/${DB}:batchGet`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ documents: todo.slice(i, i + 100).map((p) => `${DB}/${p}`) }),
    });
    if (!res.ok) throw new Error(`batchGet: ${res.status} ${(await res.text()).slice(0, 200)}`);
    for (const r of await res.json()) {
      if (r.found) cache.set(r.found.name.split('/documents/')[1], decodeFields(r.found.fields ?? {}));
      else if (r.missing) cache.set(r.missing.split('/documents/')[1], null);
    }
  }
  for (const p of paths) if (cache.get(p)) out.set(p, cache.get(p));
  return out;
}

let entries = 0;
let named = 0;
let raced = 0;
let shown = 0;
let partly = 0;
for await (const { id, data, updateTime } of listDocuments(FIREBASE_PROJECT_ID, 'auditLog', token)) {
  entries += 1;
  if (data.names !== undefined) continue;
  const ids = auditIds(data);
  const names = await resolveAuditNames(ids, read);
  if (ids.some((i) => !(i.id in names))) partly += 1;
  const words = describeAuditEntry({ ...data, names }, () => undefined);
  if (shown < 8) {
    console.log(`  ${data.action}: ${[...words.about, ...words.details].join(' · ')}`);
    shown += 1;
  }
  named += 1;
  if (!write) continue;
  const res = await fetch(
    `https://firestore.googleapis.com/v1/${DB}/auditLog/${id}?updateMask.fieldPaths=names&currentDocument.updateTime=${encodeURIComponent(updateTime)}`,
    { method: 'PATCH', headers, body: JSON.stringify({ fields: { names: encodeValue(names) } }) },
  );
  if (res.status === 400 || res.status === 409 || res.status === 412) {
    raced += 1;
    console.log(`  changed while read, left for a second run: ${id}`);
  } else if (!res.ok) {
    throw new Error(`auditLog/${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
console.log(`\n${entries} entries; ${write ? `${named - raced} named` : `${named} to name`}${raced ? `, ${raced} left for a second run` : ''}`);
console.log(`${partly} of them name something no longer in the app, which the screen says in words.`);
