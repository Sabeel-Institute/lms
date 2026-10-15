/**
 * THE LAYOUT SWEEP'S WORLD.
 *
 * Split out of `screens-e2e.mjs`, which built it inline: three hundred lines of
 * fixture in front of the checks made both harder to read, and the sweep's own
 * rule is that a suite has to be legible enough to be trusted.
 *
 * It is NOT the only seed in the repo — `seed-guide.mjs` builds a different,
 * tidier world for the user-manual screenshots, deliberately, because a manual
 * wants a plausible institute and a sweep wants the longest name a real roster
 * would carry. Two seeds with two jobs is fine; two seeds with the same job is
 * what drifts.
 *
 * The content is chosen to BREAK layouts and to cover every state a screen can
 * be in — the longest name a real cohort would write, a roster longer than one
 * screen, an empty cohort, an archived one, a session whose attendance was
 * never taken, a draft, a recording that needs attention — not to look tidy.
 * Read the comments inside: most of them record a bug this shape once caught.
 *
 * Everything goes through the Admin SDK except staff accounts, which cannot be
 * minted that way (see `provisionStaff`).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { EMULATOR_PROJECT_ID as PROJECT } from './project.mjs';
import { putLocalObject } from './media-store.mjs';
import { VIDEO_FIXTURE, ensureVideoFixture } from './media-fixtures.mjs';
import {
  HELP_VARIANTS,
  INSTITUTE_TIMEZONE,
  deriveDurationSec,
  helpVideoKey,
  mediaFromSingleAudio,
  mediaStorageKey,
  todayInZone,
} from '@sabeel/shared';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const DAY = 86_400_000;
const now = Date.now();
/**
 * A date as the app reads it: the institute's calendar day, not UTC's. Sessions
 * were dated in UTC and assignments in the institute's zone, so after 7 pm in
 * Chicago — already tomorrow in UTC — every session moved a day later than the
 * assignments seeded beside it, and the student's "next up" changed hands on a
 * tie the world was built never to have.
 */
const iso = (ms) => todayInZone(INSTITUTE_TIMEZONE, ms);

/**
 * WAITING FOR THE PORT IS NOT WAITING FOR READINESS.
 *
 * `emulators:exec` starts this script once it believes the suite is up, and the
 * functions emulator in particular accepts connections before it has registered
 * anything — the trap docs/DEV-TOOLING.md records. The browser pays for that
 * gap, not this script: the first dev sign-in came back
 * `auth/network-request-failed`, the pending screen never arrived, and the run
 * died 60 seconds later pointing at a locator. So poll the two services this
 * suite actually drives until each answers for real.
 */
async function waitForEmulators() {
  /*
   * READ-ONLY probes, deliberately.
   *
   * The obvious readiness check for the functions emulator — call a known
   * function and wait for it to stop 404ing — cannot be used here: the only
   * unauthenticated one is `bootstrapAdmin`, and calling it PROMOTES THE FIRST
   * ADMIN. A readiness check with a side effect on the thing being tested is
   * not a readiness check. The functions emulator is covered instead by
   * `emulators:exec`, which does not run this script until every emulator has
   * started, and by `free-emulator-ports.sh` at the top of the runner, which is
   * what rules out the half-dead leftover the poll-a-callable rule exists for.
   */
  const probes = [
    ['auth', `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/config`],
    ['firestore', `http://${process.env.FIRESTORE_EMULATOR_HOST}/`],
  ];
  for (const [what, url] of probes) {
    let ok = false;
    for (let i = 0; i < 120 && !ok; i += 1) {
      ok = await fetch(url).then((r) => r.ok, () => false);
      if (!ok) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ok) throw new Error(`the ${what} emulator never became ready at ${url}`);
  }
}
/**
 * Start from nothing.
 *
 * Leftover emulator state silently SKIPS the paths that matter — a previous run
 * leaves an approved admin behind and the next one sails past the pending gate
 * while still reporting success. Safe because the caller's runner owns the
 * emulator for the length of its run; nothing else is looking at it.
 *
 * A STEP THE CALLER TAKES, not a module side effect. Importing this file used
 * to wipe the emulator, which is the kind of thing that is fine until something
 * imports it for a constant.
 */
export async function resetEmulators() {
  await waitForEmulators();
  for (const [what, url] of [
    ['firestore', `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`],
    ['auth', `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`],
  ]) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(`could not clear ${what}: ${r.status}`);
  }
}

/**
 * A real, decodable audio object — 8 kHz 8-bit mono PCM, generated here.
 *
 * GENERATED rather than committed (this repo never adds a binary) and WAV rather
 * than the M4A `web-e2e.mjs` makes with ffmpeg, because ffmpeg is not a
 * dependency of this suite and a CI runner that lacks it would fail on the
 * fixture rather than on a layout. It has to actually decode: the transport
 * renders disabled until the media reports a duration, and a sweep of disabled
 * controls is a photograph of a state no student ever sees.
 */
function wav(seconds) {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) {
    // A quiet tone rather than digital silence: some decoders shortcut a
    // constant stream, and then `durationSec` and the media disagree.
    buf[44 + i] = 128 + Math.round(20 * Math.sin((i / rate) * 2 * Math.PI * 220));
  }
  return buf;
}
const AUDIO_SECONDS = 120;
const AUDIO = wav(AUDIO_SECONDS);
/**
 * Only ever the VISIBLE match.
 *
 * React Navigation keeps the previous screen MOUNTED but hidden, so a locator
 * that does not say "visible" can resolve to a node on the screen underneath —
 * one that will never become clickable. Playwright then retries for its whole
 * timeout against an element that cannot change, and the run dies at a step with
 * nothing wrong with it, roughly one run in two.
 *
 * Two details make it worse than it sounds. `getByTestId` is a CSS attribute
 * selector, so unlike a ROLE selector it does not skip `display:none` subtrees
 * the way a screen reader does — which is why a testID present on both screens
 * is ambiguous rather than obviously wrong. And `.first()` / `.last()` do not
 * mean "the one on screen"; they mean document order, which is exactly the wrong
 * question. Found in the sibling time-tracker's flow suite, at clean HEAD.
 *
 * So every locator in this file goes through one of these three. There are no
 * bare `page.getBy*` calls, deliberately.
 */
const byId = (page, id) => page.getByTestId(id).filter({ visible: true }).first();
const byName = (page, name) =>
  page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
/** By LABEL, not by role: the header Back is a link on web (see `escapes`). */
const backButton = (page) =>
  page.getByLabel(/(^|,\s*)(go\s+)?back$/i).filter({ visible: true }).first();

async function tap(locator, timeout = 30_000) {
  await locator.waitFor({ timeout });
  await locator.click();
}

/**
 * Build the world. Returns the handles a suite needs to drive it: who to sign
 * in as, which ids to navigate to, and which sessions cover which state.
 */
export async function seedWorld({ db, auth, browser, base }) {
  /**
   * Mint a staff account THROUGH THE APP, then approve it out of band.
   *
   * Staff are Google identities and the Admin SDK cannot create one, so the dev
   * sign-in row is the only way to produce an account the domain gate would
   * accept. `onUserCreate` writes the pending `staffUsers` document; this waits
   * for it, then does what an admin's approval does — claims first, then the
   * mirror, in that order, because the token is what rules trust.
   */
  async function provisionStaff(testId, email, role) {
    const staffDoc = async () => {
      const snap = await db.collection('staffUsers').where('email', '==', email).get();
      return snap.empty ? '' : snap.docs[0].id;
    };

    /*
     * Waits for the DOCUMENT, not for the pending screen, and tries twice.
     *
     * The document is what this function is for, and it is the only unambiguous
     * evidence: the app shows "Setting up your account" and "Waiting for
     * approval" at different moments of the same successful path, so a wait on
     * one text is a race against which one is up. Twice because the first
     * sign-in of a run meets a backend that has only just come up — that came
     * back `auth/network-request-failed`, which the app REPORTS to the user
     * rather than throwing at the caller, so there is nothing to catch here,
     * only a screen that never changes.
     */
    let uid = '';
    for (let attempt = 1; attempt <= 2 && !uid; attempt += 1) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await tap(byId(page, testId), 60_000);
      for (let i = 0; i < 60 && !uid; i += 1) {
        uid = await staffDoc();
        if (!uid) await new Promise((r) => setTimeout(r, 500));
      }
      await ctx.close();
      if (!uid) console.log(`  ..  ${email} never provisioned; signing in again`);
    }
    if (!uid) throw new Error(`${email} was never provisioned by onUserCreate`);
    await auth.setCustomUserClaims(uid, { role, status: 'active' });
    await db.collection('staffUsers').doc(uid).update({ role, status: 'active', approvedAt: now });
    return uid;
  }

  const adminUid = await provisionStaff('dev-signin-first-admin', 'faisal.shah@oursabeel.com', 'admin');
  const managerUid = await provisionStaff('dev-signin-manager', 'manager@oursabeel.com', 'manager');

  /*
   * A PENDING staff account, written directly — there is no third dev sign-in to
   * make one, and both of those approve themselves the moment their document
   * appears.
   *
   * Without it the staff half of People photographs as "Nobody is waiting" at
   * all five widths, so the two-button "Approve as manager / Approve as admin"
   * row is measured at none of them — the exact paired shape whose own docblock
   * records a button crushed below its own label on a real phone.
   */
  await db.collection('staffUsers').doc('sw-pending').set({
    email: 'nadia.karim@oursabeel.com',
    displayName: 'Nadia Karim',
    role: null,
    status: 'pending',
    createdAt: now - 2 * DAY,
  });
  /**
   * A DISABLED staff account, so the staff list's closed "Disabled" section has
   * a card in it — the only card there whose action row reads Re-enable, and a
   * section that is otherwise never opened.
   *
   * WITH AN AUTH USER BEHIND IT, unlike the pending one above. `setStaffAccess`
   * writes the Auth record (`updateUser` + claims) before the document, so a
   * document with no Auth user makes Re-enable fail `auth/user-not-found` — a
   * shape production cannot produce, since every staff document there was
   * written by the trigger for a real sign-in. The 2026-09-11 device pass
   * pressed Re-enable against exactly that and learned nothing about the app.
   * Password-less and provider-less, which is the shape `onUserCreate` ignores,
   * so no pending document is written over this one.
   */
  await auth.createUser({
    uid: 'sw-disabled',
    email: 'yusuf.rahman@oursabeel.com',
    displayName: 'Yusuf Rahman',
    disabled: true,
  });
  await auth.setCustomUserClaims('sw-disabled', { role: 'manager', status: 'disabled' });
  await db.collection('staffUsers').doc('sw-disabled').set({
    email: 'yusuf.rahman@oursabeel.com',
    displayName: 'Yusuf Rahman',
    photoUrl: null,
    role: 'manager',
    status: 'disabled',
    createdAt: now - 60 * DAY,
    approvedAt: now - 59 * DAY,
  });
  // And a colleague whose account was deleted: a name, and nothing else.
  await db.collection('staffUsers').doc('sw-deleted').set({
    email: null,
    displayName: 'Bilqis Omar',
    photoUrl: null,
    role: 'manager',
    status: 'deleted',
    createdAt: now - 90 * DAY,
    approvedAt: now - 89 * DAY,
  });

  /**
   * A roster LONGER THAN ONE SCREEN, because the bug being looked for is what
   * happens at the bottom of a list, and eight rows all fit at every width.
   *
   * The first name is the longest one a real roster would carry — a full Arabic
   * name with a nisba — and its address is the longest with it. Rows in this app
   * pin the name beside its actions and forbid both from shrinking (`rowItem`,
   * `rowHeadPinned`), which is correct and is also precisely the shape that
   * carries a control off the right edge when the name is long enough.
   */
  const NAMES = [
    'Abd al-Rahman ibn Muhammad al-Shinqiti',
    'Fatima Ahmed',
    'Bilal Khan',
    'Omar Siddiqui',
    'Ayesha Rahman',
    'Yusuf Ali',
    'Maryam Iqbal',
    'Zainab Hassan',
    'Ibrahim Malik',
    'Khadija Noor',
    'Sumayya Patel',
    'Hamza Chaudhry',
    'Aminah Bello',
    'Idris Abubakar',
  ];
  const STUDENT_PASSWORD = 'HikamStudent1';
  const students = [];
  for (const [i, name] of NAMES.entries()) {
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    // The last one is DISABLED so the Students screen's collapsed "Disabled"
    // section has something in it — an empty collapsible documents nothing.
    const status = i === NAMES.length - 1 ? 'disabled' : 'active';
    /*
     * Created WITHOUT a password, then given one.
     *
     * Not a detail: `onUserCreate` reads the provider list to tell the two
     * populations apart, and a `password` provider AT CREATION means a
     * client-side sign-up, which it deletes. `createStudent` makes a
     * password-less account precisely so the student can set their own from the
     * emailed link — and a password-less Admin-SDK user has EMPTY provider data,
     * which is the shape the trigger ignores. Passing the password to
     * `createUser` had every student deleted moments after it was made, exactly
     * as it once did in production.
     */
    const u = await auth.createUser({ email, displayName: name });
    await new Promise((r) => setTimeout(r, 250));
    await auth.updateUser(u.uid, { password: STUDENT_PASSWORD, emailVerified: true });
    await auth.setCustomUserClaims(u.uid, { role: 'student', status });
    await db.collection('students').doc(u.uid).set({
      displayName: name,
      email,
      role: 'student',
      status,
      createdAt: now - 40 * DAY,
      createdBy: adminUid,
    });
    students.push({ uid: u.uid, name, email, status });
  }
  /** The student the student tour signs in as: on the long-named row, so their own
   *  screens carry the longest strings too. */
  const STUDENT = students[0];
  /** The one seeded as disabled — the only row inside the "Disabled" section. */
  const DISABLED_STUDENT = students[students.length - 1];
  /**
   * A DELETED account, as `deleteAccount` leaves one: the directory row with
   * its name and no address, and no Auth user behind it. The only row inside
   * the "Deleted" section, and the only page that has no address under its name.
   */
  const DELETED_STUDENT = { uid: 'sw-deleted-student', name: 'Yusra Haddad' };
  await db.collection('students').doc(DELETED_STUDENT.uid).set({
    displayName: DELETED_STUDENT.name,
    email: null,
    role: 'student',
    status: 'deleted',
    createdAt: now - 50 * DAY,
    createdBy: adminUid,
  });

  const COHORT = 'sw-autumn';
  const COURSE = 'sw-hikam';
  /** The longest course name the institute would really write, and it is not a
   *  stress test for its own sake: it is what a section-and-day title looks like. */
  const LONG_COURSE = 'sw-arabic';
  const LONG_COURSE_NAME = 'Arabic I & Qur’anic Morphology — Tuesday Evening Section';

  await db.collection('cohorts').doc(COHORT).set({
    name: 'Autumn 2026', archived: false, createdAt: now - 45 * DAY, createdBy: adminUid,
  });
  /** An EMPTY cohort. Reachable in ordinary use — a term is created before its
   *  courses are — and the only way to photograph the Courses screen's empty
   *  state, which no amount of seeded content will show. */
  await db.collection('cohorts').doc('sw-empty').set({
    name: 'Spring 2027 — Evening Intensive', archived: false, createdAt: now - 2 * DAY, createdBy: adminUid,
  });
  /** An ARCHIVED cohort, so the Cohorts screen's collapsed archive section has a
   *  row in it. */
  await db.collection('cohorts').doc('sw-past').set({
    name: 'Spring 2026', archived: true, createdAt: now - 220 * DAY, createdBy: adminUid,
  });

  const course = (id, cohortId, name, extra = {}) =>
    db.collection('courses').doc(id).set({
      cohortId,
      name,
      archived: false,
      effectiveActive: true,
      archivedAccess: false,
      managerUids: [],
      createdAt: now - 45 * DAY,
      createdBy: adminUid,
      ...extra,
    });
  // The manager is scoped to ONE course, which is the whole of their access —
  // cohort membership grants nothing. Their tour is the read of that. The
  // disabled one is still on it, as disabling leaves a manager on their
  // courses, so the course page's managers list draws its marked row.
  await course(COURSE, COHORT, 'Hikam Foundations', { managerUids: [managerUid, 'sw-disabled'] });
  await course(LONG_COURSE, COHORT, LONG_COURSE_NAME);
  await course('sw-past-course', 'sw-past', 'Seerah Survey', { effectiveActive: false });

  /*
   * The demo student's time in the class is the one their history tells
   * (below): removed 26 days ago and back 4 days later, so the workbook's
   * "out of the class" note and its register's dashes have a stretch to show.
   */
  for (const s of students) {
    await db.collection('enrollments').doc(`${s.uid}_${COURSE}`).set({
      studentUid: s.uid, courseId: COURSE, cohortId: COHORT, active: true,
      stretches: s === STUDENT
        ? [{ from: now - 40 * DAY, to: now - 26 * DAY }, { from: now - 22 * DAY, to: null }]
        : [{ from: now - 40 * DAY, to: null }],
      enrolledBy: adminUid,
    });
  }
  for (const s of students.slice(0, 4)) {
    await db.collection('enrollments').doc(`${s.uid}_${LONG_COURSE}`).set({
      studentUid: s.uid, courseId: LONG_COURSE, cohortId: COHORT,
      active: true, stretches: [{ from: now - 40 * DAY, to: null }], enrolledBy: adminUid,
    });
  }

  /**
   * One session, its recording, its attendance snapshot and the grants that fall
   * out of it — the same order the app builds them in.
   *
   * Being EXCUSED is the whole of a student's entitlement, so a seed that marked
   * everyone present would photograph every student screen empty. `present` and
   * `absent` are here because the ledger has a section for each.
   */
  async function seedSession(id, recId, title, opts) {
    const { courseId = COURSE, cohortId = COHORT, daysAgo, dueOffset, status = 'published', notes = '',
      roster = students, present = 0, absent = [], attention = null, media = null } = opts;
    const date = iso(now - daysAgo * DAY);
    // Never null: the due date is the day access closes, so a session cannot be
    // without one. A past one is planted directly, which no callable will do —
    // a deadline may only BECOME past by the passage of time.
    const dueDate = iso(now + dueOffset * DAY);
    /*
     * The demo student is ALWAYS excused, whoever else is present.
     *
     * Being excused is the whole of a student's entitlement, so the person the
     * student tour signs in as has to be excused everywhere or their home, their
     * class record and every ledger row about them are empty — and the sweep
     * would photograph a set of empty states and call it coverage. The first
     * version of this seed marked by position and put them present in all five
     * sessions, which is exactly what happened.
     */
    const attendance = opts.attendance === null ? null : Object.fromEntries(
      roster.map((s, i) => [
        s.uid,
        absent.includes(s.uid) ? 'absent'
          : s.uid === STUDENT.uid ? 'excused'
          : i <= present ? 'present'
          : 'excused',
      ]),
    );
    const submittedAt = attendance ? now - daysAgo * DAY : null;
    const hasAudio = status !== 'draft' && status !== 'needsAttention';
    const audioKey = recId ? mediaStorageKey(recId, 'audio1') : null;
    if (hasAudio && audioKey && !media) {
      await putLocalObject(audioKey, AUDIO, 'audio/wav');
    }
    // A recording of several files, given whole: each ready one's bytes go in
    // the bucket, as an import or upload would have left them.
    const items = media ? media(recId) : null;
    for (const item of Object.values(items ?? {})) {
      if (item.status === 'ready') await putLocalObject(item.storageKey, AUDIO, item.contentType);
    }

    await db.collection('sessions').doc(id).set({
      courseId, cohortId, date, title, dueDate, notes,
      recordingId: recId, attendance: attendance ?? {}, attendanceSubmittedAt: submittedAt,
      notRecorded: false, createdAt: now - daysAgo * DAY, createdBy: adminUid, updatedAt: now - daysAgo * DAY,
    });
    if (recId) {
      await db.collection('recordings').doc(recId).set({
        sessionId: id, courseId, cohortId, title, notes, date, status, source: 'manual',
        // One audio file, as Part 1, through the same transform the switchover
        // seed uses, so the fixture is a shape the app actually holds.
        media: items ?? mediaFromSingleAudio({
          source: 'manual',
          audioPath: hasAudio ? audioKey : null,
          sizeBytes: AUDIO.length,
          durationSec: AUDIO_SECONDS,
          contentType: 'audio/wav',
          createdAt: now - daysAgo * DAY,
          createdBy: adminUid,
        }, 'audio1'),
        defaultVersion: 'audio',
        durationSec: items ? deriveDurationSec(items) : hasAudio ? AUDIO_SECONDS : null,
        createdAt: now - daysAgo * DAY, createdBy: adminUid, updatedAt: now - daysAgo * DAY,
        ...(status === 'published' ? { publishedAt: now - daysAgo * DAY } : {}),
        ...(attention ? { attentionReason: attention } : {}),
      });
    }
    if (attendance) {
      for (const [uid, mark] of Object.entries(attendance)) {
        // A student cannot read a session, so their own mark is projected onto a
        // document of their own. Written here as well as by `onSessionWritten`,
        // which does fire against the seeded writes: the trigger converges on
        // the same value, and seeding it directly means the tour does not race
        // a background function on its first screen.
        await db.collection('attendanceRecords').doc(`${uid}_${id}`).set({
          studentUid: uid, sessionId: id, courseId, cohortId,
          date, title, status: mark, submittedAt,
        });
        if (mark === 'excused' && status === 'published') {
          await db.collection('assignments').doc(`${uid}_${recId}`).set({
            studentUid: uid, recordingId: recId, sessionId: id, courseId, cohortId,
            dueDate, active: true, assignedAt: submittedAt, assignedBy: 'system',
          });
        }
      }
    }
    return { id, recId, dueDate, title };
  }

  /**
   * Five sessions covering every bucket the student home groups by — missed, due
   * soon, upcoming, completed — because the home's layout is those four group
   * headings and a sweep that saw one of them saw a quarter of the screen.
   */
  const missed = await seedSession('sw-s1', 'sw-s1r',
    'Session 1 — Introduction to the Hikam of Ibn ʿAtaʾillah, and the Method of the Commentary',
    { daysAgo: 28, dueOffset: -9, present: 6, absent: [students[6].uid],
      notes: 'Read the first ten hikam before next week. The commentary we are using is the ' +
        'one by al-Shurnubi; a scan is in the shared folder, and the pages for this session ' +
        'are 1 through 24. Bring your questions about the second hikma in particular.' });
  const dueSoon = await seedSession('sw-s2', 'sw-s2r', 'Session 2 — Knowledge and Certainty',
    { daysAgo: 21, dueOffset: 3, present: 5 });
  // Not bound to anything: nothing navigates to it by name. It is here so the
  // student home has an "Upcoming" group at all — the four bucket headings ARE
  // that screen's layout, and a home missing one is a quarter untested.
  await seedSession('sw-s3', 'sw-s3r', 'Session 3 — Patience in Hardship',
    { daysAgo: 14, dueOffset: 20, present: 4 });
  const done = await seedSession('sw-s4', 'sw-s4r', 'Session 4 — Sincerity of Intention',
    { daysAgo: 9, dueOffset: 14, present: 3 });
  /** Published, attendance NOT taken: nobody is granted anything. The state the
   *  `attendanceMissing` notification exists for, and a real staff screen. */
  const blocking = await seedSession('sw-s5', 'sw-s5r', 'Session 5 — Reliance and Trust',
    { daysAgo: 4, dueOffset: 7, attendance: null });
  /** A session with NO RECORDING — the only route to the Zoom import screen,
   *  whose same-day filter is keyed on this date. */
  const PENDING_DATE = iso(now);
  await db.collection('sessions').doc('sw-s6').set({
    courseId: COURSE, cohortId: COHORT, date: PENDING_DATE, title: 'Session 6 — Today (recording pending)',
    dueDate: iso(now + 7 * DAY), notes: '', recordingId: null, attendance: {},
    attendanceSubmittedAt: null, notRecorded: false, createdAt: now, createdBy: adminUid, updatedAt: now,
  });
  /*
   * THE OTHER TWO KINDS OF WORK THE STAFF LANDING SCREEN GROUPS BY.
   *
   * Every session above ends up either "attendance not taken" or "closing soon",
   * so the queue's other two sections — a recording waiting to be published, and
   * attendance in with no audio — were measured and photographed at zero widths,
   * along with the `needsAttention` chip and the library's draft filter.
   * The docblock at the top of this file claimed both states; nothing produced
   * them.
   */
  await seedSession('sw-s7', 'sw-s7r', 'Session 7 — Gratitude and Contentment',
    { daysAgo: 6, dueOffset: 8, present: 4, status: 'draft' });
  /*
   * A ZOOM IMPORT OF SEVERAL FILES, the session page's media list in every
   * state it draws: a class recorded in two stretches, the first copied as
   * video and audio, the second's audio failed — and flagged by staff, which
   * is how a recording holding ready files comes to need attention.
   */
  const zoomItem = (recId, id, over) => ({
    id, part: 1, version: 'audio', kind: 'audio', label: null, status: 'ready', failReason: null,
    hidden: false, storageKey: mediaStorageKey(recId, id), contentType: 'audio/wav',
    sizeBytes: AUDIO.length, durationSec: AUDIO_SECONDS, width: null, height: null, source: 'zoom',
    zoom: { meetingUuid: 'sw-zoom', fileId: `${id}-file`, recordingType: 'audio_only',
      segmentStart: new Date(now - 5 * DAY).toISOString(), topic: 'Hikam Foundations' },
    addedAt: now - 5 * DAY, addedBy: adminUid, ...over,
  });
  await seedSession('sw-s8', 'sw-s8r', 'Session 8 — The Signs of Sincerity',
    { daysAgo: 5, dueOffset: 9, present: 4, status: 'needsAttention',
      attention: 'Audio file looks truncated — re-upload before publishing.',
      media: (recId) => ({
        p1v: zoomItem(recId, 'p1v', { version: 'speaker', kind: 'video', contentType: 'video/mp4' }),
        p1a: zoomItem(recId, 'p1a', {}),
        p2a: zoomItem(recId, 'p2a', {
          part: 2, status: 'failed', failReason: 'Zoom import failed: Zoom did not hand over a download link (HTTP 404).',
          zoom: { meetingUuid: 'sw-zoom', fileId: 'p2a-file', recordingType: 'audio_only',
            segmentStart: new Date(now - 5 * DAY + 70 * 60_000).toISOString(), topic: 'Hikam Foundations' },
        }),
      }) });
  /** Attendance in, no audio: the queue's "No recording yet". */
  await db.collection('sessions').doc('sw-s9').set({
    courseId: COURSE, cohortId: COHORT, date: iso(now - 2 * DAY),
    title: 'Session 9 — Fear and Hope', dueDate: iso(now + 12 * DAY), notes: '',
    recordingId: null,
    attendance: Object.fromEntries(students.map((s) => [s.uid, 'excused'])),
    attendanceSubmittedAt: now - 2 * DAY, notRecorded: false,
    createdAt: now - 2 * DAY, createdBy: adminUid, updatedAt: now - 2 * DAY,
  });
  await seedSession('sw-a1', 'sw-a1r', 'Lesson 1 — The Arabic Alphabet',
    { courseId: LONG_COURSE, daysAgo: 9, dueOffset: 5, roster: students.slice(0, 4), present: 2 });
  /**
   * An OPEN grant on a course archived with listening off — the fifth group on
   * the student home ("Archived"), and the ledger row that reads "Closed
   * (course archived)". The date is still ahead: what closes this one is the
   * class, not the calendar, which is the case nothing else in the world
   * produces. `sw-past-course` sits in the archived cohort with
   * `archivedAccess: false`, so `canPlayFromCourse` is false.
   */
  await db.collection('enrollments').doc(`${STUDENT.uid}_sw-past-course`).set({
    studentUid: STUDENT.uid, courseId: 'sw-past-course', cohortId: 'sw-past',
    active: true, stretches: [{ from: now - 200 * DAY, to: null }], enrolledBy: adminUid,
  });
  const archived = await seedSession('sw-p1', 'sw-p1r', 'Week 12 — The Farewell Pilgrimage',
    { courseId: 'sw-past-course', cohortId: 'sw-past', daysAgo: 12, dueOffset: 10, roster: [STUDENT] });

  /**
   * ASSIGNMENTS IN EVERY STATE the student's screens draw: due soon with a
   * draft saved, past due, handed in, returned with a grade, missed,
   * upcoming, not required, and one in the archived course. Every open one is
   * due AFTER the Session 2 recording, so the hero stays that recording and
   * the tour's anchor holds. Each goes to everyone in its course, as posting
   * does, so staff screens have a class's worth of work.
   */
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const day = (offset) => iso(now + offset * DAY);
  const file = async (key, id, name, contentType, body) => {
    await putLocalObject(key, body, contentType);
    return { id, name, contentType, sizeBytes: body.length, durationSec: null, storageKey: key, addedAt: now - 5 * DAY };
  };
  async function seedCoursework(id, title, { courseId = COURSE, cohortId = COHORT, dueOffset, lateOffset = null,
    grading = { kind: 'points', outOf: 10 }, instructions = '', files = {}, roster, mine = {} }) {
    await db.collection('coursework').doc(id).set({
      courseId, cohortId, title, instructions, files,
      dueDate: day(dueOffset), lateUntil: lateOffset === null ? null : day(lateOffset), grading,
      status: 'posted', closedAt: null, postedAt: now - 10 * DAY, postedBy: adminUid,
      createdAt: now - 11 * DAY, createdBy: adminUid, updatedAt: now - 10 * DAY, editedAt: null,
    });
    for (const st of roster) {
      await db.collection('submissions').doc(`${st.uid}_${id}`).set({
        studentUid: st.uid, courseworkId: id, courseId, cohortId, active: true,
        dueDate: day(dueOffset), lateUntil: lateOffset === null ? null : day(lateOffset), closedEarly: false,
        state: 'open', attempt: 1, handedInAt: null, note: '', files: {}, returned: null, attempts: [],
        notRequired: null, moreTime: null, assignedAt: now - 10 * DAY,
        ...(st.uid === STUDENT.uid ? mine : {}),
      });
    }
    return { id, title };
  }
  const longRoster = students.slice(0, 4);
  await seedCoursework('sw-cw1', 'Memorize the first hikma', {
    dueOffset: 4, lateOffset: 11, roster: students,
    instructions: 'Memorize the first hikma and record yourself reciting it.\n\nمِنْ عَلامَةِ الاعْتِمادِ عَلى العَمَلِ نُقْصانُ الرَّجاءِ عِنْدَ وُجودِ الزَّلَلِ\n\n- Recite slowly, with the vowels as written.\n- One take is fine. A quiet room helps.\n\nIn your answer, explain its meaning in **two or three sentences** of your own.',
    files: { f1: await file('coursework/sw-cw1/f1', 'f1', 'First hikma, vowelled.pdf', 'application/pdf', PDF) },
  });
  /** The recitation the assignment asks for, with its length read as the
   *  upload probe reads it: the attachment player, on the student's own work
   *  and on what a teacher grades, is toured at every width. */
  const recitation = async (uid) => ({
    ...(await file(`work/${uid}/sw-cw1/r1`, 'r1', 'Recitation.wav', 'audio/wav', AUDIO)),
    durationSec: AUDIO_SECONDS,
  });
  await db.collection('drafts').doc(`${STUDENT.uid}_sw-cw1`).set({
    studentUid: STUDENT.uid, courseworkId: 'sw-cw1', courseId: COURSE,
    note: 'It means that losing hope after a slip shows I was relying on my own deeds.',
    files: { r1: await recitation(STUDENT.uid) }, updatedAt: now - DAY,
  });
  /** Three classmates handed it in early, one already graded: the course's
   *  teachers then have work to grade on Today and in the assignment's page. */
  for (const [i, st] of students.slice(1, 4).entries()) {
    await db.collection('submissions').doc(`${st.uid}_sw-cw1`).update({
      state: 'handedIn', handedInAt: now - (i + 1) * DAY, note: 'Recited this morning, twice through without stopping.',
      files: { r1: await recitation(st.uid) },
    });
  }
  await db.collection('grades').doc(`${students[1].uid}_sw-cw1`).set({
    studentUid: students[1].uid, courseworkId: 'sw-cw1', courseId: COURSE, grade: { points: 8 },
    feedback: 'Clear and steady. Give the madd its full two counts.', gradedBy: adminUid, gradedAt: now - DAY, withoutHandIn: false,
  });
  await seedCoursework('sw-cw2', 'Letter forms, week 3', {
    courseId: LONG_COURSE, dueOffset: -3, lateOffset: 5, grading: { kind: 'scale' }, roster: longRoster,
    instructions: 'Write each letter in its four forms, in pencil, then photograph the page flat in good light.',
  });
  await seedCoursework('sw-cw3', 'Reflection on the first hikma', {
    dueOffset: -4, lateOffset: 3, roster: students,
    instructions: 'Write a short reflection, under 300 words, on the first hikma and one moment in your own week it describes.',
    mine: {
      state: 'returned', handedInAt: now - 6 * DAY,
      note: 'The first hikma says that when we slip, our hope should not collapse, because hope was never in our deeds.',
      returned: { grade: { points: 9 }, feedback: 'A thoughtful reflection, and your example from work is a good one. Next time, connect it to what the commentary says about hope and fear being two wings.', at: now - 2 * DAY, seq: 1, retry: false },
    },
  });
  const workPage = await file(`work/${STUDENT.uid}/sw-cw4/p1`, 'p1', 'Page 1.png', 'image/png', PNG);
  await seedCoursework('sw-cw4', 'Joining letters worksheet', {
    courseId: LONG_COURSE, dueOffset: 6, grading: { kind: 'scale' }, roster: longRoster,
    mine: { state: 'handedIn', handedInAt: now - DAY, note: 'Pages 1 and 2. I was not sure about the final kāf on line 4.', files: { p1: workPage } },
  });
  await seedCoursework('sw-cw5', 'Letter forms, week 1', {
    courseId: LONG_COURSE, dueOffset: -12, lateOffset: -5, grading: { kind: 'scale' }, roster: longRoster,
  });
  await seedCoursework('sw-cw6', 'Read pages 25–48 of the commentary', {
    dueOffset: 12, lateOffset: 19, grading: { kind: 'scale' }, roster: students,
  });
  await seedCoursework('sw-cw7', 'Map of the hijra route', {
    dueOffset: 8, roster: students,
    mine: { notRequired: { reason: 'Joined after the class visit it is based on.', by: adminUid, at: now - 3 * DAY } },
  });
  await seedCoursework('sw-cw8', 'Week 12 essay', {
    courseId: 'sw-past-course', cohortId: 'sw-past', dueOffset: 9, roster: [STUDENT],
  });

  /** The demo student completed one and part-listened two more, so both the
   *  ledger and their own home have every row type on them. */
  await db.collection('completions').doc(`${STUDENT.uid}_${done.recId}`).set({
    studentUid: STUDENT.uid, recordingId: done.recId, courseId: COURSE,
    completed: true, completedAt: now - 3 * DAY, updatedAt: now - 3 * DAY,
  });
  for (const [rid, frac] of [[done.recId, 1], [dueSoon.recId, 0.6], [missed.recId, 0.2]]) {
    const ms = Math.round(AUDIO_SECONDS * 1000 * frac);
    await db.collection('listeningProgress').doc(`${STUDENT.uid}_${rid}`).set({
      studentUid: STUDENT.uid, recordingId: rid, courseId: COURSE,
      listenedMs: ms, sittings: { seed: ms }, sitting: 'seed',
      updatedAt: now - 2 * DAY,
    });
  }
  /** Four more students complete, so the ledger's filters are not all one row. */
  for (const s of students.slice(1, 5)) {
    await db.collection('completions').doc(`${s.uid}_${dueSoon.recId}`).set({
      studentUid: s.uid, recordingId: dueSoon.recId, courseId: COURSE,
      completed: true, completedAt: now - DAY, updatedAt: now - DAY,
    });
  }
  /** An override already in place, so the ledger row that carries one — an extra
   *  line of raspberry text above the actions — is toured, not just the plain row. */
  await db.collection('completionOverrides').doc(`${students[5].uid}_${dueSoon.recId}`).set({
    studentUid: students[5].uid, recordingId: dueSoon.recId, courseId: COURSE, completed: true,
    reason: 'Listened on a borrowed phone; confirmed in person after class on the 14th.',
    overriddenBy: adminUid, at: now - DAY,
  });

  for (const [i, action] of ['createCourse', 'submitAttendance', 'createRecording',
    'setRecordingStatus', 'overrideCompletion', 'createStudent'].entries()) {
    await db.collection('auditLog').add({
      at: now - i * 3600_000, actorUid: adminUid, actorRole: 'admin', action,
      courseId: i % 2 ? COURSE : null,
      targets: { courseId: COURSE, recordingId: dueSoon.recId },
      detail: { note: 'Seeded so the audit list has rows at every width.' },
    });
  }
  /**
   * The demo student's own history — the rows their page reads out of the
   * audit log, one of each kind, so the History card is measured with every
   * sentence it can print rather than with "Account created" alone. The last
   * is the one the tours anchor on: a row is only there once the audit
   * listener has answered, which the card's frame cannot say.
   */
  const history = [
    ['createEnrollment', COURSE, {}],
    ['setEnrollmentActive', COURSE, { active: false }],
    ['setEnrollmentActive', COURSE, { active: true }],
    ['setStudentAccess', null, { status: 'disabled' }],
    ['setStudentAccess', null, { status: 'active' }],
    ['createEnrollment', LONG_COURSE, { reenrolled: true }],
  ];
  for (const [i, [action, courseId, detail]] of history.entries()) {
    await db.collection('auditLog').doc(`sw-history-${i}`).set({
      at: now - (30 - i * 4) * DAY, actorUid: i % 2 ? managerUid : adminUid,
      actorRole: i % 2 ? 'manager' : 'admin', action, courseId,
      targets: courseId ? { studentUid: STUDENT.uid, courseId } : { studentUid: STUDENT.uid },
      ...(Object.keys(detail).length ? { detail } : {}),
    });
  }
  /** The last row, for the admin's tour — and the last one INSIDE the
   *  manager's course for theirs, since a manager's read is pinned to the
   *  courses they run and the final row is in a course they do not. */
  const HISTORY_ROW = `sw-history-${history.length - 1}`;
  const HISTORY_ROW_MANAGED = `sw-history-${history.findLastIndex(([, courseId]) => courseId === COURSE)}`;

  // Stand-in help films, one for each population's tour, so the film screen
  // draws its picture rather than its not-ready notice — each with captions,
  // as every published film has.
  ensureVideoFixture();
  const film = readFileSync(VIDEO_FIXTURE);
  const captions = Buffer.from('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nA stand-in film.\n');
  for (const id of ['student-to-do', 'staff-today']) {
    for (const variant of HELP_VARIANTS) {
      await putLocalObject(helpVideoKey(id, variant, 'video'), film, 'video/mp4');
      await putLocalObject(helpVideoKey(id, variant, 'captions'), captions, 'text/vtt');
    }
  }

  // WHAT A TOUR NEEDS TO NAME A THING, and nothing else. Twelve handles were
  // returned and four were read; the rest were a standing invitation to reach
  // past the fixture's own vocabulary into its internals.
  return {
    STUDENT, DISABLED_STUDENT, DELETED_STUDENT, STUDENT_PASSWORD, missed, dueSoon, blocking, archived,
    HISTORY_ROW, HISTORY_ROW_MANAGED, PENDING_DATE,
    /** A classmate whose hand-in on "Memorize the first hikma" is still to grade. */
    TO_GRADE: students[2],
    /** The long-named course, and an active student not in it: a row its roster's picker offers. */
    LONG_COURSE_NAME,
    UNENROLLED: students[4],
  };
}

export { byId, byName, backButton, tap };
