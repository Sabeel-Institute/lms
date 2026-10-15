import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real media files for the upload tests, made with ffmpeg on first use and
 * kept in the system temp directory between runs.
 *
 * REAL, because the server probes what arrives: a buffer of zeros is refused
 * as unreadable, which is right, and so it can stand in for nothing that is
 * meant to be accepted. Generated rather than committed, under the repo's
 * "never add a binary" rule. Each is a few seconds long, except `bigVideo`,
 * which is over one upload part so that the join of several parts is tested.
 */
const DIR = join(tmpdir(), 'sabeel-lms-media-samples-v2');

/** A small file handed to ffmpeg inline, so a sample stays one command. */
const inline = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
const CHAPTERS = inline(';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3000\ntitle=Two\n');
// The whole three seconds: `-shortest` ends the file with its shortest track.
const SUBTITLES = inline('1\n00:00:00,000 --> 00:00:03,000\nAs-salamu alaykum\n');
/** Three seconds of picture and sound, the inputs most video samples start from. */
const PICTURE_AND_SOUND = ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3'] as const;
/** H.264 as phones play it, 8-bit 4:2:0: from testsrc's RGB, libx264 would make 4:4:4. */
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] as const;

const SPECS = {
  /** AAC in M4A, 3 s: an ordinary class recording. */
  m4a: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', 'a.m4a'],
  mp3: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'libmp3lame', 'a.mp3'],
  wav: ['-f', 'lavfi', '-i', 'sine=duration=3', 'a.wav'],
  /** FLAC: audio phones play, but not a format the app accepts. */
  flac: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'flac', 'a.flac'],
  /** H.264 (High, 8-bit 4:2:0) + AAC in MP4, 3 s. */
  mp4: [...PICTURE_AND_SOUND, ...H264, '-c:a', 'aac', '-shortest', 'v.mp4'],
  /** The same, with its movie box first, as a web export writes it. */
  faststart: [...PICTURE_AND_SOUND, ...H264, '-c:a', 'aac', '-shortest', '-movflags', '+faststart', 'fast.mp4'],
  /** H.264 with no sound at all, as a screen recorder left with its microphone off makes. */
  silentVideo: ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', ...H264, 'silent.mp4'],
  /** Twenty seconds of picture and five of sound. */
  shortSound: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=20', '-f', 'lavfi', '-i', 'sine=duration=5',
    ...H264, '-c:a', 'aac', 'shortsound.mp4',
  ],
  /** 10-bit H.264 (High 10), which phones cannot decode. */
  high10: [...PICTURE_AND_SOUND, '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-shortest', 'hi10.mp4'],
  /** 4:4:4 H.264 (High 4:4:4 Predictive), which phones cannot decode either. */
  high444: [...PICTURE_AND_SOUND, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-shortest', 'h444.mp4'],
  /** H.264 + AAC with a chapter track, as an editor that writes markers exports it. */
  chapters: [
    ...PICTURE_AND_SOUND, '-f', 'ffmetadata', '-i', CHAPTERS,
    '-map', '0', '-map', '1', '-map_chapters', '2', ...H264, '-c:a', 'aac', '-shortest', 'chapters.mp4',
  ],
  /** H.264 + AAC with a subtitle track (mov_text, "tx3g"). */
  subtitles: [
    ...PICTURE_AND_SOUND, '-f', 'srt', '-i', SUBTITLES,
    '-map', '0', '-map', '1', '-map', '2', ...H264, '-c:a', 'aac', '-c:s', 'mov_text', '-shortest', 'subtitles.mp4',
  ],
  /** H.264 + AAC with a timecode track ("tmcd"), as cameras and editors keep it. */
  timecode: [...PICTURE_AND_SOUND, ...H264, '-c:a', 'aac', '-timecode', '01:00:00:00', '-shortest', 'tmcd.mp4'],
  /** HEVC in MP4: what an iPhone records. */
  hevc: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', 'hevc.mp4',
  ],
  /** H.264 in a QuickTime container. */
  mov: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    ...H264, '-c:a', 'aac', '-shortest', '-f', 'mov', 'v.mov',
  ],
  /** A picture, as a phone's photo of a worksheet would arrive after shrinking. */
  png: ['-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1', '-frames:v', '1', 'page.png'],
  /** Sixteen minutes of audio, over a teacher's 15-minute limit. 8 kHz WAV:
   *  no encoder to wait for, and still under the 25 MB attachment cap. */
  longAudio: ['-f', 'lavfi', '-i', 'sine=duration=960:sample_rate=8000', '-c:a', 'pcm_u8', '-ac', '1', 'long.wav'],
  /** H.264 + AAC, 20 s at a high bitrate: more than one upload part. */
  bigVideo: [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '9M', '-c:a', 'aac', '-shortest', 'big.mp4',
  ],
} as const;

export type SampleName = keyof typeof SPECS;

/**
 * H.264 + AAC with a camera's own data track, as a GoPro writes beside its
 * picture ("fdsc", "gpmd"): the timecode sample with its timecode track's
 * sample entry renamed, so the track is one no list of known names holds.
 * Its handler still says it is not a picture, which is what decides.
 */
export function cameraData(): Uint8Array {
  const bytes = sample('timecode').slice();
  const text = Buffer.from(bytes).toString('latin1');
  for (let at = text.indexOf('stsd'); at >= 0; at = text.indexOf('stsd', at + 4)) {
    const entry = text.indexOf('tmcd', at);
    if (entry >= 0 && entry - at < 24) bytes.set(Buffer.from('fdsc', 'latin1'), entry);
  }
  if (Buffer.from(bytes).includes(Buffer.from('fdsc', 'latin1'))) return bytes;
  throw new Error('cameraData: the timecode sample has no timecode entry to rename');
}

/** A one-page PDF and a plain-text note, which need no ffmpeg. */
export const PDF = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
export const TEXT = new TextEncoder().encode('Page 1 is the extra practice.\nمن علامة الاعتماد على العمل\n');

/** The bytes of one sample, made the first time it is asked for. */
export function sample(name: SampleName): Uint8Array {
  const args = SPECS[name];
  const file = join(DIR, args[args.length - 1]);
  if (!existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    execFileSync('ffmpeg', ['-loglevel', 'error', ...args.slice(0, -1), file, '-y'], { stdio: 'inherit' });
  }
  return new Uint8Array(readFileSync(file));
}
