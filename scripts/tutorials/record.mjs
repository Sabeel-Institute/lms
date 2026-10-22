/**
 * RECORD THE HELP FILMS: each film in `TUTORIALS`, on a phone and on a
 * computer, narrated, as MP4 (H.264 + AAC) with WebVTT captions.
 *
 *   node scripts/tutorials/record.mjs --wav <dir of narration WAVs> --out <dir>
 *        [--only film-id,film-id] [--variant phone|computer]
 *
 * Needs, as the browser suites do, the emulator suite running (`npm run
 * emulators`) and a dev server for it on the `web` port — not an export; see
 * "The help films" in docs/DEV-TOOLING.md for why neither kind will do:
 *   cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web --port "$(npx sabeel-ci ports web)"
 * and the narration rendered first (`tts.py`), because each step lasts as long
 * as its line: the action runs while the line is said, and the next step waits
 * for the line to end.
 *
 * Every film starts from a freshly seeded guide world (`seed-guide.mjs`), so
 * what one film changes — a register submitted, an assignment posted — is not
 * in the next. What only a development build draws is hidden — the dev
 * sign-in row, the build's "dev" label, More's Design tokens; a touch is
 * drawn as a ripple and, on the computer, the pointer as a dot that moves to
 * what it clicks.
 */
import { fileURLToPath } from 'node:url';
import { config } from '@sabeel-institute/ci-tools/lib/config.mjs';
import { emulatorProject, ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { HELP_VARIANTS, HELP_VIDEOS } from '@sabeel/shared';
import { backButton } from '../lib/seed-world.mjs';
import { TUTORIALS } from './tutorials.mjs';
import { lineId } from './lines.mjs';

// The emulator ports and project, from ci-tools.json (`npx sabeel-ci ports`).
const STACK = config(fileURLToPath(new URL('../..', import.meta.url)));
const PORTS = ports(STACK);
const EMULATOR_PROJECT_ID = emulatorProject(STACK);

const WEB = `http://127.0.0.1:${PORTS.web}/`;
const REPO = resolve(new URL('../..', import.meta.url).pathname);
/** Breath between one line and the next. */
const GAP_MS = 450;
/** Held after the last line, so a film does not cut off on its last word. */
const TAIL_MS = 1200;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.wav || !args.out) {
  console.error('usage: record.mjs --wav <dir> --out <dir> [--only a,b] [--variant phone|computer]');
  process.exit(2);
}
const WAV = resolve(args.wav);
const OUT = resolve(args.out);
const only = new Set((args.only ?? '').split(',').filter(Boolean));
if (args.variant && !HELP_VARIANTS.includes(args.variant)) {
  console.error(`--variant must be one of ${HELP_VARIANTS.join(', ')}, not ${args.variant}`);
  process.exit(2);
}
const variants = args.variant ? [args.variant] : HELP_VARIANTS;

// ONE LIST: every catalogued film is scripted, and nothing unscripted is filmed.
const scripted = new Set(TUTORIALS.map((t) => t.id));
const catalogued = new Set(HELP_VIDEOS.map((v) => v.id));
const missing = [...catalogued].filter((id) => !scripted.has(id));
const extra = [...scripted].filter((id) => !catalogued.has(id));
if (missing.length || extra.length) {
  console.error(`HELP_VIDEOS and TUTORIALS disagree — unscripted: ${missing.join(', ') || 'none'}; uncatalogued: ${extra.join(', ') || 'none'}`);
  process.exit(1);
}
// A step kept to one cut names a cut there is, or it would be in neither.
const strays = TUTORIALS.flatMap((t) => t.steps.filter((s) => s.cut && !HELP_VARIANTS.includes(s.cut)).map((s) => `${t.id}: ${s.cut}`));
if (strays.length) {
  console.error(`a step is kept to a cut there is not — ${strays.join(', ')}`);
  process.exit(1);
}
for (const id of only) {
  if (!scripted.has(id)) {
    console.error(`--only names no film: ${id}`);
    process.exit(2);
  }
}

/** Seconds of audio in a WAV, from ffprobe. */
const seconds = (path) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim());

/**
 * A fresh guide world: empty emulators, then the guide seed. Tried twice: the
 * auth triggers of the world just emptied can still be running when the seed
 * starts, and the seed then meets an account half gone.
 */
async function reseed() {
  const fs = `http://127.0.0.1:${PORTS.firestore}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const auth = `http://127.0.0.1:${PORTS.auth}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`;
  for (let attempt = 1; ; attempt++) {
    for (const url of [fs, auth]) {
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) throw new Error(`could not empty ${url}: ${r.status}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    try {
      execFileSync('node', ['scripts/seed-guide.mjs'], { cwd: REPO, stdio: 'pipe' });
      return;
    } catch (e) {
      const why = `${e.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
      if (attempt >= 2) throw new Error(`the guide seed failed twice: ${why}`);
      console.log(`(seed failed, once: ${why.slice(0, 160)})`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

/** Drawn on the page that is filmed: the touch, the pointer, and nothing that only an emulator shows. */
function overlay(showPointer) {
  const install = () => {
    if (document.getElementById('__tut-style')) return;
    const style = document.createElement('style');
    style.id = '__tut-style';
    style.textContent = `
      #__tut-dot { position: fixed; left: -100px; top: -100px; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        border-radius: 50%; background: rgba(131,17,79,.22); border: 2px solid rgba(131,17,79,.9);
        pointer-events: none; z-index: 2147483647; }
      .__tut-ripple { position: fixed; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
        background: rgba(131,17,79,.32); pointer-events: none; z-index: 2147483647; animation: __tut-r .65s ease-out forwards; }
      @keyframes __tut-r { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.7); opacity: 0 } }
      .__tut-box { position: fixed; border: 3px solid rgba(201,162,39,.95); border-radius: 12px;
        box-shadow: 0 0 0 5px rgba(201,162,39,.22); pointer-events: none; z-index: 2147483646; transition: opacity .35s; }`;
    document.head.appendChild(style);
    if (showPointer) {
      const dot = document.createElement('div');
      dot.id = '__tut-dot';
      document.body.appendChild(dot);
      window.addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    }
    window.addEventListener('pointerdown', (e) => {
      const r = document.createElement('div');
      r.className = '__tut-ripple';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    const hide = () => {
      // The dev sign-in row, by its testID.
      const devRow = document.querySelector('[data-testid="dev-sign-in"]');
      if (devRow) devRow.style.display = 'none';
      for (const el of document.querySelectorAll('div')) {
        // The build label, on the sign-in screen and at the foot of More.
        if (el.childElementCount === 0 && /(^|· )v\d+\.\d+\.\d+ · dev$/.test(el.textContent ?? '')) el.style.visibility = 'hidden';
        // More's development-only row, which nobody outside development is offered.
        if (el.childElementCount === 0 && el.textContent === 'Design tokens') {
          const row = el.closest('[role="button"]');
          if (row) row.style.display = 'none';
        }
      }
    };
    new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
    hide();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

/** What a step's `do` is given: actions a viewer can follow. */
function helpers(page, variant) {
  const phone = variant === 'phone';
  const visible = (loc) => loc.filter({ visible: true }).first();
  const byId = (id) => visible(page.getByTestId(id));
  const byPrefix = (prefix) => visible(page.locator(`[data-testid^="${prefix}"]`));
  const wait = (ms) => page.waitForTimeout(ms);
  async function center(loc) {
    await loc.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await wait(450);
    const b = await loc.boundingBox();
    if (!b) throw new Error('element has no box');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function press(loc) {
    await loc.waitFor({ timeout: 20000 });
    const { x, y } = await center(loc);
    if (phone) {
      await page.touchscreen.tap(x, y);
    } else {
      await page.mouse.move(x, y, { steps: 22 });
      await wait(160);
      await page.mouse.click(x, y);
    }
    await wait(550);
  }
  async function outline(loc) {
    await loc.waitFor({ timeout: 20000 });
    const { x, y } = await center(loc);
    if (!phone) await page.mouse.move(x, y, { steps: 22 });
    await loc.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = '__tut-box';
      Object.assign(box.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      document.body.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; }, 1900);
      setTimeout(() => box.remove(), 2300);
    });
    await wait(400);
  }
  const t = {
    page,
    wait,
    waitFor: (id, timeout = 20000) => byId(id).waitFor({ timeout }),
    waitTitle: (title) =>
      visible(page.getByTestId('screen-title').filter({ hasText: new RegExp(`^${title}$`) })).waitFor({ timeout: 25000 }),
    tap: (id) => press(byId(id)),
    tapFirst: (prefix) => press(byPrefix(prefix)),
    tapText: (text) => press(visible(page.getByText(text, { exact: true }))),
    tapIfShown: async (id) => {
      if (await byId(id).isVisible().catch(() => false)) await press(byId(id));
    },
    highlight: (id) => outline(byId(id)),
    /** Outline what has no id of its own, by its words: a confirmation, say. */
    highlightText: (text) => outline(visible(page.getByText(text, { exact: false }))),
    /** Until the element shows this text: the result of an action, not its start. */
    waitText: (id, text, timeout = 20000) => byId(id).getByText(text, { exact: true }).waitFor({ timeout }),
    /** Until the control can be used: the player, for one, once its file is ready. */
    waitEnabled: (id, timeout = 30000) =>
      visible(page.locator(`[data-testid="${id}"]:not([aria-disabled="true"])`)).waitFor({ timeout }),
    type: async (id, text) => {
      await press(byId(id));
      await page.keyboard.type(text, { delay: 45 });
    },
    typeFirst: async (prefix, text) => {
      await press(byPrefix(prefix));
      await page.keyboard.type(text, { delay: 45 });
    },
    typeFocused: (text) => page.keyboard.type(text, { delay: 45 }),
    // Adds to what a field already holds: the caret goes after it, and a
    // space keeps the two apart.
    append: async (id, text) => {
      await press(byId(id));
      await page.keyboard.press('Control+End');
      await page.keyboard.type(` ${text}`, { delay: 45 });
    },
    select: async (id, value) => {
      const loc = byId(id);
      await loc.waitFor({ timeout: 20000 });
      const { x, y } = await center(loc);
      if (!phone) await page.mouse.move(x, y, { steps: 22 });
      await loc.selectOption(value);
      await wait(600);
    },
    scroll: async (dy) => {
      const vp = page.viewportSize();
      if (!phone) await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 10 });
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, dy / 10);
        await wait(45);
      }
      await wait(350);
    },
    scrollTo: async (id) => {
      await byId(id).waitFor({ timeout: 20000 });
      await center(byId(id));
    },
    // On a phone the paperclip asks where from (choose files, or take a
    // photo); on a computer it opens the file chooser itself.
    attach: async (addId, sheetOption, files) => {
      const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
      await press(byId(addId));
      if (await byId(sheetOption).isVisible().catch(() => false)) await press(byId(sheetOption));
      await (await chooser).setFiles(files);
      await wait(1500);
    },
    chooseFiles: async (id, files) => {
      const chooser = page.waitForEvent('filechooser');
      await press(byId(id));
      await (await chooser).setFiles(files);
      await wait(800);
    },
    closeSheet: () => press(visible(page.getByTestId('sheet-panel').getByRole('button', { name: 'Close' }))),
    goBack: async () => {
      await press(visible(backButton(page)));
      await wait(500);
    },
    openCourse: async (name) => {
      await press(byId('tab-courses'));
      await press(byId('cohort-open-Autumn 2026'));
      await press(byPrefix(`course-open-${name}`));
    },
    openCourseNav: async (navId) => {
      await t.openCourse('Hikam Foundations');
      await press(byId(navId));
    },
    openSession: async (title) => {
      await t.openCourseNav('nav-sessions');
      await press(byId(`session-open-${title}`));
    },
  };
  return t;
}

/** Signed in as the film needs, on a page of its own whose video is discarded. */
async function signIn(context, as) {
  if (!as) return;
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  if (as === 'student') {
    await page.getByTestId('signin-email').filter({ visible: true }).first().fill('fatima.ahmed@example.com');
    await page.getByTestId('signin-password').filter({ visible: true }).first().fill('HikamStudent1');
    await page.getByTestId('signin-student').filter({ visible: true }).first().click();
    await page.getByTestId('tab-todo').filter({ visible: true }).first().waitFor({ timeout: 30000 });
  } else {
    await page.getByTestId('dev-signin-first-admin').filter({ visible: true }).first().click();
    await page.getByTestId('tab-today').filter({ visible: true }).first().waitFor({ timeout: 30000 });
  }
  // The push nudge is a one-time question for each account on each device;
  // answered here, it is not in the film. It is the sign-in film's to show.
  const notNow = page.getByText('Not now', { exact: true }).filter({ visible: true }).first();
  await notNow.waitFor({ timeout: 8000 }).then(() => notNow.click(), () => {});
  await page.close();
}

async function film(browsers, tut, variant) {
  const durations = tut.steps.map((step, i) => {
    const wav = join(WAV, `${lineId(tut.id, i)}.wav`);
    const said = join(WAV, `${lineId(tut.id, i)}.txt`);
    if (!existsSync(wav) || !existsSync(said)) throw new Error(`no narration for ${lineId(tut.id, i)} — render it with tts.py first`);
    // THE WORDS, NOT THE ID. A line reworded after it was rendered kept its id,
    // and with it a WAV of the old words under captions of the new ones.
    if (readFileSync(said, 'utf8') !== step.say) {
      throw new Error(`the narration for ${lineId(tut.id, i)} is of other words — render it again with tts.py`);
    }
    return seconds(wav);
  });
  await reseed();
  const dir = join(OUT, '.raw');
  mkdirSync(dir, { recursive: true });
  const phone = variant === 'phone';
  /*
   * THE PHONE AT TWICE ITS PIXELS, from a browser launched at that scale. A
   * context's own `deviceScaleFactor` sharpens screenshots, not the video:
   * Playwright films at CSS pixels, so the film was a 390-pixel page in the
   * corner of a 780-pixel frame. Launched with the scale forced, the page
   * still lays out at 390 and the screencast comes at 780.
   */
  const context = await browsers[variant].newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, recordVideo: { dir, size: { width: 780, height: 1688 } } }
      : { viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } },
  );
  await signIn(context, tut.as);
  const page = await context.newPage();
  const born = Date.now();
  await page.addInitScript(overlay, !phone);
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page
    .getByTestId(tut.as === 'student' ? 'tab-todo' : tut.as ? 'tab-today' : 'signin-email')
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  const t = helpers(page, variant);
  if (tut.start) await tut.start(t);
  await page.waitForTimeout(600);
  const cues = [];
  for (const [i, step] of tut.steps.entries()) {
    if (step.cut && step.cut !== variant) continue;
    const at = Date.now();
    cues.push({ start: (at - born) / 1000, dur: durations[i], text: step.say, wav: join(WAV, `${lineId(tut.id, i)}.wav`) });
    try {
      await step.do(t);
    } catch (e) {
      // What the page showed when the step failed, beside the films.
      await page.screenshot({ path: join(OUT, `.failed-${tut.id}-${variant}.png`) }).catch(() => {});
      await context.close().catch(() => {});
      throw new Error(`step ${i + 1} ("${step.say.slice(0, 48)}…"): ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
    const left = durations[i] * 1000 + GAP_MS - (Date.now() - at);
    if (left > 0) await page.waitForTimeout(left);
  }
  await page.waitForTimeout(TAIL_MS);
  const video = page.video();
  await page.close();
  await context.close();
  const raw = await video.path();
  const end = (Date.now() - born) / 1000;
  return { raw, cues, end };
}

/** Narration laid over the film from its first line, as MP4, with captions. */
function mux({ raw, cues, end }, base) {
  const from = Math.max(0, cues[0].start - 0.4);
  const length = Math.min(end, cues[cues.length - 1].start + cues[cues.length - 1].dur + TAIL_MS / 1000 + 0.3) - from;
  const inputs = ['-ss', from.toFixed(3), '-i', raw];
  for (const c of cues) inputs.push('-i', c.wav);
  const delays = cues.map((c, i) => {
    const ms = Math.round((c.start - from) * 1000);
    return `[${i + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`;
  });
  // Back to 48 kHz after loudnorm, which works — and would otherwise write — at
  // 192 kHz resampled to 96: past what some phones' hardware decoders take.
  const mix = `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`;
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', ...inputs,
    '-filter_complex', [...delays, mix].join(';'),
    '-map', '0:v', '-map', '[aout]', '-t', length.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart',
    `${base}.mp4`,
  ]);
  const stamp = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`;
  };
  writeFileSync(
    `${base}.vtt`,
    `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.start - from)} --> ${stamp(c.start - from + c.dur)}\n${c.text}\n`).join('\n')}`,
  );
  return length;
}

/**
 * Films only the DEV SERVER, against the emulators. A production export
 * reports to the live Sentry project and draws no staff sign-in here, and a
 * development export reloads the page under the first formatting editor (see
 * "The help films" in docs/DEV-TOOLING.md). Metro answers `/status`; the
 * emulator's staff sign-in is drawn only by a development build pointed at
 * the emulators.
 */
async function assertDevServer(browser) {
  const status = await fetch(new URL('status', WEB)).then((r) => r.text(), () => '');
  const page = await browser.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('signin-email').filter({ visible: true }).first().waitFor({ timeout: 60000 });
  const emulators = await page.getByTestId('dev-signin-first-admin').filter({ visible: true }).first().isVisible();
  await page.close();
  if (status !== 'packager-status:running' || !emulators) {
    console.error(`${WEB} is not the dev server against the emulators; see "The help films" in docs/DEV-TOOLING.md`);
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
/*
 * THE BROWSER ITSELF, headless (`channel: 'chromium'`), not Playwright's
 * headless shell. The shell answers every notification permission with
 * "denied", so a student's Notifications screen filmed as blocked; the browser
 * starts at "ask", as a phone does, and the app offers to turn them on.
 */
const browsers = {
  phone: await chromium.launch({ channel: 'chromium', args: ['--force-device-scale-factor=2'] }),
  computer: await chromium.launch({ channel: 'chromium' }),
};
await assertDevServer(browsers.computer);
let failures = 0;
for (const tut of TUTORIALS) {
  if (only.size && !only.has(tut.id)) continue;
  for (const variant of variants) {
    const base = join(OUT, `${tut.id}-${variant}`);
    process.stdout.write(`${tut.id} (${variant}) … `);
    try {
      const shot = await film(browsers, tut, variant);
      const length = mux(shot, base);
      rmSync(shot.raw, { force: true });
      console.log(`${length.toFixed(1)} s`);
    } catch (e) {
      failures += 1;
      console.log(`FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
}
await Promise.all(Object.values(browsers).map((b) => b.close()));
rmSync(join(OUT, '.raw'), { recursive: true, force: true });
process.exit(failures ? 1 : 0);
