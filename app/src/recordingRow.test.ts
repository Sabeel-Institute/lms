import { describe, expect, it } from 'vitest';
import { mediaSummary, startingItem, type MediaItem, type RecordingDoc } from '@sabeel/shared';
import { recordingRow } from './recordingRow';

/**
 * A recording as a browser's cache can still hold it: written before
 * recordings carried `media` (the legacy shape — one audio file, keyed by its
 * storage path). The web app answers a listener from its cache first, and a
 * staff phone that had opened the library before the move drew such copies
 * on the live site; `Object.values(undefined)` in the library's first row
 * blanked the whole app (SABEEL-RECORDING-WEB-7). The server's copy replaces
 * it a moment later, so all the row has to do is be drawable meanwhile.
 */
const cachedBeforeMedia = {
  courseId: 'c1',
  cohortId: 'k1',
  sessionId: 's1',
  title: 'Week 3',
  status: 'published',
  storagePath: 'recordings/r1/audio.m4a',
  durationSec: 3600,
  createdAt: 1,
} as unknown as RecordingDoc;

describe('a recording as read', () => {
  it('one cached before recordings carried media is drawn as having nothing to play, not a crash', () => {
    const row = recordingRow('r1', cachedBeforeMedia);
    // What the library draws for every row.
    expect(startingItem(row.media, row.defaultVersion)).toBeNull();
    expect(mediaSummary(row.media)).toBeNull();
  });

  it('a current recording keeps its media and the version students start on', () => {
    const item: MediaItem = {
      id: 'm1', part: 1, version: 'speaker', kind: 'video', label: null, status: 'ready', failReason: null,
      hidden: false, storageKey: 'recordings/r2/m1', contentType: 'video/mp4', sizeBytes: 1, durationSec: 60,
      width: 1280, height: 720, source: 'upload', addedAt: 1,
    } as MediaItem;
    const row = recordingRow('r2', { ...cachedBeforeMedia, media: { m1: item }, defaultVersion: 'speaker' });
    expect(startingItem(row.media, row.defaultVersion)?.id).toBe('m1');
  });
});
