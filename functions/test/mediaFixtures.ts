import { mediaStorageKey, type MediaItem, type MediaMap, type MediaVersion } from '@sabeel/shared';

/** The item id fixtures use for a recording's one audio file. */
export const AUDIO_ITEM = 'audio1';

/** One media item as an upload leaves it once confirmed; override what a test is about. */
function mediaItem(recordingId: string, id: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    part: 1,
    version: 'audio',
    kind: 'audio',
    label: null,
    status: 'ready',
    failReason: null,
    hidden: false,
    storageKey: mediaStorageKey(recordingId, id),
    contentType: 'audio/mp4',
    sizeBytes: 1024,
    durationSec: 3600,
    width: null,
    height: null,
    source: 'upload',
    zoom: null,
    addedAt: 1,
    addedBy: 'fixture',
    ...over,
  };
}

/**
 * The media fields of a recording holding one ready audio file — what a
 * recording that "has audio" means to every reader. `durationSec` is the
 * derived length, as the server would write it.
 */
export function withAudio(
  recordingId: string,
  over: Partial<MediaItem> = {},
): { media: MediaMap; defaultVersion: MediaVersion; durationSec: number | null } {
  const item = mediaItem(recordingId, AUDIO_ITEM, over);
  return {
    media: { [item.id]: item },
    defaultVersion: 'audio',
    durationSec: item.status === 'ready' && !item.hidden ? item.durationSec : null,
  };
}

/** The media fields of a recording with no file yet. */
export const NO_MEDIA = { media: {} as MediaMap, defaultVersion: 'audio' as MediaVersion, durationSec: null };
