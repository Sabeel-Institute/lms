import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  MAX_AUDIO_BYTES,
  EMULATOR_PROJECT_ID,
  type MediaItem,
  type RecordingDoc,
  type ZoomImportDoc,
} from '@sabeel/shared';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSessionRecord } from '../../src/sessions';
import { applyDeleteRecording, applyRecordingStatus, removeMedia } from '../../src/recordings';
import { uploadFile } from './uploadVia';
import { sample } from '../mediaSamples';
import {
  annotateImported,
  applyImportZoomFiles,
  applyRetryZoomImport,
  runCopyTask,
  validateImport,
  type CopyTask,
} from '../../src/zoomImport';
import type { ZoomClient, ZoomFileInfo, ZoomMeetingListing } from '../../src/zoom';
import { clearPrefix, objectExists, objectInfo, putObject } from './mediaObjects';

/**
 * The Zoom import, end to end against the emulator and the local media store,
 * with Zoom itself faked: the import claims files and queues copies, and the
 * tests run each queued copy by hand, as the task queue would.
 */
beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';
const db = () => getFirestore();

async function clearAll() {
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.sessions, COLLECTIONS.recordings, COLLECTIONS.zoomImports]) {
    const snap = await db().collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('media/');
}

let courseId = '';
let sessionId = '';
async function newSession(date = '2026-10-08') {
  const { id } = await createSessionRecord(ADMIN, { courseId, date, title: `Class ${date}`, dueDate: '2099-01-01', notes: '' });
  return id;
}
beforeEach(async () => {
  await clearAll();
  const { id: cohortId } = await createCohortRecord(ADMIN, 'C');
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'K' }));
  sessionId = await newSession();
});

const file = (over: Partial<ZoomFileInfo> & Pick<ZoomFileInfo, 'fileId'>): ZoomFileInfo => ({
  meetingUuid: 'm1',
  topic: 'Quran Immersion Fall',
  format: 'audio',
  sizeBytes: 4096,
  durationSec: 8160,
  segmentStart: '2026-10-08T14:54:00Z',
  ready: true,
  ...over,
});

/** The 2026-10-08 class: two meetings, the first in three formats. */
const M1_SPEAKER = file({ fileId: 'm1-spk', format: 'speaker', sizeBytes: 8192 });
const M1_SLIDES = file({ fileId: 'm1-sld', format: 'slides', sizeBytes: 6144 });
const M1_AUDIO = file({ fileId: 'm1-aud' });
const M2_SPEAKER = file({ fileId: 'm2-spk', meetingUuid: 'm2', format: 'speaker', segmentStart: '2026-10-08T17:11:00Z', durationSec: 3360 });
const M2_AUDIO = file({ fileId: 'm2-aud', meetingUuid: 'm2', segmentStart: '2026-10-08T17:11:00Z', durationSec: 3361 });
const ALL = [M1_SPEAKER, M1_SLIDES, M1_AUDIO, M2_SPEAKER, M2_AUDIO];

const pick = (...files: ZoomFileInfo[]) => files.map((f) => ({ meetingUuid: f.meetingUuid, fileId: f.fileId }));

/** A Zoom that holds `files`, and a copy that writes their bytes (or fails). */
function fakeZoom(files: ZoomFileInfo[] = ALL, opts: { failCopy?: Set<string> } = {}): ZoomClient {
  return {
    async listMeetings(): Promise<ZoomMeetingListing[]> {
      return [];
    },
    async freshFile(meetingUuid: string, fileId: string) {
      const f = files.find((x) => x.meetingUuid === meetingUuid && x.fileId === fileId);
      return f ? { file: f, downloadUrl: `fake://${fileId}` } : null;
    },
    async copyToMediaStore(downloadUrl: string, key: string, sizeBytes: number) {
      if (opts.failCopy?.has(downloadUrl.slice('fake://'.length))) throw new Error('network boom');
      // Write-once, like the real copy: an object already there is an error.
      if (await objectExists(key)) throw new Error(`refusing to overwrite ${key}`);
      await putObject(key, new Uint8Array(sizeBytes));
    },
  };
}

/** The task queue, as tests see it. */
function queue() {
  const tasks: CopyTask[] = [];
  return { tasks, enqueue: async (t: CopyTask) => void tasks.push(t) };
}

/** Run every queued copy once, as its final attempt unless told otherwise. */
async function runAll(tasks: CopyTask[], client: ZoomClient, finalAttempt = true) {
  for (const t of tasks.splice(0)) await runCopyTask(t, finalAttempt, client);
}

const rec = async (id: string) => (await db().collection(COLLECTIONS.recordings).doc(id).get()).data() as RecordingDoc;
const items = async (id: string): Promise<MediaItem[]> =>
  Object.values((await rec(id)).media).sort((a, b) => a.part - b.part || a.version.localeCompare(b.version));
const itemFor = async (recordingId: string, fileId: string) =>
  (await items(recordingId)).find((i) => i.zoom?.fileId === fileId) as MediaItem;
const claimOf = async (fileId: string) =>
  (await db().collection(COLLECTIONS.zoomImports).doc(fileId).get()).data() as ZoomImportDoc | undefined;
const countRecordings = async () => (await db().collection(COLLECTIONS.recordings).get()).size;

describe('importing Zoom files', () => {
  it('claims the file, adds it as a copying item, queues one copy, and returns at once', async () => {
    const q = queue();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), q.enqueue);
    const d = await rec(res.recordingId);
    expect(d).toMatchObject({ sessionId, courseId, source: 'zoom', status: 'draft' });
    const item = await itemFor(res.recordingId, 'm1-aud');
    expect(item).toMatchObject({
      part: 1,
      version: 'audio',
      kind: 'audio',
      status: 'copying',
      source: 'zoom',
      storageKey: `media/${res.recordingId}/${item.id}`,
      zoom: { meetingUuid: 'm1', fileId: 'm1-aud', recordingType: 'audio_only', segmentStart: M1_AUDIO.segmentStart, topic: M1_AUDIO.topic },
    });
    expect(q.tasks).toEqual([{ recordingId: res.recordingId, itemId: item.id }]);
    expect(await claimOf('m1-aud')).toMatchObject({ recordingId: res.recordingId, itemId: item.id, sessionId, courseId });
    // Nothing is playable yet, so nothing can be published and there is no length.
    expect(d.durationSec).toBeNull();
    await expect(applyRecordingStatus({ recordingId: res.recordingId, status: 'published' })).rejects.toThrow(/pending/);
  });

  it('the queued copy lands the file and makes it playable', async () => {
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    await runAll(q.tasks, client);
    const item = await itemFor(res.recordingId, 'm1-aud');
    expect(item).toMatchObject({ status: 'ready', sizeBytes: 4096, durationSec: 8160 });
    expect((await objectInfo(item.storageKey))?.size).toBe(4096);
    expect(await rec(res.recordingId)).toMatchObject({ status: 'draft', durationSec: 8160 });
  });

  it('makes each segment a part, in start order across meetings, its formats versions of it', async () => {
    const q = queue();
    const client = fakeZoom();
    // Chosen out of order, across both meetings.
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M2_AUDIO, M1_SPEAKER, M2_SPEAKER, M1_AUDIO) }, client, q.enqueue);
    expect((await items(res.recordingId)).map((i) => [i.part, i.version, i.kind, i.contentType])).toEqual([
      [1, 'audio', 'audio', 'audio/mp4'],
      [1, 'speaker', 'video', 'video/mp4'],
      [2, 'audio', 'audio', 'audio/mp4'],
      [2, 'speaker', 'video', 'video/mp4'],
    ]);
    await runAll(q.tasks, client);
    // Each stretch of class counted once, at its longest version.
    expect((await rec(res.recordingId)).durationSec).toBe(8160 + 3361);
  });

  it('adds to the session’s recording: a held segment gains a version, a new one a part after the rest', async () => {
    const q = queue();
    const client = fakeZoom();
    const first = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    const second = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_SLIDES, M2_AUDIO) }, client, q.enqueue);
    expect(second.recordingId).toBe(first.recordingId);
    expect(await countRecordings()).toBe(1);
    expect((await items(first.recordingId)).map((i) => [i.part, i.version])).toEqual([
      [1, 'audio'],
      [1, 'slides'],
      [2, 'audio'],
    ]);
  });

  it('refuses a file this institute already has, and writes nothing', async () => {
    const q = queue();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), q.enqueue);
    const other = await newSession('2026-10-09');
    await expect(
      applyImportZoomFiles(ADMIN, { sessionId: other, files: pick(M1_SPEAKER, M1_AUDIO) }, fakeZoom(), q.enqueue),
    ).rejects.toMatchObject({ code: 'already-exists' });
    // All or nothing: the speaker file chosen beside it was not claimed either.
    expect(await claimOf('m1-spk')).toBeUndefined();
    expect(await countRecordings()).toBe(1);
    expect(await items(res.recordingId)).toHaveLength(1);
    expect(q.tasks).toHaveLength(1);
  });

  it('lets exactly ONE of two simultaneous imports of a file into two sessions through', async () => {
    // A double tap, or two staff importing the same file: without the claim in
    // the transaction both created a draft holding the same Zoom file.
    const other = await newSession('2026-10-09');
    const outcomes = await Promise.allSettled(
      [sessionId, other].map((s) => applyImportZoomFiles(ADMIN, { sessionId: s, files: pick(M1_AUDIO) }, fakeZoom(), queue().enqueue)),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await countRecordings()).toBe(1);
  });

  it.each([
    ['gone from Zoom', fakeZoom([]), /no longer in Zoom/],
    ['still processing', fakeZoom([{ ...M1_AUDIO, ready: false }]), /still processing/],
    ['larger than can be copied', fakeZoom([{ ...M1_AUDIO, sizeBytes: MAX_AUDIO_BYTES + 1 }]), /larger than/],
  ])('refuses a file %s, and creates NOTHING', async (_why, client, message) => {
    const q = queue();
    await expect(applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue)).rejects.toThrow(message);
    expect(await countRecordings()).toBe(0);
    expect(await claimOf('m1-aud')).toBeUndefined();
    expect(q.tasks).toHaveLength(0);
  });

  it('marks a file failed when its copy cannot be queued, rather than leaving it copying for ever', async () => {
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), async () => {
      throw new Error('queue down');
    });
    expect(await itemFor(res.recordingId, 'm1-aud')).toMatchObject({ status: 'failed', failReason: expect.stringMatching(/Retry/) });
    expect((await rec(res.recordingId)).status).toBe('needsAttention');
  });

  it('validates what it is asked for before anything else', () => {
    expect(() => validateImport({ sessionId: 's', files: [] })).toThrow(/at least one/);
    expect(() => validateImport({ sessionId: 's', files: [{ meetingUuid: 'm', fileId: 'f' }, { meetingUuid: 'm', fileId: 'f' }] })).toThrow(/twice/);
    expect(() => validateImport({ sessionId: 's', files: Array.from({ length: 21 }, (_, i) => ({ meetingUuid: 'm', fileId: `f${i}` })) })).toThrow(/at most/);
    expect(() => validateImport({ sessionId: 's', files: [{ meetingUuid: 'm' }] })).toThrow(/meetingUuid and fileId/);
  });
});

describe('the copy task', () => {
  it('hands a failure back to the queue until the last attempt, then marks the file failed', async () => {
    const q = queue();
    const client = fakeZoom(ALL, { failCopy: new Set(['m1-aud']) });
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    const [task] = q.tasks;
    await expect(runCopyTask(task, false, client)).rejects.toThrow(/network boom/);
    expect((await itemFor(res.recordingId, 'm1-aud')).status).toBe('copying');

    await runCopyTask(task, true, client);
    const item = await itemFor(res.recordingId, 'm1-aud');
    expect(item).toMatchObject({ status: 'failed', failReason: expect.stringMatching(/network boom/) });
    expect(await objectExists(item.storageKey)).toBe(false);
    // Every file failed: the draft needs attention, with the reason.
    expect(await rec(res.recordingId)).toMatchObject({ status: 'needsAttention', attentionReason: expect.stringMatching(/network boom/) });
  });

  it('a recording with one file failed and another ready stays a draft, the failure on its file', async () => {
    const q = queue();
    const client = fakeZoom(ALL, { failCopy: new Set(['m1-spk']) });
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_SPEAKER, M1_AUDIO) }, client, q.enqueue);
    await runAll(q.tasks, client);
    expect((await rec(res.recordingId)).status).toBe('draft');
    expect((await itemFor(res.recordingId, 'm1-spk')).status).toBe('failed');
    expect((await itemFor(res.recordingId, 'm1-aud')).status).toBe('ready');
    // And it cannot be published with a failed file on it.
    await expect(applyRecordingStatus({ recordingId: res.recordingId, status: 'published' })).rejects.toThrow(/failed/);
  });

  it('fails a file Zoom no longer has at once, without retrying', async () => {
    const q = queue();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), q.enqueue);
    // Deleted in Zoom between the import and the copy: not the final attempt,
    // and still no retry — nothing will bring it back.
    await runCopyTask(q.tasks[0], false, fakeZoom([]));
    expect(await itemFor(res.recordingId, 'm1-aud')).toMatchObject({ status: 'failed', failReason: 'This file is no longer in Zoom.' });
  });

  it('does nothing for a file already copied, so a duplicate delivery is harmless', async () => {
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    const [task] = q.tasks;
    await runCopyTask(task, true, client);
    const before = await objectInfo((await itemFor(res.recordingId, 'm1-aud')).storageKey);
    await runCopyTask(task, true, client);
    expect(await objectInfo((await itemFor(res.recordingId, 'm1-aud')).storageKey)).toEqual(before);
  });

  it('deletes what it wrote when the file was removed while it waited', async () => {
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    const item = await itemFor(res.recordingId, 'm1-aud');
    await applyDeleteRecording(res.recordingId);
    // An attempt still in flight when the recording went wrote its bytes after.
    await putObject(item.storageKey, new Uint8Array(10));
    await runCopyTask(q.tasks[0], true, client);
    expect(await objectExists(item.storageKey)).toBe(false);
  });
});

describe('retrying', () => {
  it('queues the failed files again and lands them', async () => {
    const q = queue();
    const failing = fakeZoom(ALL, { failCopy: new Set(['m1-aud']) });
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, failing, q.enqueue);
    await runAll(q.tasks, failing);
    expect((await rec(res.recordingId)).status).toBe('needsAttention');

    const retried = await applyRetryZoomImport(res.recordingId, q.enqueue);
    expect(retried.itemIds).toHaveLength(1);
    expect((await rec(res.recordingId)).status).toBe('draft');
    expect((await itemFor(res.recordingId, 'm1-aud')).status).toBe('copying');
    await runAll(q.tasks, fakeZoom());
    expect(await itemFor(res.recordingId, 'm1-aud')).toMatchObject({ status: 'ready', failReason: null });
    expect((await rec(res.recordingId)).attentionReason).toBeUndefined();
  });

  /*
   * A retry copies over a file's object. On a ready file that students may be
   * playing, that is the file changing underneath them; only failed files are
   * ever queued again.
   */
  it('refuses a recording whose files all arrived, and touches nothing', async () => {
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    await runAll(q.tasks, client);
    await applyRecordingStatus({ recordingId: res.recordingId, status: 'published' });
    const key = (await itemFor(res.recordingId, 'm1-aud')).storageKey;
    const before = await objectInfo(key);
    await expect(applyRetryZoomImport(res.recordingId, q.enqueue)).rejects.toThrow(/already has its files/);
    expect(q.tasks).toHaveLength(0);
    expect((await rec(res.recordingId)).status).toBe('published');
    expect(await objectInfo(key)).toEqual(before);
  });

  it('settles a recording left needing attention with nothing failed', async () => {
    // Every copy finished, but the status write after it did not.
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    await runAll(q.tasks, client);
    await db().collection(COLLECTIONS.recordings).doc(res.recordingId).update({ status: 'needsAttention', attentionReason: 'x' });
    await applyRetryZoomImport(res.recordingId, q.enqueue);
    expect((await rec(res.recordingId)).status).toBe('draft');
    expect((await rec(res.recordingId)).attentionReason).toBeUndefined();
  });

  it('refuses a recording that is not a Zoom import', async () => {
    const ref = await db().collection(COLLECTIONS.recordings).add({ courseId, source: 'manual', status: 'needsAttention', media: {} });
    await expect(applyRetryZoomImport(ref.id, queue().enqueue)).rejects.toThrow(/not a Zoom import/);
  });
});

/*
 * A FILE TAKEN OUT OF THE INSTITUTE CAN BE BROUGHT BACK. The claim is what
 * makes the picker say "already imported" and what refuses a second import,
 * so a claim left behind by a removal would strand the file: shown as
 * imported, pointing at nothing, and refused for good.
 */
describe('releasing a Zoom file', () => {
  async function imported() {
    const q = queue();
    const client = fakeZoom();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, client, q.enqueue);
    await runAll(q.tasks, client);
    return res.recordingId;
  }

  it('removing the file from its draft lets it be imported again', async () => {
    const recordingId = await imported();
    await removeMedia(recordingId, (await itemFor(recordingId, 'm1-aud')).id);
    expect(await claimOf('m1-aud')).toBeUndefined();
    await expect(applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), queue().enqueue)).resolves.toBeTruthy();
  });

  it('deleting the recording lets it be imported again, into a new draft', async () => {
    const recordingId = await imported();
    await applyDeleteRecording(recordingId);
    expect(await claimOf('m1-aud')).toBeUndefined();
    const again = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), queue().enqueue);
    expect(again.recordingId).not.toBe(recordingId);
  });

  it('a failed import removed releases its claim, and a file uploaded in its place plays', async () => {
    // The session page's way out of a failed import: "Retry the Zoom import,
    // or remove it and upload the file".
    const q = queue();
    const failing = fakeZoom(ALL, { failCopy: new Set(['m1-aud']) });
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, failing, q.enqueue);
    await runAll(q.tasks, failing);
    const [failed] = await items(res.recordingId);
    expect(failed.status).toBe('failed');
    await removeMedia(res.recordingId, failed.id);
    expect(await claimOf('m1-aud')).toBeUndefined();
    const { itemId } = await uploadFile(ADMIN, res.recordingId, sample('m4a'), 'audio/mp4');
    expect(await items(res.recordingId)).toEqual([expect.objectContaining({ id: itemId, source: 'upload', status: 'ready' })]);
  });
});

/*
 * WHAT THE PICKER SHOWS. `listZoomRecordings` closes over the module-level
 * `zoomClient` and its credentials live only in Secret Manager, so the callable
 * cannot run here — but everything it does past the fetch is this, and it is
 * the half that decides what a manager sees: which files are already in the
 * institute, and where each went.
 */
describe('annotateImported', () => {
  const listing: ZoomMeetingListing = {
    meetingUuid: 'm1',
    topic: 'Quran Immersion Fall',
    startTime: M1_AUDIO.segmentStart,
    durationSec: 8160,
    segments: [{ startTime: M1_AUDIO.segmentStart, durationSec: 8160, files: [M1_SPEAKER, M1_AUDIO] }],
  };

  it('marks each file this institute has, with its recording and class, and leaves the rest alone', async () => {
    const q = queue();
    const res = await applyImportZoomFiles(ADMIN, { sessionId, files: pick(M1_AUDIO) }, fakeZoom(), q.enqueue);
    const [row] = await annotateImported([listing]);
    expect(row).toMatchObject({ meetingUuid: 'm1', topic: 'Quran Immersion Fall', durationSec: 8160 });
    expect(row.segments[0].files).toEqual([
      { fileId: 'm1-spk', format: 'speaker', sizeBytes: 8192, ready: true, imported: null },
      // The recording, not merely a flag: the row is a link to it.
      { fileId: 'm1-aud', format: 'audio', sizeBytes: 4096, ready: true, imported: { recordingId: res.recordingId, sessionId, courseName: 'K' } },
    ]);
  });

  it('says nothing is imported when nothing is', async () => {
    const [row] = await annotateImported([listing]);
    expect(row.segments[0].files.map((f) => f.imported)).toEqual([null, null]);
  });
});
