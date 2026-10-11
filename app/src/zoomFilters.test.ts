import { describe, expect, it } from 'vitest';
import type { ZoomImportRow } from '@sabeel/shared';
import { zoomRowsShown, type ZoomFilters } from './zoomFilters';

const row = (meetingUuid: string, startTime: string, over: Partial<ZoomImportRow> = {}): ZoomImportRow => ({
  meetingUuid,
  topic: 'Quran Immersion Fall',
  startTime,
  durationSec: 65 * 60,
  fileId: `${meetingUuid}-aud`,
  sizeBytes: 1,
  alreadyImported: null,
  importedCourseName: null,
  ...over,
});

// One recurring meeting, two classes an evening, all under one topic.
const ROWS = [
  row('thu-evening-2', '2026-10-09T00:15:00Z'), // 7:15 pm CDT on the 8th
  row('thu-evening-1', '2026-10-08T23:00:00Z'), // 6 pm CDT on the 8th
  row('wed-evening-2', '2026-10-08T00:15:00Z'), // 7:15 pm CDT on the 7th
  row('wed-evening-1', '2026-10-07T23:00:00Z', { alreadyImported: 'rec-1', importedCourseName: 'Tajweed QI' }),
];

const DEFAULTS: ZoomFilters = { status: 'available', search: '', hideShort: true, onDate: '2026-10-08' };
const shown = (f: Partial<ZoomFilters>) => zoomRowsShown(ROWS, { ...DEFAULTS, ...f }).map((r) => r.meetingUuid);

describe('zoomRowsShown — the session’s date', () => {
  /*
   * The 7:15 pm class is stamped on the 9th in UTC. Filtering on the UTC date
   * would hide it from the session it belongs to and offer the previous
   * evening's 7:15 class in its place — same topic, same length, wrong class.
   */
  it('shows the evening classes held on the session’s date in Houston, and only those', () => {
    expect(shown({})).toEqual(['thu-evening-2', 'thu-evening-1']);
  });

  it('shows every date when turned off', () => {
    expect(shown({ onDate: null })).toEqual(['thu-evening-2', 'thu-evening-1', 'wed-evening-2']);
  });

  it('narrows alongside the status filter rather than overriding it', () => {
    expect(shown({ status: 'imported' })).toEqual([]);
    expect(shown({ status: 'imported', onDate: '2026-10-07' })).toEqual(['wed-evening-1']);
  });
});
