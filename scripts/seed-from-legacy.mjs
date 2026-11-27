#!/usr/bin/env node
/**
 * Copy chosen cohorts of the live app into this project: accounts, Firestore
 * and media.
 *
 *     node scripts/seed-from-legacy.mjs --from <project> --from-account <email> --plan <file>         # dry run
 *     node scripts/seed-from-legacy.mjs --from <project> --from-account <email> --plan <file> --yes   # wipe this project, copy
 *
 * docs/plans/SWITCHOVER.md, "Seeding from the legacy project". The plan file
 * (`scripts/lib/legacy-selection.mjs`) names the cohorts to copy, the
 * corrections made on the way, and what of this project to keep. Every run
 * WIPES the rest of this project first. Once a copy has succeeded it writes
 * `config/app.realDataSince`, and from then on this refuses
 * (`refuseOnceRealData`) unless `--replacing <that day>` says which copy it
 * replaces.
 *
 * READ-ONLY ON THE SOURCE. Every request to it is a GET or a list, made with
 * its own account's token; nothing is written there and no IAM changes. The
 * source is named only on the command line, so no file in this repo points at
 * the live project (`projectIdentity.test.ts`).
 *
 * What it copies, all with the same ids so every reference stays intact:
 *
 *  - Every staff account, and every student enrolled (now or before) in a
 *    copied class, with their password hashes (imported with the source's
 *    scrypt parameters, read from its Auth config into this process and never
 *    printed), Google links, custom claims and disabled flags. Same uids.
 *  - Every Firestore document of the copied cohorts, and every document about
 *    the people copied, field values passed through untouched (REST JSON keeps
 *    every type). EXCEPT push registrations (`notifications/{uid}/devices`):
 *    FCM tokens belong to the source's sender and cannot deliver from here;
 *    devices register again on first sign-in. And EXCEPT recordings, which
 *    the live app stores as one audio file and this project as media items:
 *    each is converted on the way (`scripts/lib/legacy-media.mjs`), and a Zoom
 *    import gets its `zoomImports` claim so the picker knows the file is here.
 *    And EXCEPT the audit entries the live app writes under action names this
 *    app has replaced, which are renamed on the way
 *    (`scripts/lib/legacy-audit.mjs`). And EXCEPT enrolments and classes,
 *    which the live app keeps as a first joining and a last leaving date, and
 *    as whether its recordings are closed now, and this project as every
 *    stretch of each: they are rebuilt from the live app's audit log on the
 *    way (`scripts/lib/stretches.mjs`).
 *  - The copied recordings' files from the source's Storage bucket, into the
 *    R2 media bucket at the same key, with the R2 write key.
 *
 * Then it waits for the triggers its wipe fired to finish, writes back any
 * copied or kept document one of them changed, counts both sides, and fails
 * loudly on any difference.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { FIREBASE_PROJECT_ID, INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { r2Config, s3For } from './lib/r2.mjs';
import { ZOOM_IMPORTS, convertRecording, isLegacyRecording } from './lib/legacy-media.mjs';
import { RENAMED_AUDIT_ACTIONS, convertAuditEntry } from './lib/legacy-audit.mjs';
import { archiveHistory, convertCourse, convertEnrolment, enrolmentHistory } from './lib/stretches.mjs';
import { canonicalFields, decodeFields, encodeValue } from './lib/firestore-rest.mjs';
import { refuseOnceRealData } from './lib/before-switchover.mjs';
import { keptHere, parsePlan, selectFromLegacy } from './lib/legacy-selection.mjs';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

// ------------------------------------------------------------------ args --
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SOURCE = opt('--from');
const SOURCE_ACCOUNT = opt('--from-account');
const PLAN_FILE = opt('--plan');
const REPLACING = opt('--replacing');
const EXECUTE = args.includes('--yes');
const TARGET = FIREBASE_PROJECT_ID;
const TARGET_ACCOUNT = 'faisal.shah@oursabeel.com';
const USAGE = 'usage: seed-from-legacy.mjs --from <project-id> --from-account <email> --plan <file> [--replacing YYYY-MM-DD] [--yes]';
const VALUED = new Set(['--from', '--from-account', '--plan', '--replacing']);
const stray = args.filter((a, i) => !(VALUED.has(a) || VALUED.has(args[i - 1]) || a === '--yes'));
if (
  stray.length ||
  !SOURCE ||
  !SOURCE_ACCOUNT ||
  !PLAN_FILE ||
  !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(SOURCE) ||
  !SOURCE_ACCOUNT.includes('@') ||
  (REPLACING !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(REPLACING))
) {
  console.error(stray.length ? `unknown argument(s): ${stray.join(' ')}\n${USAGE}` : USAGE);
  process.exit(2);
}
if (SOURCE === TARGET) {
  console.error(`--from is ${TARGET}, the project this copies INTO`);
  process.exit(2);
}
let plan;
try {
  plan = parsePlan(JSON.parse(readFileSync(PLAN_FILE, 'utf8')));
} catch (e) {
  console.error(`--plan ${PLAN_FILE}: ${e.message}`);
  process.exit(2);
}
await refuseOnceRealData('seed-from-legacy', 'a seed would wipe everything made here since', { replacing: REPLACING });

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

/*
 * ENROLMENTS IN THE OLD SHAPE. The live app keeps a first joining and a last
 * leaving date; this app keeps every stretch in the class, rebuilt here from
 * the live app's own audit log. One where the log and the dates disagree is
 * named, to look at after the copy.
 */
const legacyAudit = srcDocs.filter((d) => shape(relPath(d.name)) === 'auditLog').map((d) => decodeFields(d.fields ?? {}));
const legacyJoins = enrolmentHistory(legacyAudit);
const legacyArchives = archiveHistory(legacyAudit);
const idOf = (d) => relPath(d.name).split('/')[1];
const ofShape = (name) => srcDocs.filter((d) => shape(relPath(d.name)) === name);
const legacyCohorts = new Map(ofShape('cohorts').map((d) => [idOf(d), decodeFields(d.fields ?? {})]));
/*
 * AND CLASSES IN THE OLD SHAPE, which kept only whether their recordings are
 * closed to students now; this app keeps every stretch they were, rebuilt
 * from the same log, so a date that passed inside one reads as Closed.
 */
const converted = new Map([
  ...ofShape('enrollments').map((d) => [relPath(d.name), { field: 'stretches', c: convertEnrolment(decodeFields(d.fields ?? {}), legacyJoins.get(idOf(d))) }]),
  ...ofShape('courses').map((d) => {
    const data = decodeFields(d.fields ?? {});
    return [relPath(d.name), { field: 'recordingsClosed', c: convertCourse(idOf(d), data, legacyCohorts.get(data.cohortId), legacyArchives) }];
  }),
]);

// Every document the whole live app would become here, converted; the plan
// then chooses among them, so a choice is made on what is actually written.
const candidates = [];
/** The audit entries renamed on the way, with the live app's name for each one's action. */
const renamed = new Map();
for (const d of srcDocs) {
  const rel = relPath(d.name);
  const fields = d.fields ?? {};
  if (shape(rel) === 'recordings' && isLegacyRecording(fields)) {
    const conv = convertRecording(rel.split('/')[1], fields);
    candidates.push({ rel, fields: conv.fields });
    if (conv.claim) candidates.push({ rel: `${ZOOM_IMPORTS}/${conv.claim.id}`, fields: conv.claim.fields });
  } else if (converted.get(rel)?.c) {
    // Every field as it was, less an enrolment's two dates the stretches replace.
    const { field, c } = converted.get(rel);
    const { enrolledAt: _first, unenrolledAt: _last, ...kept } = fields;
    candidates.push({ rel, fields: { ...(field === 'stretches' ? kept : fields), [field]: encodeValue(c.data[field]) } });
  } else if (shape(rel) === 'auditLog') {
    const entry = convertAuditEntry(fields);
    if (entry !== fields) renamed.set(rel, fields.action?.stringValue);
    candidates.push({ rel, fields: entry });
  } else {
    candidates.push({ rel, fields });
  }
}

const chosen = selectFromLegacy(candidates, srcUsers, plan);
const kept = keptHere(tgtDocs.map((d) => ({ rel: relPath(d.name), fields: d.fields ?? {} })), tgtUsers, plan);
const writes = chosen.writes;
const copiedUsers = srcUsers.filter((u) => chosen.uids.has(u.localId));
for (const u of copiedUsers) {
  if (kept.accounts.has(u.localId)) throw new Error(`account ${u.localId} is both copied and kept here`);
}
const writtenRels = new Set(writes.map((w) => w.rel));
for (const d of kept.docs) if (writtenRels.has(d.rel)) throw new Error(`${d.rel} is both copied and kept here`);
const copiedRecordings = new Set(writes.filter((w) => shape(w.rel) === 'recordings').map((w) => w.rel.split('/')[1]));
const copiedObjects = srcObjects.filter((o) => copiedRecordings.has(o.key.split('/')[1]));
const keptObjects = tgtObjects.filter((o) => kept.keepsObject(o.key));
const keptRels = new Set(kept.docs.map((d) => d.rel));
const wipedDocs = tgtDocs.filter((d) => !keptRels.has(relPath(d.name)));
const wipedUsers = tgtUsers.filter((u) => !kept.accounts.has(u.localId));
const wipedObjects = tgtObjects.filter((o) => !kept.keepsObject(o.key));

// ------------------------------------------------------------- the report --
const data = (rel) => {
  const w = writes.find((x) => x.rel === rel) ?? candidates.find((x) => x.rel === rel);
  return w ? decodeFields(w.fields) : {};
};
const userOf = new Map(srcUsers.map((u) => [u.localId, u]));
const tgtUserOf = new Map(tgtUsers.map((u) => [u.localId, u]));
const courseName = (id) => data(`courses/${id}`).name ?? id;
const person = (uid) => {
  const d = data(`students/${uid}`);
  const s = data(`staffUsers/${uid}`);
  return `${d.displayName ?? s.displayName ?? '?'} <${d.email ?? s.email ?? userOf.get(uid)?.email ?? '?'}>`;
};
const classesOf = (uid) =>
  candidates
    .filter((c) => shape(c.rel) === 'enrollments')
    .map((c) => decodeFields(c.fields))
    .filter((e) => e.studentUid === uid)
    .map((e) => `${courseName(e.courseId)}${chosen.report.keptCourses.has(e.courseId) ? '' : ' [not copied]'}${e.active ? '' : ' (left)'}`)
    .join(', ');
const copiedClassesOf = (uid) =>
  writes
    .filter((w) => shape(w.rel) === 'enrollments')
    .map((w) => decodeFields(w.fields))
    .filter((e) => e.studentUid === uid)
    .map((e) => `${courseName(e.courseId)}${e.active ? '' : ' (left)'}`)
    .join(', ');

const liveCount = countByShape(candidates.map((c) => ({ name: `x/documents/${c.rel}` })));
const copyCount = countByShape(writes.map((w) => ({ name: `x/documents/${w.rel}` })));
console.log('Documents, live app → copied:');
for (const [k, n] of [...liveCount].sort()) console.log(`  ${String(n).padStart(5)} → ${String(copyCount.get(k) ?? 0).padStart(5)}  ${k}`);
console.log('  (push registrations are never read or copied)');

console.log('\nCohorts and classes copied:');
for (const c of plan.cohorts) {
  console.log(`  ${data(`cohorts/${c}`).name}`);
  for (const course of [...chosen.report.keptCourses].filter((id) => data(`courses/${id}`).cohortId === c)) {
    const sessions = writes.filter((w) => shape(w.rel) === 'sessions' && decodeFields(w.fields).courseId === course);
    const recs = writes.filter((w) => shape(w.rel) === 'recordings' && decodeFields(w.fields).courseId === course);
    console.log(`    ${courseName(course)}: ${sessions.length} sessions, ${recs.length} recordings`);
  }
}
const left = (ids, label) => ids.forEach((id) => console.log(`  not copied: ${label(id)}`));
left(plan.dropSessions, (id) => `session "${data(`sessions/${id}`).title}" ${data(`sessions/${id}`).date}, ${courseName(data(`sessions/${id}`).courseId)}`);
left(plan.dropRecordings, (id) => `recording "${data(`recordings/${id}`).title}", ${courseName(data(`recordings/${id}`).courseId)} (its session stays, with no recording)`);

const staffUids = [...chosen.uids].filter((u) => candidates.some((c) => c.rel === `staffUsers/${u}`));
console.log(`\nStaff copied (${staffUids.length}):`);
for (const u of staffUids) console.log(`  ${person(u)}  ${data(`staffUsers/${u}`).role}`);
const studentUids = [...chosen.report.copiedStudents];
const withPassword = (uid) => (userOf.get(uid)?.providerUserInfo ?? []).some((p) => p.providerId === 'password');
console.log(`\nStudents copied (${studentUids.length}; * = has never set a password):`);
for (const u of studentUids.sort((a, b) => person(a).localeCompare(person(b)))) {
  console.log(`  ${withPassword(u) ? ' ' : '*'} ${person(u)}  ${copiedClassesOf(u)}`);
}
console.log('\nStudents not copied:');
for (const u of plan.leaveOut) console.log(`  ${person(u)}  left out by the plan; was in ${classesOf(u)}`);
for (const [from, to] of chosen.report.merged) console.log(`  ${person(from)}  folded into ${person(to)}; was in ${classesOf(from)}`);
for (const u of chosen.report.notEnrolled) console.log(`  ${person(u)}  in no copied class${classesOf(u) ? `; was in ${classesOf(u)}` : ''}`);
if (chosen.report.marksRemoved.size) {
  console.log('\nMarks taken out of registers (students not copied):');
  for (const [rel, n] of chosen.report.marksRemoved) {
    const s = data(rel);
    console.log(`  ${n}  ${courseName(s.courseId)}, "${s.title}" ${s.date}`);
  }
}
console.log(`\nDocuments moved onto the account a duplicate folds into: ${chosen.report.moved}`);
const renames = new Map();
for (const [rel, from] of renamed) if (writtenRels.has(rel)) renames.set(from, (renames.get(from) ?? 0) + 1);
console.log(`Audit entries renamed: ${[...renames].map(([from, n]) => `${n} ${from} → ${RENAMED_AUDIT_ACTIONS[from]}`).join(', ') || 'none'}`);
const inferred = [...converted]
  .filter(([rel, { c }]) => c?.inferred && writtenRels.has(rel))
  .map(([rel]) => rel);
console.log(`Enrolments and classes whose log and stored dates disagree: ${inferred.join(', ') || 'none'}`);
console.log(`\nAccounts copied: ${copiedUsers.length} of ${srcUsers.length}`);
console.log(`Media copied: ${copiedObjects.length} of ${srcObjects.length} files (${mb(sum(copiedObjects))} of ${mb(sum(srcObjects))})`);

console.log(`\nKept in ${TARGET}:`);
for (const [k, n] of [...countByShape(kept.docs.map((d) => ({ name: `x/documents/${d.rel}` })))].sort()) console.log(`  ${String(n).padStart(5)}  ${k}`);
for (const u of kept.accounts) console.log(`  account ${tgtUserOf.get(u)?.email}`);
console.log(`  ${keptObjects.length} media files (${mb(sum(keptObjects))}), and the help films`);
console.log(`Removed from ${TARGET}: ${wipedDocs.length} documents, ${wipedUsers.length} accounts, ${wipedObjects.length} media files (${mb(sum(wipedObjects))}).`);

if (!EXECUTE) {
  console.log('\nDry run. Re-run with --yes to wipe this project and copy.');
  process.exit(0);
}

// 1. Wipe this project, but what the plan keeps.
console.log('\n1/7  wiping this project');
await batchWrite(wipedDocs.map((d) => ({ delete: d.name })));
for (let i = 0; i < wipedUsers.length; i += 1000) {
  await call('target', 'POST', `${itBase(TARGET)}/accounts:batchDelete`, {
    localIds: wipedUsers.slice(i, i + 1000).map((u) => u.localId),
    force: true,
  });
}
for (let i = 0; i < wipedObjects.length; i += 1000) {
  await s3.send(new DeleteObjectsCommand({
    Bucket: media.bucket,
    Delete: { Objects: wipedObjects.slice(i, i + 1000).map((o) => ({ Key: o.key })) },
  }));
}

// 2. Accounts.
console.log(`2/7  ${copiedUsers.length} accounts`);
for (let i = 0; i < copiedUsers.length; i += 1000) {
  const r = await json('target', 'POST', `${itBase(TARGET)}/accounts:batchCreate`, {
    hashAlgorithm: 'SCRYPT',
    signerKey: hash.signerKey,
    saltSeparator: hash.saltSeparator,
    rounds: hash.rounds,
    memoryCost: hash.memoryCost,
    users: copiedUsers.slice(i, i + 1000).map(importable),
  });
  if (r.error?.length) throw new Error(`account import: ${JSON.stringify(r.error.slice(0, 3))}`);
}

// 3. Firestore.
const docName = (rel) => `projects/${TARGET}/databases/(default)/documents/${rel}`;
const updates = writes.map((w) => ({ update: { name: docName(w.rel), fields: w.fields } }));
console.log(`3/7  ${updates.length} documents`);
await batchWrite(updates);

// 4. Media.
console.log(`4/7  ${copiedObjects.length} media objects (${mb(sum(copiedObjects))})`);
for (const o of copiedObjects) {
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
 * runs has passed, every copied and every kept document is compared with what
 * it should hold, field by field, and any a trigger changed is written back,
 * until a pass finds none. The triggers themselves change nothing in data
 * copied whole.
 */
const expected = [...updates, ...kept.docs.map((d) => ({ update: { name: docName(d.rel), fields: d.fields } }))];
const problems = [];
const SETTLE_MS = 90_000;
for (let pass = 1; ; pass += 1) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const now = new Map((await allDocs('target', TARGET, fsBase(TARGET), new Set())).map((d) => [relPath(d.name), d.fields ?? {}]));
  const drifted = expected.filter((w) => canonicalFields(now.get(relPath(w.update.name))) !== canonicalFields(w.update.fields));
  console.log(`5/7  settle pass ${pass}: ${drifted.length} document(s) changed since the copy`);
  for (const w of drifted.slice(0, 20)) console.log(`       ${relPath(w.update.name)}`);
  if (drifted.length === 0) break;
  if (pass === 3) {
    problems.push(`${drifted.length} document(s) still change after the copy, e.g. ${drifted.slice(0, 3).map((w) => relPath(w.update.name)).join(', ')}`);
    break;
  }
  await batchWrite(drifted);
}

// 6. Count both sides.
console.log('6/7  checking');
const [afterDocs, afterUsers, afterObjects] = await Promise.all([
  allDocs('target', TARGET, fsBase(TARGET), new Set()),
  allUsers('target', TARGET),
  Promise.all(WIPED_PREFIXES.map((prefix) => targetObjects(prefix))).then((lists) => lists.flat()),
]);
const want = countByShape(expected.map((w) => w.update));
const got = countByShape(afterDocs);
for (const k of new Set([...want.keys(), ...got.keys()])) {
  if (want.get(k) !== got.get(k)) problems.push(`${k}: expected ${want.get(k) ?? 0}, here ${got.get(k) ?? 0}`);
}
const afterUids = new Set(afterUsers.map((u) => u.localId));
const wantUids = new Set([...copiedUsers.map((u) => u.localId), ...kept.accounts]);
if (afterUids.size !== wantUids.size || [...wantUids].some((u) => !afterUids.has(u))) {
  problems.push(`accounts: expected ${wantUids.size}, here ${afterUids.size}`);
}
const claimsLost = copiedUsers.filter((u) => u.customAttributes && afterUsers.find((a) => a.localId === u.localId)?.customAttributes !== u.customAttributes);
if (claimsLost.length) problems.push(`${claimsLost.length} accounts lost their claims`);
const sizes = new Map(afterObjects.map((o) => [o.key, o.size]));
for (const o of [...copiedObjects, ...keptObjects]) if (sizes.get(o.key) !== o.size) problems.push(`media ${o.key}: ${o.size} vs ${sizes.get(o.key)}`);
if (afterObjects.length !== copiedObjects.length + keptObjects.length) {
  problems.push(`media: expected ${copiedObjects.length + keptObjects.length} files, here ${afterObjects.length}`);
}

if (problems.length) {
  console.error(`\nMISMATCH:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// 7. Record that this project now holds the real records (`refuseOnceRealData`).
const since = todayInZone(INSTITUTE_TIMEZONE, Date.now());
await call('target', 'PATCH', `${fsBase(TARGET)}/config/app?updateMask.fieldPaths=realDataSince`, {
  fields: { realDataSince: { stringValue: since } },
});
console.log(`7/7  config/app.realDataSince = ${since}`);
console.log(`\nCopied and checked: ${afterDocs.length} documents, ${afterUsers.length} accounts, ${afterObjects.length} media objects.`);
