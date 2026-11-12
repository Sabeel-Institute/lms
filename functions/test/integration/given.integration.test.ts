import { describe, it, beforeAll, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  addDays,
  enrollmentId,
  givenRecordingId,
  todayInZone,
  type AuditEntryDoc,
  type GivenRecordingDoc,
} from '@sabeel/shared';
import { applyGive, applyTakeBack, giveRecording, takeBackRecording, type GiveInput } from '../../src/given';
import { idTokenFor } from './emulatorToken';
import { eventually } from './eventually';
import { NO_MEDIA } from '../mediaFixtures';

/**
 * GIVING A RECORDING, driven through the callables' cores with `today` set,
 * and through the callables themselves for the audit trail and the scope.
 *
 * The promises, in a teacher's words: "I can give one recording to one student
 * in my class until a date that has not passed, once I have taken attendance;
 * I can move that date or take it back, whoever gave it; a colleague acting
 * at the same moment never silently undoes me, and I can always act again on
 * purpose; and nothing I do here makes it required or marks anyone".
 *
 * The Functions emulator runs here, so seeding a session or a recording fires
 * the attendance reconcile, which writes the excused students' grants a moment
 * later. The decisions read the session as well as the grant, so the tests do
 * not wait for it; every case uses its own ids, so no trigger from one case
 * lands in another.
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();
const TODAY = '2026-11-10';
const YESTERDAY = '2026-11-09';
const LATER = '2026-11-20';
const MGR = 'given-mgr';
const MGR2 = 'given-mgr2';
const OUTSIDE_MGR = 'given-mgr-elsewhere';
const PRESENT = 'given-present';
const EXCUSED = 'given-excused';

let n = 0;
interface World {
  courseId: string;
  sessionId: string;
  recordingId: string;
}

async function world(
  over: {
    attendance?: Record<string, string>;
    submitted?: boolean;
    dueDate?: string;
    status?: string;
    course?: { effectiveActive: boolean; archivedAccess: boolean };
    enrolled?: Record<string, boolean>;
    disabled?: string[];
  } = {},
): Promise<World> {
  n += 1;
  const courseId = `given-class-${n}`;
  const sessionId = `given-session-${n}`;
  const recordingId = `given-rec-${n}`;
  const d = db();
  const enrolled = over.enrolled ?? { [PRESENT]: true, [EXCUSED]: true };
  await Promise.all([
    d.collection(COLLECTIONS.courses).doc(courseId).set({
      cohortId: 'c1',
      name: 'Hikam',
      archived: false,
      effectiveActive: over.course?.effectiveActive ?? true,
      archivedAccess: over.course?.archivedAccess ?? false,
      managerUids: [MGR, MGR2],
      createdAt: 1,
      createdBy: MGR,
    }),
    d.collection(COLLECTIONS.sessions).doc(sessionId).set({
      courseId,
      cohortId: 'c1',
      date: '2026-11-03',
      title: `Session ${n}`,
      dueDate: over.dueDate ?? '2099-01-01',
      notes: '',
      recordingId,
      attendance: over.attendance ?? { [PRESENT]: 'present', [EXCUSED]: 'excused' },
      attendanceSubmittedAt: over.submitted === false ? null : 1,
      notRecorded: false,
      createdAt: 1,
      createdBy: MGR,
      updatedAt: 1,
    }),
    d.collection(COLLECTIONS.recordings).doc(recordingId).set({
      courseId,
      cohortId: 'c1',
      sessionId,
      title: `Session ${n}`,
      status: over.status ?? 'published',
      ...NO_MEDIA,
      source: 'manual',
      recordedAt: 1,
      notes: '',
      createdBy: MGR,
      createdAt: 1,
      updatedAt: 1,
    }),
    // Each student's account, active unless named disabled: a disabled
    // account is given nothing, as it is enrolled in nothing new.
    ...Object.keys(enrolled).map((uid) =>
      d.collection(COLLECTIONS.students).doc(uid).set({
        displayName: uid,
        email: `${uid}@example.com`,
        role: 'student',
        status: over.disabled?.includes(uid) ? 'disabled' : 'active',
        createdAt: 1,
        createdBy: MGR,
      }),
    ),
    ...Object.entries(enrolled).map(([uid, active]) =>
      d.collection(COLLECTIONS.enrollments).doc(enrollmentId(uid, courseId)).set({
        studentUid: uid,
        courseId,
        cohortId: 'c1',
        active,
        stretches: active ? [{ from: 1, to: null }] : [{ from: 1, to: 2 }],
        enrolledBy: MGR,
      }),
    ),
  ]);
  return { courseId, sessionId, recordingId };
}

const ask = (w: World, over: Partial<GiveInput> = {}): GiveInput => ({
  recordingId: w.recordingId,
  studentUid: PRESENT,
  openUntil: LATER,
  expect: null,
  ...over,
});
const stored = async (w: World, uid = PRESENT) =>
  (await db().collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(uid, w.recordingId)).get()).data() as
    | GivenRecordingDoc
    | undefined;
const seen = (g: GivenRecordingDoc | undefined) => ({ givenAt: g!.givenAt, openUntil: g!.openUntil });
/** The refusal a call throws: its code, its sentence and what it says is there now. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; current?: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code: string; message: string; details?: { current?: unknown } };
    // Read as a person reads it: a date's non-breaking hyphens as hyphens.
    return { code: err.code, message: err.message.replace(/\u2011/g, '-'), current: err.details?.current };
  }
  throw new Error('expected a refusal');
}

describe('giving', () => {
  it('opens a recording to a present student until the date, filed under its class', async () => {
    const w = await world();
    const before = Date.now();
    const r = await applyGive(MGR, ask(w), TODAY);
    expect(r).toMatchObject({ outcome: 'opened', courseId: w.courseId, openUntil: LATER, previousOpenUntil: null });
    const g = await stored(w);
    expect(g).toMatchObject({ studentUid: PRESENT, recordingId: w.recordingId, courseId: w.courseId, openUntil: LATER, givenBy: MGR });
    expect(Number.isSafeInteger(g!.givenAt) && g!.givenAt >= before).toBe(true);
  });

  it('gives to an absent student, one enrolled after the register, and an excused one whose date has passed', async () => {
    const late = 'given-late';
    const w = await world({
      attendance: { [PRESENT]: 'absent', [EXCUSED]: 'excused' },
      dueDate: '2020-01-01',
      enrolled: { [PRESENT]: true, [EXCUSED]: true, [late]: true },
    });
    expect((await applyGive(MGR, ask(w), TODAY)).outcome).toBe('opened');
    expect((await applyGive(MGR, ask(w, { studentUid: late }), TODAY)).outcome).toBe('opened');
    expect((await applyGive(MGR, ask(w, { studentUid: EXCUSED }), TODAY)).outcome).toBe('opened');
  });

  it('changes no attendance and requires nothing', async () => {
    const w = await world();
    const session = (await db().collection(COLLECTIONS.sessions).doc(w.sessionId).get()).data();
    await applyGive(MGR, ask(w), TODAY);
    expect((await db().collection(COLLECTIONS.sessions).doc(w.sessionId).get()).data()).toEqual(session);
    expect((await db().collection(COLLECTIONS.assignments).doc(`${PRESENT}_${w.recordingId}`).get()).exists).toBe(false);
  });

  it('takes today, and never a day that has gone, at the institute’s midnight', async () => {
    const w = await world();
    const at2359 = todayInZone(INSTITUTE_TIMEZONE, Date.parse('2026-11-10T23:59:00-06:00'));
    const at0000 = todayInZone(INSTITUTE_TIMEZONE, Date.parse('2026-11-11T00:00:00-06:00'));
    expect(at2359).toBe(TODAY);
    expect((await applyGive(MGR, ask(w, { openUntil: TODAY }), at2359)).outcome).toBe('opened');
    const w2 = await world();
    expect((await refusal(applyGive(MGR, ask(w2, { openUntil: TODAY }), at0000))).message).toBe(
      'That date has passed. Choose today or a later day.',
    );
  });

  it('refuses, in the sheet’s sentence, everything that stands in the way', async () => {
    const cases: Array<[Parameters<typeof world>[0], Partial<GiveInput>, string]> = [
      [{ submitted: false }, {}, 'Take attendance for this session first.'],
      [{ status: 'unpublished' }, {}, 'Only a published recording can be given.'],
      [{ course: { effectiveActive: false, archivedAccess: false } }, {}, 'This class is archived and its recordings are closed.'],
      [{ enrolled: { [PRESENT]: false } }, {}, 'That student is not in this class.'],
      [{ disabled: [PRESENT] }, {}, "That student's account is not active."],
      [{}, { openUntil: YESTERDAY }, 'That date has passed. Choose today or a later day.'],
      [{}, { studentUid: EXCUSED }, 'It is required for them until 2099-01-01. It can be given after that.'],
    ];
    for (const [shape, input, sentence] of cases) {
      const w = await world(shape);
      expect(await refusal(applyGive(MGR, ask(w, input), TODAY))).toMatchObject({ code: 'failed-precondition', message: sentence });
      expect(await stored(w, input.studentUid ?? PRESENT)).toBeUndefined();
    }
  });

  it('gives from an archived class that kept listening on', async () => {
    const w = await world({ course: { effectiveActive: false, archivedAccess: true } });
    expect((await applyGive(MGR, ask(w), TODAY)).outcome).toBe('opened');
  });
});

describe('changing the date', () => {
  it('moves an open one earlier or later, keeping when it was given', async () => {
    const w = await world();
    await applyGive(MGR, ask(w), TODAY);
    const first = await stored(w);
    const earlier = await applyGive(MGR, ask(w, { openUntil: TODAY, expect: seen(first) }), TODAY);
    expect(earlier).toMatchObject({ outcome: 'moved', previousOpenUntil: LATER, openUntil: TODAY });
    const moved = await stored(w);
    expect(moved).toMatchObject({ openUntil: TODAY, givenAt: first!.givenAt, givenBy: MGR });
    expect((await applyGive(MGR2, ask(w, { openUntil: '2027-01-01', expect: seen(moved) }), TODAY)).outcome).toBe('moved');
  });

  it('writes nothing when the date already stored is sent again, even long passed and from an out-of-date sheet', async () => {
    const w = await world();
    await applyGive(MGR, ask(w), TODAY);
    const ref = db().collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(PRESENT, w.recordingId));
    const at = (await ref.get()).updateTime;
    expect((await applyGive(MGR, ask(w, { expect: seen(await stored(w)) }), TODAY)).outcome).toBe('unchanged');
    expect((await applyGive(MGR2, ask(w, { expect: { givenAt: 1, openUntil: '2099-12-31' } }), TODAY)).outcome).toBe('unchanged');
    expect((await applyGive(MGR, ask(w, { expect: seen(await stored(w)) }), '2026-12-01')).outcome).toBe('unchanged');
    expect((await ref.get()).updateTime!.isEqual(at!)).toBe(true);
  });

  it('opens an ended one again with a new opening', async () => {
    const w = await world();
    await applyGive(MGR, ask(w, { openUntil: '2026-11-05' }), '2026-11-01');
    const ended = await stored(w);
    const r = await applyGive(MGR2, ask(w, { openUntil: LATER, expect: seen(ended) }), TODAY);
    expect(r).toMatchObject({ outcome: 'reopened', previousOpenUntil: '2026-11-05' });
    const again = await stored(w);
    expect(again!.givenAt).toBeGreaterThan(ended!.givenAt);
    expect(again!.givenBy).toBe(MGR2);
  });

  it('refuses opening an ended one again while required, and never refuses moving an open one then', async () => {
    // Given first, then excused: the record stands under the requirement.
    const w = await world({ attendance: { [PRESENT]: 'present', [EXCUSED]: 'present' } });
    await applyGive(MGR, ask(w, { studentUid: EXCUSED }), TODAY);
    await db().collection(COLLECTIONS.sessions).doc(w.sessionId).update({ [`attendance.${EXCUSED}`]: 'excused' });
    const open = await stored(w, EXCUSED);
    expect((await applyGive(MGR, ask(w, { studentUid: EXCUSED, openUntil: '2027-01-01', expect: seen(open) }), TODAY)).outcome).toBe('moved');

    const w2 = await world({ attendance: { [PRESENT]: 'present', [EXCUSED]: 'present' } });
    await applyGive(MGR, ask(w2, { studentUid: EXCUSED, openUntil: '2026-11-05' }), '2026-11-01');
    await db().collection(COLLECTIONS.sessions).doc(w2.sessionId).update({ [`attendance.${EXCUSED}`]: 'excused' });
    const ended = await stored(w2, EXCUSED);
    expect((await refusal(applyGive(MGR, ask(w2, { studentUid: EXCUSED, expect: seen(ended) }), TODAY))).message).toBe(
      'It is required for them until 2099-01-01. It can be given after that.',
    );
  });
});

describe('one sheet, several actions', () => {
  it('answers each give and move with the record as it now stands, so the same sheet can act again', async () => {
    // A sheet that kept what it saw when it opened refused its own next
    // action as "someone else changed the date". Each answer carries the
    // record, which the sheet adopts.
    const w = await world();
    const opened = await applyGive(MGR, ask(w), TODAY);
    expect(opened.current).toEqual(seen(await stored(w)));
    const moved = await applyGive(MGR, ask(w, { openUntil: '2026-12-01', expect: opened.current }), TODAY);
    expect(moved).toMatchObject({ outcome: 'moved', current: { givenAt: opened.current.givenAt, openUntil: '2026-12-01' } });
    const again = await applyGive(MGR, ask(w, { openUntil: '2026-12-08', expect: moved.current }), TODAY);
    expect(again.outcome).toBe('moved');
    expect((await applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: again.current })).outcome).toBe('taken');
  });

  it('answers a reopen with its new opening', async () => {
    const w = await world();
    await applyGive(MGR, ask(w, { openUntil: '2026-11-05' }), '2026-11-01');
    const reopened = await applyGive(MGR, ask(w, { expect: seen(await stored(w)) }), TODAY);
    expect(reopened.current).toEqual(seen(await stored(w)));
    expect((await applyGive(MGR, ask(w, { openUntil: '2026-12-01', expect: reopened.current }), TODAY)).outcome).toBe('moved');
  });
});

describe('two people at once', () => {
  it('refuses a move from a sheet a colleague changed underneath, and applies it when made again', async () => {
    const w = await world();
    await applyGive(MGR, ask(w), TODAY);
    const sheetB = seen(await stored(w));
    // A moves it first.
    await applyGive(MGR, ask(w, { openUntil: '2026-11-27', expect: sheetB }), TODAY);
    const refused = await refusal(applyGive(MGR2, ask(w, { openUntil: '2026-12-04', expect: sheetB }), TODAY));
    expect(refused).toMatchObject({
      code: 'failed-precondition',
      message: 'Someone else changed the date to 2026-11-27 just now. Save again to use yours.',
    });
    expect((await stored(w))!.openUntil).toBe('2026-11-27');
    // Again, with what the refusal said is there now: B's date applies.
    const again = await applyGive(MGR2, ask(w, { openUntil: '2026-12-04', expect: refused.current as GiveInput['expect'] }), TODAY);
    expect(again.outcome).toBe('moved');
    expect((await stored(w))!.openUntil).toBe('2026-12-04');
  });

  it('refuses a save on one taken back, and says so', async () => {
    const w = await world();
    await applyGive(MGR, ask(w), TODAY);
    const sheet = seen(await stored(w));
    await applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: sheet });
    expect(await refusal(applyGive(MGR2, ask(w, { openUntil: '2026-12-04', expect: sheet }), TODAY))).toMatchObject({
      message: 'Someone else took it back just now. Give it again with the plus if they still need it.',
      current: null,
    });
    expect(await stored(w)).toBeUndefined();
  });

  it('refuses a give from the list for a student a colleague just gave it to', async () => {
    const w = await world();
    const [a, b] = await Promise.allSettled([applyGive(MGR, ask(w), TODAY), applyGive(MGR2, ask(w, { openUntil: '2026-12-04' }), TODAY)]);
    const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.outcome : (r.reason as Error).message.replace(/\u2011/g, '-')));
    expect(outcomes.filter((o) => o === 'opened')).toHaveLength(1);
    expect(outcomes).toContain('It has already been given to them. Change it from their row.');
  });

  it('refuses a take back after a colleague moved the date, and takes it when asked again', async () => {
    const w = await world();
    await applyGive(MGR, ask(w), TODAY);
    const sheet = seen(await stored(w));
    await applyGive(MGR, ask(w, { openUntil: '2026-12-31', expect: sheet }), TODAY);
    const refused = await refusal(applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: sheet }));
    expect(refused.message).toBe('Someone else changed the date to 2026-12-31 just now. Take back again to take it back anyway.');
    expect(await stored(w)).toBeDefined();
    const r = await applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: refused.current as GiveInput['expect'] });
    expect(r.outcome).toBe('taken');
    expect(await stored(w)).toBeUndefined();
  });

  it('lets a take back of one already gone through, as done', async () => {
    const w = await world();
    expect((await applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: { givenAt: 5, openUntil: LATER } })).outcome).toBe('gone');
  });
});

describe('the callables', () => {
  const req = async (uid: string, data: unknown): Promise<CallableRequest> =>
    ({ auth: { uid, token: { role: 'manager', status: 'active' }, rawToken: await idTokenFor(uid) }, data }) as unknown as CallableRequest;
  const audits = async (action: string, recordingId: string) =>
    (await db().collection(COLLECTIONS.auditLog).where('action', '==', action).where('targets.recordingId', '==', recordingId).get()).docs.map(
      (d) => d.data() as AuditEntryDoc,
    );

  it('reads the day on the institute’s clock when it is not told one', async () => {
    // 7 PM in Chicago on the 10th is 1 AM on the 11th in UTC: a server that
    // took UTC's day refused "today" all evening while the sheet offered Save.
    const w = await world();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-10T19:00:00-06:00'));
      const r = await giveRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: TODAY, expect: null }));
      expect(r.outcome).toBe('opened');
    } finally {
      vi.useRealTimers();
    }
  });

  it('record giving, moving and taking back in the audit log, and nothing that changed nothing', async () => {
    const w = await world();
    const later = '2099-02-01';
    expect(await giveRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: later, expect: null }))).toMatchObject({ outcome: 'opened' });
    const sheet = seen(await stored(w));
    // A colleague, not the giver, moves it: scope is the class's.
    expect(
      await giveRecording.run(await req(MGR2, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-03-01', expect: sheet })),
    ).toMatchObject({ outcome: 'moved' });
    const moved = seen(await stored(w));
    expect(
      await giveRecording.run(await req(MGR2, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-03-01', expect: moved })),
    ).toMatchObject({ outcome: 'unchanged' });
    expect(await takeBackRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, expect: moved }))).toEqual({ outcome: 'taken' });
    expect(await takeBackRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, expect: moved }))).toEqual({ outcome: 'gone' });

    const gives = (await audits('giveRecording', w.recordingId)).sort((a, b) => a.at - b.at);
    expect(gives.map((a) => a.detail)).toEqual([
      { title: `Session ${n}`, outcome: 'opened', openUntil: later },
      { title: `Session ${n}`, outcome: 'moved', openUntil: '2099-03-01', previousOpenUntil: later },
    ]);
    expect(gives.every((a) => a.courseId === w.courseId && a.targets.studentUid === PRESENT)).toBe(true);
    const takes = await audits('takeBackRecording', w.recordingId);
    expect(takes.map((a) => a.detail)).toEqual([{ title: `Session ${n}`, openUntil: '2099-03-01' }]);
  });

  it('refuse a manager of another class, and a call that leaves out what its sheet saw', async () => {
    const w = await world();
    expect(
      await refusal(giveRecording.run(await req(OUTSIDE_MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-02-01', expect: null }))),
    ).toMatchObject({ code: 'permission-denied' });
    expect(
      await refusal(giveRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-02-01' }))),
    ).toMatchObject({ code: 'invalid-argument' });
    expect(
      await refusal(giveRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-02-30', expect: null }))),
    ).toMatchObject({ code: 'invalid-argument', message: 'Choose the last day it stays open.' });
    expect(
      await refusal(giveRecording.run(await req(MGR, { recordingId: `a/b`, studentUid: PRESENT, openUntil: '2099-02-01', expect: null }))),
    ).toMatchObject({ code: 'invalid-argument' });
    // A take back always comes from a row, so it always saw one: with none,
    // it would delete whatever a colleague had just given.
    await giveRecording.run(await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-02-01', expect: null }));
    expect(
      await refusal(takeBackRecording.run(await req(MGR2, { recordingId: w.recordingId, studentUid: PRESENT, expect: null }))),
    ).toMatchObject({ code: 'invalid-argument' });
    expect(await stored(w)).toBeDefined();
    await applyTakeBack({ recordingId: w.recordingId, studentUid: PRESENT, expect: seen(await stored(w)) });
    expect(await stored(w)).toBeUndefined();
  });

  it('answer a give with the record the sheet then holds', async () => {
    const w = await world();
    const res = (await giveRecording.run(
      await req(MGR, { recordingId: w.recordingId, studentUid: PRESENT, openUntil: '2099-02-01', expect: null }),
    )) as { outcome: string; current: unknown; toldToday: boolean };
    // No phone, so nothing was sent today: the line may promise a message.
    expect(res).toEqual({ outcome: 'opened', current: seen(await stored(w)), toldToday: false });
  });
});

/*
 * THE MESSAGE, AS THE DEPLOYED TRIGGER SENDS IT: the Functions emulator runs
 * `onGivenRecordingWritten` on every write here, on the real clock, with the
 * emulator's sender reporting each send delivered and claiming its marker.
 */
describe('the message trigger', () => {
  const PHONE = 'given-phone';
  const sent = () => db().collection(COLLECTIONS.notifications).doc(PHONE).collection('sent').get();
  // A phone, and the sign-in account behind it: the audience check asks the
  // account, and a student with none is told nothing.
  const phone = async () => {
    await getAuth()
      .getUser(PHONE)
      .catch(() => getAuth().createUser({ uid: PHONE, email: `${PHONE}@example.com` }));
    await db().collection(COLLECTIONS.notifications).doc(PHONE).collection('devices').doc(`tok-${PHONE}`).set({ token: `tok-${PHONE}`, platform: 'web', registeredAt: Date.now() });
  };
  /*
   * HOW LONG A SILENCE MEANS NOTHING WAS SENT, and it cannot mean more: a
   * move's message arriving after this would pass. Nothing the trigger does
   * on a move can be waited for instead, since doing nothing is the point;
   * the rule itself, that only an opening sends, is `opensIt`, held without
   * a clock in `test/unit/sweeps.test.ts`. A real send here takes about a
   * second (the test above waits for one).
   */
  const settle = () => new Promise((r) => setTimeout(r, 6000));

  it('sends one message for a recording given', async () => {
    const today = todayInZone(INSTITUTE_TIMEZONE);
    const w = await world({ attendance: { [PHONE]: 'present' }, enrolled: { [PHONE]: true } });
    await phone();
    await applyGive(MGR, ask(w, { studentUid: PHONE, openUntil: addDays(today, 7) }), today);
    const after = await eventually(sent, (q) => q.size > 0);
    expect(after.docs.map((d) => d.id)).toEqual([`recordingReady_${w.recordingId}_given_${today}`]);
  });

  it('says when the day’s message has already gone, so a give again the same day promises none', async () => {
    const today = todayInZone(INSTITUTE_TIMEZONE);
    const w = await world({ attendance: { [PHONE]: 'present' }, enrolled: { [PHONE]: true } });
    await db().recursiveDelete(db().collection(COLLECTIONS.notifications).doc(PHONE));
    await phone();
    const asMgr = async (data: unknown) =>
      ({ auth: { uid: MGR, token: { role: 'manager', status: 'active' }, rawToken: await idTokenFor(MGR) }, data }) as unknown as CallableRequest;
    const first = await giveRecording.run(await asMgr({ recordingId: w.recordingId, studentUid: PHONE, openUntil: addDays(today, 7), expect: null }));
    expect(first).toMatchObject({ outcome: 'opened', toldToday: false });
    await eventually(sent, (q) => q.size > 0);
    await takeBackRecording.run(await asMgr({ recordingId: w.recordingId, studentUid: PHONE, expect: first.current }));
    const again = await giveRecording.run(await asMgr({ recordingId: w.recordingId, studentUid: PHONE, openUntil: addDays(today, 9), expect: null }));
    expect(again).toMatchObject({ outcome: 'opened', toldToday: true });
  });

  it('sends nothing when the date moves, even to a phone registered since the opening', async () => {
    // No phone at the opening, so no marker was claimed then: only the
    // trigger's opening edge stands between the move and a message.
    const today = todayInZone(INSTITUTE_TIMEZONE);
    const w = await world({ attendance: { [PHONE]: 'present' }, enrolled: { [PHONE]: true } });
    await db().recursiveDelete(db().collection(COLLECTIONS.notifications).doc(PHONE));
    await applyGive(MGR, ask(w, { studentUid: PHONE, openUntil: addDays(today, 7) }), today);
    await settle();
    await phone();
    await applyGive(MGR, ask(w, { studentUid: PHONE, openUntil: addDays(today, 9), expect: seen(await stored(w, PHONE)) }), today);
    await settle();
    expect((await sent()).size).toBe(0);
  });
});
