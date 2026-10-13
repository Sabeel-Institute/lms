#!/usr/bin/env node
/**
 * Convert the recordings this project already holds to media items.
 *
 *     node scripts/migrate-recording-media.mjs         # dry run: what would change
 *     node scripts/migrate-recording-media.mjs --yes   # convert, then check
 *
 * ONE-OFF, for the copy `seed-from-legacy.mjs` made before media items existed;
 * the seed converts as it copies from then on, with the same function
 * (`scripts/lib/legacy-media.mjs`). Delete this file once it has run.
 *
 * Each recording still in the single-file shape gets `media` (its file as Part
 * 1, "Audio only", under the key it already has) and `defaultVersion`, loses
 * `audioPath`, `sizeBytes`, `zoomUuid` and `zoomFileId`, and keeps everything
 * else. A Zoom import gets its `zoomImports/{fileId}` claim. A recording
 * already converted is left alone, so a re-run changes nothing.
 *
 * Then it checks what it wrote: every recording has media, every converted
 * file is still in the bucket at the size recorded, and every claim names a
 * recording that holds that file.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { LEGACY_ITEM_ID, ZOOM_IMPORTS, convertRecording, isLegacyRecording } from './lib/legacy-media.mjs';
import { r2Config, s3For } from './lib/r2.mjs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { HeadObjectCommand } = require('@aws-sdk/client-s3');

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument: ${unknown[0]}\nusage: migrate-recording-media.mjs [--yes]`);
  process.exit(2);
}
const EXECUTE = args.includes('--yes');

const token = execFileSync('gcloud', ['auth', 'print-access-token', '--account=faisal.shah@oursabeel.com'], {
  encoding: 'utf8',
}).trim();
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${new URL(url).pathname}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function list(collection) {
  const out = [];
  let page;
  do {
    const q = new URLSearchParams({ pageSize: '300', ...(page ? { pageToken: page } : {}) });
    const r = await api('GET', `${BASE}/${collection}?${q}`);
    out.push(...(r.documents ?? []));
    page = r.nextPageToken;
  } while (page);
  return out;
}
const idOf = (d) => d.name.split('/').pop();

const recordings = await list('recordings');
const legacy = recordings.filter((d) => isLegacyRecording(d.fields ?? {}));
const plan = legacy.map((d) => ({ id: idOf(d), ...convertRecording(idOf(d), d.fields ?? {}) }));
console.log(`${FIREBASE_PROJECT_ID}: ${recordings.length} recordings, ${legacy.length} to convert`);
for (const p of plan) {
  const item = p.fields.media.mapValue.fields[LEGACY_ITEM_ID]?.mapValue.fields;
  console.log(`  ${p.id}  ${item ? item.storageKey.stringValue : '(no file)'}${p.claim ? `  claim ${p.claim.id}` : ''}`);
}
if (!EXECUTE) {
  console.log('\nDry run. Re-run with --yes to convert.');
  process.exit(0);
}

for (const p of plan) {
  // The mask names the removed fields as well as the new ones: a field in the
  // mask and absent from the body is deleted.
  const mask = [...new Set([...Object.keys(p.fields), ...p.legacyFields])]
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join('&');
  await api('PATCH', `${BASE}/recordings/${p.id}?${mask}`, { fields: p.fields });
  if (p.claim) await api('PATCH', `${BASE}/${ZOOM_IMPORTS}/${encodeURIComponent(p.claim.id)}`, { fields: p.claim.fields });
}

// Check.
const media = r2Config();
const s3 = s3For(media.endpoint, media.read);
const after = await list('recordings');
const problems = [];
const byId = new Map(after.map((d) => [idOf(d), d.fields ?? {}]));
for (const [id, f] of byId) if (isLegacyRecording(f)) problems.push(`${id}: still single-file`);
for (const p of plan) {
  const item = byId.get(p.id)?.media?.mapValue?.fields?.[LEGACY_ITEM_ID]?.mapValue?.fields;
  if (!item) continue;
  const key = item.storageKey.stringValue;
  const want = Number(item.sizeBytes?.integerValue ?? NaN);
  const got = await s3
    .send(new HeadObjectCommand({ Bucket: media.bucket, Key: key }))
    .then((h) => h.ContentLength)
    .catch(() => null);
  if (got !== want) problems.push(`${p.id}: ${key} is ${got ?? 'missing'}, recorded ${want}`);
}
for (const c of await list(ZOOM_IMPORTS)) {
  const recId = c.fields.recordingId.stringValue;
  const itemId = c.fields.itemId.stringValue;
  if (!byId.get(recId)?.media?.mapValue?.fields?.[itemId]) problems.push(`claim ${idOf(c)}: ${recId}/${itemId} not found`);
}
if (problems.length) {
  console.error(`\nPROBLEMS:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nConverted ${plan.length}; all ${after.length} recordings hold media items, every file is in the bucket at its size, every claim resolves.`);
