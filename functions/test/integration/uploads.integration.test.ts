import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  MAX_AUDIO_BYTES,
  UPLOAD_PART_BYTES,
  type MediaItem,
  type RecordingDoc,
} from '@sabeel/shared';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSessionRecord } from '../../src/sessions';
import { applyRecordingStatus, createRecordingDraft, removeMedia } from '../../src/recordings';
import { playbackDenial } from '../../src/playback';
import {
  ABANDONED_AFTER_MS,
  finalizeUpload,
  signParts,
  startRecordingUpload,
  startUpload,
  sweepUploads,
  validateFinalizeUpload,
  validateSignParts,
  validateStartUpload,
  type UploadDoc,
} from '../../src/uploads';
import { idTokenFor } from './emulatorToken';
import { clearPrefix, objectExists, objectInfo, uploadIsOpen } from './mediaObjects';
import { uploadFile } from './uploadVia';
import { sample } from '../mediaSamples';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';

let courseId = '';
beforeEach(async () => {
  const db = getFirestore();
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.sessions, COLLECTIONS.recordings, COLLECTIONS.mediaUploads]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('media/');
  const { id: cohortId } = await createCohortRecord(ADMIN, 'C');
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'K' }));
});

const rec = async (id: string) =>
  (await getFirestore().collection(COLLECTIONS.recordings).doc(id).get()).data() as RecordingDoc;
const item = async (id: string, itemId: string): Promise<MediaItem | undefined> => (await rec(id)).media[itemId];
const uploadDoc = async (itemId: string) =>
  (await getFirestore().collection(COLLECTIONS.mediaUploads).doc(itemId).get()).data() as UploadDoc | undefined;

async function newDraft(): Promise<string> {
  const { id: sessionId } = await createSessionRecord(ADMIN, {
    courseId,
    date: '2026-07-06',
    title: 'Session 1',
    dueDate: '2099-01-01',
    notes: '',
  });
  return (await createRecordingDraft(ADMIN, { sessionId })).id;
}

/** What `getPlaybackUrl` would say to an excused student asking for this file. */
const studentDenial = (file: MediaItem | undefined, status: RecordingDoc['status']) =>
  playbackDenial({
    claims: { role: 'student', status: 'active' },
    recording: { status },
    item: file ?? null,
    cls: { effectiveActive: true, archivedAccess: false, managerUids: [] },
    uid: 'stu-1',
    assignment: { active: true, dueDate: '2099-01-01' },
    today: '2026-07-07',
  });

describe('a file that plays', () => {
  it('lands as a new part, ready, with the length read from the file itself', async () => {
    const id = await newDraft();
    const bytes = sample('m4a');
    const { itemId } = await uploadFile(ADMIN, id, bytes, 'audio/mp4');
    expect(await item(id, itemId)).toMatchObject({
      part: 1,
      version: 'audio',
      kind: 'audio',
      status: 'ready',
      sizeBytes: bytes.length,
      durationSec: 3,
      storageKey: `media/${id}/${itemId}`,
      addedBy: ADMIN,
    });
    expect((await rec(id)).durationSec).toBe(3);
    // The upload's record is gone once it has done its job.
    expect(await uploadDoc(itemId)).toBeUndefined();
  });

  it('accepts MP3 and WAV audio as well as M4A', async () => {
    const id = await newDraft();
    const mp3 = await uploadFile(ADMIN, id, sample('mp3'), 'audio/mpeg');
    const wav = await uploadFile(ADMIN, id, sample('wav'), 'audio/wav');
    expect((await item(id, mp3.itemId))?.status).toBe('ready');
    expect((await item(id, wav.itemId))?.status).toBe('ready');
  });

  /*
   * AN ORDINARY VIDEO WITH ONE MORE TRACK. Editors write chapters, cameras keep
   * a timecode, and a file may carry subtitles: none of them is a picture, and
   * phones play the file. Each was counted as a picture that is not H.264, and
   * the upload deleted with advice to export as H.264, which it already was.
   */
  it.each(['chapters', 'subtitles', 'timecode'] as const)('takes an H.264 and AAC video that also carries %s', async (name) => {
    const id = await newDraft();
    const { itemId } = await uploadFile(ADMIN, id, sample(name), 'video/mp4');
    expect(await item(id, itemId)).toMatchObject({ kind: 'video', status: 'ready', durationSec: 3 });
  });

  it('joins a video sent in several parts, in order, into the file that was sent', async () => {
    const id = await newDraft();
    const bytes = sample('bigVideo');
    expect(bytes.length).toBeGreaterThan(UPLOAD_PART_BYTES);
    const { itemId, parts } = await uploadFile(ADMIN, id, bytes, 'video/mp4');
    expect(parts.length).toBeGreaterThan(1);
    expect(await item(id, itemId)).toMatchObject({
      version: 'video',
      kind: 'video',
      contentType: 'video/mp4',
      status: 'ready',
      sizeBytes: bytes.length,
      durationSec: 20,
    });
  });

  it('puts each new part after the last, and a version on the part it names', async () => {
    const id = await newDraft();
    const first = await uploadFile(ADMIN, id, sample('mp4'), 'video/mp4');
    const second = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
    const audioOfFirst = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', {
      placement: { as: 'version', part: 1 },
    });
    expect((await item(id, first.itemId))?.part).toBe(1);
    expect((await item(id, second.itemId))?.part).toBe(2);
    expect(await item(id, audioOfFirst.itemId)).toMatchObject({ part: 1, version: 'audio' });
  });

  it('refuses a second version of the same kind on one part, and a part that is not there', async () => {
    const id = await newDraft();
    await uploadFile(ADMIN, id, sample('mp4'), 'video/mp4');
    const again = { recordingId: id, contentType: 'video/mp4' as const, sizeBytes: 10, placement: { as: 'version' as const, part: 1 } };
    await expect(startUpload(ADMIN, again)).rejects.toThrow(/already has an uploaded video/);
    await expect(startUpload(ADMIN, { ...again, placement: { as: 'version', part: 7 } })).rejects.toThrow(/not on this recording/);
    expect(Object.keys((await rec(id)).media)).toHaveLength(1);
  });
});

describe('a published recording', () => {
  it('takes a new part, which no student can open until it has arrived', async () => {
    const id = await newDraft();
    await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
    await applyRecordingStatus({ recordingId: id, status: 'published' });

    const later = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });
    expect(studentDenial(await item(id, later.itemId), 'published')).toBe('no-media');
    expect((await rec(id)).status).toBe('published');

    await finalizeUpload({ recordingId: id, itemId: later.itemId, parts: later.parts });
    expect(studentDenial(await item(id, later.itemId), 'published')).toBeNull();
  });
});

describe('a file phones cannot play', () => {
  /** Upload it, expect the finalize to refuse with `reason`, and expect no trace left. */
  async function refused(bytes: Uint8Array, contentType: 'audio/mp4' | 'audio/mpeg' | 'video/mp4', reason: RegExp) {
    const id = await newDraft();
    const { itemId, parts } = await uploadFile(ADMIN, id, bytes, contentType, { finalize: false });
    const key = `media/${id}/${itemId}`;
    await expect(finalizeUpload({ recordingId: id, itemId, parts })).rejects.toThrow(reason);
    expect(await objectExists(key)).toBe(false);
    expect((await rec(id)).media).toEqual({});
    expect(await uploadDoc(itemId)).toBeUndefined();
  }

  it('an iPhone’s HEVC video is deleted, with how to export it instead', () =>
    refused(sample('hevc'), 'video/mp4', /Export it as MP4 \(H\.264\)/));

  it('H.264 in a QuickTime file is refused the same way', () =>
    refused(sample('mov'), 'video/mp4', /Export it as MP4 \(H\.264\)/));

  it('audio in a format the app does not take is refused', () =>
    refused(sample('flac'), 'audio/mpeg', /Export it as M4A or MP3/));

  it('a video sent as audio, or audio sent as video, is refused with which to choose', async () => {
    await refused(sample('mp4'), 'audio/mp4', /has a picture/);
    await refused(sample('m4a'), 'video/mp4', /no picture/);
  });

  it('bytes that are not media at all are refused as unreadable', () =>
    refused(new Uint8Array(4096).fill(7), 'audio/mp4', /could not be read/));

  it('a file over the cap is deleted, whatever size was declared', async () => {
    // A part URL cannot sign a size, so a client can send more than it said.
    // Finalize reads the real size from the bucket.
    const id = await newDraft();
    const { itemId, partCount } = await startUpload(ADMIN, {
      recordingId: id,
      contentType: 'audio/mp4',
      sizeBytes: 1000,
      placement: { as: 'part' },
    });
    expect(partCount).toBe(1);
    // One part may hold up to 5 GiB, so the whole file goes as part 1.
    const { urls } = await signParts({ recordingId: id, itemId, partNumbers: [1] });
    const res = await fetch(urls[1], { method: 'PUT', body: new Uint8Array(MAX_AUDIO_BYTES + 1) });
    expect(res.status).toBe(200);
    await expect(
      finalizeUpload({ recordingId: id, itemId, parts: [{ partNumber: 1, etag: res.headers.get('etag') ?? '' }] }),
    ).rejects.toThrow(/too large/);
    expect(await objectExists(`media/${id}/${itemId}`)).toBe(false);
    expect((await rec(id)).media).toEqual({});
  });
});

describe('write once', () => {
  it('once a file is finished, no part URL can change it and no new one is signed', async () => {
    const id = await newDraft();
    const bytes = sample('m4a');
    const { itemId } = await startUpload(ADMIN, { recordingId: id, contentType: 'audio/mp4', sizeBytes: bytes.length, placement: { as: 'part' } });
    const { urls } = await signParts({ recordingId: id, itemId, partNumbers: [1] });
    const res = await fetch(urls[1], { method: 'PUT', body: bytes });
    await finalizeUpload({ recordingId: id, itemId, parts: [{ partNumber: 1, etag: res.headers.get('etag') ?? '' }] });
    const key = `media/${id}/${itemId}`;
    const before = await objectInfo(key);

    // The URL it was sent on, replayed with other bytes.
    const replay = await fetch(urls[1], { method: 'PUT', body: new Uint8Array(10) });
    expect(replay.ok).toBe(false);
    await expect(signParts({ recordingId: id, itemId, partNumbers: [1] })).rejects.toThrow(/not in progress/);
    expect(await objectInfo(key)).toEqual(before);
  });

  it('will not join a file with a part missing', async () => {
    const id = await newDraft();
    const bytes = sample('bigVideo');
    const { itemId, parts } = await uploadFile(ADMIN, id, bytes, 'video/mp4', { finalize: false });
    await expect(finalizeUpload({ recordingId: id, itemId, parts: parts.slice(1) })).rejects.toThrow(/every one/);
    expect((await item(id, itemId))?.status).toBe('uploading');
  });
});

describe('an upload that does not finish', () => {
  it('Remove stops it: the parts, the item and its record go', async () => {
    const id = await newDraft();
    const { itemId } = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });
    const upload = (await uploadDoc(itemId)) as UploadDoc;
    expect(await uploadIsOpen(upload.storageKey, upload.uploadId)).toBe(true);

    await removeMedia(id, itemId);
    expect(await uploadIsOpen(upload.storageKey, upload.uploadId)).toBe(false);
    expect(await item(id, itemId)).toBeUndefined();
    expect(await uploadDoc(itemId)).toBeUndefined();
  });

  it('can be removed from a PUBLISHED recording by a manager, since no student ever saw it', async () => {
    const id = await newDraft();
    const playable = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    const stuck = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });

    await removeMedia(id, stuck.itemId, false);
    expect(await item(id, stuck.itemId)).toBeUndefined();
    // A file students can play is still not a manager's to remove.
    await expect(removeMedia(id, playable.itemId, false)).rejects.toThrow(/hidden, not removed/);
  });

  it('confirming one that was removed meanwhile leaves nothing behind', async () => {
    const id = await newDraft();
    const { itemId, parts } = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });
    await removeMedia(id, itemId);
    await expect(finalizeUpload({ recordingId: id, itemId, parts })).rejects.toThrow(/not in progress/);
    expect(await objectExists(`media/${id}/${itemId}`)).toBe(false);
  });

  it('is swept a day later: parts aborted, item gone; a newer one is left alone', async () => {
    const id = await newDraft();
    const old = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });
    const recent = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4', { finalize: false });
    const oldUpload = (await uploadDoc(old.itemId)) as UploadDoc;
    const now = Date.now();
    await getFirestore()
      .collection(COLLECTIONS.mediaUploads)
      .doc(old.itemId)
      .update({ startedAt: now - ABANDONED_AFTER_MS - 1000 });

    expect(await sweepUploads(now)).toBe(1);
    expect(await item(id, old.itemId)).toBeUndefined();
    expect(await uploadIsOpen(oldUpload.storageKey, oldUpload.uploadId)).toBe(false);
    expect((await item(id, recent.itemId))?.status).toBe('uploading');
    expect(await uploadDoc(recent.itemId)).toBeDefined();
  });
});

describe('who may upload', () => {
  it('gives a student no upload at all', async () => {
    const id = await newDraft();
    const asStudent = {
      auth: { uid: 'stu-1', token: { role: 'student', status: 'active' }, rawToken: await idTokenFor('stu-1') },
      data: { recordingId: id, contentType: 'audio/mp4', sizeBytes: 10, placement: { as: 'part' } },
    } as unknown as CallableRequest;
    await expect(startRecordingUpload.run(asStudent)).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await rec(id)).media).toEqual({});
  });
});

describe('validators', () => {
  const start = { recordingId: 'r', contentType: 'audio/mp4', sizeBytes: 10, placement: { as: 'part' } };

  it('take only the types the app accepts, within their caps', () => {
    expect(validateStartUpload(start)).toEqual(start);
    expect(() => validateStartUpload({ ...start, contentType: 'audio/x-m4a' })).toThrow(/M4A, MP3, WAV or MP4/);
    expect(() => validateStartUpload({ ...start, contentType: 'video/quicktime' })).toThrow(/M4A, MP3, WAV or MP4/);
    expect(() => validateStartUpload({ ...start, sizeBytes: MAX_AUDIO_BYTES + 1 })).toThrow(/300 MB/);
    expect(validateStartUpload({ ...start, contentType: 'video/mp4', sizeBytes: MAX_AUDIO_BYTES + 1 }).sizeBytes).toBe(
      MAX_AUDIO_BYTES + 1,
    );
    expect(() => validateStartUpload({ ...start, contentType: 'video/mp4', sizeBytes: 8 * 2 ** 30 + 1 })).toThrow(/8 GB/);
  });

  it('take a new part or a version of a numbered part, and nothing else', () => {
    expect(validateStartUpload({ ...start, placement: { as: 'version', part: 2 } }).placement).toEqual({ as: 'version', part: 2 });
    for (const placement of [undefined, { as: 'version' }, { as: 'version', part: 0 }, { as: 'replace' }]) {
      expect(() => validateStartUpload({ ...start, placement })).toThrow(/placement/);
    }
  });

  it('sign a few distinct parts at a time, and finalize only with every ETag', () => {
    expect(() => validateSignParts({ recordingId: 'r', itemId: 'i', partNumbers: [] })).toThrow(/partNumbers/);
    expect(() => validateSignParts({ recordingId: 'r', itemId: 'i', partNumbers: [1, 1] })).toThrow(/distinct/);
    expect(() => validateSignParts({ recordingId: 'r', itemId: 'i', partNumbers: Array.from({ length: 17 }, (_, i) => i + 1) })).toThrow();
    expect(() => validateFinalizeUpload({ recordingId: 'r', itemId: 'i', parts: [{ partNumber: 1 }] })).toThrow(/ETag/);
  });
});
