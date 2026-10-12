import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  audioStoragePath,
  isEmptyDraft,
  type CourseDoc,
  type RecordingDoc,
  type SessionDoc,
  type ZoomImportRow,
} from '@sabeel/shared';
import { auditedCall } from './audited';
import { reportedCall } from './reported';
import { reportError } from './sentry';
import { requireCourseScope, requireStaff } from './guards';
import { MAX_AUDIO_BYTES, createRecordingDraft, finalizeRecording } from './recordings';
import { MEDIA_WRITE_SECRETS, deleteObject } from './mediaStore';
import { ZOOM_SECRETS, zoomClient, type ZoomAudioRecording, type ZoomClient } from './zoom';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stream the audio into a recording, finalize it, and settle its status.
 *
 * On success the recording is a ready draft (status draft, attentionReason
 * cleared — that also un-sticks a retried import). On failure the recording is
 * left in `needsAttention` with a reason, so staff can retry it rather than
 * losing the draft.
 */
async function downloadIntoRecording(
  recordingId: string,
  downloadUrl: string,
  zoom: { durationSec: number; sizeBytes: number },
  client: ZoomClient,
): Promise<void> {
  const ref = getFirestore().collection(COLLECTIONS.recordings).doc(recordingId);
  const key = audioStoragePath(recordingId);
  try {
    // The copy is write-once, like every upload. Whatever an earlier attempt
    // left is removed first: this only runs on a draft or needs-attention
    // recording (the callers check), so nothing a student can hear is at stake.
    await deleteObject(key);
    await client.copyToMediaStore(downloadUrl, key, zoom.sizeBytes);
    await finalizeRecording({ recordingId, durationSec: zoom.durationSec });
    await ref.update({
      status: 'draft',
      attentionReason: FieldValue.delete(),
      updatedAt: Date.now(),
    });
  } catch (e) {
    const reason = `Zoom import failed: ${(e as Error).message}`.slice(0, 300);
    await ref.update({ status: 'needsAttention', attentionReason: reason, updatedAt: Date.now() });
    // Reported here, because what is thrown next is an HttpsError and the
    // wrappers deliberately do not send those to Sentry — so a download that
    // died left a recording in needs-attention and no trace of why anywhere
    // but the recording itself.
    await reportError(e, { source: 'zoomImport', recordingId });
    throw new HttpsError('internal', reason);
  }
}

/** Import one Zoom recording into a session as its draft. Idempotent on the meeting UUID. */
export async function applyImportZoomRecording(
  callerUid: string,
  input: { meetingUuid: string; fileId: string; sessionId: string },
  client: ZoomClient,
): Promise<{ recordingId: string; alreadyExisted: boolean }> {
  const db = getFirestore();
  // Dedupe: one Zoom recording maps to at most one app recording.
  const dupe = await db
    .collection(COLLECTIONS.recordings)
    .where('zoomUuid', '==', input.meetingUuid)
    .limit(1)
    .get();
  if (!dupe.empty) {
    const existing = dupe.docs[0];
    const prior = existing.data() as RecordingDoc;
    // A DRAFT WITH NO AUDIO IS NOT AN IMPORT THAT ALREADY HAPPENED. The draft is
    // created before the download, so an attempt that died mid-transfer leaves
    // one behind — and answering "already imported" to the retry reports success
    // for a recording that plays nothing, which is exactly how staff end up
    // publishing an empty one. Finish the job instead.
    //
    // Only for the session that asked: the dedupe is global on the meeting uuid,
    // so a draft belonging to a DIFFERENT session is somebody else's import and
    // still answers "already imported" rather than being quietly adopted here.
    if (!prior.audioPath && prior.sessionId === input.sessionId) {
      await applyRetryZoomImport(existing.id, client);
      return { recordingId: existing.id, alreadyExisted: false };
    }
    return { recordingId: existing.id, alreadyExisted: true };
  }

  // Re-read the meeting for a FRESH download URL + authoritative metadata.
  const { rec, downloadUrl } = await client.freshAudioFile(input.meetingUuid, input.fileId);
  if (rec.sizeBytes > MAX_AUDIO_BYTES) {
    const mb = Math.round(MAX_AUDIO_BYTES / 1024 / 1024);
    throw new HttpsError('failed-precondition', `That recording's audio is larger than the ${mb} MB limit.`);
  }

  // The session owns title/date/due; the recording is pure media. createRecordingDraft
  // refuses a session that already has a recording.
  const { id } = await createRecordingDraft(
    callerUid,
    { sessionId: input.sessionId },
    { source: 'zoom', zoomUuid: input.meetingUuid, zoomFileId: rec.fileId },
  );

  await downloadIntoRecording(id, downloadUrl, rec, client);
  return { recordingId: id, alreadyExisted: false };
}

/** Retry a failed Zoom import using the refs stored on the recording. */
export async function applyRetryZoomImport(
  recordingId: string,
  client: ZoomClient,
): Promise<{ recordingId: string }> {
  const snap = await getFirestore().collection(COLLECTIONS.recordings).doc(recordingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such recording.');
  const rec = snap.data() as RecordingDoc;
  if (rec.source !== 'zoom' || !rec.zoomUuid || !rec.zoomFileId) {
    throw new HttpsError('failed-precondition', 'That recording is not a Zoom import.');
  }
  // ONLY AN IMPORT THAT NEVER FINISHED. A retry writes over the audio object
  // and drops the status to `draft`, which on a recording that has its audio
  // and is out in the world is an unpublish nobody asked for: the fan-out
  // switches every grant off, and the audit row reads "Retried a Zoom
  // import". The button appears only on a failed import; the callable has to
  // be the judge too. Needs-attention itself is always retryable, audio or
  // not: `downloadIntoRecording` finalizes (which records `audioPath`) BEFORE
  // it settles the status, so a failure on that last write leaves the audio
  // in place under needs-attention — and a recording reaches needs-attention
  // only from a draft, so nothing granted is at stake.
  if (rec.status !== 'needsAttention' && !isEmptyDraft(rec)) {
    throw new HttpsError('failed-precondition', 'That recording already has its audio.');
  }
  const { rec: fresh, downloadUrl } = await client.freshAudioFile(rec.zoomUuid, rec.zoomFileId);
  await downloadIntoRecording(recordingId, downloadUrl, fresh, client);
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
 * One query for the mapping, then one read per DISTINCT class actually
 * referenced — not per row: a term of imports from four classes costs four reads
 * however many recordings Zoom returns.
 */
export async function annotateImported(recs: ZoomAudioRecording[]): Promise<ZoomImportRow[]> {
  const db = getFirestore();
  const imported = await db.collection(COLLECTIONS.recordings).where('source', '==', 'zoom').get();
  const byUuid = new Map<string, { recordingId: string; courseId: string }>();
  for (const doc of imported.docs) {
    const data = doc.data() as RecordingDoc;
    if (data.zoomUuid) byUuid.set(data.zoomUuid, { recordingId: doc.id, courseId: data.courseId });
  }

  const courseNames = new Map<string, string>();
  await Promise.all(
    [...new Set([...byUuid.values()].map((v) => v.courseId))].map(async (id) => {
      const s = await db.collection(COLLECTIONS.courses).doc(id).get();
      if (s.exists) courseNames.set(id, (s.data() as CourseDoc).name);
    }),
  );

  return recs.map((r) => {
    const imp = byUuid.get(r.meetingUuid);
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
