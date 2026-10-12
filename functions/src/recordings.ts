import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { reportedCall } from './reported';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  audioStoragePath,
  canTransition,
  isDiscardable,
  publishBlockers,
  todayInZone,
  type RecordingDoc,
  type RecordingSource,
  type RecordingStatus,
  type SessionDoc,
} from '@sabeel/shared';
import { requireAdmin, requireCourseScope } from './guards';
import { MEDIA_WRITE_SECRETS, deleteObject, head, signPut } from './mediaStore';

/** Max upload size. A 2-hour 128 kbps M4A is ~115 MB; 300 MB leaves room
 *  without letting a video file through by accident. */
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024;

/** How long an upload URL lasts: long enough for a slow connection to send
 *  300 MB, short enough that a leaked one is soon useless. */
const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------- create --

export interface CreateRecordingInput {
  sessionId: string;
}

export function validateCreateRecording(data: unknown): CreateRecordingInput {
  const d = data as Partial<CreateRecordingInput> | null;
  if (typeof d?.sessionId !== 'string' || !d.sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
  return { sessionId: d.sessionId };
}

/**
 * Create the draft recording for a session, BEFORE any audio exists.
 *
 * This ordering is what makes the upload safe: course scope is checked here,
 * server-side, and the client is handed an id it may then write audio to. The
 * meeting metadata (title/date/due/notes) lives on the session; the recording is
 * pure media. Refuses a session that already has a recording (0..1), and links
 * both directions (recording.sessionId + session.recordingId).
 */
export async function createRecordingDraft(
  callerUid: string,
  input: CreateRecordingInput,
  // Zoom import reuses this exact path but stamps its source + dedupe refs.
  origin: { source?: RecordingSource; zoomUuid?: string; zoomFileId?: string } = {},
) {
  const db = getFirestore();
  const sessionRef = db.collection(COLLECTIONS.sessions).doc(input.sessionId);
  /*
   * ONE SESSION, ONE RECORDING — held by a transaction, not by the read above
   * the write. Two calls in the same window (a double tap on Upload, a Zoom
   * import racing a manual one) both read "no recording yet", both created a
   * draft, and the session pointed at whichever link landed last: the other
   * draft sat orphaned in the library, publishable, never cascaded by a
   * session delete, and its fan-out reconciled the session's OTHER recording.
   */
  const ref = db.collection(COLLECTIONS.recordings).doc();
  await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
    const session = sessionSnap.data() as SessionDoc;
    // A pointer to a recording that no longer exists is no recording: a
    // delete that cleared the document but not the pointer wedged the session
    // behind this refusal. Read inside the transaction, so a recording being
    // created for this session at the same moment is still seen.
    if (
      session.recordingId &&
      (await tx.get(db.collection(COLLECTIONS.recordings).doc(session.recordingId))).exists
    ) {
      throw new HttpsError('failed-precondition', 'This session already has a recording.');
    }
    // "This class was not recorded" and a recording cannot both be true: the
    // flag takes the session off the work queue and out of the morning
    // "attendance still not taken" message, so a draft under it would sit
    // where neither reader looks. The session page says as much — putting
    // audio here is un-marking it — and `updateSession` refuses the flag on a
    // session with a recording, so the two never disagree in a stored document.
    if (session.notRecorded) {
      throw new HttpsError(
        'failed-precondition',
        'This session is marked as not recorded. Un-mark it first.',
      );
    }
    const doc: RecordingDoc = {
      sessionId: input.sessionId,
      courseId: session.courseId,
      cohortId: session.cohortId,
      title: session.title,
      notes: session.notes,
      date: session.date,
      status: 'draft',
      source: origin.source ?? 'manual',
      audioPath: null,
      durationSec: null,
      sizeBytes: null,
      createdAt: Date.now(),
      createdBy: callerUid,
      updatedAt: Date.now(),
      ...(origin.zoomUuid ? { zoomUuid: origin.zoomUuid } : {}),
      ...(origin.zoomFileId ? { zoomFileId: origin.zoomFileId } : {}),
    };
    tx.set(ref, doc);
    tx.update(sessionRef, { recordingId: ref.id, updatedAt: Date.now() });
  });
  return { id: ref.id, audioPath: audioStoragePath(ref.id) };
}

export const createRecording = auditedCall('createRecording', async (req, audit) => {
  const input = validateCreateRecording(req.data);
  const db = getFirestore();
  const sessionSnap = await db.collection(COLLECTIONS.sessions).doc(input.sessionId).get();
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
  const courseId = (sessionSnap.data() as SessionDoc).courseId;
  const uid = await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  audit.targets = { sessionId: input.sessionId };
  return createRecordingDraft(uid, input);
});

// ---------------------------------------------------------------- upload --

export interface StartUploadInput {
  recordingId: string;
  contentType: string;
  sizeBytes: number;
}

export function validateStartUpload(data: unknown): StartUploadInput {
  const d = data as Partial<StartUploadInput> | null;
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  if (typeof d.contentType !== 'string' || !/^audio\/[a-z0-9.+-]+$/.test(d.contentType)) {
    throw new HttpsError('invalid-argument', 'Only audio files can be uploaded.');
  }
  if (typeof d.sizeBytes !== 'number' || !Number.isInteger(d.sizeBytes) || d.sizeBytes <= 0) {
    throw new HttpsError('invalid-argument', 'sizeBytes must be a positive whole number.');
  }
  if (d.sizeBytes > MAX_AUDIO_BYTES) {
    throw new HttpsError('invalid-argument', 'That audio file is too large (300 MB at most).');
  }
  return { recordingId: d.recordingId, contentType: d.contentType, sizeBytes: d.sizeBytes };
}

/**
 * Hand the client a URL it may PUT this recording's audio to, once.
 *
 * The bytes go straight from the browser or phone to the bucket, never through
 * a Function: a two-hour recording would meet the 60-minute timeout, and the
 * bytes would be paid for twice. So everything the bucket cannot check is
 * checked here, before a URL exists: course scope, a recording that is still a
 * draft with no audio, an audio content type, a declared size under the cap.
 * The URL itself signs the content type and `If-None-Match: *`, so it creates
 * the object once or not at all (`mediaStore.signPut`); the real size is
 * checked by `finalizeRecording` once the bytes have landed.
 */
export async function startUpload(input: StartUploadInput) {
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(input.recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const rec = snap.data() as RecordingDoc;
  if (rec.status !== 'draft' && rec.status !== 'needsAttention') {
    throw new HttpsError(
      'failed-precondition',
      'Audio can only be added while a recording is a draft. Unpublish it first.',
    );
  }
  if (rec.audioPath) {
    throw new HttpsError('failed-precondition', 'This recording already has audio. Remove it first.');
  }
  const audioPath = audioStoragePath(input.recordingId);
  // An earlier upload that landed but was never finalized (the tab closed, the
  // finalize call failed) is in the way of a write-once URL. Nothing refers to
  // it — `audioPath` is still null on a draft — so it goes.
  await deleteObject(audioPath);
  const put = await signPut(audioPath, input.contentType, UPLOAD_URL_TTL_MS);
  return { audioPath, url: put.url, headers: put.headers, expiresAt: put.expiresAt };
}

/**
 * Not audited: it changes nothing anyone reads. The audit row is written when
 * the upload is confirmed (`finalizeRecordingUpload`), which is the moment
 * audio actually arrives on the recording.
 */
export const startRecordingUpload = reportedCall(async (req) => {
  const input = validateStartUpload(req.data);
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(input.recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  await requireCourseScope(req, (rec.data() as RecordingDoc).courseId);
  return startUpload(input);
}, MEDIA_WRITE_SECRETS);

// -------------------------------------------------------------- finalize --

export interface FinalizeInput {
  recordingId: string;
  durationSec: number | null;
}

export function validateFinalize(data: unknown): FinalizeInput {
  const d = data as Partial<FinalizeInput> | null;
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  if (d.durationSec !== null && d.durationSec !== undefined) {
    if (typeof d.durationSec !== 'number' || !Number.isFinite(d.durationSec) || d.durationSec <= 0) {
      throw new HttpsError('invalid-argument', 'durationSec must be a positive number or null.');
    }
  }
  return { recordingId: d.recordingId, durationSec: d.durationSec ?? null };
}

/**
 * Confirm the upload landed, and record what actually arrived.
 *
 * The client reports duration (it has the decoded media; the server would need
 * ffmpeg to find out) but the server reads SIZE from the bucket rather than
 * trusting it — size is the one field a wrong value could be used to argue
 * about, and it costs one HEAD to get right. Duration is advisory: a wrong
 * value mis-draws a progress bar and nothing more.
 *
 * An object over the cap is DELETED, not just refused: the upload URL cannot
 * sign a size, so this is where an oversized file is caught, and leaving it
 * would both cost storage and block a corrected re-upload (the URL is
 * write-once).
 *
 * Marking `audioPath` only after the object is confirmed present is what stops a
 * failed upload leaving a publishable-looking draft behind.
 */
export async function finalizeRecording(input: FinalizeInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(input.recordingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');

  const path = audioStoragePath(input.recordingId);
  const object = await head(path);
  if (!object) {
    throw new HttpsError('failed-precondition', 'No audio found for that recording.');
  }
  const { sizeBytes } = object;
  if (sizeBytes > MAX_AUDIO_BYTES) {
    await deleteObject(path);
    throw new HttpsError('failed-precondition', 'That audio file is too large (300 MB at most).');
  }

  await ref.update({
    audioPath: path,
    sizeBytes,
    durationSec: input.durationSec,
    updatedAt: Date.now(),
  });
  return { recordingId: input.recordingId, audioPath: path, sizeBytes };
}

export const finalizeRecordingUpload = auditedCall('finalizeRecordingUpload', async (req, audit) => {
  const input = validateFinalize(req.data);
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(input.recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (rec.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  return finalizeRecording(input);
}, MEDIA_WRITE_SECRETS);

// ---------------------------------------------------------------- status --

export interface SetStatusInput {
  recordingId: string;
  status: RecordingStatus;
  attentionReason?: string;
}

const STATUSES: RecordingStatus[] = [
  'draft',
  'published',
  'archived',
  'unpublished',
  'needsAttention',
];

export function validateSetStatus(data: unknown): SetStatusInput {
  const d = data as Partial<SetStatusInput> | null;
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  if (!STATUSES.includes(d.status as RecordingStatus)) {
    throw new HttpsError('invalid-argument', 'Unknown status.');
  }
  return {
    recordingId: d.recordingId,
    status: d.status as RecordingStatus,
    attentionReason: typeof d.attentionReason === 'string' ? d.attentionReason : undefined,
  };
}

/**
 * Move a recording through its lifecycle, refusing anything the state machine
 * does not draw — and refusing to publish something that is not ready.
 *
 * Both checks live here rather than in the UI, because the UI hiding a button is
 * convenience and this is the boundary.
 */
export async function applyRecordingStatus(input: SetStatusInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(input.recordingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const current = snap.data() as RecordingDoc;

  if (!canTransition(current.status, input.status)) {
    throw new HttpsError(
      'failed-precondition',
      `A ${current.status} recording cannot become ${input.status}.`,
    );
  }

  if (input.status === 'published') {
    const blockers = publishBlockers({ ...current, status: current.status });
    if (blockers.length > 0) {
      throw new HttpsError('failed-precondition', `Not ready to publish: ${blockers.join(', ')}.`);
    }
    // Publishing onto a session whose deadline has gone would grant the excused
    // a recording that closed before it existed — an obligation nobody can
    // fulfil and a ledger row nobody can clear. The deadline lives on the
    // session, so it is checked here rather than in the pure publishBlockers.
    const session = (
      await db.collection(COLLECTIONS.sessions).doc(current.sessionId).get()
    ).data() as SessionDoc | undefined;
    if (session && session.dueDate < todayInZone(INSTITUTE_TIMEZONE)) {
      throw new HttpsError(
        'failed-precondition',
        "This session's due date has passed. Move it before publishing, or nobody will be able to listen.",
      );
    }
  }

  const update: Record<string, unknown> = { status: input.status, updatedAt: Date.now() };
  if (input.status === 'published' && !current.publishedAt) update.publishedAt = Date.now();
  if (input.status === 'needsAttention') update.attentionReason = input.attentionReason ?? '';
  await ref.update(update);
  return { recordingId: input.recordingId, status: input.status };
}

export const setRecordingStatus = auditedCall('setRecordingStatus', async (req, audit) => {
  const input = validateSetStatus(req.data);
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(input.recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (rec.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  audit.detail = { status: input.status };
  return applyRecordingStatus(input);
});

// ----------------------------------------------------------- clear audio --

/**
 * Delete a recording's audio so it can be re-uploaded.
 *
 * The upload URL is write-once (`mediaStore.signPut`), which is what stops a
 * published recording's audio being swapped underneath students who have
 * already listened to it. Replacing bad audio therefore has to come through
 * here, and only while the recording is not live.
 */
export async function clearAudio(recordingId: string) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const current = snap.data() as RecordingDoc;

  if (current.status !== 'draft' && current.status !== 'needsAttention') {
    throw new HttpsError(
      'failed-precondition',
      'Audio can only be replaced while a recording is a draft. Unpublish it first.',
    );
  }

  await deleteObject(audioStoragePath(recordingId));
  await ref.update({ audioPath: null, sizeBytes: null, durationSec: null, updatedAt: Date.now() });
  return { recordingId };
}

export const clearRecordingAudio = auditedCall('clearRecordingAudio', async (req, audit) => {
  const d = req.data as { recordingId?: unknown };
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(d.recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (rec.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  return clearAudio(d.recordingId);
}, MEDIA_WRITE_SECRETS);

// Everything that references a recording by id, so a permanent delete leaves no
// orphans. All are keyed on a `recordingId` field (single-field equality → no
// composite index needed).
export const RECORDING_DEPENDENTS = [
  COLLECTIONS.assignments,
  COLLECTIONS.completions,
  COLLECTIONS.completionEvents,
  COLLECTIONS.listeningProgress,
  COLLECTIONS.completionOverrides,
] as const;

/**
 * Whether anything at all points at this recording — asked of the DATA.
 *
 * `isEmptyDraft` is a proxy for "there is nothing here to destroy", and the
 * proxy is only sound for a recording that was NEVER published. It is not sound
 * for one that was: `published → unpublished → draft` is a legal pair of
 * transitions, `clearAudio` accepts a draft and nulls `audioPath`, and the
 * recording is then indistinguishable by shape from one created five minutes
 * ago — while every assignment, completion, listening-progress row and override
 * from its term is still sitting there. Four course-scoped calls in a row turned
 * a manager into an admin for the one irreversible act in the product.
 *
 * So the gate asks the collections instead. One document from each is enough,
 * and the cost is only paid on the delete path.
 */
async function hasRecordingHistory(recordingId: string): Promise<boolean> {
  const db = getFirestore();
  const probes = await Promise.all(
    RECORDING_DEPENDENTS.map((coll) =>
      db.collection(coll).where('recordingId', '==', recordingId).limit(1).get(),
    ),
  );
  return probes.some((q) => !q.empty);
}

/**
 * The authorization for permanently deleting a recording, in one place.
 *
 * ADMIN-ONLY BECAUSE IT DESTROYS LISTENING HISTORY — the invariant in
 * `CLAUDE.md` and the manual. The single exception is a draft that has none:
 * whoever had the course scope to create it may discard it, which is what lets
 * a manager clean up their own failed upload rather than leaving an unusable
 * draft parked on the session until an admin appears.
 *
 * `applyDeleteRecording` itself authorizes NOTHING — it is the cascade, and
 * `deleteSession` calls it too. That path is gated by `requireAdmin` at its own
 * entry rather than by this function, because deleting a session destroys the
 * class's attendance for that day as well; it used to check course scope alone,
 * which made deleting the SESSION a way past everything below.
 */
export async function requireDeleteRights(
  req: CallableRequest,
  rec: RecordingDoc,
  recordingId: string,
): Promise<void> {
  // AUTHORIZE FIRST, THEN PROBE. Course scope is the floor either way — an admin
  // passes it without a read — so checking it up front means a manager acting on
  // a class that is not theirs is refused before five collection queries are
  // spent finding out whether the recording had history.
  await requireCourseScope(req, rec.courseId);
  // `isDiscardable` is the same question the CLIENT asks, so the button it
  // offers and the words on the confirmation match what happens here. The
  // collection probe is still the authority: it also covers a recording written
  // before `publishedAt` existed, and anything that put a dependent row there by
  // another route.
  if (isDiscardable(rec) && !(await hasRecordingHistory(recordingId))) return;
  requireAdmin(req);
}

/**
 * PERMANENTLY delete a recording — the one destructive path (everything else is
 * archive/unpublish, which is reversible). Reclaiming storage is the only real
 * reason to reach for it. Refuses a live (published) recording: unpublish or
 * archive first, so a delete can never silently pull a recording out from under
 * students mid-term. Cascades so no assignment/completion/progress/override doc
 * is left pointing at a recording that no longer exists.
 */
export async function applyDeleteRecording(recordingId: string) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const rec = snap.data() as RecordingDoc;
  if (rec.status === 'published') {
    throw new HttpsError(
      'failed-precondition',
      'Unpublish or archive a live recording before deleting it permanently.',
    );
  }

  // 1. Dependent docs, chunked under the 500-writes/batch cap (a roster is far
  //    smaller, but a recording old enough to delete could have accumulated a
  //    doc per student across several collections).
  const commits: Promise<unknown>[] = [];
  for (const coll of RECORDING_DEPENDENTS) {
    const q = await db.collection(coll).where('recordingId', '==', recordingId).get();
    for (let i = 0; i < q.docs.length; i += 400) {
      const batch = db.batch();
      for (const doc of q.docs.slice(i, i + 400)) batch.delete(doc.ref);
      commits.push(batch.commit());
    }
  }
  await Promise.all(commits);

  // 2. The audio object — at the CANONICAL path, not only when `audioPath` is
  //    set. An upload that landed in the bucket but never finalized leaves the
  //    object there with the field still null; keying the delete off the field
  //    would orphan those bytes forever, and they are the one thing here that
  //    costs money. The path is derived from the id, so this is exact.
  await deleteObject(rec.audioPath ?? audioStoragePath(recordingId));

  // 3. The recording itself, and the session's pointer, IN ONE TRANSACTION:
  //    written one after the other, a failure between them left a session
  //    pointing at a document that was gone — refused a new draft as "already
  //    has a recording", and undeletable, since its cascade began with "No
  //    such recording". The session may itself be mid-delete, or point at a
  //    later recording by now; only a pointer to THIS one is cleared.
  const sessionRef = db.collection(COLLECTIONS.sessions).doc(rec.sessionId);
  await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    tx.delete(ref);
    if (sessionSnap.exists && (sessionSnap.data() as SessionDoc).recordingId === recordingId) {
      tx.update(sessionRef, { recordingId: null, updatedAt: Date.now() });
    }
  });
  return { recordingId, courseId: rec.courseId };
}

/**
 * The whole of "delete this recording": decide who may, then destroy it.
 *
 * SEPARATED FROM THE WRAPPER so a test can drive the two together, which is the
 * only way to assert what this actually promises — that a caller who may not
 * delete leaves every listening record exactly where it was. Testing the gate
 * alone proves it throws; it does not prove nothing was destroyed, and the
 * order of those two steps is the whole of the guarantee. Same reasoning as
 * every other core in this file.
 */
export async function applyRecordingDelete(
  req: CallableRequest,
  recordingId: string,
): Promise<{ recordingId: string; courseId: string }> {
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  await requireDeleteRights(req, snap.data() as RecordingDoc, recordingId);
  return applyDeleteRecording(recordingId);
}

export const deleteRecording = auditedCall('deleteRecording', async (req, audit) => {
  const d = req.data as { recordingId?: unknown };
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  const res = await applyRecordingDelete(req, d.recordingId);
  audit.courseId = res.courseId; // recordingId target is auto-picked from req.data
  return { recordingId: res.recordingId };
}, MEDIA_WRITE_SECRETS);
