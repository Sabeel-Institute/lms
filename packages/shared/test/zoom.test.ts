import { describe, it, expect } from 'vitest';
import { zoomRecordingDate, zoomRecordingHours } from '../src';

describe('zoomRecordingDate', () => {
  /*
   * THE POINT OF THE FUNCTION. Zoom stamps a 7 pm Houston class at midnight
   * UTC, so the UTC date — what the picker used to print — is the next day, and
   * the class could not be found under the date of the session it belongs to.
   */
  it('dates an evening class by the institute calendar, not by UTC', () => {
    expect(zoomRecordingDate({ startTime: '2026-10-09T00:02:00Z' })).toBe('2026-10-08');
  });

  /*
   * The same UTC clock time on either side of the change: 05:30 UTC is 12:30
   * am CDT in October but 11:30 pm CST in November. Any fixed offset gets one
   * of the two wrong.
   */
  it('follows the clocks going back, not a fixed offset', () => {
    expect(zoomRecordingDate({ startTime: '2026-10-09T05:30:00Z' })).toBe('2026-10-09');
    expect(zoomRecordingDate({ startTime: '2026-11-12T05:30:00Z' })).toBe('2026-11-11');
  });

  it('leaves a daytime class on its own date', () => {
    expect(zoomRecordingDate({ startTime: '2026-10-08T15:00:00Z' })).toBe('2026-10-08');
  });
});

describe('zoomRecordingHours', () => {
  it('runs from the start for the duration, on the institute clock', () => {
    // 136 minutes from 6:02 pm CDT.
    expect(zoomRecordingHours({ startTime: '2026-10-08T23:02:00Z', durationSec: 136 * 60 })).toBe(
      '6:02–8:18 PM',
    );
  });

  it('tells apart two classes that share a meeting, a topic and a date', () => {
    const tajweed = zoomRecordingHours({ startTime: '2026-10-08T23:00:00Z', durationSec: 65 * 60 });
    const arabic = zoomRecordingHours({ startTime: '2026-10-09T00:15:00Z', durationSec: 65 * 60 });
    expect([tajweed, arabic]).toEqual(['6:00–7:05 PM', '7:15–8:20 PM']);
  });
});
