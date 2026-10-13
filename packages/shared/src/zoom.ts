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
