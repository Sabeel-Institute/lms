import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  assignmentId,
  enrollmentId,
  giveAction,
  givenChanged,
  giveRefusal,
  givenRecordingId,
  isCalendarDate,
  todayInZone,
  type AssignmentDoc,
  type CourseDoc,
  type EnrollmentDoc,
  type GivenExpectation,
  type GivenRecordingDoc,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { recordingCourseId, requireCourseScope, requireStaff } from './guards';

/**
 * GIVING A RECORDING TO ONE STUDENT: staff open one class recording to one
 * enrolled student until a date, optional and counted nowhere
 * (`GivenRecordingDoc`, `docs/plans/GIVE-A-RECORDING.md`).
 *
 * Two callables. `giveRecording` gives, moves the date of an open one, or
 * opens an ended one again; `takeBackRecording` deletes it. Any admin or
 * manager of the class may do either, whoever gave it. The decisions are the
 * shared ones the sheet shows (`giveRefusal`, `givenChanged`), read here in
 * one transaction with everything they depend on, so the sheet and the server
 * cannot disagree and a register submitted a second ago is seen.
 */

export interface GiveInput {
  recordingId: string;
  studentUid: string;
  openUntil: string;
  expect: GivenExpectation;
}

export interface TakeBackInput {
  recordingId: string;
  studentUid: string;
  expect: GivenExpectation;
}

export type GiveOutcome = 'opened' | 'moved' | 'reopened' | 'unchanged';

/** A document id the caller names: built into paths, so bounded and slash-free. */
function docId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) {
    throw new HttpsError('invalid-argument', `${name} is required.`);
  }
  return value;
}

/**
 * What the caller's sheet showed when it opened: `null` from the give list, or
 * the record as it stood. REQUIRED, never defaulted: a call that left it out
 * would be one that cannot be told from a colleague's stale screen.
 */
function expectation(value: unknown): GivenExpectation {
  if (value === null) return null;
  const v = value as { givenAt?: unknown; openUntil?: unknown } | undefined;
  if (
    typeof v !== 'object' ||
    !Number.isSafeInteger(v.givenAt) ||
    (v.givenAt as number) <= 0 ||
    typeof v.openUntil !== 'string' ||
    !isCalendarDate(v.openUntil)
  ) {
    throw new HttpsError('invalid-argument', 'expect is required: null, or the record as the sheet showed it.');
  }
  return { givenAt: v.givenAt as number, openUntil: v.openUntil };
}

function validateGive(data: unknown): GiveInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const recordingId = docId(d.recordingId, 'recordingId');
  const studentUid = docId(d.studentUid, 'studentUid');
  if (typeof d.openUntil !== 'string' || !isCalendarDate(d.openUntil)) {
    throw new HttpsError('invalid-argument', 'Choose the last day it stays open.');
  }
  if (!('expect' in d)) throw new HttpsError('invalid-argument', 'expect is required: null, or the record as the sheet showed it.');
  return { recordingId, studentUid, openUntil: d.openUntil, expect: expectation(d.expect) };
}

function validateTakeBack(data: unknown): TakeBackInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const recordingId = docId(d.recordingId, 'recordingId');
  const studentUid = docId(d.studentUid, 'studentUid');
  if (!('expect' in d)) throw new HttpsError('invalid-argument', 'expect is required: null, or the record as the sheet showed it.');
  return { recordingId, studentUid, expect: expectation(d.expect) };
}

/**
 * Out of date: the sentence says what changed, and `details.current` is the
 * record as it now stands, which becomes what the caller's sheet saw, so
 * acting again does what they typed on purpose.
 */
function stale(sentence: string, current: GivenRecordingDoc | null): HttpsError {
  return new HttpsError('failed-precondition', sentence, {
    current: current ? { givenAt: current.givenAt, openUntil: current.openUntil } : null,
  });
}

/**
 * Give, move or reopen, in one transaction with every fact the decision
 * reads: the recording, its class, its session's register, the student's
 * enrolment and grant, and the record itself.
 *
 * `today` is a parameter, as in `sessions.ts`, so the date rules can be driven
 * at the institute's midnight without faking the clock.
 */
export async function applyGive(
  callerUid: string,
  input: GiveInput,
  today: string = todayInZone(INSTITUTE_TIMEZONE),
): Promise<{ outcome: GiveOutcome; title: string; courseId: string; openUntil: string; previousOpenUntil: string | null }> {
  const db = getFirestore();
  const { recordingId, studentUid, openUntil, expect } = input;
  return db.runTransaction(async (tx) => {
    const recSnap = await tx.get(db.collection(COLLECTIONS.recordings).doc(recordingId));
    if (!recSnap.exists) throw new HttpsError('not-found', 'No such recording.');
    const recording = recSnap.data() as RecordingDoc;
    const givenRef = db.collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(studentUid, recordingId));
    const [clsSnap, sessionSnap, enrolSnap, grantSnap, givenSnap] = await tx.getAll(
      db.collection(COLLECTIONS.courses).doc(recording.courseId),
      db.collection(COLLECTIONS.sessions).doc(recording.sessionId),
      db.collection(COLLECTIONS.enrollments).doc(enrollmentId(studentUid, recording.courseId)),
      db.collection(COLLECTIONS.assignments).doc(assignmentId(studentUid, recordingId)),
      givenRef,
    );
    if (!clsSnap.exists) throw new HttpsError('not-found', 'No such class.');
    if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
    const current = givenSnap.exists ? (givenSnap.data() as GivenRecordingDoc) : null;
    const result = { title: recording.title, courseId: recording.courseId, openUntil, previousOpenUntil: current?.openUntil ?? null };

    // The date already stored, sent again — a second tap, or a colleague who
    // saved the same date a moment before — changes nothing, so nothing is
    // refused, written or logged. Before the staleness check, or two people
    // agreeing would be told one of them was out of date.
    if (current && current.openUntil === openUntil) return { ...result, outcome: 'unchanged' as const };

    const changed = givenChanged(expect, current, 'save');
    if (changed) throw stale(changed, current);

    const enrolment = enrolSnap.data() as EnrollmentDoc | undefined;
    const refusal = giveRefusal({
      studentUid,
      openUntil,
      today,
      session: sessionSnap.data() as SessionDoc,
      recordingStatus: recording.status,
      cls: clsSnap.data() as CourseDoc,
      enrolled: !!enrolment?.active,
      grant: grantSnap.exists ? (grantSnap.data() as AssignmentDoc) : null,
      given: current,
      fromPlus: expect === null,
    });
    if (refusal) throw new HttpsError('failed-precondition', refusal);

    const action = giveAction(current, today);
    if (action === 'move' && current) {
      // A move keeps `givenAt`: the message trigger sends on an opening only.
      tx.update(givenRef, { openUntil });
      return { ...result, outcome: 'moved' as const };
    }
    const doc: GivenRecordingDoc = {
      studentUid,
      recordingId,
      courseId: recording.courseId,
      openUntil,
      givenAt: Date.now(),
      givenBy: callerUid,
    };
    tx.set(givenRef, doc);
    return { ...result, outcome: action === 'reopen' ? ('reopened' as const) : ('opened' as const) };
  });
}

/**
 * Take it back: the record goes, and the recording closes to the student at
 * once. In any state, and silent. One already gone is simply done; one a
 * colleague changed since the sheet opened is refused, so a take back never
 * undoes a date someone else just gave.
 */
export async function applyTakeBack(
  input: TakeBackInput,
): Promise<{ outcome: 'taken' | 'gone'; title: string; courseId: string; openUntil: string | null }> {
  const db = getFirestore();
  const { recordingId, studentUid, expect } = input;
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(studentUid, recordingId));
    const [recSnap, givenSnap] = await tx.getAll(db.collection(COLLECTIONS.recordings).doc(recordingId), ref);
    if (!recSnap.exists) throw new HttpsError('not-found', 'No such recording.');
    const recording = recSnap.data() as RecordingDoc;
    const result = { title: recording.title, courseId: recording.courseId };
    if (!givenSnap.exists) return { ...result, outcome: 'gone' as const, openUntil: null };
    const current = givenSnap.data() as GivenRecordingDoc;
    const changed = givenChanged(expect, current, 'takeBack');
    if (changed) throw stale(changed, current);
    tx.delete(ref);
    return { ...result, outcome: 'taken' as const, openUntil: current.openUntil };
  });
}

export const giveRecording = auditedCall('giveRecording', async (req, audit) => {
  requireStaff(req);
  const input = validateGive(req.data);
  const courseId = await recordingCourseId(input.recordingId);
  const uid = await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  const r = await applyGive(uid, input);
  audit.detail = { title: r.title, outcome: r.outcome, openUntil: r.openUntil, previousOpenUntil: r.previousOpenUntil };
  audit.noop = r.outcome === 'unchanged';
  return { outcome: r.outcome };
});

export const takeBackRecording = auditedCall('takeBackRecording', async (req, audit) => {
  requireStaff(req);
  const input = validateTakeBack(req.data);
  const courseId = await recordingCourseId(input.recordingId);
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  const r = await applyTakeBack(input);
  audit.detail = { title: r.title, openUntil: r.openUntil };
  audit.noop = r.outcome === 'gone';
  return { outcome: r.outcome };
});
