/**
 * Seed a RICH DEMO dataset into the LIVE project, for looking at the reports
 * with realistic volume. Paired with `wipe-demo-prod.mjs`, which removes exactly
 * what this creates and nothing else.
 *
 *   node scripts/seed-demo-prod.mjs          # says what it would do
 *   node scripts/seed-demo-prod.mjs --yes    # seed
 *   node scripts/wipe-demo-prod.mjs          # remove it all again
 *
 * Refused after switchover, when the project holds real students
 * (`refuseAfterSwitchover`).
 *
 * THIS WRITES TO PRODUCTION. It is additive: everything it creates carries
 * `demoSeed: true` and a `demo-` id prefix, so anything you made yourself is
 * left alone and the wipe can be exact.
 *
 * Two constraints this respects, both learned the hard way:
 *
 *  - Student auth accounts are created with `importUsers`, not `createUser`.
 *    Import does not fire the `onUserCreate` trigger, so there is no window in
 *    which provisioning could reject them — and a student created WITH a
 *    password would be rejected as a client-side self-signup (see
 *    `provision.ts`). Claims go in with the import.
 *  - Assignments are NOT written here. Publishing a recording and submitting
 *    attendance is what creates them, via the real `onRecordingWritten` /
 *    `onSessionWritten` triggers in production. We write the sessions and
 *    recordings, wait for the fan-out, then hang completions and listening
 *    progress off whatever the triggers actually produced — so the demo data is
 *    consistent with the real engine rather than a parallel invention of it.
 */
import { createRequire } from 'node:module';
import { FIREBASE_PROJECT_ID, mediaFromSingleAudio, mediaStorageKey } from '@sabeel/shared';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { r2Config, s3For } from './lib/r2.mjs';
import { refuseAfterSwitchover } from './lib/before-switchover.mjs';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

refuseAfterSwitchover('seed-demo-prod', "demo data would land on real students' records");
const unknownArgs = process.argv.slice(2).filter((a) => a !== '--yes');
if (unknownArgs.length) {
  console.error('usage: node scripts/seed-demo-prod.mjs [--yes]');
  process.exit(2);
}
if (!process.argv.includes('--yes')) {
  console.log('Dry run: this writes 3 cohorts, 8 courses, 50 students and about 80 sessions to the live project. Re-run with --yes to write.');
  process.exit(0);
}
const PROJECT = FIREBASE_PROJECT_ID;
if (process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is set — this script targets production.');
}
initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();
// The media bucket (R2), with the write key from Secret Manager.
const media = r2Config();
const s3 = s3For(media.endpoint, media.write);

const DEMO = { demoSeed: true }; // the wipe key — on every document we create
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();
const today = iso(now);

// Deterministic ids so re-running is idempotent rather than duplicating.
const sid = (...p) => `demo-${p.join('-')}`;

// A seeded RNG: a demo you can regenerate identically is easier to talk about
// than one that reshuffles every run.
let _s = 20260725;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

// ------------------------------------------------------------------ people --

const FIRST = ['Fatima','Bilal','Omar','Ayesha','Yusuf','Maryam','Zainab','Ibrahim','Khadija','Hamza',
  'Sumayya','Idris','Aisha','Uthman','Ruqayya','Salman','Safiyya','Anas','Juwayriya','Musa',
  'Asma','Talha','Hafsa','Zubayr','Nusayba','Ammar','Umm Kulthum','Suhayb','Layla','Bilqis',
  'Adam','Sana','Yahya','Amina','Ilyas','Hajar','Dawud','Rabia','Harun','Nadia',
  'Ishaq','Sawda','Zakariya','Habiba','Tariq','Iman','Faris','Sakina','Rashid','Widad'];
const LAST = ['Ahmed','Khan','Siddiqui','Rahman','Ali','Iqbal','Hassan','Malik','Farooq','Qureshi',
  'Aziz','Haddad','Nasir','Baig','Chaudhry','Mansour','Karim','Sheikh','Ansari','Rizvi'];

const students = FIRST.map((first, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    uid: sid('stu', n),
    displayName: `${first} ${LAST[i % LAST.length]}`,
    email: `demo.student${n}@example.com`,
  };
});

const staff = [
  { uid: sid('staff', 'amina'), displayName: 'Amina Yusuf', email: 'demo.amina@example.com' },
  { uid: sid('staff', 'kareem'), displayName: 'Kareem Sultan', email: 'demo.kareem@example.com' },
];

// ------------------------------------------------------- cohorts & courses --

const COHORTS = [
  { key: 'a25', name: 'Autumn 2025', archived: true, start: '2025-09-08', courses: [
      { key: 'hik1', name: 'Hikam Foundations I', sessions: 12 },
      { key: 'ara1', name: 'Arabic I', sessions: 12 },
  ] },
  { key: 'sp26', name: 'Spring 2026', archived: false, start: '2026-01-12', courses: [
      { key: 'hik2', name: 'Hikam Foundations II', sessions: 12 },
      { key: 'ara2', name: 'Arabic II', sessions: 11 },
      { key: 'seer', name: 'Seerah of the Prophet ﷺ', sessions: 10 },
  ] },
  { key: 'su26', name: 'Summer 2026', archived: false, start: '2026-06-01', courses: [
      { key: 'hik3', name: 'Hikam Foundations III', sessions: 8 },
      { key: 'fiqh', name: 'Fiqh of Worship', sessions: 8 },
      { key: 'tajw', name: 'Tajweed Intensive', sessions: 7 },
  ] },
];

const SESSION_TITLES = {
  hik1: ['Introduction to the Hikam','Knowledge and Certainty','Reliance and Trust','Patience in Hardship','Sincerity of Intention','Gratitude','The Heart and Its States','Repentance','Contentment','Remembrance','Humility','Review and Reflection'],
  hik2: ['Return to the Path','Detachment','The Veil of the Self','Provision and Trust','Signs and Meanings','Nearness','The Company of the Sincere','Fear and Hope','Presence of Heart','Trials as Gifts','Stillness','Closing Reflections'],
  hik3: ['Beginnings Revisited','Certainty in Practice','Speech and Silence','The Inner Struggle','Light upon Light','Service','Companionship','Concluding Session'],
  ara1: ['The Arabic Alphabet','Short Vowels','Long Vowels','Sun and Moon Letters','Nouns and Gender','The Definite Article','Simple Sentences','Pronouns','Possession','Prepositions','Numbers 1–10','Review'],
  ara2: ['Verb Roots','The Past Tense','The Present Tense','Subject and Object','Broken Plurals','Adjectives','Questions','Negation','The Dual','Commands','Review and Assessment'],
  seer: ['Arabia before Islam','The Early Years','The First Revelation','The Early Believers','Persecution','The Migration to Abyssinia','The Year of Sorrow','The Night Journey','Hijrah to Madinah','Building the Community'],
  fiqh: ['Purification','Prayer: Conditions','Prayer: Description','Zakat','Fasting','Hajj','Common Questions','Review'],
  tajw: ['Makharij: Introduction','The Throat Letters','Heavy and Light','Rules of Noon Sakinah','Rules of Meem Sakinah','Madd: Lengthening','Practice and Assessment'],
};

// ------------------------------------------------------------------ audio ---

const DURATION_SEC = 720;

/**
 * Repo-local, and REGENERATED EVERY RUN. Both parts matter, because line ~206
 * uploads this file to the LIVE bucket.
 *
 * It used to be `/tmp/demo-lecture.m4a`, cached by existence — so whatever
 * happened to sit at that world-writable path got published to production, and
 * three sibling checkouts on this machine all shared `/tmp`. Regenerating
 * removes the cache-poisoning path entirely; ffmpeg takes about a second for a
 * 12-minute 16 kbit/s mono tone.
 */
const AUDIO = resolve(import.meta.dirname, '..', '.tmp', 'demo-lecture.m4a');

function ensureAudio() {
  mkdirSync(dirname(AUDIO), { recursive: true });
  // A 12-minute tone at a low bitrate: real, playable audio without shipping
  // hundreds of megabytes into the bucket for a dataset that gets wiped.
  execFileSync('ffmpeg', ['-f','lavfi','-i','sine=frequency=210:duration=720,volume=0.25',
    '-c:a','aac','-b:a','16k','-ac','1', AUDIO, '-y'], { stdio: 'ignore' });

  // Look at what is about to be published, rather than trusting that ffmpeg did
  // what was asked. A truncated or substituted file is otherwise indetectable
  // until it is already in the production bucket.
  const bytes = statSync(AUDIO).size;
  if (bytes < 100_000 || bytes > 5_000_000) {
    throw new Error(`fixture is ${bytes} bytes — not the expected 12-minute tone`);
  }
  const probed = Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration',
    '-of','default=noprint_wrappers=1:nokey=1', AUDIO], { encoding: 'utf8' }).trim());
  if (!(Math.abs(probed - DURATION_SEC) < 2)) {
    throw new Error(`fixture is ${probed}s, expected ${DURATION_SEC}s — refusing to upload`);
  }
}

// --------------------------------------------------------------- utilities --

async function commitAll(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 400)) w(batch);
    await batch.commit();
  }
}

// =============================================================== 1. people ==
console.log('1/6  auth accounts (import — does not fire onUserCreate)');
const toImport = [
  ...students.map((s) => ({ uid: s.uid, email: s.email, displayName: s.displayName,
    customClaims: { role: 'student', status: 'active' } })),
  ...staff.map((s) => ({ uid: s.uid, email: s.email, displayName: s.displayName,
    customClaims: { role: 'manager', status: 'active' } })),
];
const res = await auth.importUsers(toImport);
console.log(`     imported ${res.successCount}, failed ${res.failureCount}`);
if (res.failureCount) console.log('    ', res.errors.slice(0, 3));

// One student gets a password so the student experience can be viewed. Setting a
// password AFTER creation does not re-fire onCreate, so this is safe.
//
// MINTED PER RUN, never committed: this is a working credential on a live
// project, and demo students have been excused in real sessions, so a password
// in the repository was a way into real recordings for anyone reading it.
const DEMO_STUDENT_PW = `Demo-${randomBytes(9).toString('base64url')}`;
await auth.updateUser(students[0].uid, { password: DEMO_STUDENT_PW, emailVerified: true });

await commitAll([
  ...students.map((s) => (b) => b.set(db.collection('students').doc(s.uid), {
    email: s.email, displayName: s.displayName, role: 'student', status: 'active',
    createdAt: now - 200 * day, createdBy: 'demo-seed', ...DEMO })),
  ...staff.map((s) => (b) => b.set(db.collection('staffUsers').doc(s.uid), {
    email: s.email, displayName: s.displayName, photoUrl: null,
    role: 'manager', status: 'active', createdAt: now - 200 * day,
    approvedBy: 'demo-seed', approvedAt: now - 200 * day, ...DEMO })),
]);
console.log(`     ${students.length} students, ${staff.length} managers`);

// ==================================================== 2. cohorts & courses ==
console.log('2/6  cohorts, courses, enrolments');
const courses = [];
const writes = [];
for (const co of COHORTS) {
  const cohortId = sid('coh', co.key);
  writes.push((b) => b.set(db.collection('cohorts').doc(cohortId), {
    name: co.name, archived: co.archived, createdAt: now - 300 * day,
    createdBy: 'demo-seed', ...DEMO }));
  for (const c of co.courses) {
    const courseId = sid('crs', c.key);
    // A manager on some courses, so manager scoping is visible on the Staff screen.
    const managerUids = c.key === 'hik2' ? [staff[0].uid]
      : c.key === 'ara2' ? [staff[1].uid] : [];
    writes.push((b) => b.set(db.collection('courses').doc(courseId), {
      cohortId, name: c.name, archived: false,
      // An archived cohort's classes keep their recordings open here, so
      // nothing was ever closed to their students.
      effectiveActive: !co.archived, archivedAccess: co.archived, recordingsClosed: [],
      managerUids, createdAt: now - 300 * day, createdBy: 'demo-seed', ...DEMO }));
    courses.push({ ...c, courseId, cohortId, cohort: co });
  }
}

// Enrolment: every student takes 1–3 courses; each course lands 12–22 students.
const roster = new Map(courses.map((c) => [c.courseId, []]));
for (const s of students) {
  const n = 1 + Math.floor(rnd() * 3);
  const chosen = new Set();
  while (chosen.size < n) chosen.add(pick(courses).courseId);
  for (const courseId of chosen) {
    roster.get(courseId).push(s.uid);
    const c = courses.find((x) => x.courseId === courseId);
    writes.push((b) => b.set(db.collection('enrollments').doc(`${s.uid}_${courseId}`), {
      studentUid: s.uid, courseId, cohortId: c.cohortId, active: true,
      stretches: [{ from: now - 180 * day, to: null }], enrolledBy: 'demo-seed', ...DEMO }));
  }
}
await commitAll(writes);
console.log('     ' + courses.map((c) => `${c.name}: ${roster.get(c.courseId).length}`).join(', '));

// ================================================ 3. sessions & recordings ==
console.log('3/6  sessions, attendance, recordings');
ensureAudio();
const MASTER = 'demo-seed/master.m4a';
await s3.send(new PutObjectCommand({ Bucket: media.bucket, Key: MASTER, Body: readFileSync(AUDIO), ContentType: 'audio/mp4' }));

const sessionWrites = [];
const recordingWrites = [];
const audioCopies = [];
let sessionCount = 0, recordingCount = 0, attendanceCount = 0;

for (const c of courses) {
  const enrolled = roster.get(c.courseId);
  const start = new Date(c.start ?? c.cohort.start).getTime();
  for (let i = 0; i < c.sessions; i++) {
    const date = iso(start + i * 7 * day);
    if (date > today) continue;                       // no future meetings
    const sessionId = sid('ses', c.key, String(i + 1).padStart(2, '0'));
    const title = `Session ${i + 1} — ${SESSION_TITLES[c.key][i] ?? 'Class'}`;
    const dueDate = iso(start + i * 7 * day + 7 * day);
    const isRecent = start + i * 7 * day > now - 10 * day;

    // The last meeting or two of a live course are deliberately incomplete —
    // that is what the "still to do" side of the reports looks like.
    const hasRecording = c.cohort.archived ? chance(0.92) : (isRecent ? chance(0.4) : chance(0.88));
    const attendanceTaken = c.cohort.archived ? true : (isRecent ? chance(0.5) : chance(0.94));

    const attendance = {};
    if (attendanceTaken) {
      for (const uid of enrolled) {
        // Most were there; of the rest, most were excused (and so granted the
        // recording) and a few were absent without being excused, who get
        // nothing. Weighted this way so the demo has real required listening.
        attendance[uid] = chance(0.78) ? 'present' : (chance(0.75) ? 'excused' : 'absent');
      }
      attendanceCount++;
    }
    const recordingId = hasRecording ? sid('rec', c.key, String(i + 1).padStart(2, '0')) : null;

    sessionWrites.push((b) => b.set(db.collection('sessions').doc(sessionId), {
      courseId: c.courseId, cohortId: c.cohortId, date, title, dueDate,
      notes: chance(0.25) ? 'Focus on the section we discussed at the end — it comes up next week.' : '',
      recordingId,
      attendance, attendanceSubmittedAt: attendanceTaken ? start + i * 7 * day + 3600000 : null,
      ...(attendanceTaken ? { attendanceSubmittedBy: 'demo-seed' } : {}),
      notRecorded: false, createdAt: start + i * 7 * day, createdBy: 'demo-seed',
      updatedAt: start + i * 7 * day, ...DEMO }));
    sessionCount++;

    if (recordingId) {
      // A few recordings sit in a non-published state on purpose, so the library
      // filters and the "needs attention" path have something to show.
      const roll = rnd();
      const status = isRecent && roll < 0.25 ? 'draft'
        : roll < 0.04 ? 'needsAttention'
        : c.cohort.archived && roll > 0.9 ? 'archived'
        : 'published';
      const audioPath = status === 'draft' && chance(0.4) ? null : mediaStorageKey(recordingId, 'audio1');
      if (audioPath) audioCopies.push(audioPath);
      const source = chance(0.7) ? 'zoom' : 'manual';
      const createdAt = start + i * 7 * day + 3600000;
      recordingWrites.push((b) => b.set(db.collection('recordings').doc(recordingId), {
        sessionId, courseId: c.courseId, cohortId: c.cohortId,
        title, notes: '', date,
        status, source,
        media: mediaFromSingleAudio(
          { source, audioPath, sizeBytes: 1_450_000, durationSec: DURATION_SEC, createdAt, createdBy: 'demo-seed' },
          'audio1',
        ),
        defaultVersion: 'audio',
        durationSec: audioPath ? DURATION_SEC : null,
        ...(status === 'needsAttention'
          ? { attentionReason: 'Audio looks truncated — re-import before publishing.' } : {}),
        ...(status === 'published' ? { publishedAt: start + i * 7 * day + 7200000 } : {}),
        createdAt, createdBy: 'demo-seed',
        updatedAt: start + i * 7 * day + 3600000, ...DEMO }));
      recordingCount++;
    }
  }
}
// Sessions BEFORE recordings: the recording trigger reads its session, so the
// session must already exist or the first fan-out finds nothing to reconcile.
await commitAll(sessionWrites);
await commitAll(recordingWrites);
console.log(`     ${sessionCount} sessions (${attendanceCount} with attendance), ${recordingCount} recordings`);

console.log(`4/6  audio: server-side copy x${audioCopies.length} (no re-upload)`);
for (let i = 0; i < audioCopies.length; i += 12) {
  await Promise.all(audioCopies.slice(i, i + 12).map((key) =>
    s3.send(new CopyObjectCommand({ Bucket: media.bucket, CopySource: `${media.bucket}/${MASTER}`, Key: key }))));
}
await s3.send(new DeleteObjectCommand({ Bucket: media.bucket, Key: MASTER })).catch(() => {});

// ===================================================== 5. let triggers run ==
console.log('5/6  waiting for onRecordingWritten / onSessionWritten fan-out…');
let assignments = [];
const isDemoId = (v) => String(v ?? '').startsWith('demo-');
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = await db.collection('assignments').where('active', '==', true).get();
  /*
   * DEMO GRANTS ONLY. This query sees every active grant in the project, and
   * step 6 writes completions, progress and overrides for a random share of
   * whatever it is handed — with `set`, which replaces the document. Unfiltered,
   * it wrote fabricated listening records over real students' own, flagged as
   * demo, which the wipe then deleted. Both ends of every row must be seeded.
   */
  assignments = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => isDemoId(a.studentUid) && isDemoId(a.recordingId));
  process.stdout.write(`\r     ${assignments.length} assignments so far…`);
  if (i > 3 && assignments.length && assignments.length === (globalThis.__last ?? -1)) break;
  globalThis.__last = assignments.length;
}
console.log('');

// ============================================ 6. completions and progress ==
console.log('6/6  completions, listening progress, overrides, audit');
const done = [];
for (const a of assignments) {
  const overdue = a.dueDate && a.dueDate < today;
  // Older obligations are mostly settled; recent ones are still in flight.
  const p = overdue ? 0.72 : 0.4;
  if (chance(p)) {
    const at = now - Math.floor(rnd() * 60) * day;
    done.push((b) => b.set(db.collection('completions').doc(`${a.studentUid}_${a.recordingId}`), {
      studentUid: a.studentUid, recordingId: a.recordingId, courseId: a.courseId,
      completed: true, completedAt: at, updatedAt: at, ...DEMO }));
    done.push((b) => b.set(db.collection('listeningProgress').doc(`${a.studentUid}_${a.recordingId}`), {
      studentUid: a.studentUid, recordingId: a.recordingId, courseId: a.courseId,
      listenedMs: DURATION_SEC * 1000, sittings: { seed: DURATION_SEC * 1000 }, sitting: 'seed',
      updatedAt: at, ...DEMO }));
  } else if (chance(0.45)) {
    // Started, not finished — the rows staff actually chase.
    const frac = 0.1 + rnd() * 0.7;
    done.push((b) => b.set(db.collection('listeningProgress').doc(`${a.studentUid}_${a.recordingId}`), {
      studentUid: a.studentUid, recordingId: a.recordingId, courseId: a.courseId,
      listenedMs: Math.round(DURATION_SEC * 1000 * frac),
      sittings: { seed: Math.round(DURATION_SEC * 1000 * frac) }, sitting: 'seed',
      updatedAt: now - Math.floor(rnd() * 20) * day, ...DEMO }));
  }
}
// A handful of staff overrides, each with the reason the ledger requires.
const REASONS = ['Attended the make-up session in person.','Caught up one-to-one with the teacher.',
  'Listened on a family member\'s device; confirmed the content.','Excused for travel; reviewed the notes instead.'];
for (const a of assignments.slice(0, 14)) {
  done.push((b) => b.set(db.collection('completionOverrides').doc(`${a.studentUid}_${a.recordingId}`), {
    studentUid: a.studentUid, recordingId: a.recordingId, courseId: a.courseId,
    completed: true, reason: pick(REASONS), overriddenBy: 'demo-seed',
    at: now - Math.floor(rnd() * 30) * day, ...DEMO }));
}
await commitAll(done);

// Audit entries, so that screen is not empty either.
const audit = [];
for (const c of courses.slice(0, 6)) {
  for (const [action, detail] of [['createCourse', null], ['submitAttendance', null],
      ['setRecordingStatus', { status: 'published' }], ['createSession', null]]) {
    audit.push((b) => b.set(db.collection('auditLog').doc(sid('aud', c.key, action)), {
      at: now - Math.floor(rnd() * 45) * day, actorUid: 'demo-seed', actorRole: 'admin',
      action, courseId: c.courseId, targets: {}, ...(detail ? { detail } : {}), ...DEMO }));
  }
}
await commitAll(audit);

const counts = {};
for (const c of ['cohorts','courses','sessions','recordings','students','enrollments',
  'assignments','completions','listeningProgress','completionOverrides','auditLog']) {
  counts[c] = (await db.collection(c).count().get()).data().count;
}
console.log('\nDone. Production now holds:');
for (const [k, v] of Object.entries(counts)) console.log(`   ${String(v).padStart(5)}  ${k}`);
console.log(`\nDemo student sign-in:  ${students[0].email}  /  ${DEMO_STUDENT_PW}`);
console.log('Wipe it all again with:  node scripts/wipe-demo-prod.mjs');
process.exit(0);
