/**
 * The Zoom import picker's logic — the pure part: which meetings show, what a
 * quick pick chooses, and what the chosen files add up to.
 *
 * The institute runs one recurring Zoom meeting per cohort, so every class in
 * it comes back under the same topic. What tells them apart is the day and the
 * hours, and the session being imported into already knows its day — so by
 * default the picker shows only that day's meetings. Kept out of the screen so
 * these rules are tested where they live.
 */
import {
  R2_STORAGE_USD_PER_GB_MONTH,
  zoomRecordingDate,
  type ZoomFileRow,
  type ZoomFormat,
  type ZoomMeetingRow,
  type ZoomSegmentRow,
} from '@sabeel/shared';

export type ZoomStatusFilter = 'available' | 'imported' | 'all';

/** Which formats are offered: every format, the videos, or the audio alone. */
export type ZoomFormatFilter = 'all' | 'video' | 'audio';

export interface ZoomFilters {
  status: ZoomStatusFilter;
  search: string;
  hideShort: boolean;
  /** Only meetings recorded on this institute-calendar date; null shows every date. */
  onDate: string | null;
}

/** Under this, a recording is a test click or a dropped call, not a class. */
const SHORT_SEC = 120;

/** A file staff can still choose: Zoom has finished it and nobody has imported it. */
export const choosable = (f: ZoomFileRow) => f.ready && !f.imported;

export function zoomMeetingsShown(rows: readonly ZoomMeetingRow[], f: ZoomFilters): ZoomMeetingRow[] {
  const phrase = f.search.trim().toLowerCase();
  const files = (m: ZoomMeetingRow) => m.segments.flatMap((s) => s.files);
  return rows.filter(
    (m) =>
      (f.status === 'all' ||
        (f.status === 'imported' ? files(m).some((x) => x.imported) : files(m).some((x) => !x.imported))) &&
      (!phrase || m.topic.toLowerCase().includes(phrase)) &&
      (!f.hideShort || m.durationSec >= SHORT_SEC) &&
      (f.onDate === null || zoomRecordingDate(m) === f.onDate),
  );
}

/** Whether a file's format is offered under the format filter. */
export function formatShown(format: ZoomFormat, filter: ZoomFormatFilter): boolean {
  return filter === 'all' || (filter === 'audio') === (format === 'audio');
}

export type QuickPick = 'audio' | 'videoAndAudio' | 'everything';

const QUICK_FORMATS: Record<QuickPick, ZoomFormat[]> = {
  audio: ['audio'],
  videoAndAudio: ['speaker', 'audio'],
  everything: ['speaker', 'slides', 'audio'],
};

/**
 * What a quick pick chooses in one meeting: those formats, in every segment of
 * a class's length, that can still be chosen. A short segment (a test click,
 * a restart that caught a few seconds) is left for staff to tick by hand.
 */
export function quickPickFiles(meeting: ZoomMeetingRow, pick: QuickPick): string[] {
  return meeting.segments
    .filter((s) => s.durationSec >= SHORT_SEC)
    .flatMap((s) => s.files)
    .filter((f) => choosable(f) && QUICK_FORMATS[pick].includes(f.format))
    .map((f) => f.fileId);
}

/** The chosen files, as the import callable takes them. */
export function chosenFiles(
  rows: readonly ZoomMeetingRow[],
  chosen: ReadonlySet<string>,
): { meetingUuid: string; fileId: string }[] {
  return rows.flatMap((m) =>
    m.segments.flatMap((s) =>
      s.files.filter((f) => chosen.has(f.fileId)).map((f) => ({ meetingUuid: m.meetingUuid, fileId: f.fileId })),
    ),
  );
}

export interface SelectionSummary {
  files: number;
  bytes: number;
  /** Class time covered: each segment with anything chosen, once. */
  durationSec: number;
  /** What storing the chosen files costs a month on R2, in dollars. */
  usdPerMonth: number;
}

export function selectionSummary(rows: readonly ZoomMeetingRow[], chosen: ReadonlySet<string>): SelectionSummary {
  let files = 0;
  let bytes = 0;
  let durationSec = 0;
  for (const m of rows) {
    for (const s of m.segments) {
      const picked = s.files.filter((f) => chosen.has(f.fileId));
      if (picked.length === 0) continue;
      files += picked.length;
      bytes += picked.reduce((n, f) => n + f.sizeBytes, 0);
      durationSec += s.durationSec;
    }
  }
  return { files, bytes, durationSec, usdPerMonth: (bytes / 1e9) * R2_STORAGE_USD_PER_GB_MONTH };
}

/** "about $0.01 a month", or "under a cent a month" — never a confident $0.00. */
export function storageCostText(usdPerMonth: number): string {
  if (usdPerMonth < 0.005) return 'under a cent a month to store';
  return `about $${usdPerMonth.toFixed(2)} a month to store`;
}

/** A segment is short enough to be a test click or a dropped restart. */
export const isShortSegment = (s: ZoomSegmentRow) => s.durationSec < SHORT_SEC;
