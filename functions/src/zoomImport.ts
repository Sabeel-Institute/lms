import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  deriveDurationSec,
  mediaStorageKey,
  type CourseDoc,
  type MediaItem,
  type RecordingDoc,
  type SessionDoc,
  type ZoomImportDoc,
  type ZoomImportRow,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { reportedCall } from './reported';
import { reportError } from './sentry';
import { requireCourseScope, requireStaff } from './guards';
import { MAX_AUDIO_BYTES, draftInTransaction, finalizeRecording } from './recordings';
import { MEDIA_WRITE_SECRETS, deleteObject } from './mediaStore';
import { ZOOM_SECRETS, zoomClient, type ZoomAudioRecording, type ZoomClient } from './zoom';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Copy one Zoom file into its item, confirm it, and settle the recording.
 *
 * On success the item is `ready` and the recording a draft again (which also
 * un-sticks a retried import). On failure the item is `failed` with the reason
 * and the recording needs attention, so staff can retry rather than losing it.
 */
async function copyIntoItem(
  recordingId: string,
  item: MediaItem,
  downloadUrl: string,
  zoom: { durationSec: number; sizeBytes: number },
  client: ZoomClient,
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.recordings).doc(recordingId);
  try {
    // ON ITS WAY IN AGAIN, in the document and not only here: a retry starts
    // from a `failed` item, and only an item that is copying can be confirmed.
    await db.runTransaction(async (tx) => {
      const rec = (await tx.get(ref)).data() as RecordingDoc | undefined;
      const current = rec?.media[item.id];
      if (!rec || !current) throw new Error('the recording or its file was removed');
      tx.update(ref, { [`media.${item.id}`]: { ...current, status: 'copying', failReason: null } });
    });
    // The copy is write-once, like every upload. Whatever an earlier attempt
    // at this item left is removed first: only an item that never became
    // ready gets here, so nothing a student can hear is at stake.
    await deleteObject(item.storageKey);
    await client.copyToMediaStore(downloadUrl, item.storageKey, zoom.sizeBytes);
    await finalizeRecording({ recordingId, itemId: item.id, durationSec: zoom.durationSec });
    await ref.update({ status: 'draft', attentionReason: FieldValue.delete(), updatedAt: Date.now() });
  } catch (e) {
    const reason = `Zoom import failed: ${(e as Error).message}`.slice(0, 300);
    await db.runTransaction(async (tx) => {
      const rec = (await tx.get(ref)).data() as RecordingDoc | undefined;
      const current = rec?.media[item.id];
      if (!rec || !current) return;
      tx.update(ref, {
        [`media.${item.id}`]: { ...current, status: 'failed', failReason: reason },
        status: 'needsAttention',
        attentionReason: reason,
        updatedAt: Date.now(),
      });
    });
    // Reported here, because what is thrown next is an HttpsError and the
    // wrappers deliberately do not send those to Sentry — so a copy that died
    // left a recording in needs-attention and no trace of why anywhere but the
    // recording itself.
    await reportError(e, { source: 'zoomImport', recordingId });
    throw new HttpsError('internal', reason);
  }
}

/** A Zoom audio file as a media item on its way in. */
function zoomItem(recordingId: string, itemId: string, rec: ZoomAudioRecording, callerUid: string): MediaItem {
  return {
    id: itemId,
    part: 1,
    version: 'audio',
    kind: 'audio',
    label: null,
    status: 'copying',
    failReason: null,
    hidden: false,
    storageKey: mediaStorageKey(recordingId, itemId),
    contentType: 'audio/mp4',
    sizeBytes: rec.sizeBytes,
    durationSec: rec.durationSec,
    width: null,
    height: null,
    source: 'zoom',
    zoom: {
      meetingUuid: rec.meetingUuid,
      fileId: rec.fileId,
      recordingType: 'audio_only',
      segmentStart: rec.startTime,
      topic: rec.topic,
    },
    addedAt: Date.now(),
    addedBy: callerUid,
  };
}

/**
 * Import one Zoom file into a session as its draft recording.
 *
 * THE FILE IS CLAIMED IN THE SAME TRANSACTION THAT CREATES THE DRAFT AND ITS
 * ITEM (`zoomImports/{fileId}`), so a double tap or two staff importing the
 * same file into two sessions cannot both succeed: the second reads the claim
 * and is told where the file went. The bytes are copied afterwards, outside
 * the transaction.
 */
export async function applyImportZoomRecording(
  callerUid: string,
  input: { meetingUuid: string; fileId: string; sessionId: string },
  client: ZoomClient,
): Promise<{ recordingId: string; alreadyExisted: boolean }> {
  const db = getFirestore();
  const claimRef = db.collection(COLLECTIONS.zoomImports).doc(input.fileId);
  const claim = await claimRef.get();
  if (claim.exists) {
    const prior = claim.data() as ZoomImportDoc;
    const recSnap = await db.collection(COLLECTIONS.recordings).doc(prior.recordingId).get();
    const item = recSnap.exists ? (recSnap.data() as RecordingDoc).media[prior.itemId] : undefined;
    // A FILE THAT NEVER ARRIVED IS NOT AN IMPORT THAT ALREADY HAPPENED. The
    // item is claimed before the copy, so an attempt that died mid-transfer
    // leaves one behind, and answering "already imported" to the retry
    // reports success for a recording that plays nothing. Finish the job —
    // but only for the session that asked; a claim belonging to another
    // session is somebody else's import.
    if (item && item.status !== 'ready' && prior.sessionId === input.sessionId) {
      await applyRetryZoomImport(prior.recordingId, client);
      return { recordingId: prior.recordingId, alreadyExisted: false };
    }
    if (item) return { recordingId: prior.recordingId, alreadyExisted: true };
    // A claim whose item is gone was left by a delete that did not finish;
    // the transaction below takes it over.
  }

  // Re-read the meeting for a FRESH download URL + authoritative metadata.
  const { rec, downloadUrl } = await client.freshAudioFile(input.meetingUuid, input.fileId);
  if (rec.sizeBytes > MAX_AUDIO_BYTES) {
    const mb = Math.round(MAX_AUDIO_BYTES / 1024 / 1024);
    throw new HttpsError('failed-precondition', `That recording's audio is larger than the ${mb} MB limit.`);
  }

  const sessionRef = db.collection(COLLECTIONS.sessions).doc(input.sessionId);
  const ref = db.collection(COLLECTIONS.recordings).doc();
  const itemId = db.collection(COLLECTIONS.recordings).doc().id;
  const item = zoomItem(ref.id, itemId, rec, callerUid);
  await db.runTransaction(async (tx) => {
    const current = await tx.get(claimRef);
    if (current.exists) {
      const other = current.data() as ZoomImportDoc;
      const owner = await tx.get(db.collection(COLLECTIONS.recordings).doc(other.recordingId));
      if (owner.exists && (owner.data() as RecordingDoc).media[other.itemId]) {
        throw new HttpsError('already-exists', 'That Zoom file is already being imported.');
      }
    }
    const draft = await draftInTransaction(tx, sessionRef, ref, callerUid, 'zoom');
    const media = { [itemId]: item };
    tx.update(ref, { media, durationSec: deriveDurationSec(media) });
    const claimDoc: ZoomImportDoc = {
      recordingId: ref.id,
      itemId,
      sessionId: input.sessionId,
      courseId: draft.courseId,
      meetingUuid: rec.meetingUuid,
      claimedAt: Date.now(),
    };
    tx.set(claimRef, claimDoc);
  });

  await copyIntoItem(ref.id, item, downloadUrl, rec, client);
  return { recordingId: ref.id, alreadyExisted: false };
}

/** Retry every Zoom file on a recording that never arrived. */
export async function applyRetryZoomImport(
  recordingId: string,
  client: ZoomClient,
): Promise<{ recordingId: string }> {
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const rec = snap.data() as RecordingDoc;
  // ONLY FILES THAT NEVER FINISHED, and only off a recording that is not
  // live. A retry deletes and rewrites the object and drops the status to
  // `draft`, which on a recording out in the world is an unpublish nobody
  // asked for: the fan-out switches every grant off. The button appears only
  // on a failed import; the callable has to be the judge too.
  if (rec.status !== 'draft' && rec.status !== 'needsAttention') {
    throw new HttpsError('failed-precondition', 'That recording already has its audio.');
  }
  const zoomItems = Object.values(rec.media).filter((i) => i.zoom);
  if (zoomItems.length === 0) {
    throw new HttpsError('failed-precondition', 'That recording is not a Zoom import.');
  }
  const pending = zoomItems.filter((i) => i.status !== 'ready');
  if (pending.length === 0) {
    // EVERY FILE ARRIVED BUT THE STATUS NEVER SETTLED: `copyIntoItem` confirms
    // the item, then writes `draft`, and a transient failure on that last write
    // leaves the recording needing attention with nothing left to copy. The
    // one button the screen offers for it has to finish the job.
    await snap.ref.update({ status: 'draft', attentionReason: FieldValue.delete(), updatedAt: Date.now() });
    return { recordingId };
  }
  for (const item of pending) {
    const ref = item.zoom as NonNullable<MediaItem['zoom']>;
    const { rec: fresh, downloadUrl } = await client.freshAudioFile(ref.meetingUuid, ref.fileId);
    await copyIntoItem(recordingId, item, downloadUrl, fresh, client);
  }
  return { recordingId };
}

// ---------------------------------------------------------------- callables --

/**
 * Moving a class recording is not a normal callable.
 *
 * The bytes go from Zoom to the bucket through the Cloudflare Worker, not
 * through here, but the callable waits for the copy: about 6 s for a 100 MB
 * audio file, longer when Zoom is slow. The platform default of 60 s would turn
 * a slow day into an import that "did not work" the first time and worked the
 * second. The client timeout is raised to match in app/src/zoom.ts; raising
 * only one end just moves which side gives up.
 */
const IMPORT_RUNTIME = { timeoutSeconds: 540 } as const;

export const listZoomRecordings = reportedCall(async (req) => {
  requireStaff(req); // the central list is not class-specific
  const d = req.data as { from?: unknown; to?: unknown };
  const from = typeof d?.from === 'string' ? d.from : '';
  const to = typeof d?.to === 'string' ? d.to : '';
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) {
    throw new HttpsError('invalid-argument', 'from and to must be YYYY-MM-DD.');
  }
  if (from > to) throw new HttpsError('invalid-argument', 'The range ends before it starts.');
  const recs = await zoomClient.listAudioRecordings(from, to);
  return annotateImported(recs);
}, ZOOM_SECRETS);

/**
 * Mark which of Zoom's recordings this institute already has, and name the class.
 *
 * SEPARATE FROM THE CALLABLE so it can be tested: `listZoomRecordings` closes
 * over the module-level `zoomClient`, which needs credentials that exist only in
 * Secret Manager, so nothing about the list could be exercised anywhere — and
 * this is the whole of what it does beyond the fetch. Returning
 * `alreadyImported: null` for every row is invisible to a type checker and turns
 * the picker into an invitation to import everything a second time.
 *
 * One read of the claims (`zoomImports`), then one read per DISTINCT class actually
 * referenced — not per row: a term of imports from four classes costs four reads
 * however many recordings Zoom returns.
 */
export async function annotateImported(recs: ZoomAudioRecording[]): Promise<ZoomImportRow[]> {
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

  return recs.map((r) => {
    const imp = byFile.get(r.fileId);
    return {
      ...r,
      alreadyImported: imp?.recordingId ?? null,
      importedCourseName: imp ? (courseNames.get(imp.courseId) ?? null) : null,
    };
  });
}

export const importZoomRecording = auditedCall(
  'importZoomRecording',
  async (req, audit) => {
    const d = req.data as { meetingUuid?: unknown; fileId?: unknown; sessionId?: unknown };
    if (typeof d?.meetingUuid !== 'string' || !d.meetingUuid) {
      throw new HttpsError('invalid-argument', 'meetingUuid is required.');
    }
    if (typeof d?.fileId !== 'string' || !d.fileId) {
      throw new HttpsError('invalid-argument', 'fileId is required.');
    }
    if (typeof d?.sessionId !== 'string' || !d.sessionId) {
      throw new HttpsError('invalid-argument', 'sessionId is required.');
    }
    const sessionSnap = await getFirestore()
      .collection(COLLECTIONS.sessions)
      .doc(d.sessionId)
      .get();
    if (!sessionSnap.exists) throw new HttpsError('not-found', 'No such session.');
    const courseId = (sessionSnap.data() as SessionDoc).courseId;
    const uid = await requireCourseScope(req, courseId);
    audit.courseId = courseId;
    const res = await applyImportZoomRecording(
      uid,
      { meetingUuid: d.meetingUuid, fileId: d.fileId, sessionId: d.sessionId },
      zoomClient,
    );
    audit.targets = { recordingId: res.recordingId, sessionId: d.sessionId };
    return res;
  },
  [...ZOOM_SECRETS, ...MEDIA_WRITE_SECRETS],
  IMPORT_RUNTIME,
);

export const retryZoomImport = auditedCall(
  'retryZoomImport',
  async (req, audit) => {
    const d = req.data as { recordingId?: unknown };
    if (typeof d?.recordingId !== 'string' || !d.recordingId) {
      throw new HttpsError('invalid-argument', 'recordingId is required.');
    }
    const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(d.recordingId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
    const courseId = (snap.data() as RecordingDoc).courseId;
    await requireCourseScope(req, courseId);
    audit.courseId = courseId;
    return applyRetryZoomImport(d.recordingId, zoomClient);
  },
  [...ZOOM_SECRETS, ...MEDIA_WRITE_SECRETS],
  IMPORT_RUNTIME,
);
