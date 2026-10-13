import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  type MediaItem,
  type RecordingDoc,
  type ZoomImportDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSessionRecord } from '../../src/sessions';
import { MAX_AUDIO_BYTES, applyDeleteRecording, finalizeRecording, removeMedia, startUpload } from '../../src/recordings';
import { annotateImported, applyImportZoomRecording, applyRetryZoomImport } from '../../src/zoomImport';
import type { ZoomAudioRecording, ZoomClient } from '../../src/zoom';
import { clearPrefix, objectExists, objectInfo, putObject } from './mediaObjects';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';

async function clearAll() {
  const db = getFirestore();
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.recordings, COLLECTIONS.zoomImports]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('media/');
}

let courseId = '';
let sessionId = '';
beforeEach(async () => {
  await clearAll();
  const { id: cohortId } = await createCohortRecord(ADMIN, 'C');
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'K' }));
  ({ id: sessionId } = await createSessionRecord(ADMIN, {
    courseId,
    date: '2026-05-07',
    title: 'Session One',
    // A real date — see the note in `recordings.integration.test.ts`.
    dueDate: '2099-01-01',
    notes: '',
  }));
});

const REC: ZoomAudioRecording = {
  meetingUuid: 'uuid-1',
  topic: 'Zoom Session One',
  startTime: '2026-05-07T18:00:00Z',
  durationSec: 300,
  fileId: 'file-1',
  sizeBytes: 4096,
};

/** A ZoomClient that serves one recording and writes fake bytes on download. */
function fakeClient(rec: ZoomAudioRecording, opts: { fail?: boolean } = {}): ZoomClient {
  return {
    async listAudioRecordings() {
      return [rec];
    },
    async freshAudioFile(meetingUuid, fileId) {
      return { rec, downloadUrl: `fake://${meetingUuid}/${fileId}` };
    },
    async copyToMediaStore(_downloadUrl, key, sizeBytes) {
      if (opts.fail) throw new Error('network boom');
      // Write-once, like the real copy: an object already there is an error.
      if (await objectExists(key)) throw new Error(`refusing to overwrite ${key}`);
      await putObject(key, new Uint8Array(sizeBytes || 4096));
    },
  };
}

const rec = async (id: string) =>
  (await getFirestore().collection(COLLECTIONS.recordings).doc(id).get()).data() as RecordingDoc;
const countRecordings = async () =>
  (await getFirestore().collection(COLLECTIONS.recordings).get()).size;
/** The recording's one item: a Zoom import of one file makes exactly one. */
const itemOf = async (id: string): Promise<MediaItem> => {
  const items = Object.values((await rec(id)).media);
  expect(items).toHaveLength(1);
  return items[0];
};
const fileArrived = async (id: string) => objectExists((await itemOf(id)).storageKey);
const claimOf = async (fileId: string) =>
  (await getFirestore().collection(COLLECTIONS.zoomImports).doc(fileId).get()).data() as ZoomImportDoc | undefined;
/** The only recording, found the way staff find it: by the Zoom file's claim. */
const claimed = async () => {
  const c = await claimOf('file-1');
  expect(c).toBeDefined();
  return getFirestore().collection(COLLECTIONS.recordings).doc((c as ZoomImportDoc).recordingId).get();
};

describe('applyImportZoomRecording', () => {
  it('creates a ready draft: source zoom, the file claimed, metadata, audio confirmed', async () => {
    const res = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC),
    );
    expect(res.alreadyExisted).toBe(false);
    const d = await rec(res.recordingId);
    expect(d).toMatchObject({ sessionId, courseId, source: 'zoom', status: 'draft', durationSec: 300 });
    const item = await itemOf(res.recordingId);
    expect(item).toMatchObject({
      part: 1,
      version: 'audio',
      kind: 'audio',
      status: 'ready',
      source: 'zoom',
      sizeBytes: 4096, // read from the media store, not trusted from Zoom
      durationSec: 300,
      storageKey: `media/${res.recordingId}/${item.id}`,
      zoom: {
        meetingUuid: 'uuid-1',
        fileId: 'file-1',
        recordingType: 'audio_only',
        segmentStart: REC.startTime,
        topic: REC.topic,
      },
    });
    expect(await fileArrived(res.recordingId)).toBe(true);
    // The claim names where the file went, for the picker and the next import.
    expect(await claimOf('file-1')).toMatchObject({ recordingId: res.recordingId, itemId: item.id, sessionId, courseId });
  });

  it('is idempotent on the Zoom file — a second import links, not duplicates', async () => {
    const first = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC),
    );
    const again = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC),
    );
    expect(again).toEqual({ recordingId: first.recordingId, alreadyExisted: true });
    expect(await countRecordings()).toBe(1);
  });

  it('refuses an oversize recording and creates NOTHING', async () => {
    await expect(
      applyImportZoomRecording(
        ADMIN,
        { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
        fakeClient({ ...REC, sizeBytes: MAX_AUDIO_BYTES + 1 }),
      ),
    ).rejects.toThrow(/larger than/i);
    expect(await countRecordings()).toBe(0);
    expect(await claimOf('file-1')).toBeUndefined();
  });

  it('lets exactly ONE of two simultaneous imports of a file into two sessions through', async () => {
    // A double tap, or two staff importing the same file: without the claim in
    // the transaction both created a draft holding the same Zoom file.
    const { id: otherSessionId } = await createSessionRecord(ADMIN, {
      courseId,
      date: '2026-05-14',
      title: 'Session Two',
      dueDate: '2099-01-01',
      notes: '',
    });
    const outcomes = await Promise.allSettled(
      [sessionId, otherSessionId].map((s) =>
        applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId: s }, fakeClient(REC)),
      ),
    );
    const created = outcomes.filter((o) => o.status === 'fulfilled' && !o.value.alreadyExisted);
    expect(created).toHaveLength(1);
    expect(await countRecordings()).toBe(1);
  });

  it('a download failure leaves the draft in needs-attention with a reason', async () => {
    await expect(
      applyImportZoomRecording(
        ADMIN,
        { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
        fakeClient(REC, { fail: true }),
      ),
    ).rejects.toThrow(/import failed/i);
    // The draft exists (so it can be retried), in needs-attention, its file
    // failed with the reason and nothing in the bucket.
    expect(await countRecordings()).toBe(1);
    const snap = await claimed();
    const d = snap.data() as RecordingDoc;
    expect(d.status).toBe('needsAttention');
    expect(d.attentionReason).toMatch(/import failed/i);
    expect(await itemOf(snap.id)).toMatchObject({ status: 'failed', failReason: expect.stringMatching(/network boom/) });
    expect(await fileArrived(snap.id)).toBe(false);
    // Nothing a student could be given: the recording's length is unknown.
    expect(d.durationSec).toBeNull();
  });

  it('re-importing after a FAILED attempt finishes the download, not "already existed"', async () => {
    // The draft is created before the transfer, so a failed import leaves the
    // dedupe key behind. Answering "already imported" to the retry reported
    // success for a recording holding no audio — the state staff then tried to
    // publish and play. Idempotence is about not duplicating, not about
    // declaring an unfinished job done.
    await expect(
      applyImportZoomRecording(
        ADMIN,
        { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
        fakeClient(REC, { fail: true }),
      ),
    ).rejects.toThrow(/import failed/i);

    const retried = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC),
    );
    expect(retried.alreadyExisted).toBe(false);
    expect(await countRecordings()).toBe(1);

    const doc = await getFirestore()
      .collection(COLLECTIONS.recordings)
      .doc(retried.recordingId)
      .get();
    const rec = doc.data() as RecordingDoc;
    expect(rec.status).toBe('draft');
    expect((await itemOf(retried.recordingId)).status).toBe('ready');
    expect(await fileArrived(retried.recordingId)).toBe(true);
  });
});

/*
 * ONE MEETING, TWO SESSIONS — the guard that keeps an unfinished import from
 * being adopted by whoever asks next.
 *
 * The dedupe is global on the Zoom file, and the "finish the job" branch
 * above it exists so a retry of a half-done import completes rather than
 * reporting success. Together, without `prior.sessionId === input.sessionId`,
 * importing a meeting into session B finds session A's failed draft, downloads
 * the audio into A's recording, and hands back A's id with
 * `alreadyExisted: false` — staff are told their import worked, session B still
 * has no recording, and a session in another class silently gains audio nobody
 * chose for it. The test above cannot see it: it retries into the SAME session.
 */
describe('a failed import belongs to the session that started it', () => {
  it('is not adopted by an import into a different session', async () => {
    await expect(
      applyImportZoomRecording(
        ADMIN,
        { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
        fakeClient(REC, { fail: true }),
      ),
    ).rejects.toThrow(/import failed/i);

    const { id: otherSessionId } = await createSessionRecord(ADMIN, {
      courseId,
      date: '2026-05-14',
      title: 'Session Two',
      dueDate: '2099-01-01',
      notes: '',
    });
    const res = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId: otherSessionId },
      fakeClient(REC),
    );

    // Told the truth — this meeting is already spoken for — and nothing written.
    expect(res.alreadyExisted).toBe(true);
    expect(await countRecordings()).toBe(1);
    const first = await rec(res.recordingId);
    expect(first.sessionId).toBe(sessionId);
    // The other session's draft was NOT quietly finished on its behalf.
    expect((await itemOf(res.recordingId)).status).toBe('failed');
    expect(await fileArrived(res.recordingId)).toBe(false);
  });
});

/*
 * A FILE TAKEN OUT OF THE INSTITUTE CAN BE BROUGHT BACK. The claim is what
 * makes the picker say "already imported" and what refuses a second import,
 * so a claim left behind by a removal would strand the file: shown as
 * imported, pointing at nothing, and refused for good.
 */
describe('releasing a Zoom file', () => {
  it('removing the file from its draft lets it be imported again', async () => {
    const first = await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC));
    await removeMedia(first.recordingId, (await itemOf(first.recordingId)).id);
    expect(await claimOf('file-1')).toBeUndefined();
    expect((await annotateImported([REC]))[0].alreadyImported).toBeNull();
  });

  it('uploading the file by hand over a failed import replaces it and releases the claim', async () => {
    // The session page's way out of a failed import: "Retry the Zoom import,
    // or upload the file".
    await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC, { fail: true })).catch(
      () => undefined,
    );
    const failed = await claimed();
    const { itemId } = await startUpload(ADMIN, { recordingId: failed.id, contentType: 'audio/mp4', sizeBytes: 10 });
    await putObject((await rec(failed.id)).media[itemId].storageKey, new Uint8Array(10));
    await finalizeRecording({ recordingId: failed.id, itemId, durationSec: 30 });
    expect(await itemOf(failed.id)).toMatchObject({ id: itemId, source: 'upload', status: 'ready' });
    expect(await claimOf('file-1')).toBeUndefined();
  });

  it('deleting the recording lets it be imported again, into a new draft', async () => {
    const first = await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC));
    await applyDeleteRecording(first.recordingId);
    expect(await claimOf('file-1')).toBeUndefined();
    const again = await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC));
    expect(again.alreadyExisted).toBe(false);
    expect(again.recordingId).not.toBe(first.recordingId);
    expect((await itemOf(again.recordingId)).status).toBe('ready');
  });
});

/*
 * WHAT THE PICKER SHOWS, which had no test of any kind.
 *
 * `listZoomRecordings` closes over the module-level `zoomClient` and its
 * credentials live only in Secret Manager, so the callable itself cannot run
 * here — but everything it does past the fetch is this, and it is the half that
 * decides what a manager sees: which meetings are already in the institute, and
 * which class each went into. Getting it wrong offers every imported recording
 * for import a second time, and the picker's `imported` filter then matches
 * nothing.
 */
describe('annotateImported', () => {
  const other: ZoomAudioRecording = { ...REC, meetingUuid: 'uuid-2', fileId: 'file-2', topic: 'Not imported' };

  it('marks the one this institute already has, names its class, and leaves the rest alone', async () => {
    const { recordingId } = await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC),
    );

    const rows = await annotateImported([REC, other]);
    expect(rows).toHaveLength(2);
    // The id, not merely a flag: the row is tappable through to this recording.
    expect(rows[0]).toMatchObject({
      meetingUuid: 'uuid-1',
      alreadyImported: recordingId,
      importedCourseName: 'K',
    });
    expect(rows[1]).toMatchObject({
      meetingUuid: 'uuid-2',
      alreadyImported: null,
      importedCourseName: null,
    });
  });

  it('says nothing is imported when nothing is', async () => {
    const rows = await annotateImported([REC, other]);
    expect(rows.map((r) => r.alreadyImported)).toEqual([null, null]);
  });
});

describe('applyRetryZoomImport', () => {
  it('re-downloads a failed import and moves it back to a ready draft', async () => {
    // First, a failed import.
    await applyImportZoomRecording(
      ADMIN,
      { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId },
      fakeClient(REC, { fail: true }),
    ).catch(() => undefined);
    const failed = await claimed();
    expect((failed.data() as RecordingDoc).status).toBe('needsAttention');

    // Retry with a working client.
    await applyRetryZoomImport(failed.id, fakeClient(REC));
    const d = await rec(failed.id);
    expect(d.status).toBe('draft');
    expect(d.attentionReason).toBeUndefined();
    expect(await itemOf(failed.id)).toMatchObject({ status: 'ready', failReason: null });
    expect(await fileArrived(failed.id)).toBe(true);
    expect(d.durationSec).toBe(300);
  });

  it('refuses to retry a recording that already has its audio, and touches nothing', async () => {
    /*
     * A retry re-downloads over the item's object and drops the
     * status to `draft`. On a PUBLISHED recording that is an unpublish nobody
     * asked for — every grant switched off by the fan-out, the audio replaced
     * under students mid-lecture, audited as "Retried a Zoom import". The
     * button only appears on a failed import, but the callable is the boundary.
     */
    await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC));
    const imported = await claimed();
    await imported.ref.update({ status: 'published', publishedAt: Date.now() });
    const key = (await itemOf(imported.id)).storageKey;
    const before = await objectInfo(key);

    await expect(applyRetryZoomImport(imported.id, fakeClient({ ...REC, sizeBytes: 8192 }))).rejects.toThrow(
      /already has its audio/i,
    );
    expect((await rec(imported.id)).status).toBe('published');
    expect(await objectInfo(key)).toEqual(before);
  });

  it('retries an import whose audio landed but whose status never settled', async () => {
    /*
     * `copyIntoItem` copies, confirms the item, then writes `draft`. A
     * transient failure on that last write leaves the recording in
     * needs-attention WITH its audio — and the guard above, read
     * as "any audio means finished", refused the one button the screen offers
     * for a needs-attention import. Nothing published is at stake: a recording
     * reaches needs-attention only from a draft, so no grant is on.
     */
    await applyImportZoomRecording(ADMIN, { meetingUuid: 'uuid-1', fileId: 'file-1', sessionId }, fakeClient(REC));
    const imported = await claimed();
    expect((await itemOf(imported.id)).status).toBe('ready');
    await imported.ref.update({
      status: 'needsAttention',
      attentionReason: 'Zoom import failed: 14 UNAVAILABLE',
    });

    await applyRetryZoomImport(imported.id, fakeClient(REC));
    const d = await rec(imported.id);
    expect(d.status).toBe('draft');
    expect(d.attentionReason).toBeUndefined();
    expect(await fileArrived(imported.id)).toBe(true);
  });

  it('refuses to retry a non-Zoom recording', async () => {
    const ref = await getFirestore().collection(COLLECTIONS.recordings).add({
      courseId,
      source: 'manual',
      status: 'needsAttention',
      media: {},
    } as Partial<RecordingDoc> as RecordingDoc);
    await expect(applyRetryZoomImport(ref.id, fakeClient(REC))).rejects.toThrow(/not a Zoom import/i);
  });
});
