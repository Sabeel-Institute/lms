import { parseFromTokenizer } from 'music-metadata';
import { tokenizer, type IRangeRequestClient } from '@tokenizer/range';
import type { MediaKind } from '@sabeel/shared';
import { readRange } from './mediaStore';

/**
 * What a stored file actually holds, read from the bucket a few ranges at a
 * time: the container's headers and its track list, never the media. Probing
 * a 184 MiB MP4 whose index sits at the END of the file reads about 0.4 MiB.
 */
export interface Probe {
  /** Container as the parser names it: "isom/iso2/avc1/mp41", "qt", "WAVE", "MPEG". */
  container: string;
  /** The audio codec of an audio-only file, or of an MP4's sound. */
  codec: string | null;
  durationSec: number | null;
  /** Each video track's codec, as a fourcc: "avc1", "hvc1", "vp09". */
  videoCodecs: string[];
  /** Each audio track's codec, in an MP4. */
  audioCodecs: string[];
}

/** A file the parser could not read at all. */
export class UnreadableMedia extends Error {}

/**
 * Probe one object.
 *
 * NO MIME TYPE IS PASSED TO THE PARSER. It picks its format from a hint before
 * it looks at the bytes, so a WAV declared as `video/mp4` was read as a broken
 * MP4 rather than a fine WAV. The content type is the uploader's claim; what is
 * inside is the question.
 */
export async function probeObject(key: string, sizeBytes: number): Promise<Probe> {
  const client: IRangeRequestClient = {
    async getResponse(_method, range) {
      const [first, last] = range ?? [0, sizeBytes - 1];
      const end = Math.min(last, sizeBytes - 1);
      const bytes = await readRange(key, first, end);
      return {
        size: sizeBytes,
        acceptPartialRequests: true,
        contentRange: { firstBytePosition: first, lastBytePosition: end, instanceLength: sizeBytes },
        arrayBuffer: async () => bytes,
      };
    },
    abort() {},
  };
  let format;
  try {
    format = (await parseFromTokenizer(await tokenizer(client, { avoidHeadRequests: true }), { skipCovers: true }))
      .format;
  } catch (e) {
    throw new UnreadableMedia((e as Error).message);
  }
  const tracks = format.trackInfo ?? [];
  // The parser names a codec it has no word for by its fourcc in angle
  // brackets — "<avc1>", "<hvc1>" — and marks audio tracks as type 2. A video
  // track is one it did not mark as audio.
  const fourcc = (name: string | undefined) => name?.match(/^<(.+)>$/)?.[1] ?? null;
  const video = tracks.filter((t) => t.type !== 2 && fourcc(t.codecName));
  const audio = tracks.filter((t) => !video.includes(t));
  return {
    container: format.container ?? '',
    codec: format.codec ?? null,
    durationSec: format.duration && format.duration > 0 ? Math.round(format.duration) : null,
    videoCodecs: video.map((t) => fourcc(t.codecName) as string),
    audioCodecs: audio.map((t) => fourcc(t.codecName) ?? t.codecName ?? ''),
  };
}

const VIDEO_REFUSED =
  "This video uses a format phones can't play. Export it as MP4 (H.264) and upload again.";
const AUDIO_REFUSED =
  "This audio uses a format phones can't play. Export it as M4A or MP3 and upload again.";

/** Whether an AAC or MP3 codec name names what Android and every browser play. */
const playableAudio = (codec: string) => /AAC|Layer 3/.test(codec);

/**
 * Whether a probed file may become a media item of this kind, and its length.
 *
 * Audio: AAC (M4A), MP3 or PCM (WAV), with no picture. Video: an MP4 whose
 * every picture is H.264 and whose sound is AAC or MP3 — what Android's player
 * and every browser play without help. An iPhone's HEVC `.mov` is the case
 * this exists to catch, and it fails twice over: QuickTime container, HEVC
 * picture. A file whose length cannot be read is refused too, since the
 * player's scrubber and the ledger's share played both stand on it.
 */
export function judgeProbe(p: Probe, kind: MediaKind): { ok: true; durationSec: number } | { ok: false; reason: string } {
  if (kind === 'video') {
    if (p.videoCodecs.length === 0) {
      return { ok: false, reason: 'This file has no picture. Upload it as an audio file (M4A or MP3) instead.' };
    }
    const mp4 = p.container !== 'qt' && /isom|mp4|iso\d|avc1|M4V/i.test(p.container);
    const h264 = p.videoCodecs.every((c) => c === 'avc1' || c === 'avc3');
    const sound = p.audioCodecs.every(playableAudio);
    if (!mp4 || !h264 || !sound) return { ok: false, reason: VIDEO_REFUSED };
  } else {
    if (p.videoCodecs.length > 0) {
      return { ok: false, reason: 'This file has a picture. Upload it as a video (MP4) instead.' };
    }
    const codec = p.codec ?? '';
    if (!(playableAudio(codec) || (p.container === 'WAVE' && codec === 'PCM'))) {
      return { ok: false, reason: AUDIO_REFUSED };
    }
  }
  if (p.durationSec === null) {
    return { ok: false, reason: 'The length of this file could not be read. Export it again and upload the new file.' };
  }
  return { ok: true, durationSec: p.durationSec };
}
