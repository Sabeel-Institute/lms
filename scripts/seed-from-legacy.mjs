#!/usr/bin/env node
/**
 * Copy the live app's data into this project: accounts, Firestore and media.
 *
 *     node scripts/seed-from-legacy.mjs --from <project> --from-account <email>         # dry run
 *     node scripts/seed-from-legacy.mjs --from <project> --from-account <email> --yes   # wipe this project, copy
 *
 * docs/plans/SWITCHOVER.md, "Seeding from the legacy project". Run before the
 * first deploy and again on switchover day; every run WIPES this project first,
 * so anything entered here in between is test data and is lost.
 *
 * READ-ONLY ON THE SOURCE. Every request to it is a GET or a list, made with
 * its own account's token; nothing is written there and no IAM changes. The
 * source is named only on the command line, so no file in this repo points at
 * the live project (`projectIdentity.test.ts`).
 *
 * What it copies, all with the same ids so every reference stays intact:
 *
 *  - Accounts, with their password hashes (imported with the source's scrypt
 *    parameters, read from its Auth config into this process and never
 *    printed), Google links, custom claims and disabled flags. Same uids.
 *  - Every Firestore document, recursively, field values passed through
 *    untouched (REST JSON keeps every type). EXCEPT push registrations
 *    (`notifications/{uid}/devices`): FCM tokens belong to the source's sender
 *    and cannot deliver from here; devices register again on first sign-in.
 *    And EXCEPT recordings, which the live app stores as one audio file and
 *    this project as media items: each is converted on the way
 *    (`scripts/lib/legacy-media.mjs`), and a Zoom import gets its
 *    `zoomImports` claim so the picker knows the file is here. And EXCEPT the
 *    audit entries the live app writes under action names this app has
 *    replaced, which are renamed on the way (`scripts/lib/legacy-audit.mjs`).
 *    And EXCEPT enrolments, which the live app keeps as a first joining and a
 *    last leaving date and this project as every stretch in the class: each
 *    is rebuilt from the live app's audit log on the way
 *    (`scripts/lib/stretches.mjs`).
 *  - Every object under `recordings/` in the source's Storage bucket, into the
 *    R2 media bucket at the same key, with the R2 write key.
 *
 * Then it waits for the triggers its wipe fired to finish, writes back any
 * copied document one of them changed, counts both sides, and fails loudly on
 * any difference.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { r2Config, s3For } from './lib/r2.mjs';
import { ZOOM_IMPORTS, convertRecording, isLegacyRecording } from './lib/legacy-media.mjs';
import { RENAMED_AUDIT_ACTIONS, convertAuditEntry } from './lib/legacy-audit.mjs';
import { convertEnrolment, enrolmentHistory } from './lib/stretches.mjs';
import { decodeFields, encodeValue } from './lib/firestore-rest.mjs';
import { refuseAfterSwitchover } from './lib/before-switchover.mjs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

refuseAfterSwitchover('seed-from-legacy', 'a seed would wipe everything made here since the move');

// ------------------------------------------------------------------ args --
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SOURCE = opt('--from');
const SOURCE_ACCOUNT = opt('--from-account');
const EXECUTE = args.includes('--yes');
const TARGET = FIREBASE_PROJECT_ID;
const TARGET_ACCOUNT = 'faisal.shah@oursabeel.com';
if (!SOURCE || !SOURCE_ACCOUNT || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(SOURCE) || !SOURCE_ACCOUNT.includes('@')) {
  console.error('usage: seed-from-legacy.mjs --from <project-id> --from-account <email> [--yes]');
  process.exit(2);
}
if (SOURCE === TARGET) {
  console.error(`--from is ${TARGET}, the project this copies INTO`);
  process.exit(2);
}

const token = (account) =>
  execFileSync('gcloud', ['auth', 'print-access-token', `--account=${account}`], { encoding: 'utf8' }).trim();
const tok = { source: token(SOURCE_ACCOUNT), target: token(TARGET_ACCOUNT) };

async function call(side, method, url, body) {
  const project = side === 'source' ? SOURCE : TARGET;
  if (side === 'source' && !['GET', 'POST-READ'].includes(method)) throw new Error(`refusing ${method} on the source`);
  const res = await fetch(url, {
    method: method === 'POST-READ' ? 'POST' : method,
    headers: {
      Authorization: `Bearer ${tok[side]}`,
      'X-Goog-User-Project': project,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${side} ${method} ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}
const json = async (...a) => (await call(...a)).json();

// ------------------------------------------------------------- firestore --
const fsBase = (p) => `https://firestore.googleapis.com/v1/projects/${p}/databases/(default)/documents`;
/** Subcollections whose documents are not copied. */
const SKIP_SUBCOLLECTIONS = new Set(['devices']);

/** Every existing document under `parent` (a document name, or the root), recursively. */
async function allDocs(side, project, parent = fsBase(project), skip = SKIP_SUBCOLLECTIONS) {
  const out = [];
  const ids = [];
  let page;
  do {
    const r = await json(side, 'POST-READ', `${parent}:listCollectionIds`, { pageSize: 300, pageToken: page });
    ids.push(...(r.collectionIds ?? []));
    page = r.nextPageToken;
  } while (page);
  for (const id of ids) {
    if (parent !== fsBase(project) && skip.has(id)) continue;
    let p;
    do {
      const q = new URLSearchParams({ pageSize: '300', showMissing: 'true', ...(p ? { pageToken: p } : {}) });
      const r = await json(side, 'GET', `${parent}/${id}?${q}`);
      for (const d of r.documents ?? []) {
        if (d.createTime) out.push(d); // a "missing" parent holds subcollections only
        out.push(...(await allDocs(side, project, `https://firestore.googleapis.com/v1/${d.name}`, skip)));
      }
      p = r.nextPageToken;
    } while (p);
  }
  return out;
}

/** `projects/x/databases/(default)/documents/a/b` → `a/b` */
const relPath = (name) => name.split('/documents/')[1];
/** `a/b/c/d` → `a/*\/c` (the collection shape), for counting. */
const shape = (rel) => rel.split('/').filter((_, i) => i % 2 === 0).join('/');

function countByShape(docs) {
  const m = new Map();
  for (const d of docs) m.set(shape(relPath(d.name)), (m.get(shape(relPath(d.name))) ?? 0) + 1);
  return m;
}

async function batchWrite(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const r = await json('target', 'POST', `${fsBase(TARGET)}:batchWrite`, { writes: writes.slice(i, i + 400) });
    const bad = (r.status ?? []).filter((s) => s.code);
    if (bad.length) throw new Error(`batchWrite: ${bad.length} failed, first: ${JSON.stringify(bad[0])}`);
  }
}

// ------------------------------------------------------------------ auth --
const itBase = (p) => `https://identitytoolkit.googleapis.com/v1/projects/${p}`;

async function allUsers(side, project) {
  const out = [];
  let page;
  do {
    const q = new URLSearchParams({ maxResults: '1000', ...(page ? { nextPageToken: page } : {}) });
    const r = await json(side, 'GET', `${itBase(project)}/accounts:batchGet?${q}`);
    out.push(...(r.users ?? []));
    page = r.nextPageToken;
  } while (page);
  return out;
}

const USER_FIELDS = [
  'localId', 'email', 'emailVerified', 'displayName', 'photoUrl', 'passwordHash', 'salt',
  'customAttributes', 'disabled', 'createdAt', 'lastLoginAt', 'phoneNumber',
];
function importable(u) {
  const o = Object.fromEntries(USER_FIELDS.filter((k) => u[k] !== undefined).map((k) => [k, u[k]]));
  o.providerUserInfo = (u.providerUserInfo ?? [])
    .filter((p) => p.providerId !== 'password' && p.providerId !== 'phone')
    .map(({ providerId, rawId, email, displayName, photoUrl }) => ({ providerId, rawId, email, displayName, photoUrl }));
  return o;
}

// ----------------------------------------------------------------- media --
const media = r2Config();
const s3 = s3For(media.endpoint, media.write);

async function sourceObjects() {
  const bucket = `${SOURCE}.firebasestorage.app`;
  const out = [];
  let page;
  do {
    const q = new URLSearchParams({ prefix: 'recordings/', maxResults: '1000', ...(page ? { pageToken: page } : {}) });
    const r = await json('source', 'GET', `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${q}`);
    out.push(...(r.items ?? []).map((o) => ({ bucket, key: o.name, size: Number(o.size), contentType: o.contentType })));
    page = r.nextPageToken;
  } while (page);
  return out;
}

/**
 * Every prefix this project writes media to, but `help/`: the help films are
 * this app's own, published from scripts/tutorials, and not the live app's.
 * Testers' uploads, Zoom copies and assignment files go with the wipe, or
 * they would stay in the bucket with nothing pointing at them.
 */
const WIPED_PREFIXES = ['recordings/', 'media/', 'coursework/', 'work/'];

async function targetObjects(prefix = 'recordings/') {
  const out = [];
  let t;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: media.bucket, Prefix: prefix, ContinuationToken: t }));
    out.push(...(r.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size })));
    t = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (t);
  return out;
}

// ------------------------------------------------------------------- run --
console.log(`Copy ${SOURCE} (as ${SOURCE_ACCOUNT}, read-only) → ${TARGET} (as ${TARGET_ACCOUNT})\n`);

const [srcDocs, srcUsers, srcObjects] = await Promise.all([allDocs('source', SOURCE), allUsers('source', SOURCE), sourceObjects()]);
// The source's password hashing, read BEFORE anything here is wiped: a
// failure to read it must leave this project as it was, not empty.
const cfg = await json('source', 'GET', `https://identitytoolkit.googleapis.com/admin/v2/projects/${SOURCE}/config`);
const hash = cfg.signIn?.hashConfig;
if (hash?.algorithm !== 'SCRYPT') throw new Error(`unexpected source hash algorithm: ${hash?.algorithm}`);
const [tgtDocs, tgtUsers, tgtObjects] = await Promise.all([
  allDocs('target', TARGET, fsBase(TARGET), new Set()),
  allUsers('target', TARGET),
  Promise.all(WIPED_PREFIXES.map((prefix) => targetObjects(prefix))).then((lists) => lists.flat()),
]);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const sum = (xs) => xs.reduce((a, o) => a + o.size, 0);

console.log('Source:');
for (const [k, n] of [...countByShape(srcDocs)].sort()) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log(`  ${String(srcUsers.length).padStart(5)}  accounts`);
console.log(`  ${String(srcObjects.length).padStart(5)}  media objects (${mb(sum(srcObjects))})`);
console.log(`\nThis project now: ${tgtDocs.length} documents, ${tgtUsers.length} accounts, ${tgtObjects.length} media objects. All are removed first.`);

/*
 * ENROLMENTS IN THE OLD SHAPE. The live app keeps a first joining and a last
 * leaving date; this app keeps every stretch in the class, rebuilt here from
 * the live app's own audit log. One where the log and the dates disagree is
 * named, to look at after the copy.
 */
const legacyHistory = enrolmentHistory(srcDocs.filter((d) => shape(relPath(d.name)) === 'auditLog').map((d) => decodeFields(d.fields ?? {})));
const enrolments = new Map(
  srcDocs
    .filter((d) => shape(relPath(d.name)) === 'enrollments')
    .map((d) => [relPath(d.name), convertEnrolment(decodeFields(d.fields ?? {}), legacyHistory.get(relPath(d.name).split('/')[1]))]),
);
const inferredEnrolments = [...enrolments].filter(([, c]) => c?.inferred).map(([rel]) => rel);
console.log(`\nEnrolments given their stretches: ${[...enrolments.values()].filter(Boolean).length}; inferred where the log and the dates disagree: ${inferredEnrolments.join(', ') || 'none'}`);

if (!EXECUTE) {
  console.log('\nDry run. Re-run with --yes to wipe this project and copy.');
  process.exit(0);
}

// 1. Wipe this project.
console.log('\n1/6  wiping this project');
await batchWrite(tgtDocs.map((d) => ({ delete: d.name })));
for (let i = 0; i < tgtUsers.length; i += 1000) {
  await call('target', 'POST', `${itBase(TARGET)}/accounts:batchDelete`, {
    localIds: tgtUsers.slice(i, i + 1000).map((u) => u.localId),
    force: true,
  });
}
for (let i = 0; i < tgtObjects.length; i += 1000) {
  await s3.send(new DeleteObjectsCommand({
    Bucket: media.bucket,
    Delete: { Objects: tgtObjects.slice(i, i + 1000).map((o) => ({ Key: o.key })) },
  }));
}

// 2. Accounts.
console.log(`2/6  ${srcUsers.length} accounts`);
for (let i = 0; i < srcUsers.length; i += 1000) {
  const r = await json('target', 'POST', `${itBase(TARGET)}/accounts:batchCreate`, {
    hashAlgorithm: 'SCRYPT',
    signerKey: hash.signerKey,
    saltSeparator: hash.saltSeparator,
    rounds: hash.rounds,
    memoryCost: hash.memoryCost,
    users: srcUsers.slice(i, i + 1000).map(importable),
  });
  if (r.error?.length) throw new Error(`account import: ${JSON.stringify(r.error.slice(0, 3))}`);
}

// 3. Firestore, recordings converted and retired audit actions renamed on the way.
const docName = (rel) => `projects/${TARGET}/databases/(default)/documents/${rel}`;
const writes = [];
/** How many audit entries were renamed, by the live app's name for the action. */
const renamed = new Map();
for (const d of srcDocs) {
  const rel = relPath(d.name);
  const fields = d.fields ?? {};
  if (shape(rel) === 'recordings' && isLegacyRecording(fields)) {
    const conv = convertRecording(rel.split('/')[1], fields);
    writes.push({ update: { name: docName(rel), fields: conv.fields } });
    if (conv.claim) writes.push({ update: { name: docName(`${ZOOM_IMPORTS}/${conv.claim.id}`), fields: conv.claim.fields } });
  } else if (shape(rel) === 'enrollments' && enrolments.get(rel)) {
    // Every field as it was, less the two dates the stretches replace.
    const { enrolledAt: _first, unenrolledAt: _last, ...kept } = fields;
    writes.push({ update: { name: docName(rel), fields: { ...kept, stretches: encodeValue(enrolments.get(rel).data.stretches) } } });
  } else if (shape(rel) === 'auditLog') {
    const entry = convertAuditEntry(fields);
    const from = fields.action?.stringValue;
    if (entry !== fields) renamed.set(from, (renamed.get(from) ?? 0) + 1);
    writes.push({ update: { name: docName(rel), fields: entry } });
  } else {
    writes.push({ update: { name: docName(rel), fields } });
  }
}
const renames = [...renamed].map(([from, n]) => `${n} ${from} → ${RENAMED_AUDIT_ACTIONS[from]}`).join(', ');
console.log(`3/6  ${srcDocs.length} documents, ${writes.length - srcDocs.length} Zoom claims; audit entries renamed: ${renames || 'none'}`);
await batchWrite(writes);

// 4. Media.
console.log(`4/6  ${srcObjects.length} media objects (${mb(sum(srcObjects))})`);
for (const o of srcObjects) {
  const res = await call('source', 'GET', `https://storage.googleapis.com/storage/v1/b/${o.bucket}/o/${encodeURIComponent(o.key)}?alt=media`);
  await s3.send(new PutObjectCommand({
    Bucket: media.bucket,
    Key: o.key,
    // The SDK's Node handler takes a Node stream, not a web one.
    Body: Readable.fromWeb(res.body),
    ContentLength: o.size,
    ContentType: o.contentType,
  }));
  console.log(`     ${o.key}  ${mb(o.size)}`);
}

/*
 * 5. SETTLE. The wipe's deletes fired the recording and session triggers, and
 * one that runs after the copy has rewritten a grant finds "no recording" and
 * switches every grant of it off; a past session's grant is never revived.
 * That rewrote the term's Missed and Completed record, and the count below
 * cannot see it (the documents are all there). So once the burst of trigger
 * runs has passed, every copied document is compared with what was written,
 * field by field, and any a trigger changed is written back, until a pass
 * finds none. The triggers themselves change nothing in data copied whole.
 */
const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
const problems = [];
const SETTLE_MS = 90_000;
for (let pass = 1; ; pass += 1) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const now = new Map((await allDocs('target', TARGET, fsBase(TARGET), new Set())).map((d) => [relPath(d.name), d.fields ?? {}]));
  const drifted = writes.filter((w) => canonical(now.get(relPath(w.update.name))) !== canonical(w.update.fields));
  console.log(`5/6  settle pass ${pass}: ${drifted.length} document(s) changed since the copy`);
  if (drifted.length === 0) break;
  if (pass === 3) {
    problems.push(`${drifted.length} document(s) still change after the copy, e.g. ${drifted.slice(0, 3).map((w) => relPath(w.update.name)).join(', ')}`);
    break;
  }
  await batchWrite(drifted);
}

// 6. Count both sides.
console.log('6/6  checking');
const [afterDocs, afterUsers, afterObjects] = await Promise.all([
  allDocs('target', TARGET, fsBase(TARGET), new Set()),
  allUsers('target', TARGET),
  targetObjects(),
]);
const want = countByShape(writes.map((w) => w.update));
const got = countByShape(afterDocs);
for (const k of new Set([...want.keys(), ...got.keys()])) {
  if (want.get(k) !== got.get(k)) problems.push(`${k}: source ${want.get(k) ?? 0}, here ${got.get(k) ?? 0}`);
}
if (afterUsers.length !== srcUsers.length) problems.push(`accounts: source ${srcUsers.length}, here ${afterUsers.length}`);
const claimsLost = srcUsers.filter((u) => u.customAttributes && afterUsers.find((a) => a.localId === u.localId)?.customAttributes !== u.customAttributes);
if (claimsLost.length) problems.push(`${claimsLost.length} accounts lost their claims`);
const sizes = new Map(afterObjects.map((o) => [o.key, o.size]));
for (const o of srcObjects) if (sizes.get(o.key) !== o.size) problems.push(`media ${o.key}: ${o.size} vs ${sizes.get(o.key)}`);

if (problems.length) {
  console.error(`\nMISMATCH:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nCopied and checked: ${afterDocs.length} documents, ${afterUsers.length} accounts, ${afterObjects.length} media objects.`);
