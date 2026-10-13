import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zoomClient, type ZoomMeeting } from '../../src/zoom';

/*
 * THE REAL CLIENT against a fake Zoom, at the one seam it has: `fetch`.
 *
 * The fake answers the way the forum and the API's own behaviour say Zoom
 * does — `from`/`to` are UTC calendar dates, both inclusive — so what is under
 * test is what a staff member gets when they type a date: the classes held on
 * that day in Houston, evening ones included, and none from the evening before.
 */
const meeting = (uuid: string, start: string, minutes: number): ZoomMeeting => ({
  uuid,
  topic: 'Quran Immersion Fall',
  start_time: start,
  duration: minutes,
  recording_files: [
    {
      id: `${uuid}-aud`,
      status: 'completed',
      recording_type: 'audio_only',
      file_type: 'M4A',
      file_size: 1,
      recording_start: start,
      recording_end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    },
  ],
});

const ZOOM = [
  meeting('wed-evening', '2026-10-08T00:00:00Z', 65), // 7 pm CDT on the 7th
  meeting('thu-afternoon', '2026-10-08T18:00:00Z', 65), // 1 pm CDT on the 8th
  meeting('thu-evening-1', '2026-10-08T23:00:00Z', 65), // 6 pm CDT on the 8th
  meeting('thu-evening-2', '2026-10-09T00:15:00Z', 65), // 7:15 pm CDT on the 8th
  meeting('fri-afternoon', '2026-10-09T18:00:00Z', 65), // 1 pm CDT on the 9th
];

let asked: { from: string; to: string }[] = [];

beforeEach(() => {
  asked = [];
  process.env.ZOOM_ACCOUNT_ID = 'acct';
  process.env.ZOOM_CLIENT_ID = 'id';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'zoom.us') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    asked.push({ from, to });
    const meetings = ZOOM.filter((m) => {
      const utcDate = (m.start_time ?? '').slice(0, 10);
      return utcDate >= from && utcDate <= to;
    });
    return new Response(JSON.stringify({ meetings, next_page_token: '' }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listMeetings — the dates are the institute’s', () => {
  it('lists every class held on the day in Houston, evening ones included', async () => {
    const rows = await zoomClient.listMeetings('2026-10-08', '2026-10-08');
    expect(rows.map((r) => r.meetingUuid)).toEqual(['thu-evening-2', 'thu-evening-1', 'thu-afternoon']);
  });

  it('keeps the evening before out, though Zoom files it under the same UTC date', async () => {
    const rows = await zoomClient.listMeetings('2026-10-08', '2026-10-08');
    expect(rows.map((r) => r.meetingUuid)).not.toContain('wed-evening');
  });

  it('keeps the day after out, though it had to ask Zoom for it', async () => {
    const rows = await zoomClient.listMeetings('2026-10-08', '2026-10-08');
    expect(rows.map((r) => r.meetingUuid)).not.toContain('fri-afternoon');
    expect(asked).toEqual([{ from: '2026-10-08', to: '2026-10-09' }]);
  });
});
