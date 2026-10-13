import { describe, it, expect } from 'vitest';
import { dateWindows, meetingListing } from '../../src/zoom';

const audio = (over = {}) => ({
  id: 'aud',
  recording_type: 'audio_only',
  file_type: 'M4A',
  file_extension: 'M4A',
  file_size: 12345,
  recording_start: '2026-05-07T18:00:05Z',
  recording_end: '2026-05-07T18:05:05Z',
  status: 'completed',
  ...over,
});

describe('meetingListing', () => {
  it('lists the formats the import takes, as versions of one segment, and nothing else', () => {
    // The shape the live account returns: video, audio, timeline and transcript.
    const m = meetingListing({
      uuid: 'abc/def==',
      topic: 'Session 3',
      start_time: '2026-05-07T18:00:00Z',
      duration: 90,
      recording_files: [
        { ...audio(), id: 'mp4', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4', file_size: 99999 },
        { ...audio(), id: 'tl', recording_type: 'timeline', file_type: 'TIMELINE' },
        { ...audio(), id: 'vtt', recording_type: 'audio_transcript', file_type: 'TRANSCRIPT' },
        audio(),
        { ...audio(), id: 'scr', recording_type: 'shared_screen', file_type: 'MP4', file_size: 5000 },
      ],
    });
    expect(m).toMatchObject({ meetingUuid: 'abc/def==', topic: 'Session 3', durationSec: 300 });
    expect(m?.segments).toHaveLength(1);
    expect(m?.segments[0].files.map((f) => [f.fileId, f.format, f.sizeBytes])).toEqual([
      ['mp4', 'speaker', 99999],
      ['scr', 'slides', 5000],
      ['aud', 'audio', 12345],
    ]);
  });

  it('makes a segment of each time recording restarted, in order, and adds up their lengths', () => {
    // 2026-08-13 Team Meetings: a 62.5-minute and a 1.5-minute segment.
    const second = { recording_start: '2026-08-13T19:10:00Z', recording_end: '2026-08-13T19:11:30Z' };
    const m = meetingListing({
      uuid: 'u',
      start_time: '2026-08-13T18:00:00Z',
      recording_files: [
        audio({ id: 'a2', ...second }),
        audio({ id: 'a1', recording_start: '2026-08-13T18:05:00Z', recording_end: '2026-08-13T19:07:30Z' }),
        { ...audio({ id: 'v2', ...second }), recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4' },
      ],
    });
    expect(m?.segments.map((s) => [s.startTime, s.durationSec, s.files.map((f) => f.fileId)])).toEqual([
      ['2026-08-13T18:05:00Z', 3750, ['a1']],
      ['2026-08-13T19:10:00Z', 90, ['v2', 'a2']],
    ]);
    expect(m).toMatchObject({ startTime: '2026-08-13T18:05:00Z', durationSec: 3840 });
  });

  /*
   * The card prints start + duration as the hours the class ran, and duration
   * comes from the FILE — so a start taken from the meeting would stretch the
   * span over the minutes before anyone pressed record.
   */
  it('starts when recording started, not when the meeting opened', () => {
    const m = meetingListing({
      uuid: 'x',
      start_time: '2026-10-08T22:50:00Z',
      duration: 150,
      recording_files: [audio({ recording_start: '2026-10-08T23:02:00Z', recording_end: '2026-10-09T01:18:00Z' })],
    });
    expect(m).toMatchObject({ startTime: '2026-10-08T23:02:00Z', durationSec: 136 * 60 });
  });

  it('falls back to the meeting start and duration (minutes) when the file has no start/end', () => {
    const m = meetingListing({
      uuid: 'x',
      start_time: '2026-10-08T23:00:00Z',
      duration: 12,
      recording_files: [audio({ recording_start: undefined, recording_end: undefined })],
    });
    expect(m).toMatchObject({ startTime: '2026-10-08T23:00:00Z', durationSec: 720 });
  });

  it('lists a file Zoom is still processing, as not ready', () => {
    const m = meetingListing({ uuid: 'x', recording_files: [audio({ status: 'processing' })] });
    expect(m?.segments[0].files[0]).toMatchObject({ fileId: 'aud', ready: false });
  });

  it('drops a recording with no start at all — it has no date to list it under', () => {
    const m = meetingListing({
      uuid: 'x',
      duration: 12,
      recording_files: [audio({ recording_start: undefined, recording_end: undefined })],
    });
    expect(m).toBeNull();
  });

  it('takes an M4A as the audio even when recording_type is absent', () => {
    const m = meetingListing({ uuid: 'x', recording_files: [audio({ recording_type: undefined })] });
    expect(m?.segments[0].files[0]).toMatchObject({ fileId: 'aud', format: 'audio' });
  });

  it('is null when nothing in the meeting is media the import takes', () => {
    const m = meetingListing({
      uuid: 'x',
      recording_files: [{ ...audio(), id: 'vtt', recording_type: 'audio_transcript', file_type: 'TRANSCRIPT' }],
    });
    expect(m).toBeNull();
  });
});

describe('dateWindows', () => {
  it('asks for a single day when both bounds are that day — "today\'s class"', () => {
    expect(dateWindows('2026-09-10', '2026-09-10')).toEqual([{ from: '2026-09-10', to: '2026-09-10' }]);
  });

  it('covers a long range in 30-day windows that meet without overlap or gap', () => {
    const windows = dateWindows('2026-01-01', '2026-03-15');
    expect(windows).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-03-03' },
      { from: '2026-03-04', to: '2026-03-15' },
    ]);
  });

  it('asks for nothing when the range ends before it starts', () => {
    expect(dateWindows('2026-09-11', '2026-09-10')).toEqual([]);
  });
});
