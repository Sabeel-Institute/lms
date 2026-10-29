/**
 * The media files the browser suites and the manual's screenshots play.
 *
 * GENERATED rather than committed: a binary in git is exactly what this repo's
 * "never add a binary" rule exists to prevent, and ffmpeg reproduces each one
 * identically in a second. Each is made once, under MEDIA_FIXTURES (gitignored,
 * and outside shots/, which the suites empty as they start), and then reused.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32 } from 'node:zlib';

/** The audio fixture's length. A substitute supplied via E2E_AUDIO must match it. */
export const AUDIO_SECONDS = 720;
export const MEDIA_FIXTURES = '.tmp/media';
export const AUDIO_FIXTURE = process.env.E2E_AUDIO ?? `${MEDIA_FIXTURES}/test-lecture.m4a`;
export const VIDEO_FIXTURE = `${MEDIA_FIXTURES}/test-lecture.mp4`;

/**
 * ffmpeg, writing to the path its arguments end with — into a folder made
 * first. A fresh checkout has no fixture folder until a suite makes one, and
 * the sweep never did: on CI its first film failed as if ffmpeg were missing.
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
        `${AUDIO_SECONDS}-second audio file.`,
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
export const HEVC_FIXTURE = `${MEDIA_FIXTURES}/test-hevc.mp4`;
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
 *
 * The slide is drawn by a browser and ffmpeg only holds it for the length of
 * the audio: ffmpeg's text filter needs a build with FreeType, which neither
 * CI's static Linux build nor Homebrew's has, so the guide world's seed failed
 * there while it passed here.
 */
export async function ensureSlideVideo(path, title) {
  ensureAudioFixture();
  if (existsSync(path)) return;
  const slide = path.replace(/\.mp4$/, '.png');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
    const esc = (t) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    const bullets = [
      'Patience is a light that does not go out',
      'Gratitude in ease, patience in hardship',
      'Read the passage before next week',
    ];
    await page.setContent(`<html><body style="margin:0;width:640px;height:360px;background:#1F2937;
      font-family:sans-serif;position:relative;overflow:hidden">
      <div style="position:absolute;left:40px;top:34px;color:#fff;font-size:26px">${esc(title)}</div>
      <div style="position:absolute;left:40px;top:84px;width:160px;height:3px;background:#C9A227"></div>
      ${bullets.map((b, i) => `<div style="position:absolute;left:56px;top:${114 + 36 * i}px;color:#E5E7EB;font-size:18px">•&nbsp;&nbsp;${esc(b)}</div>`).join('')}
      <!-- The speaker top right, where Zoom's "slides and speaker" layout puts
           them, clear of the player's fullscreen icon in the opposite corner. -->
      <div style="position:absolute;left:490px;top:20px;width:130px;height:96px;background:#4B5563"></div>
      <div style="position:absolute;left:538px;top:38px;width:34px;height:34px;background:#9CA3AF"></div>
      <div style="position:absolute;left:520px;top:78px;width:70px;height:38px;background:#9CA3AF"></div>
      <div style="position:absolute;left:496px;top:22px;color:#E5E7EB;font-size:12px">Teacher</div>
      </body></html>`);
    mkdirSync(dirname(slide), { recursive: true });
    await page.screenshot({ path: slide, type: 'png' });
  } finally {
    await browser.close();
  }
  ffmpeg([
    '-loop', '1', '-framerate', '1', '-i', slide, '-i', AUDIO_FIXTURE,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-shortest', '-movflags', '+faststart', path,
  ]);
}
