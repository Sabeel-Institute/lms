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
const DIR = join(tmpdir(), 'sabeel-lms-media-samples-v1');

const SPECS = {
  /** AAC in M4A, 3 s: an ordinary class recording. */
  m4a: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', 'a.m4a'],
  mp3: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'libmp3lame', 'a.mp3'],
  wav: ['-f', 'lavfi', '-i', 'sine=duration=3', 'a.wav'],
  /** FLAC: audio phones play, but not a format the app accepts. */
  flac: ['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'flac', 'a.flac'],
  /** H.264 + AAC in MP4, 3 s. */
  mp4: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', 'v.mp4',
  ],
  /** HEVC in MP4: what an iPhone records. */
  hevc: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', 'hevc.mp4',
  ],
  /** H.264 in a QuickTime container. */
  mov: [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-f', 'mov', 'v.mov',
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
