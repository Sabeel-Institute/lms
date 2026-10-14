import { describe, expect, it } from 'vitest';
import type { MediaItem, MediaMap } from '@sabeel/shared';
import { placementOptions } from './uploadPlacement';

/** One file of a recording, ready unless told otherwise. */
const file = (id: string, over: Partial<MediaItem>): MediaItem =>
  ({
    id,
    part: 1,
    version: 'audio',
    kind: 'audio',
    label: null,
    status: 'ready',
    failReason: null,
    hidden: false,
    storageKey: `media/r/${id}`,
    contentType: 'audio/mp4',
    sizeBytes: 1,
    durationSec: 60,
    width: null,
    height: null,
    source: 'zoom',
    zoom: null,
    addedAt: 1,
    addedBy: 'adm',
    ...over,
  }) as MediaItem;

describe('where an uploaded file may go', () => {
  /*
   * A TWO-STRETCH IMPORT WHOSE FIRST STRETCH FAILED. The file list shows Part 1
   * (failed) and Part 2; a version can only go on Part 2, which has a working
   * file, and it must be called Part 2, as the list calls it.
   */
  it('names a part as the file list does, failed parts counted', () => {
    const media: MediaMap = {
      a1: file('a1', { part: 1, status: 'failed' }),
      a2: file('a2', { part: 2 }),
    };
    expect(placementOptions(media, 'video/mp4')).toEqual([
      { value: 'part', label: 'New part' },
      { value: 'v2', label: 'Version of Part 2' },
    ]);
  });

  it('offers no part that already has a file of the kind', () => {
    const media: MediaMap = { a1: file('a1', { part: 1 }) };
    expect(placementOptions(media, 'audio/mp4')).toEqual([{ value: 'part', label: 'New part' }]);
  });
});
