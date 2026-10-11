import { describe, it, expect } from 'vitest';
import { dateWindows, pickAudioRecording } from '../../src/zoom';

describe('pickAudioRecording', () => {
  it('selects the audio_only M4A among mixed files and takes duration from the file', () => {
    // The exact shape your live account returned: M4A + TIMELINE + MP4.
    const r = pickAudioRecording({
      uuid: 'abc/def==',
      topic: 'Session 3',
      start_time: '2026-05-07T18:00:00Z',
      duration: 90,
      recording_files: [
        { id: 'mp4', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4', file_size: 99999 },
        { id: 'tl', recording_type: 'timeline', file_type: 'TIMELINE' },
        {
          id: 'aud',
          recording_type: 'audio_only',
          file_type: 'M4A',
          file_extension: 'M4A',
          file_size: 12345,
          recording_start: '2026-05-07T18:00:05Z',
          recording_end: '2026-05-07T18:05:05Z',
        },
      ],
    });
    expect(r).toMatchObject({ meetingUuid: 'abc/def==', topic: 'Session 3', fileId: 'aud', sizeBytes: 12345 });
    expect(r?.durationSec).toBe(300); // 5 min from recording_start/end, not the coarse meeting minutes
  });

  /*
   * The card prints start + duration as the hours the class ran, and duration
   * already came from the FILE — so a start taken from the meeting would
   * stretch the span over the minutes before anyone pressed record, and the end
   * it printed would match nothing.
   */
  it('starts the recording when the audio started, not when the meeting opened', () => {
    const r = pickAudioRecording({
      uuid: 'x',
      start_time: '2026-10-08T22:50:00Z',
      duration: 150,
      recording_files: [
        {
          id: 'aud',
          recording_type: 'audio_only',
          file_type: 'M4A',
          recording_start: '2026-10-08T23:02:00Z',
          recording_end: '2026-10-09T01:18:00Z',
        },
      ],
    });
    expect(r).toMatchObject({ startTime: '2026-10-08T23:02:00Z', durationSec: 136 * 60 });
  });

  it('falls back to the meeting start and duration (minutes) when the file has no start/end', () => {
    const r = pickAudioRecording({
      uuid: 'x',
      start_time: '2026-10-08T23:00:00Z',
      duration: 12,
      recording_files: [{ id: 'a', recording_type: 'audio_only', file_type: 'M4A' }],
    });
    expect(r).toMatchObject({ startTime: '2026-10-08T23:00:00Z', durationSec: 720 });
  });

  it('drops a recording with no start at all — it has no date to list it under', () => {
    const r = pickAudioRecording({
      uuid: 'x',
      duration: 12,
      recording_files: [{ id: 'a', recording_type: 'audio_only', file_type: 'M4A' }],
    });
    expect(r).toBeNull();
  });

  it('matches by M4A extension even when recording_type is absent', () => {
    const r = pickAudioRecording({
      uuid: 'x',
      start_time: '2026-10-08T23:00:00Z',
      recording_files: [{ id: 'a', file_type: 'M4A', file_extension: 'M4A' }],
    });
    expect(r?.fileId).toBe('a');
  });

  it('returns null when there is no audio-only file (video only)', () => {
    const r = pickAudioRecording({
      uuid: 'x',
      recording_files: [{ id: 'v', recording_type: 'shared_screen_with_speaker_view', file_type: 'MP4' }],
    });
    expect(r).toBeNull();
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
