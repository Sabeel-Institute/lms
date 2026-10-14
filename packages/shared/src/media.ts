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

/** The order versions are listed in everywhere: Zoom's formats first, audio last. */
export const VERSION_ORDER: readonly MediaVersion[] = ['speaker', 'slides', 'video', 'audio'];

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
  return [...byPart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([part, list]) => ({
      part,
      items: list.sort(
        (x, y) => VERSION_ORDER.indexOf(x.version) - VERSION_ORDER.indexOf(y.version) || x.addedAt - y.addedAt,
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

/**
 * A change to a recording's media that leaves every file as it is: hide or
 * show one, move a part, or set the version students start on. The screen and
 * the callable (`editRecordingMedia`) share this shape.
 */
export type MediaEdit =
  | { op: 'hide' | 'show'; itemId: string }
  | { op: 'moveUp' | 'moveDown'; part: number }
  | { op: 'defaultVersion'; version: MediaVersion };

/**
 * What a recording holds, in a few words for a list: "2 parts · video and
 * audio", "audio". Counts what students can play; null when that is nothing.
 */
export function mediaSummary(media: MediaMap): string | null {
  const playable = Object.values(media).filter(isPlayable);
  if (playable.length === 0) return null;
  const parts = new Set(playable.map((i) => i.part)).size;
  const kinds = new Set(playable.map((i) => i.kind));
  const what = kinds.size === 2 ? 'video and audio' : kinds.has('video') ? 'video' : 'audio';
  return parts > 1 ? `${parts} parts · ${what}` : what;
}

/**
 * The verb a student is asked to do with a recording: "Watch" when any of
 * what they can play is video, "Listen" otherwise — so "Watch by" and "Listen
 * by". Counts only what a student can play: a hidden video asks nobody to
 * watch anything.
 */
export function playVerb(media: MediaMap): 'Watch' | 'Listen' {
  return Object.values(media).some((i) => isPlayable(i) && i.kind === 'video') ? 'Watch' : 'Listen';
}

// ---------------------------------------------------------------- upload --

/**
 * What staff may upload, by extension, and the content type each is stored
 * under. The probe after upload decides whether the file inside is playable;
 * this only decides what the picker offers and what the server will start.
 */
export const UPLOAD_TYPES = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
} as const;

export type UploadContentType = (typeof UPLOAD_TYPES)[keyof typeof UPLOAD_TYPES];

/** The content type a file is stored under, from its name; null if it is not one staff may upload. */
export function uploadContentType(fileName: string): UploadContentType | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext && ext in UPLOAD_TYPES ? UPLOAD_TYPES[ext as keyof typeof UPLOAD_TYPES] : null;
}

/** Whether a stored content type is a video's. */
export function isVideoContentType(contentType: string): boolean {
  return contentType.startsWith('video/');
}

/** Largest audio file: a 2-hour 128 kbps M4A is ~115 MB, so 300 MiB leaves room. */
export const MAX_AUDIO_BYTES = 300 * 2 ** 20;
/** Largest uploaded video: 3.5 hours at Zoom's 1.75 GB/h ceiling, with headroom. */
export const MAX_VIDEO_UPLOAD_BYTES = 8 * 2 ** 30;

/** The cap on one uploaded file of this type. */
export function maxUploadBytes(contentType: string): number {
  return isVideoContentType(contentType) ? MAX_VIDEO_UPLOAD_BYTES : MAX_AUDIO_BYTES;
}

/**
 * The size of each piece an upload is sent in. Every upload is multipart, so
 * a dropped connection costs one piece, not the file. 16 MiB: small enough
 * that a phone holds three in memory at once, large enough that an 8 GiB
 * video is 512 pieces, well under the bucket's 10,000.
 */
export const UPLOAD_PART_BYTES = 16 * 2 ** 20;

/** How many pieces a file of this size is sent in. */
export function uploadPartCount(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_BYTES));
}

/** Where an uploaded file goes: a new part at the end, or another version of a part. */
export type UploadPlacement = { as: 'part' } | { as: 'version'; part: number };

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
 * A Zoom file's segment start is not in the old shape, so it comes out null,
 * and `scripts/backfill-zoom-segments.mjs` asks Zoom for it after the copy.
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
