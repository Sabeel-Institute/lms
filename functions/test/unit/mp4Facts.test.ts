import { describe, expect, it } from 'vitest';
import { mp4Facts } from '../../src/mp4Facts';
import { cameraData, sample } from '../mediaSamples';

/** A file read the way the bucket is read: a range at a time, inclusive. */
const of = (bytes: Uint8Array) => mp4Facts(async (first, last) => bytes.subarray(first, last + 1), bytes.length);

/**
 * What an MP4 says of itself that the tag parser does not. The promises these
 * serve, a silent video accepted and a 10-bit one refused, are held by the
 * upload suite against real uploads; this holds the reader to the files.
 */
describe('an MP4’s own facts', () => {
  it('finds the movie box at the end, as cameras write it, and at the start, as web exports do', async () => {
    expect(await of(sample('mp4'))).toEqual({ durationSec: 3, avcProfiles: [100], pictures: ['avc1'] });
    expect(await of(sample('faststart'))).toEqual({ durationSec: 3, avcProfiles: [100], pictures: ['avc1'] });
  });

  it('reads the picture’s length when the sound is shorter, or missing', async () => {
    expect((await of(sample('shortSound')))?.durationSec).toBe(20);
    expect((await of(sample('silentVideo')))?.durationSec).toBe(3);
  });

  it('names the profiles phones cannot decode', async () => {
    expect((await of(sample('high10')))?.avcProfiles).toEqual([110]);
    expect((await of(sample('high444')))?.avcProfiles).toEqual([244]);
  });

  /*
   * A PICTURE IS A TRACK WHOSE HANDLER SAYS SO. A GoPro's file carries the
   * camera's own data tracks beside its H.264 and AAC; one of them, named
   * by no list the probe kept, was counted as a picture phones cannot play.
   */
  it('counts only video-handler tracks as pictures, whatever else the file carries', async () => {
    expect((await of(sample('timecode')))?.pictures).toEqual(['avc1']);
    expect((await of(cameraData()))?.pictures).toEqual(['avc1']);
    expect((await of(sample('hevc')))?.pictures).toEqual(['hvc1']);
    // QuickTime keeps a second handler, for its data, after the media's own.
    expect((await of(sample('mov')))?.pictures).toEqual(['avc1']);
    expect((await of(sample('m4a')))?.pictures).toEqual([]);
  });

  it('reads nothing into a file cut short, or one that is not an MP4', async () => {
    expect(await of(sample('mp4').subarray(0, 1000))).toBeNull();
    expect(await of(sample('wav'))).toBeNull();
  });
});
