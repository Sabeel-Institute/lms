import { describe, it, expect } from 'vitest';
import {
  deriveDurationSec,
  mediaFromSingleAudio,
  mediaParts,
  mediaStorageKey,
  mediaSummary,
  maxUploadBytes,
  playVerb,
  uploadContentType,
  uploadPartCount,
  UPLOAD_PART_BYTES,
  startingItem,
  type MediaItem,
  type MediaMap,
} from '../src';

const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  part: 1,
  version: 'audio',
  kind: 'audio',
  label: null,
  status: 'ready',
  failReason: null,
  hidden: false,
  storageKey: `media/r1/${id}`,
  contentType: 'audio/mp4',
  sizeBytes: 1000,
  durationSec: 3600,
  width: null,
  height: null,
  source: 'zoom',
  zoom: null,
  addedAt: 1,
  addedBy: 'adm',
  ...over,
});
const mediaOf = (...items: MediaItem[]): MediaMap => Object.fromEntries(items.map((i) => [i.id, i]));

/** The 2026-10-08 class: two Zoom meetings, the first in three formats. */
const QURAN = mediaOf(
  item('p1s', { part: 1, version: 'speaker', kind: 'video', durationSec: 8160 }),
  item('p1l', { part: 1, version: 'slides', kind: 'video', durationSec: 8159 }),
  item('p1a', { part: 1, version: 'audio', durationSec: 8160 }),
  item('p2s', { part: 2, version: 'speaker', kind: 'video', durationSec: 3360 }),
  item('p2a', { part: 2, version: 'audio', durationSec: 3361 }),
);

describe('deriveDurationSec', () => {
  it('counts each stretch of class once, however many formats cover it', () => {
    // Part 1's longest version plus part 2's: 2 h 16 min + 56 min, not five files.
    expect(deriveDurationSec(QURAN)).toBe(8160 + 3361);
  });

  it('counts only what a student can play', () => {
    const hiddenPart2 = { ...QURAN, p2s: { ...QURAN.p2s, hidden: true }, p2a: { ...QURAN.p2a, hidden: true } };
    expect(deriveDurationSec(hiddenPart2)).toBe(8160);
    const copying = mediaOf(item('a', { status: 'copying' }));
    expect(deriveDurationSec(copying)).toBeNull();
  });

  it('is unknown, not zero, when nothing playable has a length', () => {
    // A ledger row would print "0% listened" over a confident zero.
    expect(deriveDurationSec({})).toBeNull();
    expect(deriveDurationSec(mediaOf(item('a', { durationSec: null })))).toBeNull();
  });
});

describe('mediaParts', () => {
  it('orders parts by number and versions the same way everywhere', () => {
    const parts = mediaParts(Object.values(QURAN).reverse());
    expect(parts.map((p) => p.part)).toEqual([1, 2]);
    expect(parts[0].items.map((i) => i.version)).toEqual(['speaker', 'slides', 'audio']);
  });
});

describe('startingItem', () => {
  it("starts on the recording's default version", () => {
    expect(startingItem(QURAN, 'speaker')?.id).toBe('p1s');
    expect(startingItem(QURAN, 'audio')?.id).toBe('p1a');
  });

  it('falls back to audio when the first part lacks the default', () => {
    expect(startingItem(mediaOf(item('a'), item('v', { version: 'video', kind: 'video' })), 'slides')?.id).toBe('a');
  });

  it('skips a part nobody can play', () => {
    const p1Hidden = { ...QURAN, p1s: { ...QURAN.p1s, hidden: true }, p1l: { ...QURAN.p1l, hidden: true }, p1a: { ...QURAN.p1a, hidden: true } };
    expect(startingItem(p1Hidden, 'speaker')?.id).toBe('p2s');
  });

  it('has nothing to start on when nothing is ready', () => {
    expect(startingItem({}, 'audio')).toBeNull();
    expect(startingItem(mediaOf(item('a', { status: 'uploading' })), 'audio')).toBeNull();
  });
});

describe('mediaFromSingleAudio', () => {
  const base = {
    source: 'manual' as const,
    audioPath: 'recordings/r1/audio.m4a',
    sizeBytes: 5000,
    durationSec: 1800,
    createdAt: 7,
    createdBy: 'adm',
  };

  it('makes the one file Part 1, audio only, ready, under the key it already has', () => {
    const media = mediaFromSingleAudio(base, 'i1');
    expect(media).toEqual({
      i1: expect.objectContaining({
        id: 'i1',
        part: 1,
        version: 'audio',
        kind: 'audio',
        status: 'ready',
        hidden: false,
        storageKey: 'recordings/r1/audio.m4a',
        sizeBytes: 5000,
        durationSec: 1800,
        source: 'upload',
        zoom: null,
        addedAt: 7,
        addedBy: 'adm',
      }),
    });
    // The recording's length is unchanged by the move.
    expect(deriveDurationSec(media)).toBe(1800);
  });

  it('keeps a Zoom import retryable and deduplicated by its file id', () => {
    const media = mediaFromSingleAudio({ ...base, source: 'zoom', zoomUuid: 'u==', zoomFileId: 'f1' }, 'i1');
    expect(media.i1.source).toBe('zoom');
    expect(media.i1.zoom).toEqual({
      meetingUuid: 'u==',
      fileId: 'f1',
      recordingType: 'audio_only',
      segmentStart: null,
      topic: null,
    });
  });

  it('makes nothing from a recording that had no audio', () => {
    expect(mediaFromSingleAudio({ ...base, audioPath: null }, 'i1')).toEqual({});
  });
});

describe('mediaStorageKey', () => {
  it('names the recording and the item', () => {
    expect(mediaStorageKey('rec1', 'item1')).toBe('media/rec1/item1');
  });
});

describe('mediaSummary', () => {
  it('says what students can play, in a few words', () => {
    expect(mediaSummary(QURAN)).toBe('2 parts · video and audio');
    expect(mediaSummary(mediaOf(item('a')))).toBe('audio');
    expect(mediaSummary(mediaOf(item('v', { kind: 'video', version: 'video' })))).toBe('video');
    // Hidden or not yet arrived is nothing to a student.
    expect(mediaSummary(mediaOf(item('a', { hidden: true }), item('b', { status: 'copying' })))).toBeNull();
  });
});

describe('playVerb', () => {
  it('asks a student to watch only what they can watch', () => {
    expect(playVerb(QURAN)).toBe('Watch');
    expect(playVerb(mediaOf(item('a')))).toBe('Listen');
    // A hidden or unfinished video leaves the student only the audio.
    expect(playVerb(mediaOf(item('a'), item('v', { kind: 'video', version: 'video', hidden: true })))).toBe('Listen');
    expect(playVerb(mediaOf(item('a'), item('v', { kind: 'video', version: 'video', status: 'copying' })))).toBe('Listen');
    expect(playVerb({})).toBe('Listen');
  });
});

describe('what staff may upload', () => {
  it('takes M4A, MP3, WAV and MP4 by name, whatever the case', () => {
    expect(uploadContentType('Class 3.M4A')).toBe('audio/mp4');
    expect(uploadContentType('class.mp3')).toBe('audio/mpeg');
    expect(uploadContentType('class.wav')).toBe('audio/wav');
    expect(uploadContentType('whiteboard.mp4')).toBe('video/mp4');
    // An iPhone video, raw AAC (no length without reading the whole file), and no extension at all.
    for (const name of ['IMG_0001.MOV', 'class.aac', 'notes.pdf', 'class']) expect(uploadContentType(name)).toBeNull();
  });

  it('caps audio at 300 MB and video at 8 GB', () => {
    expect(maxUploadBytes('audio/mp4')).toBe(300 * 2 ** 20);
    expect(maxUploadBytes('video/mp4')).toBe(8 * 2 ** 30);
  });

  it('cuts a file into parts that cover it, and the largest video into fewer than 10,000', () => {
    expect(uploadPartCount(1)).toBe(1);
    expect(uploadPartCount(UPLOAD_PART_BYTES)).toBe(1);
    expect(uploadPartCount(UPLOAD_PART_BYTES + 1)).toBe(2);
    expect(uploadPartCount(8 * 2 ** 30)).toBeLessThan(10_000);
  });
});
