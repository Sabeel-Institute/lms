import { HttpsError } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { getFunctions } from 'firebase-admin/functions';
import { FieldValue, getFirestore, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  MAX_AUDIO_BYTES,
  ZOOM_RECORDING_TYPES,
  deriveDurationSec,
  mediaStorageKey,
  zoomFormatMedia,
  type CourseDoc,
  type MediaItem,
  type MediaMap,
  type RecordingDoc,
  type SessionDoc,
  type ZoomImportDoc,
  type ZoomMeetingRow,
  type ZoomFileInfo,
  type ZoomMeetingListing,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { SENTRY_DSN, reportedCall } from './reported';
import { reportError } from './sentry';
import { requireCourseScope, requireStaff } from './guards';
import { draftInTransaction } from './recordings';
import { writeItem } from './mediaWrite';
import { MEDIA_WRITE_SECRETS, deleteObject, head } from './mediaStore';
import { MAX_COPY_BYTES } from './mediaCopier';
import { ZOOM_SECRETS, zoomClient, type ZoomClient } from './zoom';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** How many files one import may take: every format of every segment of a long day. */
const MAX_IMPORT_FILES = 20;

// ---------------------------------------------------------------- listing --

export const listZoomRecordings = reportedCall(async (req) => {
  requireStaff(req); // the central list is not class-specific
  const d = req.data as { from?: unknown; to?: unknown };
  const from = typeof d?.from === 'string' ? d.from : '';
  const to = typeof d?.to === 'string' ? d.to : '';
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) {
    throw new HttpsError('invalid-argument', 'from and to must be YYYY-MM-DD.');
  }
  if (from > to) throw new HttpsError('invalid-argument', 'The range ends before it starts.');
  return annotateImported(await zoomClient.listMeetings(from, to));
}, ZOOM_SECRETS);

/**
 * Mark which of Zoom's files this institute already has, and where.
 *
 * SEPARATE FROM THE CALLABLE so it can be tested: `listZoomRecordings` closes
 * over the module-level `zoomClient`, which needs credentials that exist only in
 * Secret Manager, and this is the whole of what it does beyond the fetch.
 * Marking nothing is invisible to a type checker and turns the picker into an
 * invitation to import everything a second time.
 *
 * One read of the claims (`zoomImports`), then one read per DISTINCT class
 * actually referenced — not per file.
 */
export async function annotateImported(meetings: ZoomMeetingListing[]): Promise<ZoomMeetingRow[]> {
  const db = getFirestore();
  const claims = await db.collection(COLLECTIONS.zoomImports).get();
  const byFile = new Map<string, ZoomImportDoc>();
  for (const doc of claims.docs) byFile.set(doc.id, doc.data() as ZoomImportDoc);

  const courseNames = new Map<string, string>();
  await Promise.all(
    [...new Set([...byFile.values()].map((v) => v.courseId))].map(async (id) => {
      const s = await db.collection(COLLECTIONS.courses).doc(id).get();
      if (s.exists) courseNames.set(id, (s.data() as CourseDoc).name);
    }),
  );

  return meetings.map((m) => ({
    meetingUuid: m.meetingUuid,
    topic: m.topic,
    startTime: m.startTime,
    durationSec: m.durationSec,
    segments: m.segments.map((seg) => ({
      startTime: seg.startTime,
      durationSec: seg.durationSec,
      files: seg.files.map((f) => {
        const imp = byFile.get(f.fileId);
        return {
          fileId: f.fileId,
          format: f.format,
          sizeBytes: f.sizeBytes,
          ready: f.ready,
          imported: imp
            ? { recordingId: imp.recordingId, sessionId: imp.sessionId, courseName: courseNames.get(imp.courseId) ?? null }
            : null,
        };
      }),
    })),
  }));
}

// ----------------------------------------------------------------- import --

/** One file to copy: the work a task does. */
export interface CopyTask {
  recordingId: string;
  itemId: string;
}

/** Hand a copy to the task queue. Injected, so tests can see what was queued. */
export type Enqueue = (task: CopyTask) => Promise<void>;

/** The production queue: one `copyZoomFile` task per file. */
const enqueueCopy: Enqueue = (task) => getFunctions().taskQueue<CopyTask>('copyZoomFile').enqueue(task);

export interface ImportInput {
  sessionId: string;
  files: { meetingUuid: string; fileId: string }[];
}

export function validateImport(data: unknown): ImportInput {
  const d = data as { sessionId?: unknown; files?: unknown } | null;
  if (typeof d?.sessionId !== 'string' || !d.sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
  if (!Array.isArray(d.files) || d.files.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose at least one file.');
  }
  if (d.files.length > MAX_IMPORT_FILES) {
    throw new HttpsError('invalid-argument', `Choose at most ${MAX_IMPORT_FILES} files at a time.`);
  }
  const files = (d.files as unknown[]).map((f) => {
    const x = f as { meetingUuid?: unknown; fileId?: unknown } | null;
    if (typeof x?.meetingUuid !== 'string' || !x.meetingUuid || typeof x.fileId !== 'string' || !x.fileId) {
      throw new HttpsError('invalid-argument', 'Each file needs its meetingUuid and fileId.');
    }
    return { meetingUuid: x.meetingUuid, fileId: x.fileId };
  });
  if (new Set(files.map((f) => f.fileId)).size !== files.length) {
    throw new HttpsError('invalid-argument', 'The same file was chosen twice.');
  }
  return { sessionId: d.sessionId, files };
}

/** Where a Zoom item sits on the class's timeline: its meeting and segment. */
const segmentKey = (z: { meetingUuid: string; segmentStart: string | null }) =>
  `${z.meetingUuid}|${z.segmentStart}`;

/**
 * The largest file of each kind the import takes. Audio as an upload; video as
 * the Worker can copy in one put (a larger Zoom file is refused with a reason,
 * see MEDIA-ON-CLOUDFLARE.md spike M1).
 */
function capFor(file: Pick<ZoomFileInfo, 'format'>): number {
  return zoomFormatMedia(file.format).kind === 'audio' ? MAX_AUDIO_BYTES : MAX_COPY_BYTES;
}

/**
 * Import Zoom files into a session's recording, creating the draft if the
 * session has none.
 *
 * ASYNCHRONOUS. Everything that decides anything happens here, in ONE
 * TRANSACTION: each file is claimed in `zoomImports/{fileId}` (a double tap,
 * or two staff importing the same file, gets "already imported"), the draft
 * is created or the existing recording read, and an item per file is added as
 * `copying`. Then one task per file is queued and this returns; the session
 * page follows the items as the tasks finish. A blocking call could not cover
 * several gigabytes of video.
 *
 * PARTS FOLLOW THE CLASS. The files of one segment become versions of one part;
 * segments become parts in start-time order, after any the recording already
 * has, across every meeting chosen. A segment the recording already holds a
 * version of gains this one as another version of that part.
 */
export async function applyImportZoomFiles(
  callerUid: string,
  input: ImportInput,
  client: ZoomClient,
  enqueue: Enqueue = enqueueCopy,
): Promise<{ recordingId: string; itemIds: string[] }> {
  const db = getFirestore();
  // Fresh from Zoom, not from the listing the picker was given: sizes and
  // processing state change, and the file may have been deleted since.
  const fresh = await Promise.all(input.files.map((f) => client.freshFile(f.meetingUuid, f.fileId)));
  const files = fresh.map((r, i) => {
    if (!r) throw new HttpsError('not-found', 'One of the chosen files is no longer in Zoom. Load the list again.');
    if (r.file.meetingUuid !== input.files[i].meetingUuid) {
      throw new HttpsError('invalid-argument', 'A chosen file is not in the meeting it was listed under.');
    }
    if (!r.file.ready) {
      throw new HttpsError('failed-precondition', 'Zoom is still processing one of the chosen files. Try again later.');
    }
    if (r.file.sizeBytes > capFor(r.file)) {
      const mb = Math.round(capFor(r.file) / 1024 / 1024);
      throw new HttpsError('failed-precondition', `One of the chosen files is larger than the ${mb} MB that can be copied.`);
    }
    return r.file;
  });

  const sessionRef = db.collection(COLLECTIONS.sessions).doc(input.sessionId);
  const claimRefs = files.map((f) => db.collection(COLLECTIONS.zoomImports).doc(f.fileId));
  const added: MediaItem[] = [];
  const recordingId = await db.runTransaction(async (tx) => {
    added.length = 0;
    // Every read first: a transaction may not read after it writes.
    const claims = await Promise.all(claimRefs.map((r) => tx.get(r)));
    for (const c of claims) {
      if (!c.exists) continue;
      const prior = c.data() as ZoomImportDoc;
      const owner = await tx.get(db.collection(COLLECTIONS.recordings).doc(prior.recordingId));
      // A claim whose item is gone was left by a delete that did not finish;
      // this import takes it over.
      if (owner.exists && (owner.data() as RecordingDoc).media?.[prior.itemId]) {
        throw new HttpsError('already-exists', 'One of the chosen files is already imported. Load the list again.');
      }
    }
    const session = await tx.get(sessionRef);
    if (!session.exists) throw new HttpsError('not-found', 'No such session.');
    const pointer = (session.data() as SessionDoc).recordingId;
    const existing = pointer ? await tx.get(db.collection(COLLECTIONS.recordings).doc(pointer)) : null;

    let ref: DocumentReference;
    let rec: RecordingDoc;
    if (existing?.exists) {
      ref = existing.ref;
      rec = existing.data() as RecordingDoc;
    } else {
      ref = db.collection(COLLECTIONS.recordings).doc();
      rec = await draftInTransaction(tx, sessionRef, ref, callerUid, 'zoom');
    }

    const current = Object.values(rec.media);
    const partOf = new Map<string, number>();
    for (const item of current) if (item.zoom) partOf.set(segmentKey(item.zoom), item.part);
    let next = Math.max(0, ...current.map((i) => i.part)) + 1;
    for (const f of [...files].sort((a, b) => a.segmentStart.localeCompare(b.segmentStart))) {
      const key = segmentKey({ meetingUuid: f.meetingUuid, segmentStart: f.segmentStart });
      if (!partOf.has(key)) partOf.set(key, next++);
    }

    const media: MediaMap = { ...rec.media };
    files.forEach((f, i) => {
      const id = db.collection(COLLECTIONS.recordings).doc().id;
      const { kind, contentType } = zoomFormatMedia(f.format);
      const item: MediaItem = {
        id,
        part: partOf.get(segmentKey({ meetingUuid: f.meetingUuid, segmentStart: f.segmentStart })) as number,
        version: f.format,
        kind,
        label: null,
        status: 'copying',
        failReason: null,
        hidden: false,
        storageKey: mediaStorageKey(ref.id, id),
        contentType,
        sizeBytes: f.sizeBytes,
        durationSec: f.durationSec,
        width: null,
        height: null,
        source: 'zoom',
        zoom: {
          meetingUuid: f.meetingUuid,
          fileId: f.fileId,
          recordingType: ZOOM_RECORDING_TYPES[f.format],
          segmentStart: f.segmentStart,
          topic: f.topic,
        },
        addedAt: Date.now(),
        addedBy: callerUid,
      };
      media[id] = item;
      added.push(item);
      const claim: ZoomImportDoc = {
        recordingId: ref.id,
        itemId: id,
        sessionId: input.sessionId,
        courseId: rec.courseId,
        meetingUuid: f.meetingUuid,
        claimedAt: Date.now(),
      };
      tx.set(claimRefs[i], claim);
    });
    const update: Record<string, unknown> = {
      media,
      durationSec: deriveDurationSec(media),
      updatedAt: Date.now(),
    };
    // A draft that needed attention is a draft again: there is new work on it.
    // A recording out in the world keeps its status; its new files appear to
    // students as they become ready.
    if (rec.status === 'needsAttention') {
      update.status = 'draft';
      update.attentionReason = FieldValue.delete();
    }
    tx.update(ref, update);
    return ref.id;
  });

  await queueCopies(recordingId, added.map((i) => i.id), enqueue);
  return { recordingId, itemIds: added.map((i) => i.id) };
}

/**
 * Queue a copy per item. A copy that cannot be queued is an item that will
 * never move, so it is marked failed with a reason staff can act on (Retry)
 * rather than left `copying` for ever.
 */
async function queueCopies(recordingId: string, itemIds: string[], enqueue: Enqueue): Promise<void> {
  for (const itemId of itemIds) {
    try {
      await enqueue({ recordingId, itemId });
    } catch (e) {
      await reportError(e, { source: 'zoomImport.enqueue', recordingId });
      await markFailed(recordingId, itemId, 'The copy could not be started. Retry the import.');
    }
  }
}

// ------------------------------------------------------------- the copy --

/**
 * Settle a draft's status after its items change: it needs attention when
 * every file it holds failed, and stops needing it once none has. A recording
 * that is not a draft keeps its status; its failed files show on the session
 * page.
 */
function settleStatus(tx: Transaction, ref: DocumentReference, rec: RecordingDoc, media: MediaMap): void {
  if (rec.status !== 'draft' && rec.status !== 'needsAttention') return;
  const items = Object.values(media);
  const failed = items.filter((i) => i.status === 'failed');
  if (items.length > 0 && failed.length === items.length) {
    tx.update(ref, { status: 'needsAttention', attentionReason: failed[0].failReason ?? 'Zoom import failed.' });
  } else if (rec.status === 'needsAttention' && failed.length === 0) {
    tx.update(ref, { status: 'draft', attentionReason: FieldValue.delete() });
  }
}

async function markFailed(recordingId: string, itemId: string, reason: string): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  await db.runTransaction(async (tx) => {
    const rec = (await tx.get(ref)).data() as RecordingDoc | undefined;
    const item = rec?.media[itemId];
    if (!rec || !item) return;
    const failed: MediaItem = { ...item, status: 'failed', failReason: reason };
    tx.update(ref, { [`media.${itemId}`]: failed, updatedAt: Date.now() });
    settleStatus(tx, ref, rec, { ...rec.media, [itemId]: failed });
  });
}

/**
 * Copy one Zoom file into its item: the work of one task.
 *
 * Zoom's file link lasts an hour, so it is resolved here, immediately before
 * the copy, on every attempt. A failure is thrown back to the queue, which
 * retries with backoff; on the final attempt the item is marked `failed` with
 * the reason instead, and Retry on the session page queues it again. A file
 * Zoom no longer has fails at once: no retry will bring it back.
 *
 * An item that is gone (removed, or its recording deleted, while the task
 * waited) has its object deleted in case an earlier attempt wrote it; an item
 * already ready has nothing left to do. Both make a duplicate delivery
 * harmless.
 */
export async function runCopyTask(task: CopyTask, finalAttempt: boolean, client: ZoomClient): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(task.recordingId);
  const rec = (await ref.get()).data() as RecordingDoc | undefined;
  const item = rec?.media[task.itemId];
  if (!rec || !item) {
    await deleteObject(mediaStorageKey(task.recordingId, task.itemId));
    return;
  }
  if (item.status !== 'copying' || !item.zoom) return;

  try {
    const found = await client.freshFile(item.zoom.meetingUuid, item.zoom.fileId);
    if (!found) {
      await markFailed(task.recordingId, task.itemId, 'This file is no longer in Zoom.');
      return;
    }
    // Write-once, like every upload: whatever an earlier attempt left goes first.
    await deleteObject(item.storageKey);
    await client.copyToMediaStore(found.downloadUrl, item.storageKey, found.file.sizeBytes, item.contentType);
    await settleCopy(task.recordingId, task.itemId, found.file.durationSec, capFor(found.file));
    await db.runTransaction(async (tx) => {
      const now = (await tx.get(ref)).data() as RecordingDoc | undefined;
      if (now) settleStatus(tx, ref, now, now.media);
    });
  } catch (e) {
    if (!finalAttempt) throw e;
    const reason = `Zoom import failed: ${(e as Error).message}`.slice(0, 300);
    await markFailed(task.recordingId, task.itemId, reason);
    // Reported here, because the queue's last failure is otherwise visible only
    // on the recording itself.
    await reportError(e, { source: 'copyZoomFile', recordingId: task.recordingId });
  }
}

/**
 * Record what a copy actually put in the bucket: the item becomes `ready` with
 * the size read from the bucket and the length Zoom reported. An object over
 * the cap is deleted and its item removed rather than kept. Only an item still
 * `copying` is settled, so a task replayed later cannot rewrite a ready one.
 */
async function settleCopy(recordingId: string, itemId: string, durationSec: number | null, maxBytes: number) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  const item = ((await ref.get()).data() as RecordingDoc | undefined)?.media[itemId];
  if (item?.status !== 'copying') throw new Error('That file is not waiting to be confirmed.');
  const object = await head(item.storageKey);
  if (!object) throw new Error('No file found for that copy.');
  const tooLarge = object.sizeBytes > maxBytes;
  if (tooLarge) await deleteObject(item.storageKey);
  await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as RecordingDoc | undefined;
    const current = fresh?.media[itemId];
    if (!fresh || !current) throw new Error('That file was removed.');
    writeItem(tx, ref, fresh, itemId, tooLarge
      ? null
      : { ...current, status: 'ready', failReason: null, sizeBytes: object.sizeBytes, durationSec });
  });
  if (tooLarge) throw new Error(`That file is too large (${Math.round(maxBytes / 2 ** 20)} MB at most).`);
}

/** The attempts a copy gets before its item is marked failed. */
const COPY_ATTEMPTS = 3;

export const copyZoomFile = onTaskDispatched<CopyTask>(
  {
    retryConfig: { maxAttempts: COPY_ATTEMPTS, minBackoffSeconds: 60 },
    // Zoom's API and the Worker both take a handful at a time comfortably; a
    // day's import of a dozen files then finishes in a few minutes.
    rateLimits: { maxConcurrentDispatches: 4 },
    // The Worker's copy takes up to 20 minutes for the largest file.
    timeoutSeconds: 1800,
    // PRIVATE, said out loud: only the queue, with the runtime account's token,
    // may call this. The first deploy left it open to anyone (allUsers) though
    // private is the documented default — see docs/DEPLOY.md.
    invoker: 'private',
    secrets: [SENTRY_DSN, ...ZOOM_SECRETS, ...MEDIA_WRITE_SECRETS],
  },
  async (req) => {
    const d = req.data as Partial<CopyTask> | null;
    if (typeof d?.recordingId !== 'string' || typeof d.itemId !== 'string') return;
    await runCopyTask(
      { recordingId: d.recordingId, itemId: d.itemId },
      req.retryCount >= COPY_ATTEMPTS - 1,
      zoomClient,
    );
  },
);

// ------------------------------------------------------------------ retry --

/**
 * Queue every failed Zoom file on a recording again.
 *
 * Only failed files: a ready one is never copied over, which is what keeps a
 * file students may be playing from changing underneath them. A recording
 * left needing attention with nothing failed — every copy finished but the
 * status write after it did not — is settled to a draft, since that is the
 * one button the screen offers for it.
 */
export async function applyRetryZoomImport(
  recordingId: string,
  enqueue: Enqueue = enqueueCopy,
): Promise<{ recordingId: string; itemIds: string[] }> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  const itemIds = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
    const rec = snap.data() as RecordingDoc;
    const zoomItems = Object.values(rec.media).filter((i) => i.zoom);
    if (zoomItems.length === 0) {
      throw new HttpsError('failed-precondition', 'That recording is not a Zoom import.');
    }
    const failed = zoomItems.filter((i) => i.status === 'failed');
    if (failed.length === 0) {
      if (rec.status !== 'needsAttention') {
        throw new HttpsError('failed-precondition', 'That recording already has its files.');
      }
      tx.update(ref, { status: 'draft', attentionReason: FieldValue.delete(), updatedAt: Date.now() });
      return [];
    }
    const media = { ...rec.media };
    for (const i of failed) media[i.id] = { ...i, status: 'copying', failReason: null };
    const update: Record<string, unknown> = { media, updatedAt: Date.now() };
    if (rec.status === 'needsAttention') {
      update.status = 'draft';
      update.attentionReason = FieldValue.delete();
    }
    tx.update(ref, update);
    return failed.map((i) => i.id);
  });
  await queueCopies(recordingId, itemIds, enqueue);
  return { recordingId, itemIds };
}

// -------------------------------------------------------------- callables --

export const importZoomFiles = auditedCall(
  'importZoomFiles',
  async (req, audit) => {
    const input = validateImport(req.data);
    const sessionSnap = await getFirestore().collection(COLLECTIONS.sessions).doc(input.sessionId).get();
    if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
    const courseId = (sessionSnap.data() as SessionDoc).courseId;
    const uid = await requireCourseScope(req, courseId);
    audit.courseId = courseId;
    const res = await applyImportZoomFiles(uid, input, zoomClient);
    audit.targets = { recordingId: res.recordingId, sessionId: input.sessionId };
    audit.detail = { files: input.files.length };
    return res;
  },
  ZOOM_SECRETS,
);

export const retryZoomImport = auditedCall('retryZoomImport', async (req, audit) => {
  const d = req.data as { recordingId?: unknown };
  if (typeof d?.recordingId !== 'string' || !d.recordingId) {
    throw new HttpsError('invalid-argument', 'recordingId is required.');
  }
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(d.recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const courseId = (snap.data() as RecordingDoc).courseId;
  await requireCourseScope(req, courseId);
  audit.courseId = courseId;
  return applyRetryZoomImport(d.recordingId);
});
