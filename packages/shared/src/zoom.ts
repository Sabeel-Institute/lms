import { clockRangeInZone, todayInZone } from './assignments';
import { INSTITUTE_TIMEZONE } from './constants';

import type { MediaKind, MediaVersion } from './media';

/** The Zoom formats the import takes, as the media versions they become. */
export type ZoomFormat = Extract<MediaVersion, 'speaker' | 'slides' | 'audio'>;

/**
 * Zoom's `recording_type` for each format the import takes. Gallery view and
 * the speaker-only file are not recorded by the account; transcripts, chat and
 * timelines are not media.
 */
export const ZOOM_RECORDING_TYPES: Record<ZoomFormat, string> = {
  speaker: 'shared_screen_with_speaker_view',
  slides: 'shared_screen',
  audio: 'audio_only',
};

/** What kind of media a Zoom format is, and its content type. */
export function zoomFormatMedia(format: ZoomFormat): { kind: MediaKind; contentType: string } {
  return format === 'audio'
    ? { kind: 'audio', contentType: 'audio/mp4' }
    : { kind: 'video', contentType: 'video/mp4' };
}

/** One importable file of a Zoom recording segment, as the picker sees it. */
export interface ZoomFileRow {
  fileId: string;
  format: ZoomFormat;
  sizeBytes: number;
  /** False while Zoom is still processing it: listed, not pickable. */
  ready: boolean;
  /** Where it went, when this institute already has it; else null. */
  imported: { recordingId: string; sessionId: string; courseName: string | null } | null;
}

/**
 * One stretch of recording: Zoom starts a new segment, under the same meeting,
 * each time the host stops and restarts recording. Its formats cover the same
 * minutes and become versions of one part.
 */
export interface ZoomSegmentRow {
  /** When it began (ISO 8601, UTC). */
  startTime: string;
  durationSec: number;
  files: ZoomFileRow[];
}

/**
 * A Zoom meeting with its importable files, grouped as Zoom groups them —
 * shared so the callable's return type and the picker's row type cannot drift.
 * `startTime` and `durationSec` are the first segment's start and the
 * segments' total, which is what dates the meeting and what the card shows.
 */
export interface ZoomMeetingRow {
  meetingUuid: string;
  topic: string;
  startTime: string;
  durationSec: number;
  segments: ZoomSegmentRow[];
}

/**
 * `zoomImports/{fileId}`: where one Zoom file went. Written in the same
 * transaction that adds the media item, deleted with it, so the picker's
 * "already imported" and the media map cannot disagree.
 */
export interface ZoomImportDoc {
  recordingId: string;
  itemId: string;
  sessionId: string;
  courseId: string;
  meetingUuid: string;
  claimedAt: number;
}

/**
 * The date a Zoom recording was made on, in the institute's calendar.
 *
 * THE ONE ANSWER TO "WHICH DAY", for every place that asks: the picker's card,
 * its same-day filter, and the date range the callable honours. Zoom's own
 * timestamps are UTC, and the first ten characters of one put every class that
 * starts at 7 pm Houston time or later (6 pm once the clocks go back) on the
 * following day — the evening classes, which are exactly the ones that share a
 * recurring meeting and need telling apart.
 */
export function zoomRecordingDate(rec: { startTime: string }): string {
  return todayInZone(INSTITUTE_TIMEZONE, Date.parse(rec.startTime));
}

/**
 * When the audio ran, on the institute's 12-hour clock: `6:02–8:18 PM`.
 *
 * What tells two recordings of one recurring meeting apart, since they share a
 * topic and a date. The end is the start plus the duration the row already
 * carries, so the two figures on the card cannot disagree.
 */
export function zoomRecordingHours(rec: { startTime: string; durationSec: number }): string {
  const start = Date.parse(rec.startTime);
  return clockRangeInZone(INSTITUTE_TIMEZONE, start, start + rec.durationSec * 1000);
}

// ------------------------------------------------- Zoom's own listings --
//
// Pure, with no network, so the server's import and the operator scripts read
// a listing the same way: one answer to "which segment is this file in".

/** One importable file, as Zoom reports it now. */
export interface ZoomFileInfo {
  meetingUuid: string;
  topic: string;
  fileId: string;
  format: ZoomFormat;
  sizeBytes: number;
  durationSec: number;
  /** When its segment began (ISO 8601): the file's own `recording_start`. */
  segmentStart: string;
  /** False while Zoom is still processing it. */
  ready: boolean;
}

/** A meeting's importable files, grouped into segments. */
export interface ZoomMeetingListing {
  meetingUuid: string;
  topic: string;
  startTime: string;
  durationSec: number;
  segments: { startTime: string; durationSec: number; files: ZoomFileInfo[] }[];
}

/** Zoom's own response shapes, only the fields read. */
export interface ZoomFile {
  id?: string;
  status?: string;
  recording_type?: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  recording_start?: string;
  recording_end?: string;
  download_url?: string;
}
export interface ZoomMeeting {
  uuid?: string;
  topic?: string;
  start_time?: string;
  duration?: number; // minutes
  recording_files?: ZoomFile[];
}
const FORMAT_OF: Record<string, ZoomFormat> = Object.fromEntries(
  Object.entries(ZOOM_RECORDING_TYPES).map(([format, type]) => [type, format as ZoomFormat]),
);

/**
 * When a file ran: its own start and length, which bracket exactly what
 * students will see or hear — the meeting may have opened minutes before
 * anyone pressed record. The meeting's start and whole minutes only when the
 * file does not say.
 */
function fileSpan(f: ZoomFile, m: ZoomMeeting): { startTime: string; durationSec: number } {
  if (f.recording_start && f.recording_end) {
    const d = (Date.parse(f.recording_end) - Date.parse(f.recording_start)) / 1000;
    if (Number.isFinite(d) && d > 0) return { startTime: f.recording_start, durationSec: Math.round(d) };
  }
  return { startTime: m.start_time ?? '', durationSec: Math.round((m.duration ?? 0) * 60) };
}

/** One of a meeting's files as an importable file, or null if it is not media the import takes. */
export function zoomFileInfo(m: ZoomMeeting, f: ZoomFile): ZoomFileInfo | null {
  // An M4A with no `recording_type` is the audio: older listings left it off.
  const format: ZoomFormat | undefined =
    FORMAT_OF[f.recording_type ?? ''] ??
    (!f.recording_type && (f.file_extension ?? f.file_type) === 'M4A' ? 'audio' : undefined);
  if (!format || !f.id) return null;
  const span = fileSpan(f, m);
  return {
    meetingUuid: m.uuid ?? '',
    topic: m.topic ?? '',
    fileId: f.id,
    format,
    sizeBytes: f.file_size ?? 0,
    durationSec: span.durationSec,
    segmentStart: span.startTime,
    ready: (f.status ?? 'completed') === 'completed',
  };
}

/**
 * A meeting → its importable files grouped into segments, or null if it has
 * none. Pure (no network): the one bit of Zoom-JSON parsing worth testing on
 * its own, since the fake client in integration tests hands back listings
 * already in this shape.
 *
 * A SEGMENT IS A RECORDING START. Stopping and restarting the recording makes
 * a new set of files under the same meeting, each file carrying the start of
 * its own stretch, and the formats of one stretch share it. A segment's length
 * is its longest file's. Null too for a meeting with no readable start: it has
 * no date, so no range could hold it, and dating it would throw on the list.
 */
export function meetingListing(m: ZoomMeeting): ZoomMeetingListing | null {
  const bySegment = new Map<string, ZoomFileInfo[]>();
  for (const f of m.recording_files ?? []) {
    const info = zoomFileInfo(m, f);
    if (!info || !Number.isFinite(Date.parse(info.segmentStart))) continue;
    bySegment.set(info.segmentStart, [...(bySegment.get(info.segmentStart) ?? []), info]);
  }
  if (bySegment.size === 0) return null;
  const order: ZoomFormat[] = ['speaker', 'slides', 'audio'];
  const segments = [...bySegment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([startTime, files]) => ({
      startTime,
      durationSec: Math.max(...files.map((f) => f.durationSec)),
      files: files.sort((x, y) => order.indexOf(x.format) - order.indexOf(y.format)),
    }));
  return {
    meetingUuid: m.uuid ?? '',
    topic: m.topic ?? '',
    startTime: segments[0].startTime,
    durationSec: segments.reduce((n, seg) => n + seg.durationSec, 0),
    segments,
  };
}

/**
 * Where one of a meeting's files began: its segment's start, exactly as an
 * import records it (`ZoomMediaRef.segmentStart`). Null when the meeting no
 * longer lists the file. For an item copied from before segments were
 * recorded, which is what `scripts/backfill-zoom-segments.mjs` fills in.
 */
export function fileSegmentStart(m: ZoomMeeting, fileId: string): string | null {
  const f = (m.recording_files ?? []).find((x) => x.id === fileId);
  const start = f ? fileSpan(f, m).startTime : '';
  return Number.isFinite(Date.parse(start)) ? start : null;
}
