/**
 * The media a recording holds: parts and versions.
 *
 * A recording is still the unit of everything students owe (grants,
 * completion, progress, the ledger). What it holds is a set of media items,
 * organised two ways:
 *
 * - a PART is a stretch of class time, and parts play in order;
 * - a VERSION is a format of a part ("slides and speaker", "audio only"),
 *   and every version of a part shares its timeline.
 *
 * Items live inside the recording document as a map keyed by item id, so the
 * player reads one document and a status change is one transaction with them.
 * See docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md.
 */
export type MediaKind = 'audio' | 'video';

/** `video` is an upload; the other three are Zoom's formats. */
export type MediaVersion = 'speaker' | 'slides' | 'audio' | 'video';

/**
 * `uploading` and `copying` are on their way into the bucket; `failed` never
 * got there and says why. Only `ready` items can be played or published.
 */
export type MediaStatus = 'uploading' | 'copying' | 'ready' | 'failed';

export type MediaSource = 'zoom' | 'upload';

/** Where a Zoom item came from, so a failed copy can be retried. */
export interface ZoomMediaRef {
  meetingUuid: string;
  /** Zoom's id for the one file; the dedupe key (`zoomImports/{fileId}`). */
  fileId: string;
  /** Zoom's `recording_type`, e.g. `audio_only`. */
  recordingType: string;
  /** When the segment began (ISO 8601), which groups versions into a part.
   *  Null on items migrated from before parts existed. */
  segmentStart: string | null;
  topic: string | null;
}

export interface MediaItem {
  /** Random, and also the last segment of `storageKey`. */
  id: string;
  /** 1-based; parts play in this order. */
  part: number;
  version: MediaVersion;
  kind: MediaKind;
  /** A staff override of the generated label. */
  label: string | null;
  status: MediaStatus;
  failReason: string | null;
  /** Hidden items stay in the bucket and in history; students do not see them. */
  hidden: boolean;
  storageKey: string;
  contentType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  /** Video only. */
  width: number | null;
  height: number | null;
  source: MediaSource;
  /** Zoom items only. */
  zoom: ZoomMediaRef | null;
  addedAt: number;
  addedBy: string;
}

export type MediaMap = Record<string, MediaItem>;

/** What each version is called wherever it is listed or chosen. */
export const VERSION_LABELS: Record<MediaVersion, string> = {
  speaker: 'Video: slides and speaker',
  slides: 'Video: slides only',
  audio: 'Audio only',
  video: 'Video',
};

/** An item's name: the staff override, or its version's. */
export function itemLabel(item: Pick<MediaItem, 'label' | 'version'>): string {
  return item.label ?? VERSION_LABELS[item.version];
}

/**
 * Where an item's bytes live in the media bucket. One definition, used by the
 * upload and import paths and checked against the copier Worker's own key
 * pattern by `functions/test/unit/mediaConfig.test.ts`.
 *
 * Items migrated from before parts existed keep the key they were stored
 * under, which is why every item carries its own `storageKey` and nothing
 * derives one from an id after the fact.
 */
export function mediaStorageKey(recordingId: string, itemId: string): string {
  return `media/${recordingId}/${itemId}`;
}

/** Ready and not hidden: what a student can play. */
export function isPlayable(item: MediaItem): boolean {
  return item.status === 'ready' && !item.hidden;
}

export interface MediaPart {
  part: number;
  items: MediaItem[];
}

/**
 * The parts a list of items makes, in play order. Items within a part keep a
 * fixed order (Zoom's formats first, by version name) so every surface lists
 * them the same way.
 */
export function mediaParts(items: Iterable<MediaItem>): MediaPart[] {
  const byPart = new Map<number, MediaItem[]>();
  for (const item of items) {
    const list = byPart.get(item.part) ?? [];
    list.push(item);
    byPart.set(item.part, list);
  }
  const order: MediaVersion[] = ['speaker', 'slides', 'video', 'audio'];
  return [...byPart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([part, list]) => ({
      part,
      items: list.sort(
        (x, y) => order.indexOf(x.version) - order.indexOf(y.version) || x.addedAt - y.addedAt,
      ),
    }));
}

/**
 * The recording's length: over the parts a student can play, the longest ready
 * version of each, added up. Versions of one part cover the same minutes, so
 * adding them would count a class twice.
 *
 * Null when nothing playable has a known length, which the ledger shows as
 * "unknown" rather than a confident 0% (`listenedShare`).
 */
export function deriveDurationSec(media: MediaMap): number | null {
  let total = 0;
  let known = false;
  for (const { items } of mediaParts(Object.values(media).filter(isPlayable))) {
    const longest = Math.max(0, ...items.map((i) => i.durationSec ?? 0));
    if (longest > 0) {
      total += longest;
      known = true;
    }
  }
  return known ? total : null;
}

/**
 * The item a student starts on: the first playable part, in the recording's
 * default version if that part has it, else its audio, else whatever it has.
 */
export function startingItem(media: MediaMap, defaultVersion: MediaVersion): MediaItem | null {
  const first = mediaParts(Object.values(media).filter(isPlayable))[0];
  if (!first) return null;
  return (
    first.items.find((i) => i.version === defaultVersion) ??
    first.items.find((i) => i.version === 'audio') ??
    first.items[0]
  );
}

/** Nothing at all: no item in any state. */
export function hasNoMedia(media: MediaMap): boolean {
  return Object.keys(media).length === 0;
}

/** A recording as stored before parts existed: one audio file, or none. */
export interface SingleAudioRecording {
  source: 'manual' | 'zoom';
  audioPath: string | null;
  sizeBytes: number | null;
  durationSec: number | null;
  zoomUuid?: string;
  zoomFileId?: string;
  createdAt: number;
  createdBy: string;
  /** What the file is; recordings from before parts existed were all M4A. */
  contentType?: string;
}

/**
 * The media map for a recording stored before parts existed: its one audio
 * file as Part 1, "Audio only", ready — or nothing, if it had none.
 *
 * THE ONE TRANSFORM, used by the seed that copies the live project's data on
 * switchover day and by the migration of what this project already holds, so
 * the two cannot convert a recording differently. The object keeps its key.
 */
export function mediaFromSingleAudio(rec: SingleAudioRecording, itemId: string): MediaMap {
  if (!rec.audioPath) return {};
  const zoom: ZoomMediaRef | null =
    rec.source === 'zoom' && rec.zoomUuid && rec.zoomFileId
      ? {
          meetingUuid: rec.zoomUuid,
          fileId: rec.zoomFileId,
          recordingType: 'audio_only',
          segmentStart: null,
          topic: null,
        }
      : null;
  return {
    [itemId]: {
      id: itemId,
      part: 1,
      version: 'audio',
      kind: 'audio',
      label: null,
      status: 'ready',
      failReason: null,
      hidden: false,
      storageKey: rec.audioPath,
      contentType: rec.contentType ?? 'audio/mp4',
      sizeBytes: rec.sizeBytes,
      durationSec: rec.durationSec,
      width: null,
      height: null,
      source: rec.source === 'zoom' ? 'zoom' : 'upload',
      zoom,
      addedAt: rec.createdAt,
      addedBy: rec.createdBy,
    },
  };
}
