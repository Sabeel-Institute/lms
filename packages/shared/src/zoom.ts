import { clockRangeInZone, todayInZone } from './assignments';
import { INSTITUTE_TIMEZONE } from './constants';

/**
 * A Zoom cloud recording (audio-only) as the import picker sees it — shared so
 * the callable's return type and the screen's row type cannot drift.
 */
export interface ZoomImportRow {
  meetingUuid: string;
  topic: string;
  /** When the AUDIO began (ISO 8601, UTC) — see `zoomRecordingDate`. */
  startTime: string;
  durationSec: number;
  fileId: string;
  sizeBytes: number;
  /**
   * Existing recording id if already imported, else null.
   *
   * Both a flag and a destination: the picker filters on it and the row it
   * renders is tappable through to that recording, which is what the brief
   * promises an already-imported row does.
   */
  alreadyImported: string | null;
  /** When already imported: the class it went into, for the row's sentence. */
  importedCourseName: string | null;
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
