/**
 * Give every Zoom file copied from the legacy app its segment start.
 *
 * A recording stored before parts existed became one audio item
 * (`mediaFromSingleAudio`) with `zoom.segmentStart: null`, and the import keys
 * a part by meeting AND segment start. So the same class's video, imported
 * later, matched nothing and became Part 2: the class twice over, its length
 * doubled. Migrated, not accommodated: this asks Zoom where each such file
 * began, exactly as an import records it (`fileSegmentStart`), and writes it
 * onto the item, with the meeting's topic where it is missing.
 *
 * A meeting Zoom no longer lists keeps null: none of its files can be imported
 * again, so nothing can meet it as another part.
 *
 * Run on the live project now, and again on switchover day after the final
 * seed (docs/plans/SWITCHOVER.md), which copies items in the same shape.
 * Dry run unless --yes:
 *
 *     node scripts/backfill-zoom-segments.mjs          # says what it would do
 *     node scripts/backfill-zoom-segments.mjs --yes    # does it
 *
 * Reads with the oursabeel.com account's token and the Zoom app's credentials
 * from Secret Manager into this process only; prints neither.
 */
import { execFileSync } from 'node:child_process';
import { FIREBASE_PROJECT_ID, fileSegmentStart } from '@sabeel/shared';
import { listDocuments } from './lib/firestore-rest.mjs';

const ACCOUNT = 'faisal.shah@oursabeel.com';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node scripts/backfill-zoom-segments.mjs [--yes]`);
  process.exit(2);
}
const write = args.includes('--yes');

const gcloud = (...a) => execFileSync('gcloud', [...a, `--account=${ACCOUNT}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const secret = (name) => gcloud('secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${FIREBASE_PROJECT_ID}`);
const token = gcloud('auth', 'print-access-token');

async function zoomToken() {
  const basic = Buffer.from(`${secret('ZOOM_CLIENT_ID')}:${secret('ZOOM_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(secret('ZOOM_ACCOUNT_ID'))}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) throw new Error(`Zoom token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/** A meeting's recordings, or null when Zoom no longer has them. */
async function meeting(zoom, uuid) {
  // A UUID with a leading '/' or an embedded '//' must be DOUBLE url-encoded.
  const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(encodeURIComponent(uuid))}/recordings`, {
    headers: { Authorization: `Bearer ${zoom}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Zoom meeting ${uuid}: HTTP ${res.status}`);
  return res.json();
}

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
async function patch(recordingId, itemId, fields) {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(`media.\`${itemId}\`.zoom.${f}`)}`);
  const zoomFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }]));
  const body = { fields: { media: { mapValue: { fields: { [itemId]: { mapValue: { fields: { zoom: { mapValue: { fields: zoomFields } } } } } } } } } };
  const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/recordings/${recordingId}?${mask.join('&')}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`recordings/${recordingId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const todo = [];
for await (const { id, data } of listDocuments(FIREBASE_PROJECT_ID, 'recordings', token)) {
  for (const item of Object.values(data.media ?? {})) {
    if (item.zoom && item.zoom.segmentStart === null) todo.push({ recordingId: id, title: data.title, item });
  }
}
console.log(`${todo.length} Zoom file(s) with no segment start${write ? '' : ' (dry run: --yes writes)'}`);
if (todo.length === 0) process.exit(0);

const zoom = await zoomToken();
const meetings = new Map();
let filled = 0;
let gone = 0;
for (const { recordingId, title, item } of todo) {
  const uuid = item.zoom.meetingUuid;
  if (!meetings.has(uuid)) meetings.set(uuid, await meeting(zoom, uuid));
  const m = meetings.get(uuid);
  const start = m ? fileSegmentStart(m, item.zoom.fileId) : null;
  if (!start) {
    gone += 1;
    console.log(`  kept   ${recordingId} ${item.id} "${title}": Zoom no longer lists this file`);
    continue;
  }
  const fields = { segmentStart: start, ...(item.zoom.topic === null && m.topic ? { topic: m.topic } : {}) };
  if (write) await patch(recordingId, item.id, fields);
  filled += 1;
  console.log(`  ${write ? 'filled' : 'would '} ${recordingId} ${item.id} "${title}": ${start}`);
}
console.log(`\n${filled} ${write ? 'filled' : 'to fill'}, ${gone} kept (gone from Zoom)`);
