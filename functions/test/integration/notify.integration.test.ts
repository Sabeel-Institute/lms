import { describe, it, beforeAll, beforeEach, afterEach, expect } from 'vitest';
import { withAudio } from '../mediaFixtures';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  assignmentId,
  type AssignmentDoc,
  type CourseDoc,
  type PushMessage,
  type RecordingDoc,
  type SessionDoc,
  type StaffUserDoc,
  type StudentDoc,
} from '@sabeel/shared';
import { getAuth } from 'firebase-admin/auth';
import { setSender, resetSender, type SendOutcome } from '../../src/messaging';
import { notifyAttendanceMissing, notifyLastDay, notifyRecordingReady } from '../../src/notifyJobs';
import { applyStudentAccess } from '../../src/students';
import { applyStaffAccess } from '../../src/staff';
import { eventually } from './eventually';

/**
 * Everything about notifications EXCEPT delivery.
 *
 * There is no FCM emulator — none exists — so the send is stubbed and what is
 * asserted is who would have been messaged, with what, and how many times. That
 * is the whole of the logic; the transport is one function in `messaging.ts` and
 * only a real device can prove it.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const ADMIN = 'admin-uid';
const COURSE = 'c-notify';
const COHORT = 'coh-notify';

/** Every message the stubbed sender was asked to deliver, in order. */
let outbox: { tokens: string[]; message: PushMessage }[] = [];
let staleTokens: string[] = [];

/*
 * NEW SESSION AND RECORDING IDS EACH TEST.
 *
 * `recursiveDelete` clears this file's recordings and sessions, and each
 * deletion fires `onRecordingWritten` / `onSessionWritten`, which reconcile
 * against a document that is now gone and deactivate every assignment on it.
 * The Functions emulator delivers those on its own schedule, so one could land
 * after the next test had re-seeded `assignments/s1_r1` with `active: true` —
 * and the `lastDay` cases then find nothing to notify about. Same shape as the
 * flakes already fixed in three sibling files; production never reuses an id
 * either. The test bodies keep saying `'r1'` and `'sess1'`; the helpers
 * namespace.
 */
let testRun = 0;
const ns = (id: string) => `${id}-run${testRun}`;

beforeEach(async () => {
  testRun += 1;
  outbox = [];
  staleTokens = [];
  setSender(async (tokens, message): Promise<SendOutcome> => {
    outbox.push({ tokens, message });
    return { stale: staleTokens, sent: tokens.length - staleTokens.length };
  });

  // recursiveDelete, not a get-and-delete loop: a person who has devices but has
  // never opened the settings screen has NO `notifications/{uid}` document, so
  // listing the collection does not return them and their subcollections
  // survive into the next test. That leftover made the `sent` marker look
  // already-claimed and every send silently return false.
  for (const c of [
    COLLECTIONS.notifications,
    COLLECTIONS.sessions,
    COLLECTIONS.recordings,
    COLLECTIONS.assignments,
    COLLECTIONS.completions,
    COLLECTIONS.courses,
    COLLECTIONS.students,
    COLLECTIONS.staffUsers,
  ]) {
    await db().recursiveDelete(db().collection(c));
  }
  // And the accounts: one disabled here stays disabled into the next test.
  const { users } = await getAuth().listUsers();
  await getAuth().deleteUsers(users.map((u) => u.uid));

  const course: CourseDoc = {
    cohortId: COHORT,
    name: 'Hikam Foundations',
    archived: false,
    effectiveActive: true,
    archivedAccess: false,
    recordingsClosed: [],
    managerUids: ['mgr1'],
    createdAt: 1,
    createdBy: ADMIN,
  };
  await db().collection(COLLECTIONS.courses).doc(COURSE).set(course);
});

afterEach(() => {
  resetSender();
});

/*
 * A fresh `registeredAt` per call, like the app's own `registerThisDevice`.
 *
 * A `set` whose content is byte-identical to what is already there does not
 * reach the trigger, so a fixture that re-registered with a fixed timestamp was
 * testing a write the app never makes — and made a re-registration look like
 * something the sweep ignores.
 */
let registrationClock = 1;

async function withDevice(uid: string, token = `tok-${uid}`, registeredAt = (registrationClock += 1)) {
  // A device belongs to an account, as every one in production does; the
  // sender asks the account whether it is disabled.
  await getAuth()
    .getUser(uid)
    .catch(() => getAuth().createUser({ uid, email: `${uid}@example.com` }));
  await db()
    .collection(COLLECTIONS.notifications)
    .doc(uid)
    .collection('devices')
    .doc(token)
    .set({ token, platform: 'web', registeredAt });
}

async function seedRecording(id: string, sessionId: string, status: RecordingDoc['status']) {
  const rec: RecordingDoc = {
    sessionId: ns(sessionId),
    courseId: COURSE,
    cohortId: COHORT,
    title: 'Session 3 — Patience',
    notes: '',
    date: '2026-08-10',
    status,
    source: 'manual',
    ...withAudio(ns(id), { durationSec: 720 }),
    createdAt: 1,
    createdBy: ADMIN,
    updatedAt: 1,
  };
  await db().collection(COLLECTIONS.recordings).doc(ns(id)).set(rec);
}

/** The morning these grants are looked at: before their 2026-08-20 due date. */
const TODAY = '2026-08-12';

function grant(studentUid: string, recordingId: string, dueDate = '2026-08-20'): AssignmentDoc {
  return {
    studentUid,
    recordingId: ns(recordingId),
    sessionId: ns('sess1'),
    courseId: COURSE,
    cohortId: COHORT,
    dueDate,
    active: true,
    assignedAt: 1,
    assignedBy: 'system',
  };
}

/*
 * The grant as STORED, which is what `notifyRecordingReady` reads — the event
 * payload it is handed only says which one to look at.
 *
 * Writing it fires the real `onAssignmentWritten` in the Functions emulator,
 * whose sender claims the "sent" marker as if it had delivered. That trigger
 * reads the wall clock, and every due date in this file is behind it, so it
 * refuses on "past its date" before it can claim anything; the calls below
 * inject `TODAY` and see the grant open. If a fixture date is ever moved past
 * the real today, the emulator's own trigger races the test for the marker
 * and the sends here flake.
 */
async function seedGrant(studentUid: string, recordingId: string, dueDate?: string, active = true) {
  const doc = { ...grant(studentUid, recordingId, dueDate), active };
  await db()
    .collection(COLLECTIONS.assignments)
    .doc(assignmentId(studentUid, doc.recordingId))
    .set(doc);
  return doc;
}

/*
 * An account that can be DISABLED: the directory row `applyStudentAccess` /
 * `applyStaffAccess` look up, and the Auth user they switch off. With an email
 * and no password, the shape `onUserCreate` leaves alone.
 */
async function seedStudentAccount(uid: string) {
  const email = `${uid}@example.com`;
  const doc: StudentDoc = {
    displayName: uid,
    email,
    role: 'student',
    status: 'active',
    createdAt: 1,
    createdBy: ADMIN,
  };
  await db().collection(COLLECTIONS.students).doc(uid).set(doc);
  await getAuth()
    .deleteUser(uid)
    .catch(() => undefined);
  await getAuth().createUser({ uid, email });
}

async function seedStaffAccount(uid: string) {
  const email = `${uid}@oursabeel.com`;
  const doc: StaffUserDoc = {
    displayName: uid,
    email,
    photoUrl: null,
    role: 'manager',
    status: 'active',
    createdAt: 1,
  };
  await db().collection(COLLECTIONS.staffUsers).doc(uid).set(doc);
  await getAuth()
    .deleteUser(uid)
    .catch(() => undefined);
  await getAuth().createUser({ uid, email });
}

async function seedSession(id: string, fields: Partial<SessionDoc>) {
  const s: SessionDoc = {
    courseId: COURSE,
    cohortId: COHORT,
    date: '2026-08-10',
    title: 'Session 3 — Patience',
    dueDate: '2026-08-20',
    notes: '',
    recordingId: null,
    attendance: {},
    attendanceSubmittedAt: null,
    notRecorded: false,
    createdAt: 1,
    createdBy: ADMIN,
    updatedAt: 1,
    ...fields,
  };
  await db().collection(COLLECTIONS.sessions).doc(ns(id)).set(s);
}

describe('recordingReady', () => {
  it('says nothing for a course that is archived with listening off', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db().collection(COLLECTIONS.courses).doc(COURSE).update({ effectiveActive: false, archivedAccess: false, recordingsClosed: [{ from: Date.now(), to: null }] });
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it('says nothing once the listen-by date has gone', async () => {
    // A grant turning active after its date is one the reconcile should never
    // have revived; announcing it would tell a student to listen by last month.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1', '2026-08-11'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
    // The due day itself is still on time.
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1', TODAY), TODAY)).toBe(true);
  });

  it('tells the excused student, naming the class and the deadline', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].tokens).toEqual(['tok-s1']);
    expect(outbox[0].message.title).toContain('Hikam Foundations');
    expect(outbox[0].message.body).toContain('2026-08-20');
  });

  it('sends ONCE however many times the reconcile runs', async () => {
    // Every attendance correction rewrites every grant on the session, so this
    // is the normal case, not an edge one.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(1);
  });

  it('says nothing about a recording that is not published', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'draft');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it('respects the switch being off', async () => {
    await withDevice('s1');
    await db().collection(COLLECTIONS.notifications).doc('s1').set({ recordingReady: false });
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  /*
   * THE SWITCH IS PER MESSAGE, and the test above cannot say so.
   *
   * The promise on the settings screen is three independent switches — the
   * screen renders one row per kind and the manual describes them one at a
   * time. `prefEnabled(prefs, kind)` reading the wrong key, or ignoring `kind`
   * altogether (`prefs?.recordingReady !== false`), satisfies every assertion
   * above: the one switch that IS tested is the one such a version would read.
   * A student who turned off "A recording is ready" would then be silenced on
   * every message in the product, and nobody would learn it from this file.
   *
   * So each kind is proved twice over: its own switch stops it, and somebody
   * else's switch does not. The second half is the one that discriminates.
   */
  it('is not silenced by a DIFFERENT switch being off', async () => {
    await withDevice('s1');
    await db().collection(COLLECTIONS.notifications).doc('s1').set({ lastDay: false });
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
    expect(outbox).toHaveLength(1);
  });

  it('notifies someone who has never opened the settings screen', async () => {
    // A missing preferences document means ON. The other way round, nobody would
    // ever be notified until they visited a screen for turning it off.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
  });

  it('does not spend the one delivery on a student with no device yet', async () => {
    // The marker is the whole of "once", so claiming it for someone unreachable
    // would mean they are never told about this recording — registering a device
    // an hour later would find the notification already marked as sent.
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    const claimed = await db()
      .collection(COLLECTIONS.notifications)
      .doc('s1')
      .collection('sent')
      .get();
    expect(claimed.empty).toBe(true);

    await withDevice('s1');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
    expect(outbox).toHaveLength(1);
  });

  it('prunes a token the transport rejects, and keeps the rest', async () => {
    await withDevice('s1', 'tok-dead');
    await withDevice('s1', 'tok-live');
    staleTokens = ['tok-dead'];
    await seedRecording('r1', 'sess1', 'published');
    await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY);
    const left = await db()
      .collection(COLLECTIONS.notifications)
      .doc('s1')
      .collection('devices')
      .get();
    expect(left.docs.map((d) => d.id)).toEqual(['tok-live']);
  });

  /*
   * THE ONE DELIVERY IS NOT SPENT ON A FAILURE. The marker is claimed before
   * the send, so a transport that then failed left it standing: the student
   * was recorded as told and never was. What is asserted is the promise — a
   * later attempt, with the transport back, delivers — not the marker.
   */
  it('tries again after the transport failed, and delivers once it is back', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    let calls = 0;
    setSender(async (tokens, message): Promise<SendOutcome> => {
      calls += 1;
      if (calls === 1) throw new Error('FCM unreachable');
      if (calls === 2) return { stale: [], sent: 0 }; // reached, refused every token for a transient reason
      outbox.push({ tokens, message });
      return { stale: [], sent: tokens.length };
    });
    await expect(notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).rejects.toThrow(/unreachable/);
    await expect(notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).rejects.toThrow(/none of 1/);
    expect(outbox).toHaveLength(0);
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(true);
    expect(outbox).toHaveLength(1);
    // And now it has been delivered, it stays delivered.
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(1);
  });

  it('keeps the claim when every device is dead — there is nowhere left to deliver', async () => {
    await withDevice('s1', 'tok-dead');
    staleTokens = ['tok-dead'];
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
    // A device registered afterwards is not told about a recording whose
    // delivery already ran against a dead token: the marker stands, as after
    // a real delivery. (Registering a device an hour later is the case the
    // no-device branch protects; this one had a device, and it was gone.)
    staleTokens = [];
    await withDevice('s1', 'tok-new');
    expect(await notifyRecordingReady(db(), await seedGrant('s1', 'r1'), TODAY)).toBe(false);
  });

  /*
   * THE EVENT IS A HINT; THE DOCUMENT IS THE FACT.
   *
   * The trigger is retried, and a retry is handed the payload of the ORIGINAL
   * event — hours old by then, and still saying `active: true`. In between, the
   * grant may have been closed: the register corrected from excused to present,
   * the recording unpublished, the student unenrolled. A send that trusted the
   * payload told a student "ready to listen" about audio `getPlaybackUrl` had
   * already begun refusing. What is asserted is the send, not a flag.
   */
  it('says nothing when the grant has been closed since the event fired', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    const stalePayload = await seedGrant('s1', 'r1');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .update({ active: false });
    expect(await notifyRecordingReady(db(), stalePayload, TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it('names the deadline as it stands now, not as the event had it', async () => {
    // Staff moved the listen-by date after the grant appeared and before the
    // retry ran; the reconcile rewrote the stored grant, the event payload
    // still carries the old date.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    const stalePayload = await seedGrant('s1', 'r1', '2026-08-20');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .update({ dueDate: '2026-08-27' });
    expect(await notifyRecordingReady(db(), stalePayload, TODAY)).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].message.body).toContain('2026-08-27');
    expect(outbox[0].message.body).not.toContain('2026-08-20');
  });

  it('says nothing about a grant that no longer exists at all', async () => {
    // Nothing in the app deletes a grant, but a retry of a fixture's delete
    // event is exactly the shape a stale payload takes; the document is what
    // decides.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyRecordingReady(db(), grant('s1', 'r1'), TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  /*
   * DISABLING SWITCHES OFF ACCESS, and a push is access. The account is shut
   * out of Auth and every callable refuses it — but the device registrations
   * it left behind are still valid tokens, and a sweep that found them kept
   * sending "last day to listen" for audio the person could no longer open, to
   * a phone that is no longer theirs to act on. The registration goes with the
   * session: they cannot stay signed in, and signing in again re-registers the
   * device, so an account re-enabled loses nothing.
   */
  it('says nothing to a student whose account has been disabled', async () => {
    await seedStudentAccount('s1');
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    const edge = await seedGrant('s1', 'r1');
    await applyStudentAccess({ uid: 's1', status: 'disabled' });
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it('says nothing to a disabled student whose phone has registered itself again', async () => {
    await seedStudentAccount('s1');
    await seedRecording('r1', 'sess1', 'published');
    const edge = await seedGrant('s1', 'r1');
    await applyStudentAccess({ uid: 's1', status: 'disabled' });
    // The token the phone still holds registers it again, for up to an hour.
    await withDevice('s1');
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });
});

/*
 * BEFORE SWITCHOVER, ONLY TESTERS HEAR ANYTHING.
 *
 * The institute's project holds a copy of every real account while the live
 * app still notifies them, so a real student must hear nothing from this one
 * until the audience opens — and must not have the one delivery a notification
 * gets used up while they are outside it.
 */
describe('the notify audience', () => {
  const saved = process.env.NOTIFY_AUDIENCE;
  afterEach(() => {
    process.env.NOTIFY_AUDIENCE = saved;
  });

  async function readyFor(uid: string) {
    await seedStudentAccount(uid);
    await getAuth().setCustomUserClaims(uid, { role: 'student', status: 'active' });
    await withDevice(uid);
    await seedRecording('r1', 'sess1', 'published');
    return seedGrant(uid, 'r1');
  }

  it('tells staff and not students when the audience is staff', async () => {
    process.env.NOTIFY_AUDIENCE = 'staff';
    await seedStaffAccount('mgr1');
    await getAuth().setCustomUserClaims('mgr1', { role: 'manager', status: 'active' });
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), '2026-08-20')).toBe(1);

    expect(await notifyRecordingReady(db(), await readyFor('s1'), TODAY)).toBe(false);
    expect(outbox.map((o) => o.tokens)).toEqual([['tok-mgr1']]);
  });

  it('tells a test student named alongside staff', async () => {
    process.env.NOTIFY_AUDIENCE = 'staff,s1@example.com';
    expect(await notifyRecordingReady(db(), await readyFor('s1'), TODAY)).toBe(true);
    expect(outbox.map((o) => o.tokens)).toEqual([['tok-s1']]);
  });

  it('tells a tester on the list', async () => {
    process.env.NOTIFY_AUDIENCE = 'someone@oursabeel.com, S1@Example.com';
    expect(await notifyRecordingReady(db(), await readyFor('s1'), TODAY)).toBe(true);
    expect(outbox.map((o) => o.tokens)).toEqual([['tok-s1']]);
  });

  it('tells a student who is not on it nothing, and keeps the delivery for later', async () => {
    process.env.NOTIFY_AUDIENCE = 'someone@oursabeel.com';
    const edge = await readyFor('s1');
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);

    // Switchover day: the same notification now reaches them.
    process.env.NOTIFY_AUDIENCE = 'everyone';
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(true);
    expect(outbox.map((o) => o.tokens)).toEqual([['tok-s1']]);
  });

  it('tells nobody when the list is empty or missing', async () => {
    const edge = await readyFor('s1');
    process.env.NOTIFY_AUDIENCE = '';
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(false);
    delete process.env.NOTIFY_AUDIENCE;
    expect(await notifyRecordingReady(db(), edge, TODAY)).toBe(false);
    expect(outbox).toHaveLength(0);
  });

  it('refuses a list that is not email addresses, rather than guess', async () => {
    const edge = await readyFor('s1');
    for (const value of ['Everyone', 's1', 'staff,everyone']) {
      process.env.NOTIFY_AUDIENCE = value;
      await expect(notifyRecordingReady(db(), edge, TODAY)).rejects.toThrow(/NOTIFY_AUDIENCE/);
    }
    expect(outbox).toHaveLength(0);
  });

  it('holds back the morning reminders too, and only for those outside it', async () => {
    process.env.NOTIFY_AUDIENCE = 's2@example.com';
    for (const uid of ['s1', 's2']) {
      await seedStudentAccount(uid);
      await withDevice(uid);
      await seedGrant(uid, 'r1', TODAY);
    }
    await seedRecording('r1', 'sess1', 'published');
    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    expect(outbox.map((o) => o.tokens)).toEqual([['tok-s2']]);
  });
});

describe('lastDay', () => {
  const TODAY = '2026-08-20';

  it('reminds only the people whose deadline is TODAY', async () => {
    await withDevice('s1');
    await withDevice('s2');
    await seedRecording('r1', 'sess1', 'published');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s2', ns('r1')))
      .set(grant('s2', 'r1', '2026-08-25'));

    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].tokens).toEqual(['tok-s1']);
  });

  it('says nothing to someone who has already finished it', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    await db()
      .collection(COLLECTIONS.completions)
      .doc(assignmentId('s1', ns('r1')))
      .set({
        studentUid: 's1',
        recordingId: ns('r1'),
        courseId: COURSE,
        completed: true,
        completedAt: 1,
        updatedAt: 1,
      });
    expect(await notifyLastDay(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
  });

  it('stops for the student who turned THIS reminder off, and not for another switch', async () => {
    await withDevice('s1');
    await withDevice('s2');
    await seedRecording('r1', 'sess1', 'published');
    for (const uid of ['s1', 's2']) {
      await db()
        .collection(COLLECTIONS.assignments)
        .doc(assignmentId(uid, ns('r1')))
        .set(grant(uid, 'r1', TODAY));
    }
    // s1 turned off the last-day reminder; s2 turned off a different one.
    await db().collection(COLLECTIONS.notifications).doc('s1').set({ lastDay: false });
    await db().collection(COLLECTIONS.notifications).doc('s2').set({ recordingReady: false });

    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].tokens).toEqual(['tok-s2']);
  });

  /*
   * NOBODY IS REMINDED ABOUT SOMETHING THEY CANNOT OPEN.
   *
   * Both filters guard the same promise from opposite sides — a grant that was
   * withdrawn (unenrolled, or corrected from excused to present) and a recording
   * that is not published. Either one removed sends a push saying "last day to
   * listen" for audio `getPlaybackUrl` will refuse, which reads as the app
   * losing something the student was told they had.
   */
  it('says nothing about a grant that has been withdrawn', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set({ ...grant('s1', 'r1', TODAY), active: false });
    expect(await notifyLastDay(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
  });

  it('says nothing about a recording that is not published', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'draft');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    expect(await notifyLastDay(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
  });

  /*
   * WHAT IT SAYS, not just that it was sent. Every other assertion here counts
   * recipients, so the whole block passes with `recordingReadyMessage` in this
   * job's place — which would tell a student on the closing morning that the
   * recording "is yours to listen to until" today, an invitation rather than a
   * deadline, in the one message that exists to be a deadline.
   */
  it('says the recording CLOSES, and names the class and the day', async () => {
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    expect(outbox[0].message).toEqual({
      title: 'Hikam Foundations: a recording closes today',
      body: `Session 3 — Patience closes at the end of ${TODAY}.`,
      // The tap opens the recording, not the home screen.
      path: `play/${ns('r1')}`,
    });
  });

  it('runs a second morning without repeating itself', async () => {
    // The sweep fires every day regardless of whether yesterday's finished.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    expect(await notifyLastDay(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(1);
  });

  it('reminds again when staff move the deadline — a new last day is a new reminder', async () => {
    // Moving the listen-by date forward is the documented way to reopen a
    // closed session. Keyed on the recording alone, the marker spent on the
    // first date silenced the second one.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    const ref = db().collection(COLLECTIONS.assignments).doc(assignmentId('s1', ns('r1')));
    await ref.set(grant('s1', 'r1', TODAY));
    expect(await notifyLastDay(db(), TODAY)).toBe(1);
    await ref.update({ dueDate: '2026-09-01' });
    expect(await notifyLastDay(db(), '2026-09-01')).toBe(1);
    expect(await notifyLastDay(db(), '2026-09-01')).toBe(0);
    expect(outbox).toHaveLength(2);
  });

  it('says nothing for a course that is archived with listening off', async () => {
    // The audio is refused there (`class-listening-off`), so the reminder would
    // point at a locked door. Mirrors the attendanceMissing case below.
    await withDevice('s1');
    await seedRecording('r1', 'sess1', 'published');
    await db().collection(COLLECTIONS.courses).doc(COURSE).update({ effectiveActive: false, archivedAccess: false, recordingsClosed: [{ from: Date.now(), to: null }] });
    await db()
      .collection(COLLECTIONS.assignments)
      .doc(assignmentId('s1', ns('r1')))
      .set(grant('s1', 'r1', TODAY));
    expect(await notifyLastDay(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
    // With archived access ON the recording still plays, so the reminder goes.
    await db().collection(COLLECTIONS.courses).doc(COURSE).update({ archivedAccess: true });
    expect(await notifyLastDay(db(), TODAY)).toBe(1);
  });
});

describe('attendanceMissing', () => {
  const TODAY = '2026-08-20';

  it('tells the course managers about a meeting nobody marked', async () => {
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(1);
    expect(outbox[0].tokens).toEqual(['tok-mgr1']);
    expect(outbox[0].message.body).toContain('2026-08-10');
  });

  it('leaves a teacher alone for the first couple of days', async () => {
    // Attendance taken the next morning is normal, not a lapse.
    await withDevice('mgr1');
    await seedSession('sess1', { date: TODAY, attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
  });

  it('says nothing once attendance has been submitted', async () => {
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: 1 });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
  });

  it('says nothing about a course that has finished', async () => {
    await withDevice('mgr1');
    await db().collection(COLLECTIONS.courses).doc(COURSE).update({ effectiveActive: false, recordingsClosed: [{ from: Date.now(), to: null }] });
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
  });

  it('does not nag every morning about the same session', async () => {
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(1);
    expect(await notifyAttendanceMissing(db(), '2026-08-21')).toBe(0);
  });

  /*
   * THE GRACE PERIOD, AT ITS EDGES.
   *
   * "Leaves a teacher alone for the first couple of days" is asserted at zero
   * days and the notification at ten — a gap wide enough to hide any value of
   * `graceDays` between 1 and 10. Both directions past the boundary are real
   * failures with a person on the end of them: shortened, a teacher is nagged
   * the morning after class about a register they were always going to take;
   * lengthened, a class sits locked out of a published recording for the best
   * part of a week with nothing said. The default is 2, so the last silent day
   * is one day back and the first spoken one is two.
   */
  it('is still silent one day after the meeting, and speaks on the second', async () => {
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-19', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
    await seedSession('sess2', { date: '2026-08-18', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(1);
  });

  /*
   * A CLASS SOMEBODY SAID WAS NOT RECORDED. The whole reason this message exists
   * is that an un-taken register locks a class out of a published recording —
   * so where there is no recording, chasing the register every morning for the
   * rest of the term is noise with nothing behind it.
   */
  it('leaves a session marked as not recorded alone', async () => {
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null, notRecorded: true });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
    // …and the same session, unmarked, is chased — so the silence is the flag's
    // doing and not the fixture's.
    await seedSession('sess2', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(1);
  });

  /*
   * THE STAFF SWITCH, and the same discriminator as the two student blocks: a
   * manager who turned a DIFFERENT message off still gets this one. Without the
   * second half, `prefEnabled` ignoring its `kind` argument passes here too.
   */
  it('stops for the manager who turned it off', async () => {
    await withDevice('mgr1');
    await db().collection(COLLECTIONS.notifications).doc('mgr1').set({ attendanceMissing: false });
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
  });

  it('is not silenced by a DIFFERENT switch being off', async () => {
    await withDevice('mgr1');
    await db().collection(COLLECTIONS.notifications).doc('mgr1').set({ lastDay: false });
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(1);
    expect(outbox[0].tokens).toEqual(['tok-mgr1']);
  });

  it('says nothing to a manager whose account has been disabled', async () => {
    // The same promise as the student case: the registrations go with the
    // account, so a disabled manager is not chased about a class they can no
    // longer open.
    await seedStaffAccount('mgr1');
    await withDevice('mgr1');
    await seedSession('sess1', { date: '2026-08-10', attendanceSubmittedAt: null });
    await applyStaffAccess(ADMIN, { uid: 'mgr1', status: 'disabled' });
    expect(await notifyAttendanceMissing(db(), TODAY)).toBe(0);
    expect(outbox).toHaveLength(0);
  });
});

/**
 * A device belongs to one account at a time.
 *
 * The trigger is what actually enforces it, so this drives the emulator's real
 * trigger rather than a function call: sign-out's own unregister is bounded (it
 * must be, or the button hangs offline and somebody stays signed in on a shared
 * device), and a delete that was never acknowledged before the credential
 * dropped is never sent. The registration left behind is a perfectly valid
 * token, so `notifyOnce`'s stale-token pruning never touches it — the previous
 * student's "a recording is ready" arrives on the phone the next student is
 * holding.
 */
describe('a token registered to a new account leaves the old one', () => {
  const TOKEN = 'shared-device-token';
  const devices = (uid: string) =>
    db().collection(COLLECTIONS.notifications).doc(uid).collection('devices');

  /** The trigger runs out of band; wait for it rather than guessing a delay. */
  async function settled(uid: string, present: boolean) {
    const exists = await eventually(async () => (await devices(uid).doc(TOKEN).get()).exists, (e) => e === present);
    if (exists !== present) throw new Error(`devices/${TOKEN} under ${uid} never became ${present ? 'present' : 'absent'}`);
  }

  it('removes the same token from every other account', async () => {
    await withDevice('student-a', TOKEN);
    await settled('student-a', true);

    await withDevice('student-b', TOKEN);
    await settled('student-a', false);
    // And the account that just registered keeps it.
    expect((await devices('student-b').doc(TOKEN).get()).exists).toBe(true);
  });

  /*
   * TRIGGER DELIVERY IS NOT ORDERED, and a trigger that treats its own document
   * as the winner has each invocation delete the other's row — leaving the
   * device registered to NOBODY, which is worse than the leak it exists to
   * close. Both writes here land before either invocation can run, so the
   * claim is about convergence, not about which account wins.
   */
  it('converges on exactly one registration however the triggers interleave', async () => {
    await Promise.all([
      withDevice('student-a', TOKEN),
      withDevice('student-b', TOKEN),
    ]);
    const survivors = async () =>
      (
        await Promise.all(
          ['student-a', 'student-b'].map((uid) => devices(uid).doc(TOKEN).get()),
        )
      ).filter((d) => d.exists).length;

    await eventually(survivors, (n) => n <= 1);
    // Settle, then confirm it stayed at one rather than passing through it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await survivors()).toBe(1);
  });

  /*
   * NOTE ON WHAT IS NOT TESTED HERE.
   *
   * The trigger is `onDocumentWritten` rather than `onDocumentCreated`, so a
   * re-registration re-runs the sweep. That matters only for a duplicate the
   * sweep FAILED to clear — one invocation dying on a still-building index, say
   * — because while the sweep is working every registration finds the other row
   * already gone and is therefore a create. There is no way to stage that state
   * from a test: any row written here fires the sweep and is cleaned up.
   *
   * So the recovery path is asserted at the declaration instead, in
   * `functions/test/unit/deviceSweep.test.ts`. Writing a behavioural test that
   * passes under `onDocumentCreated` too would be worse than none.
   */

  it('leaves an unrelated device alone', async () => {
    await withDevice('student-a', 'a-different-phone');
    await withDevice('student-b', TOKEN);
    await settled('student-b', true);
    expect((await devices('student-a').doc('a-different-phone').get()).exists).toBe(true);
  });

  it('does not remove the registration it was fired for', async () => {
    // Re-registering under the SAME account — every sign-in does this — must not
    // race the trigger into deleting the row it just wrote.
    await withDevice('student-a', TOKEN);
    await settled('student-a', true);
    await withDevice('student-a', TOKEN);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await devices('student-a').doc(TOKEN).get()).exists).toBe(true);
  });
});
