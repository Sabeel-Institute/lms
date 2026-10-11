/**
 * The Zoom import picker's filters — the pure part.
 *
 * The institute runs one recurring Zoom meeting per cohort, so every class in
 * it comes back under the same topic. What tells them apart is the day and the
 * hours, and the session being imported into already knows its day — so by
 * default the picker shows only that day's recordings. Kept out of the screen
 * so that rule is tested where it lives.
 */
import { zoomRecordingDate, type ZoomImportRow } from '@sabeel/shared';

export type ZoomStatusFilter = 'available' | 'imported' | 'all';

export interface ZoomFilters {
  status: ZoomStatusFilter;
  search: string;
  hideShort: boolean;
  /** Only recordings made on this institute-calendar date; null shows every date. */
  onDate: string | null;
}

/** Under this, a recording is a test click or a dropped call, not a class. */
const SHORT_SEC = 120;

export function zoomRowsShown(rows: readonly ZoomImportRow[], f: ZoomFilters): ZoomImportRow[] {
  const phrase = f.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === 'all' || (f.status === 'imported' ? r.alreadyImported : !r.alreadyImported)) &&
      (!phrase || r.topic.toLowerCase().includes(phrase)) &&
      (!f.hideShort || r.durationSec >= SHORT_SEC) &&
      (f.onDate === null || zoomRecordingDate(r) === f.onDate),
  );
}
