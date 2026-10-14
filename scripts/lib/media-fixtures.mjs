/**
 * The media files the browser suites and the manual's screenshots play.
 *
 * GENERATED rather than committed: a binary in git is exactly what this repo's
 * "never add a binary" rule exists to prevent, and ffmpeg reproduces each one
 * identically in a second. Each is made once and then reused.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32 } from 'node:zlib';

/** The audio fixture's length. A substitute supplied via E2E_AUDIO must match it. */
export const AUDIO_SECONDS = 720;
export const AUDIO_FIXTURE = process.env.E2E_AUDIO ?? 'e2e-shots/test-lecture.m4a';
export const VIDEO_FIXTURE = 'e2e-shots/test-lecture.mp4';

/**
 * ffmpeg, writing to the path its arguments end with — into a folder made
 * first. A fresh checkout has no e2e-shots/ until a suite makes one, and the
 * sweep never did: on CI its first film failed as if ffmpeg were missing.
 */
const ffmpeg = (args) => {
  mkdirSync(dirname(args[args.length - 1]), { recursive: true });
  execFileSync('ffmpeg', [...args, '-y'], { stdio: 'ignore' });
};

/**
 * A real 12-minute 32 kbps mono M4A — the shape of an actual class recording
 * (a two-hour one lands near 29 MB at this bitrate).
 */
export function ensureAudioFixture() {
  if (existsSync(AUDIO_FIXTURE)) return;
  try {
    ffmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${AUDIO_SECONDS},volume=0.3`,
      '-c:a', 'aac', '-b:a', '32k', '-ac', '1', AUDIO_FIXTURE,
    ]);
  } catch {
    throw new Error(
      `Could not generate ${AUDIO_FIXTURE}. Install ffmpeg, or point E2E_AUDIO at a ` +
        `${AUDIO_SECONDS}-second audio file (it must live OUTSIDE e2e-shots/, which the ` +
        'browser suite wipes on startup).',
    );
  }
}

/**
 * The same twelve minutes as video — a picture with a clock on it, and the
 * audio fixture's sound — tiny, so a version switch is a real switch of source
 * and not a download.
 */
export function ensureVideoFixture() {
  ensureAudioFixture();
  if (existsSync(VIDEO_FIXTURE)) return;
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=1:duration=${AUDIO_SECONDS}`,
    '-i', AUDIO_FIXTURE, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-shortest', '-movflags', '+faststart', VIDEO_FIXTURE,
  ]);
}

/**
 * An iPhone's kind of video: HEVC in MP4, which phones and browsers outside
 * Apple's cannot all play, so the server refuses it. Needs an ffmpeg built
 * with libx265.
 */
export const HEVC_FIXTURE = 'e2e-shots/test-hevc.mp4';
export function ensureHevcFixture() {
  if (existsSync(HEVC_FIXTURE)) return;
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=5', '-f', 'lavfi', '-i', 'sine=duration=5',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', HEVC_FIXTURE,
  ]);
}

/**
 * A photographed page, as a student hands one in: a PNG, made in memory and
 * never written to disk, large enough to read when it is opened.
 */
export function pagePhoto() {
  return execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc=size=480x360', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * A Word file, as far as its bytes go: a ZIP holding one short text, stored
 * uncompressed, which is what the server checks a `.docx` for. Made in memory.
 */
export function wordFile(text) {
  const name = Buffer.from('outline.txt');
  const data = Buffer.from(text);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size, stored as is
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const entry = Buffer.concat([local, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, end]);
}

/**
 * A class's shared screen for the manual's figures: a dark presentation slide
 * carrying `title` and three bullet points and a speaker's box in the corner,
 * over the audio fixture's sound. It has to read as VIDEO at
 * a glance: a plain cream slide in the app's own colours was taken for one
 * more card on the page.
 */
export function ensureSlideVideo(path, title) {
  ensureAudioFixture();
  if (existsSync(path)) return;
  const esc = (t) => t.replace(/[\\':]/g, (c) => `\\${c}`);
  const text = (t, x, y, size, color = 'white') =>
    `drawtext=text='${esc(t)}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}`;
  const filters = [
    text(title, 40, 40, 26),
    'drawbox=x=40:y=84:w=160:h=3:color=0xC9A227:t=fill',
    text('•  Patience is a light that does not go out', 56, 120, 18, '0xE5E7EB'),
    text('•  Gratitude in ease, patience in hardship', 56, 156, 18, '0xE5E7EB'),
    text('•  Read the passage before next week', 56, 192, 18, '0xE5E7EB'),
    // The speaker top right, where Zoom's "slides and speaker" layout puts
    // them — clear of the player's fullscreen icon in the opposite corner.
    'drawbox=x=490:y=20:w=130:h=96:color=0x4B5563:t=fill',
    'drawbox=x=538:y=38:w=34:h=34:color=0x9CA3AF:t=fill',
    'drawbox=x=520:y=78:w=70:h=38:color=0x9CA3AF:t=fill',
    text('Teacher', 496, 24, 12, '0xE5E7EB'),
  ].join(',');
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x1F2937:size=640x360:rate=1:duration=${AUDIO_SECONDS}`,
    '-i', AUDIO_FIXTURE, '-vf', filters,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-shortest', '-movflags', '+faststart', path,
  ]);
}
