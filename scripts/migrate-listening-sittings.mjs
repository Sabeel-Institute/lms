/**
 * Give every listening-progress row its sittings, and take its place out.
 *
 * A row used to hold one total, merged across devices by keeping the larger,
 * and the place to resume from. It now holds each sitting's listening, added
 * up (`withSitting` in @sabeel/shared), and no place: the place is kept on
 * each device, and a bookmark carries it between them (decision 2026-10-15).
 * Migrated, not accommodated: a row from before holds its whole total as one
 * sitting, `earlier`, and loses `positionMs`, `part` and `version`. The rules
 * refuse a save to a row without sittings, so run this straight after the
 * rules and the app that write them are deployed.
 *
 * ONLY OVER THE ROW IT READ: each write carries the update time it was read
 * at, so a row a student saved meanwhile is left, and named, for a second run.
 * Dry run unless --yes:
 *
 *     node scripts/migrate-listening-sittings.mjs          # says what it would do
 *     node scripts/migrate-listening-sittings.mjs --yes    # does it
 *
 * Reads and writes with the oursabeel.com account's token; prints none.
 */
import { execFileSync } from 'node:child_process';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { listDocuments } from './lib/firestore-rest.mjs';

const ACCOUNT = 'faisal.shah@oursabeel.com';
/** The sitting a row's listening from before sittings is kept under. */
const EARLIER = 'earlier';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node scripts/migrate-listening-sittings.mjs [--yes]`);
  process.exit(2);
}
const write = args.includes('--yes');
const token = execFileSync('gcloud', ['auth', 'print-access-token', `--account=${ACCOUNT}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
let rows = 0;
let migrated = 0;
let raced = 0;
for await (const { id, data, updateTime } of listDocuments(FIREBASE_PROJECT_ID, 'listeningProgress', token)) {
  rows += 1;
  if (data.sittings !== undefined) continue;
  const listenedMs = Math.round(data.listenedMs);
  console.log(`${write ? 'migrating' : 'would migrate'} ${id}: ${listenedMs} ms listened, as one earlier sitting`);
  if (!write) continue;
  // Fields named in the mask and absent from the body are removed.
  const mask = ['listenedMs', 'sittings', 'sitting', 'positionMs', 'part', 'version']
    .map((f) => `updateMask.fieldPaths=${f}`)
    .join('&');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/${DB}/listeningProgress/${id}?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          listenedMs: { integerValue: String(listenedMs) },
          sittings: { mapValue: { fields: { [EARLIER]: { integerValue: String(listenedMs) } } } },
          sitting: { stringValue: EARLIER },
        },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    if (/FAILED_PRECONDITION/.test(text)) {
      console.log(`  ${id} changed while this ran: left for a second run`);
      raced += 1;
      continue;
    }
    throw new Error(`listeningProgress/${id}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  migrated += 1;
}
console.log(
  `${rows} rows; ${write ? `${migrated} migrated${raced ? `, ${raced} to run again` : ''}` : 'nothing written (dry run; --yes to write)'}`,
);
