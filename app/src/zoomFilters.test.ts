import { describe, expect, it } from 'vitest';
import type { ZoomFileRow, ZoomMeetingRow } from '@sabeel/shared';
import {
  chosenFiles,
  quickPickFiles,
  selectionSummary,
  storageCostText,
  zoomMeetingsShown,
  type ZoomFilters,
} from './zoomFilters';

const f = (fileId: string, over: Partial<ZoomFileRow> = {}): ZoomFileRow => ({
  fileId,
  format: 'audio',
  sizeBytes: 1,
  ready: true,
  imported: null,
  ...over,
});

const meeting = (meetingUuid: string, startTime: string, over: Partial<ZoomMeetingRow> = {}): ZoomMeetingRow => ({
  meetingUuid,
  topic: 'Quran Immersion Fall',
  startTime,
  durationSec: 65 * 60,
  segments: [{ startTime, durationSec: 65 * 60, files: [f(`${meetingUuid}-aud`)] }],
  ...over,
});

// One recurring meeting, two classes an evening, all under one topic.
const ROWS = [
  meeting('thu-evening-2', '2026-10-09T00:15:00Z'), // 7:15 pm CDT on the 8th
  meeting('thu-evening-1', '2026-10-08T23:00:00Z'), // 6 pm CDT on the 8th
  meeting('wed-evening-2', '2026-10-08T00:15:00Z'), // 7:15 pm CDT on the 7th
  meeting('wed-evening-1', '2026-10-07T23:00:00Z', {
    segments: [
      {
        startTime: '2026-10-07T23:00:00Z',
        durationSec: 65 * 60,
        files: [f('wed1-aud', { imported: { recordingId: 'rec-1', sessionId: 's', courseName: 'Tajweed QI' } })],
      },
    ],
  }),
];

const DEFAULTS: ZoomFilters = { status: 'available', search: '', hideShort: true, onDate: '2026-10-08' };
const shown = (x: Partial<ZoomFilters>) => zoomMeetingsShown(ROWS, { ...DEFAULTS, ...x }).map((r) => r.meetingUuid);

describe('zoomMeetingsShown — the session’s date', () => {
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

/** The 2026-10-08 class's first meeting: three formats, and a 40-second restart. */
const QURAN: ZoomMeetingRow = {
  meetingUuid: 'm1',
  topic: 'Quran Immersion Fall',
  startTime: '2026-10-08T14:54:00Z',
  durationSec: 8160 + 40,
  segments: [
    {
      startTime: '2026-10-08T14:54:00Z',
      durationSec: 8160,
      files: [
        f('spk', { format: 'speaker', sizeBytes: 229_000_000 }),
        f('sld', { format: 'slides', sizeBytes: 147_000_000 }),
        f('aud', { sizeBytes: 79_000_000 }),
      ],
    },
    { startTime: '2026-10-08T17:10:00Z', durationSec: 40, files: [f('short-aud', { sizeBytes: 10_000 })] },
  ],
};

describe('quick picks', () => {
  it('choose those formats, and leave a short restart for staff to tick by hand', () => {
    expect(quickPickFiles(QURAN, 'audio')).toEqual(['aud']);
    expect(quickPickFiles(QURAN, 'videoAndAudio')).toEqual(['spk', 'aud']);
    expect(quickPickFiles(QURAN, 'everything')).toEqual(['spk', 'sld', 'aud']);
  });

  it('never choose a file that is still processing or already imported', () => {
    const busy: ZoomMeetingRow = {
      ...QURAN,
      segments: [
        {
          ...QURAN.segments[0],
          files: [
            f('spk', { format: 'speaker', ready: false }),
            f('aud', { imported: { recordingId: 'r', sessionId: 's', courseName: null } }),
          ],
        },
      ],
    };
    expect(quickPickFiles(busy, 'videoAndAudio')).toEqual([]);
  });
});

describe('what the chosen files add up to', () => {
  it('counts each stretch of class once, however many formats of it are chosen', () => {
    const s = selectionSummary([QURAN], new Set(['spk', 'aud']));
    expect(s).toMatchObject({ files: 2, bytes: 308_000_000, durationSec: 8160 });
    // The plan's worked example: 455 MB is "about $0.01 a month".
    expect(storageCostText(selectionSummary([QURAN], new Set(['spk', 'sld', 'aud'])).usdPerMonth)).toBe(
      'about $0.01 a month to store',
    );
  });

  it('says so rather than printing $0.00 for a small file', () => {
    expect(storageCostText(selectionSummary([QURAN], new Set(['short-aud'])).usdPerMonth)).toBe(
      'under a cent a month to store',
    );
  });

  it('hands the import the meeting each chosen file came from', () => {
    expect(chosenFiles([QURAN, ...ROWS], new Set(['aud', 'thu-evening-1-aud']))).toEqual([
      { meetingUuid: 'm1', fileId: 'aud' },
      { meetingUuid: 'thu-evening-1', fileId: 'thu-evening-1-aud' },
    ]);
  });
});
