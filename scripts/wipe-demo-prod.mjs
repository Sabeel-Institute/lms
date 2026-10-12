/**
 * Remove everything `seed-demo-prod.mjs` put into the LIVE project — and nothing
 * else.
 *
 *   node scripts/wipe-demo-prod.mjs           # DRY RUN: prints the plan, deletes nothing
 *   node scripts/wipe-demo-prod.mjs --yes     # actually delete
 *
 * Dry run is the DEFAULT on purpose. This deletes hundreds of documents from
 * production, including — see below — a few things you may have made yourself,
 * and it may be run months later by someone (or some session) with no memory of
 * how the data got there. Making the destructive path opt-in means the worst a
 * mistaken invocation can do is print a list.
 *
 * WHAT COUNTS AS DEMO DATA
 *
 * The seed marks everything it writes with `demoSeed: true` and a `demo-` id
 * prefix. But the flag alone is not enough, and assuming it was left orphans:
 * plenty of demo-related documents are written by the app and by the triggers,
 * so they never carry it —
 *
 *   - assignments / attendanceRecords — created by the publish/attendance fan-out
 *   - listeningProgress / completions / completionEvents — written by anyone who
 *     opens a demo recording and presses play, including while demoing it
 *   - auditLog           — `getPlaybackUrl` and every staff callable audits itself
 *   - enrollments        — a demo student enrolled by hand, in a demo course or
 *     a real one, is an app-written row with no flag
 *   - notifications/{uid} and its devices/sent subtrees — written the moment a
 *     demo account turns notifications on, and Firestore never cascades a
 *     subcollection delete, so removing the parent alone leaves them behind
 *   - sessions / recordings — anything YOU add inside a demo course while
 *     exploring. These are listed by name in the plan, because they are the one
 *     category this removes that you created rather than the seed. They go with
 *     the course: leaving them would orphan them (a session pointing at a course
 *     that no longer exists) and strand their audio in the bucket, billable.
 *
 * So the sweep is by REFERENCE as well as by flag: anything pointing at a
 * `demo-` id in any of the fields the app joins on. That prefix exists only on
 * seeded data, so this cannot reach anything unrelated to the demo.
 *
 * WHERE THE DEMO LEAKED INTO REAL DATA
 *
 * Staff demoed with real classes open, so demo accounts got INTO real records:
 * demo students enrolled in real courses and marked on real registers, and demo
 * staff added as managers of a real course. Deleting the accounts and leaving
 * those references would put ghost rows on a real class's ledger — the ledger
 * deliberately keeps marks for departed students, so a uid with no student
 * behind it would sit there as "departed" for good. This script therefore also
 * edits real documents, in exactly two ways, both listed by name in the plan:
 * it removes demo uids from a real session's `attendance` map, and from a real
 * course's `managerUids`. Real students' marks are untouched.
 */
import { createRequire } from 'node:module';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { r2Config, s3For } from './lib/r2.mjs';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');
const { DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const PROJECT = FIREBASE_PROJECT_ID;
const EXECUTE = process.argv.includes('--yes');
if (process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is set — this script targets production.');
}
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const auth = admin.auth();
// The media bucket (R2), with the write key from Secret Manager.
const media = r2Config();
const s3 = s3For(media.endpoint, media.write);
/** Every key under a prefix. */
async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: media.bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(r.Contents ?? []).map((o) => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
const { FieldValue, FieldPath } = admin.firestore;

const isDemoId = (v) => String(v ?? '').startsWith('demo-');
/** Any id, key or value starting with `demo-`, however deep. */
const mentionsDemo = (v) =>
  typeof v === 'string' ? isDemoId(v)
  : v && typeof v === 'object' && !(v instanceof Date)
    ? Object.entries(v).some(([k, x]) => isDemoId(k) || mentionsDemo(x))
    : false;
const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const FLAGGED = ['cohorts','courses','sessions','recordings','students','enrollments',
  'completions','listeningProgress','completionOverrides','completionEvents','auditLog','staffUsers'];
const BY_REFERENCE = ['sessions','recordings','enrollments','attendanceRecords','assignments',
  'completions','completionEvents','listeningProgress','completionOverrides','auditLog'];

/** The fields the app joins on. A document pointing at demo data through any of
 *  them is orphaned the moment that data goes. */
const isDemoRef = (d) => {
  const v = d.data();
  return (
    ['recordingId', 'studentUid', 'courseId', 'sessionId', 'cohortId'].some((f) => isDemoId(v[f])) ||
    Object.values(v.targets ?? {}).some(isDemoId)
  );
};

// ---------------------------------------------------------------- the plan --
const plan = [];      // { label, docs }
const yoursInDemo = [];
const seen = new Set();

for (const coll of FLAGGED) {
  const snap = await db.collection(coll).where('demoSeed', '==', true).get();
  snap.docs.forEach((d) => seen.add(d.ref.path));
  if (snap.size) plan.push({ label: `${coll} (seeded)`, docs: snap.docs });
}
for (const coll of BY_REFERENCE) {
  const snap = await db.collection(coll).get();
  const docs = snap.docs.filter(
    (d) => !seen.has(d.ref.path) && d.data().demoSeed !== true && isDemoRef(d),
  );
  docs.forEach((d) => seen.add(d.ref.path));
  if (coll === 'sessions' || coll === 'recordings') {
    for (const d of docs) yoursInDemo.push(`${coll}/${d.id} — “${d.data().title ?? ''}”`);
  }
  if (docs.length) plan.push({ label: `${coll} (app/trigger-written)`, docs });
}

// Real documents that name a demo account. Edited, not deleted.
const sessionFixes = [];   // { ref, title, keys }
for (const d of (await db.collection('sessions').get()).docs) {
  if (seen.has(d.ref.path)) continue;
  const keys = Object.keys(d.data().attendance ?? {}).filter(isDemoId);
  if (keys.length) sessionFixes.push({ ref: d.ref, title: `${d.data().date} ${d.data().title ?? ''}`, keys });
}
const courseFixes = [];    // { ref, name, uids }
for (const d of (await db.collection('courses').get()).docs) {
  if (seen.has(d.ref.path)) continue;
  const uids = (d.data().managerUids ?? []).filter(isDemoId);
  if (uids.length) courseFixes.push({ ref: d.ref, name: d.data().name, uids });
}

// `listDocuments` rather than `get`: a parent whose own document was never
// written still shows up here when it has subcollections, and a device
// registration creates exactly that shape.
const notificationTrees = [];
for (const ref of await db.collection('notifications').listDocuments()) {
  if (!isDemoId(ref.id)) continue;
  const [devices, sent] = await Promise.all([ref.collection('devices').get(), ref.collection('sent').get()]);
  notificationTrees.push({ ref, devices: devices.size, sent: sent.size });
}
// Markers about demo things under REAL people's trees: a real manager of a
// demo course was reminded about its untaken register, and the marker
// `sent/attendanceMissing_demo-…` sits under their own uid.
const strayMarkers = (await db.collectionGroup('sent').get()).docs.filter(
  (d) => !isDemoId(d.ref.parent.parent?.id) && (isDemoId(d.id) || mentionsDemo(d.data())),
);

const removedRecordingIds = new Set(
  plan.filter((p) => p.label.startsWith('recordings')).flatMap((p) => p.docs.map((d) => d.id)),
);
const orphanFiles = (await listKeys('recordings/')).filter((k) => removedRecordingIds.has(k.split('/')[1]));
const seedTmp = await listKeys('demo-seed/');

const demoUsers = [];
let page;
do {
  const r = await auth.listUsers(1000, page);
  demoUsers.push(...r.users.filter((u) => isDemoId(u.uid)));
  page = r.pageToken;
} while (page);

const totalDocs = plan.reduce((n, p) => n + p.docs.length, 0);

console.log(EXECUTE ? 'DELETING demo data from PRODUCTION' : 'DRY RUN — nothing will be deleted');
console.log('');
for (const p of plan) console.log(`   ${String(p.docs.length).padStart(5)}  ${p.label}`);
console.log(`   ${String(notificationTrees.length).padStart(5)}  notification trees` +
  (notificationTrees.length
    ? `  (${notificationTrees.map((t) => `${t.ref.id}: ${t.devices} devices, ${t.sent} sent`).join('; ')})`
    : ''));
console.log(`   ${String(strayMarkers.length).padStart(5)}  sent markers about demo things under real accounts`);
console.log(`   ${String(orphanFiles.length + seedTmp.length).padStart(5)}  storage objects`);
console.log(`   ${String(demoUsers.length).padStart(5)}  auth accounts`);
console.log(`\n   total: ${totalDocs} documents`);

if (yoursInDemo.length) {
  console.log('\n   NOT seed data — you created these inside a demo course, so they go with it:');
  for (const y of yoursInDemo) console.log(`      ${y}`);
}
if (sessionFixes.length || courseFixes.length) {
  console.log('\n   REAL documents edited, not deleted — demo accounts removed from them:');
  for (const f of sessionFixes) console.log(`      sessions/${f.ref.id} “${f.title}”: ${f.keys.length} demo marks off the register`);
  for (const f of courseFixes) console.log(`      courses/${f.ref.id} “${f.name}”: managers ${f.uids.join(', ')}`);
}

// -------------------------------------------------------------- what stays --
console.log('\nWhat survives:');
for (const c of ['cohorts','courses','sessions','recordings','auditLog','staffUsers']) {
  const snap = await db.collection(c).get();
  const left = snap.docs.filter((d) => !seen.has(d.ref.path));
  console.log(`   ${String(left.length).padStart(5)}  ${c}` +
    (left.length && left.length <= 4 ? `  (${left.map((d) => d.id.slice(0, 22)).join(', ')})` : ''));
}

if (!EXECUTE) {
  console.log('\nRe-run with --yes to delete.');
  process.exit(0);
}

// ----------------------------------------------------------------- execute --
console.log('\nDeleting…');
for (const p of plan) {
  for (let i = 0; i < p.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of p.docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  console.log(`   removed ${p.docs.length} ${p.label}`);
}
for (const f of sessionFixes) {
  // FieldPath, not a dotted string: a uid with a hyphen is not a bare
  // identifier, and the dotted form is rejected for it.
  await f.ref.update(...f.keys.flatMap((k) => [new FieldPath('attendance', k), FieldValue.delete()]));
}
for (const f of courseFixes) {
  await f.ref.update({ managerUids: FieldValue.arrayRemove(...f.uids) });
}
console.log(`   edited ${sessionFixes.length} sessions and ${courseFixes.length} courses`);
for (const t of notificationTrees) await db.recursiveDelete(t.ref);
console.log(`   removed ${notificationTrees.length} notification trees`);
for (const group of chunk(strayMarkers, 400)) {
  const batch = db.batch();
  for (const d of group) batch.delete(d.ref);
  await batch.commit();
}
console.log(`   removed ${strayMarkers.length} stray sent markers`);
for (const group of [orphanFiles, seedTmp]) {
  for (let i = 0; i < group.length; i += 20) {
    await Promise.all(group.slice(i, i + 20).map((Key) =>
      s3.send(new DeleteObjectCommand({ Bucket: media.bucket, Key })).catch(() => {})));
  }
}
console.log(`   removed ${orphanFiles.length + seedTmp.length} storage objects`);
for (let i = 0; i < demoUsers.length; i += 900) {
  await auth.deleteUsers(demoUsers.slice(i, i + 900).map((u) => u.uid));
}
console.log(`   removed ${demoUsers.length} auth accounts`);

// ------------------------------------------------------------------ verify --
// The promise is "nothing demo remains", so that is what gets asserted: every
// collection, every document, ids, keys and values alike — not the lists above,
// which are the mechanism. A collection this script never heard of shows up
// here too, which is the point of asking the database rather than the code.
const residue = [];
for (const coll of await db.listCollections()) {
  for (const d of (await coll.get()).docs) {
    if (isDemoId(d.id) || mentionsDemo(d.data())) residue.push(d.ref.path);
  }
}
for (const ref of await db.collection('notifications').listDocuments()) {
  if (isDemoId(ref.id)) residue.push(ref.path);
}
// The subcollections too: a REAL manager of a demo course was sent
// `attendanceMissing_demo-…`, which lives under their own notifications tree
// and no root scan sees. Every `sent` and `devices` row in the project.
for (const group of ['sent', 'devices']) {
  for (const d of (await db.collectionGroup(group).get()).docs) {
    if (isDemoId(d.id) || mentionsDemo(d.data())) residue.push(d.ref.path);
  }
}
let usersLeft = 0;
let verifyPage;
do {
  const r = await auth.listUsers(1000, verifyPage);
  usersLeft += r.users.filter((u) => isDemoId(u.uid)).length;
  verifyPage = r.pageToken;
} while (verifyPage);
if (residue.length || usersLeft) {
  console.log(`\nSTILL REFERENCING DEMO DATA — ${residue.length} documents, ${usersLeft} auth accounts:`);
  for (const p of residue.slice(0, 40)) console.log(`   ${p}`);
  process.exit(1);
}
console.log('\nVerified: no document in any collection, and no auth account, refers to demo data.');
console.log('Done.');
process.exit(0);
