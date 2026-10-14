import { HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  UPLOAD_CONFIRM_SECONDS,
  UPLOAD_PART_BYTES,
  UPLOAD_TYPES,
  isVideoContentType,
  maxUploadBytes,
  mediaStorageKey,
  uploadPartCount,
  type MediaItem,
  type RecordingDoc,
  type UploadContentType,
  type UploadPlacement,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { reportedCall, SENTRY_DSN } from './reported';
import { requireCourseScope } from './guards';
import {
  MEDIA_WRITE_SECRETS,
  abortMultipart,
  completeMultipart,
  deleteObject,
  head,
  signPartPut,
  startMultipart,
} from './mediaStore';
import { UnreadableMedia, judgeProbe, probeObject } from './mediaProbe';
import { writeItem } from './mediaWrite';
import { reportError } from './sentry';
import { sweepAttachmentUploads } from './attachments';

/**
 * Staff uploads: one or more audio or video files onto a recording, each a new
 * part or another version of a part (docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md,
 * "Staff upload").
 *
 * The bytes go straight from the browser or phone to the bucket, never through
 * a Function: an 8 GiB video would meet the 60-minute timeout, and the bytes
 * would be paid for twice. EVERY upload is multipart, in `UPLOAD_PART_BYTES`
 * pieces: a dropped connection costs one piece rather than the file, and one
 * code path serves a 3 MB lecture and a 6 GB one.
 *
 *   start    → an `uploading` item, a multipart upload, a `mediaUploads` doc
 *   sign     → URLs for a few parts at a time, each good for an hour
 *   finalize → join the parts, check the size, PROBE what arrived, then
 *              `ready` with the length read from the file, or deleted with a
 *              reason the uploader can act on
 *
 * Anything that never finishes is cleared: Remove on the session page aborts
 * it at once (`removeMedia`), the daily sweep catches the rest, and the bucket
 * itself drops unfinished multipart uploads after a day
 * (`cloudflare/media-bucket/lifecycle.json`).
 */

/** How long a part URL lasts. Parts are signed a few at a time as the upload
 *  goes, so this only has to cover one batch on a slow connection. */
const PART_URL_TTL_MS = 60 * 60 * 1000;
/** Parts signed per request. */
const MAX_PARTS_PER_SIGN = 16;
/** An upload untouched for this long is abandoned; the bucket's own rule is the same day. */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Server-only record of an upload in flight (`mediaUploads/{itemId}`). */
export interface UploadDoc {
  recordingId: string;
  storageKey: string;
  uploadId: string;
  contentType: UploadContentType;
  sizeBytes: number;
  partCount: number;
  startedAt: number;
  startedBy: string;
}

const uploadRef = (itemId: string) => getFirestore().collection(COLLECTIONS.mediaUploads).doc(itemId);
const recordingRef = (id: string) => getFirestore().collection(COLLECTIONS.recordings).doc(id);

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpsError('invalid-argument', `${name} is required.`);
  return v;
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// ----------------------------------------------------------------- start --

export interface StartUploadInput {
  recordingId: string;
  contentType: UploadContentType;
  sizeBytes: number;
  placement: UploadPlacement;
}

export function validateStartUpload(data: unknown): StartUploadInput {
  const d = data as Partial<Record<keyof StartUploadInput, unknown>> | null;
  const recordingId = requireString(d?.recordingId, 'recordingId');
  const contentType = d?.contentType;
  if (!(Object.values(UPLOAD_TYPES) as unknown[]).includes(contentType)) {
    throw new HttpsError('invalid-argument', 'That kind of file cannot be uploaded. Use M4A, MP3, WAV or MP4.');
  }
  const type = contentType as UploadContentType;
  if (!isPositiveInt(d?.sizeBytes)) {
    throw new HttpsError('invalid-argument', 'sizeBytes must be a positive whole number.');
  }
  if (d.sizeBytes > maxUploadBytes(type)) {
    throw new HttpsError(
      'invalid-argument',
      isVideoContentType(type) ? 'That video is too large (8 GB at most).' : 'That audio file is too large (300 MB at most).',
    );
  }
  const p = d.placement as { as?: unknown; part?: unknown } | undefined;
  let placement: UploadPlacement;
  if (p?.as === 'part') placement = { as: 'part' };
  else if (p?.as === 'version' && isPositiveInt(p.part)) placement = { as: 'version', part: p.part };
  else throw new HttpsError('invalid-argument', 'placement must be a new part, or a version of a part.');
  return { recordingId, contentType: type, sizeBytes: d.sizeBytes, placement };
}

/**
 * Add an `uploading` item and open a multipart upload for it.
 *
 * ON A RECORDING IN ANY STATE. Adding a file to a published recording is the
 * fix for "the second half was in another file", and it is safe: the item is
 * invisible to students until it is ready, and a ready file never changes.
 *
 * ONE VERSION OF A KIND PER PART. A second "Video" of Part 1 would put two
 * identical choices side by side in the student's player; a failed one does
 * not count, since it is only there to be removed or retried.
 */
export async function startUpload(callerUid: string, input: StartUploadInput) {
  const db = getFirestore();
  const itemId = db.collection(COLLECTIONS.recordings).doc().id;
  const storageKey = mediaStorageKey(input.recordingId, itemId);
  const video = isVideoContentType(input.contentType);
  const partCount = uploadPartCount(input.sizeBytes);
  const uploadId = await startMultipart(storageKey, input.contentType);
  try {
    await db.runTransaction(async (tx) => {
      const ref = recordingRef(input.recordingId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
      const rec = snap.data() as RecordingDoc;
      const live = Object.values(rec.media).filter((i) => i.status !== 'failed');
      let part: number;
      if (input.placement.as === 'part') {
        part = Math.max(0, ...Object.values(rec.media).map((i) => i.part)) + 1;
      } else {
        part = input.placement.part;
        if (!live.some((i) => i.part === part)) {
          throw new HttpsError('failed-precondition', 'That part is not on this recording any more.');
        }
      }
      const version = video ? 'video' : 'audio';
      if (live.some((i) => i.part === part && i.version === version)) {
        throw new HttpsError(
          'failed-precondition',
          `That part already has ${video ? 'an uploaded video' : 'an audio'} version. Add this one as a new part, or remove that one first.`,
        );
      }
      const item: MediaItem = {
        id: itemId,
        part,
        version,
        kind: video ? 'video' : 'audio',
        label: null,
        status: 'uploading',
        failReason: null,
        hidden: false,
        storageKey,
        contentType: input.contentType,
        sizeBytes: null,
        durationSec: null,
        width: null,
        height: null,
        source: 'upload',
        zoom: null,
        addedAt: Date.now(),
        addedBy: callerUid,
      };
      writeItem(tx, ref, rec, itemId, item);
      const upload: UploadDoc = {
        recordingId: input.recordingId,
        storageKey,
        uploadId,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        partCount,
        startedAt: Date.now(),
        startedBy: callerUid,
      };
      tx.set(uploadRef(itemId), upload);
    });
  } catch (e) {
    await abortMultipart(storageKey, uploadId);
    throw e;
  }
  return { itemId, partBytes: UPLOAD_PART_BYTES, partCount };
}

/** The course a recording belongs to, which every upload call is scoped by. */
async function courseOf(recordingId: string): Promise<string> {
  const rec = await recordingRef(recordingId).get();
  if (!rec.exists) throw new HttpsError('not-found', 'No such recording.');
  return (rec.data() as RecordingDoc).courseId;
}

/**
 * Not audited: nothing anyone reads changes until the file is confirmed, and
 * that is audited (`finalizeRecordingUpload`).
 */
export const startRecordingUpload = reportedCall(async (req) => {
  const input = validateStartUpload(req.data);
  const uid = await requireCourseScope(req, await courseOf(input.recordingId));
  return startUpload(uid, input);
}, MEDIA_WRITE_SECRETS);

// ------------------------------------------------------------------ sign --

/** The upload behind an item, checked against the recording it claims. */
async function openUpload(recordingId: string, itemId: string): Promise<UploadDoc> {
  const snap = await uploadRef(itemId).get();
  const upload = snap.data() as UploadDoc | undefined;
  if (!upload || upload.recordingId !== recordingId) {
    throw new HttpsError('failed-precondition', 'That upload is not in progress. Start it again.');
  }
  return upload;
}

export interface SignPartsInput {
  recordingId: string;
  itemId: string;
  partNumbers: number[];
}

export function validateSignParts(data: unknown): SignPartsInput {
  const d = data as Partial<Record<keyof SignPartsInput, unknown>> | null;
  const recordingId = requireString(d?.recordingId, 'recordingId');
  const itemId = requireString(d?.itemId, 'itemId');
  const parts = d?.partNumbers;
  if (
    !Array.isArray(parts) ||
    parts.length === 0 ||
    parts.length > MAX_PARTS_PER_SIGN ||
    !parts.every(isPositiveInt) ||
    new Set(parts).size !== parts.length
  ) {
    throw new HttpsError('invalid-argument', `partNumbers must be 1 to ${MAX_PARTS_PER_SIGN} distinct part numbers.`);
  }
  return { recordingId, itemId, partNumbers: parts as number[] };
}

export async function signParts(input: SignPartsInput): Promise<{ urls: Record<number, string> }> {
  const upload = await openUpload(input.recordingId, input.itemId);
  if (input.partNumbers.some((n) => n > upload.partCount)) {
    throw new HttpsError('invalid-argument', `This upload has ${upload.partCount} parts.`);
  }
  const urls: Record<number, string> = {};
  for (const n of input.partNumbers) {
    urls[n] = await signPartPut(upload.storageKey, upload.uploadId, n, PART_URL_TTL_MS);
  }
  return { urls };
}

export const signRecordingUploadParts = reportedCall(async (req) => {
  const input = validateSignParts(req.data);
  await requireCourseScope(req, await courseOf(input.recordingId));
  return signParts(input);
}, MEDIA_WRITE_SECRETS);

// -------------------------------------------------------------- finalize --

export interface FinalizeUploadInput {
  recordingId: string;
  itemId: string;
  parts: { partNumber: number; etag: string }[];
}

export function validateFinalizeUpload(data: unknown): FinalizeUploadInput {
  const d = data as Partial<Record<keyof FinalizeUploadInput, unknown>> | null;
  const recordingId = requireString(d?.recordingId, 'recordingId');
  const itemId = requireString(d?.itemId, 'itemId');
  const parts = d?.parts;
  if (
    !Array.isArray(parts) ||
    !parts.every(
      (p: { partNumber?: unknown; etag?: unknown }) =>
        isPositiveInt(p?.partNumber) && typeof p.etag === 'string' && p.etag.length > 0 && p.etag.length < 200,
    )
  ) {
    throw new HttpsError('invalid-argument', 'parts must list each part number with its ETag.');
  }
  return { recordingId, itemId, parts: parts as FinalizeUploadInput['parts'] };
}

/** Take a file off its recording and out of the bucket, with the reason the uploader is told. */
async function discard(input: { recordingId: string; itemId: string }, upload: UploadDoc, reason: string): Promise<never> {
  await deleteObject(upload.storageKey);
  const db = getFirestore();
  await db.runTransaction(async (tx) => {
    const ref = recordingRef(input.recordingId);
    const rec = (await tx.get(ref)).data() as RecordingDoc | undefined;
    if (rec?.media[input.itemId]) writeItem(tx, ref, rec, input.itemId, null);
    tx.delete(uploadRef(input.itemId));
  });
  throw new HttpsError('failed-precondition', reason);
}

/**
 * Join the parts, then decide from what actually arrived.
 *
 * Every part, each once: a missing piece would join into a file that is
 * quietly shorter than the class. Then the SIZE from the bucket (the URLs
 * cannot sign one), then the PROBE: a file phones cannot play is deleted and
 * its item removed, with a sentence saying how to export it instead. The
 * length is the probe's, read from the file — not the uploader's device's.
 */
export async function finalizeUpload(input: FinalizeUploadInput) {
  const upload = await openUpload(input.recordingId, input.itemId);
  const numbers = input.parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (numbers.length !== upload.partCount || numbers.some((n, i) => n !== i + 1)) {
    throw new HttpsError('invalid-argument', `This upload has ${upload.partCount} parts, and every one must be listed once.`);
  }
  const rec = (await recordingRef(input.recordingId).get()).data() as RecordingDoc | undefined;
  if (rec?.media[input.itemId]?.status !== 'uploading') {
    throw new HttpsError('failed-precondition', 'That file is not waiting to be confirmed.');
  }
  try {
    await completeMultipart(
      upload.storageKey,
      upload.uploadId,
      [...input.parts].sort((a, b) => a.partNumber - b.partNumber),
    );
  } catch {
    throw new HttpsError('failed-precondition', 'The file did not arrive whole. Remove it and upload it again.');
  }
  const object = await head(upload.storageKey);
  if (!object) throw new HttpsError('failed-precondition', 'No file found for that upload.');
  if (object.sizeBytes > maxUploadBytes(upload.contentType)) {
    return discard(input, upload, isVideoContentType(upload.contentType)
      ? 'That video is too large (8 GB at most).'
      : 'That audio file is too large (300 MB at most).');
  }
  let verdict;
  try {
    verdict = judgeProbe(
      await probeObject(upload.storageKey, object.sizeBytes),
      isVideoContentType(upload.contentType) ? 'video' : 'audio',
    );
  } catch (e) {
    if (!(e instanceof UnreadableMedia)) throw e;
    verdict = { ok: false as const, reason: 'This file could not be read as audio or video. Export it again and upload the new file.' };
  }
  if (!verdict.ok) return discard(input, upload, verdict.reason);

  const durationSec = verdict.durationSec;
  const db = getFirestore();
  const removedMeanwhile = await db.runTransaction(async (tx) => {
    const ref = recordingRef(input.recordingId);
    const fresh = (await tx.get(ref)).data() as RecordingDoc | undefined;
    const current = fresh?.media[input.itemId];
    tx.delete(uploadRef(input.itemId));
    // CONFIRMED ALREADY, by another call for the same upload: a client, or
    // the HTTP layer under it, sending finalize twice. The file is in place;
    // read as removed, its bytes were deleted from under a ready file.
    if (current?.status === 'ready' && current.storageKey === upload.storageKey) return false;
    if (!fresh || current?.status !== 'uploading') return true;
    writeItem(tx, ref, fresh, input.itemId, {
      ...current,
      status: 'ready',
      failReason: null,
      sizeBytes: object.sizeBytes,
      durationSec,
    });
    return false;
  });
  // Removed while it was being confirmed (Remove pressed, or the recording
  // deleted): nothing points at the object any more.
  if (removedMeanwhile) {
    await deleteObject(upload.storageKey);
    throw new HttpsError('not-found', 'That file was removed.');
  }
  return { recordingId: input.recordingId, itemId: input.itemId, sizeBytes: object.sizeBytes, durationSec };
}

export const finalizeRecordingUpload = auditedCall(
  'finalizeRecordingUpload',
  async (req, audit) => {
    const input = validateFinalizeUpload(req.data);
    const courseId = await courseOf(input.recordingId);
    await requireCourseScope(req, courseId);
    audit.courseId = courseId;
    audit.detail = { itemId: input.itemId };
    return finalizeUpload(input);
  },
  MEDIA_WRITE_SECRETS,
  // Joining parts and probing take seconds; the default minute is ample, but
  // a slow bucket on an 8 GiB join should not be what fails it.
  { timeoutSeconds: UPLOAD_CONFIRM_SECONDS },
);

// ----------------------------------------------------------------- abort --

/** Stop an upload in flight, if one is: its parts go, its record goes. */
export async function abortUpload(itemId: string): Promise<void> {
  const upload = (await uploadRef(itemId).get()).data() as UploadDoc | undefined;
  if (!upload) return;
  await abortMultipart(upload.storageKey, upload.uploadId);
  await uploadRef(itemId).delete();
}

// ----------------------------------------------------------------- sweep --

/**
 * Clear every upload started more than a day ago and never finished: a tab
 * closed mid-upload, a phone that lost signal for good. Its item goes too, so
 * the session page stops saying "upload not finished" and nothing blocks
 * publishing. Returns how many it cleared.
 */
export async function sweepUploads(now: number): Promise<number> {
  const db = getFirestore();
  const stale = await db
    .collection(COLLECTIONS.mediaUploads)
    .where('startedAt', '<', now - ABANDONED_AFTER_MS)
    .get();
  for (const doc of stale.docs) {
    const upload = doc.data() as UploadDoc;
    await abortMultipart(upload.storageKey, upload.uploadId);
    await deleteObject(upload.storageKey);
    await db.runTransaction(async (tx) => {
      const ref = recordingRef(upload.recordingId);
      const rec = (await tx.get(ref)).data() as RecordingDoc | undefined;
      if (rec?.media[doc.id]?.status === 'uploading') writeItem(tx, ref, rec, doc.id, null);
      tx.delete(doc.ref);
    });
  }
  return stale.size;
}

export const sweepAbandonedUploads = onSchedule(
  { schedule: '30 3 * * *', timeZone: INSTITUTE_TIMEZONE, secrets: [SENTRY_DSN, ...MEDIA_WRITE_SECRETS] },
  async () => {
    try {
      const now = Date.now();
      console.log(`upload sweep: ${await sweepUploads(now)} uploads, ${await sweepAttachmentUploads(now)} attachments cleared`);
    } catch (e) {
      await reportError(e, { source: 'sweepAbandonedUploads' });
      throw e;
    }
  },
);
