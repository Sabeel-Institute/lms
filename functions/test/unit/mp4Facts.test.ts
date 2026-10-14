import { describe, expect, it } from 'vitest';
import { mp4Facts } from '../../src/mp4Facts';
import { sample } from '../mediaSamples';

/** A file read the way the bucket is read: a range at a time, inclusive. */
const of = (bytes: Uint8Array) => mp4Facts(async (first, last) => bytes.subarray(first, last + 1), bytes.length);

/**
 * What an MP4 says of itself that the tag parser does not. The promises these
 * serve, a silent video accepted and a 10-bit one refused, are held by the
 * upload suite against real uploads; this holds the reader to the files.
 */
describe('an MP4’s own facts', () => {
  it('finds the movie box at the end, as cameras write it, and at the start, as web exports do', async () => {
    expect(await of(sample('mp4'))).toEqual({ durationSec: 3, avcProfiles: [100] });
    expect(await of(sample('faststart'))).toEqual({ durationSec: 3, avcProfiles: [100] });
  });

  it('reads the picture’s length when the sound is shorter, or missing', async () => {
    expect((await of(sample('shortSound')))?.durationSec).toBe(20);
    expect((await of(sample('silentVideo')))?.durationSec).toBe(3);
  });

  it('names the profiles phones cannot decode', async () => {
    expect((await of(sample('high10')))?.avcProfiles).toEqual([110]);
    expect((await of(sample('high444')))?.avcProfiles).toEqual([244]);
  });

  it('reads nothing into a file cut short, or one that is not an MP4', async () => {
    expect(await of(sample('mp4').subarray(0, 1000))).toBeNull();
    expect(await of(sample('wav'))).toBeNull();
  });
});
