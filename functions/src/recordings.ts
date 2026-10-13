import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { getFirestore, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  canTransition,
  deriveDurationSec,
  isDiscardable,
  isPlayable,
  publishBlockers,
  todayInZone,
  type MediaEdit,
  type MediaMap,
  type MediaVersion,
  type RecordingDoc,
  type RecordingSource,
  type RecordingStatus,
  type SessionDoc,
} from '@sabeel/shared';
import { isAdminCaller, requireAdmin, requireCourseScope } from './guards';
import { MEDIA_WRITE_SECRETS, deleteObject } from './mediaStore';
import { abortUpload } from './uploads';
import { writeItem } from './mediaWrite';

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
export async function createRecordingDraft(callerUid: string, input: CreateRecordingInput) {
  const db = getFirestore();
  const sessionRef = db.collection(COLLECTIONS.sessions).doc(input.sessionId);
  const ref = db.collection(COLLECTIONS.recordings).doc();
  await db.runTransaction((tx) => draftInTransaction(tx, sessionRef, ref, callerUid, 'manual'));
  return { id: ref.id };
}

/**
 * Create the session's draft recording inside a caller's transaction, after
 * the reads every creator needs. Shared by the upload path and the Zoom import,
 * which has to claim its file in the same transaction.
 *
 * ONE SESSION, ONE RECORDING — held by the transaction, not by a read above
 * the write. Two calls in the same window (a double tap on Upload, a Zoom
 * import racing a manual one) both read "no recording yet", both created a
 * draft, and the session pointed at whichever link landed last: the other
 * draft sat orphaned in the library, publishable, never cascaded by a session
 * delete, and its fan-out reconciled the session's OTHER recording.
 */
export async function draftInTransaction(
  tx: Transaction,
  sessionRef: DocumentReference,
  ref: DocumentReference,
  callerUid: string,
  source: RecordingSource,
): Promise<RecordingDoc> {
  const db = getFirestore();
  const sessionSnap = await tx.get(sessionRef);
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
  const session = sessionSnap.data() as SessionDoc;
  // A pointer to a recording that no longer exists is no recording: a delete
  // that cleared the document but not the pointer wedged the session behind
  // this refusal. Read inside the transaction, so a recording being created for
  // this session at the same moment is still seen.
  if (
    session.recordingId &&
    (await tx.get(db.collection(COLLECTIONS.recordings).doc(session.recordingId))).exists
  ) {
    throw new HttpsError('failed-precondition', 'This session already has a recording.');
  }
  // "This class was not recorded" and a recording cannot both be true: the
  // flag takes the session off the work queue and out of the morning
  // "attendance still not taken" message, so a draft under it would sit where
  // neither reader looks. `updateSession` refuses the flag on a session with a
  // recording, so the two never disagree in a stored document.
  if (session.notRecorded) {
    throw new HttpsError(
      'failed-precondition',
      'This session is marked as not recorded. Un-mark it first.',
    );
  }
  const doc: RecordingDoc = {
    sessionId: sessionRef.id,
    courseId: session.courseId,
    cohortId: session.cohortId,
    title: session.title,
    notes: session.notes,
    date: session.date,
    status: 'draft',
    source,
    media: {},
    defaultVersion: 'audio',
    durationSec: null,
    createdAt: Date.now(),
    createdBy: callerUid,
    updatedAt: Date.now(),
  };
  tx.set(ref, doc);
  tx.update(sessionRef, { recordingId: ref.id, updatedAt: Date.now() });
  return doc;
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

// ---------------------------------------------------------------- media --

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
        "This session's due date has passed. Move it before publishing, or nobody will be able to open it.",
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

// ---------------------------------------------------------- remove media --

/**
 * Remove one file from a recording.
 *
 * A FILE STUDENTS NEVER SAW — still uploading, still copying, or failed — can
 * go from a recording in any state: that is an upload being cancelled or a
 * failed import being cleared, and nothing anyone played disappears. An upload
 * in flight is aborted with it.
 *
 * A READY file follows the recording. A draft's are its makers' to correct. A
 * live recording's are never removed — hidden instead, so nothing a student
 * is part-way through vanishes. One taken down (archived, unpublished) is an
 * admin's to clear out, for storage. The object goes, the item goes, and a
 * Zoom file's claim goes, so it can be imported again.
 */
export async function removeMedia(recordingId: string, itemId: string, asAdmin = false) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  const removed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
    const rec = snap.data() as RecordingDoc;
    const item = rec.media[itemId];
    if (!item) throw new HttpsError('not-found', 'No such file on that recording.');
    if (item.status === 'ready') {
      if (rec.status === 'published') {
        throw new HttpsError('failed-precondition', 'A published recording’s files are hidden, not removed. Hide it, or unpublish first.');
      }
      if ((rec.status === 'archived' || rec.status === 'unpublished') && !asAdmin) {
        throw new HttpsError('permission-denied', 'Only an admin can remove a file from a recording that has been published.');
      }
    }
    writeItem(tx, ref, rec, itemId, null);
    if (item.zoom) tx.delete(db.collection(COLLECTIONS.zoomImports).doc(item.zoom.fileId));
    return item;
  });
  await abortUpload(itemId);
  await deleteObject(removed.storageKey);
  return { recordingId, itemId };
}

export const removeRecordingMedia = auditedCall('removeRecordingMedia', async (req, audit) => {
  const d = req.data as { recordingId?: unknown; itemId?: unknown };
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  if (typeof d.itemId !== 'string' || !d.itemId) {
    throw new HttpsError('invalid-argument', 'itemId is required.');
  }
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(d.recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (rec.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  audit.detail = { itemId: d.itemId };
  return removeMedia(d.recordingId, d.itemId, isAdminCaller(req));
}, MEDIA_WRITE_SECRETS);

// ------------------------------------------------------------ edit media --

const VERSIONS: MediaVersion[] = ['speaker', 'slides', 'audio', 'video'];

export function validateMediaEdit(data: unknown): { recordingId: string; edit: MediaEdit } {
  const d = data as { recordingId?: unknown; op?: unknown; itemId?: unknown; part?: unknown; version?: unknown } | null;
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  const recordingId = d.recordingId;
  if (d.op === 'hide' || d.op === 'show') {
    if (typeof d.itemId !== 'string' || !d.itemId) throw new HttpsError('invalid-argument', 'itemId is required.');
    return { recordingId, edit: { op: d.op, itemId: d.itemId } };
  }
  if (d.op === 'moveUp' || d.op === 'moveDown') {
    if (typeof d.part !== 'number' || !Number.isInteger(d.part) || d.part < 1) {
      throw new HttpsError('invalid-argument', 'part must be a part number.');
    }
    return { recordingId, edit: { op: d.op, part: d.part } };
  }
  if (d.op === 'defaultVersion') {
    if (!VERSIONS.includes(d.version as MediaVersion)) throw new HttpsError('invalid-argument', 'Unknown version.');
    return { recordingId, edit: { op: d.op, version: d.version as MediaVersion } };
  }
  throw new HttpsError('invalid-argument', 'Unknown edit.');
}

/**
 * Hide or show a file, move a part, or set the version students start on.
 *
 * Allowed in every state, live included: none of these changes a file, and
 * each is how a published recording is corrected without taking it down —
 * the second half that was in another meeting moved into place, a bad camera
 * angle hidden. Audited, like every change to what students are given.
 *
 * ONE THING IS REFUSED: hiding the last file a student could play in a
 * published recording. Students would keep a recording, a deadline and an
 * obligation, and be given nothing to play; unpublishing says what is meant.
 */
export async function applyMediaEdit(recordingId: string, edit: MediaEdit) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
    const rec = snap.data() as RecordingDoc;
    const media: MediaMap = { ...rec.media };
    if (edit.op === 'hide' || edit.op === 'show') {
      const item = media[edit.itemId];
      if (!item) throw new HttpsError('not-found', 'No such file on that recording.');
      media[edit.itemId] = { ...item, hidden: edit.op === 'hide' };
      if (rec.status === 'published' && !Object.values(media).some(isPlayable)) {
        throw new HttpsError(
          'failed-precondition',
          'That is the last file students can play. Unpublish the recording instead.',
        );
      }
    } else if (edit.op === 'moveUp' || edit.op === 'moveDown') {
      const parts = [...new Set(Object.values(media).map((i) => i.part))].sort((a, b) => a - b);
      const at = parts.indexOf(edit.part);
      const other = parts[edit.op === 'moveUp' ? at - 1 : at + 1];
      if (at < 0 || other === undefined) throw new HttpsError('failed-precondition', 'That part cannot move that way.');
      for (const [id, item] of Object.entries(media)) {
        if (item.part === edit.part) media[id] = { ...item, part: other };
        else if (item.part === other) media[id] = { ...item, part: edit.part };
      }
    } else if (edit.op === 'defaultVersion') {
      tx.update(ref, { defaultVersion: edit.version, updatedAt: Date.now() });
      return;
    }
    tx.update(ref, { media, durationSec: deriveDurationSec(media), updatedAt: Date.now() });
  });
  return { recordingId };
}

export const editRecordingMedia = auditedCall('editRecordingMedia', async (req, audit) => {
  const { recordingId, edit } = validateMediaEdit(req.data);
  const rec = await getFirestore().collection(COLLECTIONS.recordings).doc(recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (rec.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  audit.detail = { ...edit };
  return applyMediaEdit(recordingId, edit);
});

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
 * transitions, `removeMedia` accepts a draft and empties its media, and the
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

  // 2. Every item's object, whatever state it is in — an `uploading` item
  //    whose bytes landed but were never confirmed is still bytes in the
  //    bucket, and they are the one thing here that costs money — and every
  //    Zoom file's claim, so the file can be imported again. An upload still
  //    in flight is aborted first, or its parts would sit in the bucket until
  //    its own one-day rule.
  const items = Object.values(rec.media);
  await Promise.all(items.map((i) => abortUpload(i.id)));
  await Promise.all(items.map((i) => deleteObject(i.storageKey)));
  await Promise.all(
    items
      .filter((i) => i.zoom)
      .map((i) => db.collection(COLLECTIONS.zoomImports).doc((i.zoom as { fileId: string }).fileId).delete()),
  );

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
