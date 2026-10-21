import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Does the release build start, and is it the build it claims to be? Run on the
 * artifact that ships, on an Android emulator, the same here as in CI:
 *
 *   npm run check:release -- <app.aab|app.apk> [--launches 5] [--commit <sha>] [--out <dir>]
 *
 * An AAB becomes a universal APK through bundletool, signed with a throwaway
 * key, which is enough to install it. The app is uninstalled first, so this
 * clears its data on the emulator. Then, for each cold start, the sign-in
 * screen must appear and stay up with its label reading `v<app.json version> ·
 * <commit>`, the emulator-only sign-in row must be absent (a release build that
 * shows it points at the emulators), and the device log must hold no crash or
 * ANR for the app. Screens and logs land in --out; the result in result.json.
 *
 * Uses the one attached device. With none attached, outside CI, it boots this
 * machine's AVD with scripts/emulator.sh; in CI the workflow boots one first.
 */

const BUNDLETOOL = { version: '1.18.3', sha256: 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29' };
const SIGN_IN = 'Sign in with Google';

/** The build label on the sign-in screen: `v0.2.1 · f66ae31`, `+` when built from a dirty tree. */
export function buildLabel(texts) {
  for (const text of texts) {
    const match = /^v(\d+\.\d+\.\d+) · ([0-9a-f]{7,40})(\+?)$/.exec(text.trim());
    if (match) return { version: match[1], commit: match[2], dirty: match[3] === '+' };
  }
  return null;
}

/** Why a label is not this build's, or null when it is. */
export function labelProblem(label, version, sha) {
  if (!label) return 'no build label on the sign-in screen';
  if (label.version !== version) return `the label says v${label.version}, app.json ${version}`;
  if (!sha.startsWith(label.commit)) return `the label says ${label.commit}, the build is ${sha.slice(0, 7)}`;
  if (label.dirty) return 'the label marks a build from uncommitted changes';
  return null;
}

/** The emulator-only sign-in row, whatever each app calls it ("Dev sign-in", "Emulator sign-in", "Dev (emulator) sign-in"). */
export function devRowShown(texts) {
  return texts.some((text) => /\b(dev|emulator)\b[^\n]{0,24}sign[- ]in/i.test(text));
}

/**
 * Device-log lines that report this app crashing or hanging: a native
 * tombstone (`>>> pkg <<<`), a Java crash (`Process: pkg, PID: …`) or an ANR.
 * Matched on the whole package, so a `.debug` build beside it never counts.
 */
export function crashLines(logcat, pkg) {
  const named = (line) => [/>>> (\S+) <<</, /Process: ([^,\s]+)/, /ANR in (\S+)/]
    .some((pattern) => pattern.exec(line)?.[1] === pkg);
  return logcat.split('\n').filter(named);
}

const ENTITIES = { '#10': '\n', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Every text and content description in a uiautomator dump. */
export function screenTexts(xml) {
  return [...xml.matchAll(/(?:text|content-desc)="([^"]+)"/g)]
    .map((m) => m[1].replace(/&(#10|amp|quot|apos|lt|gt);/g, (_, entity) => ENTITIES[entity]));
}

const output = (program, args, options = {}) =>
  execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...options });
const adb = (...args) => output('adb', args);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};

function bundletool() {
  const jar = process.env.BUNDLETOOL_JAR ?? join(homedir(), '.cache', 'sabeel-ci', `bundletool-all-${BUNDLETOOL.version}.jar`);
  if (!existsSync(jar)) {
    mkdirSync(resolve(jar, '..'), { recursive: true });
    output('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', jar,
      `https://github.com/google/bundletool/releases/download/${BUNDLETOOL.version}/bundletool-all-${BUNDLETOOL.version}.jar`]);
  }
  const digest = createHash('sha256').update(readFileSync(jar)).digest('hex');
  if (digest !== BUNDLETOOL.sha256) throw new Error(`bundletool at ${jar} does not match its pinned checksum`);
  return jar;
}

function universalApk(aab, out) {
  const keystore = join(out, 'check.jks');
  const apks = join(out, 'universal.apks');
  rmSync(keystore, { force: true });
  rmSync(apks, { force: true });
  output('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'release-check', '-keypass', 'release-check',
    '-alias', 'check', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=release check', '-noprompt']);
  output('java', ['-jar', bundletool(), 'build-apks', '--bundle', aab, '--output', apks, '--mode', 'universal',
    '--ks', keystore, '--ks-pass', 'pass:release-check', '--ks-key-alias', 'check', '--key-pass', 'pass:release-check']);
  const apk = join(out, 'universal.apk');
  writeFileSync(apk, execFileSync('unzip', ['-p', apks, 'universal.apk'], { maxBuffer: 1 << 30 }));
  return apk;
}

async function device() {
  const attached = () => adb('devices').split('\n').slice(1).filter((line) => /\tdevice$/.test(line));
  let devices = attached();
  if (!devices.length) {
    if (process.env.CI) throw new Error('No Android device attached; the workflow boots one first');
    console.log('No device attached: booting the AVD with scripts/emulator.sh headless');
    spawn('bash', ['scripts/emulator.sh', 'headless'], { detached: true, stdio: 'ignore' }).unref();
    adb('wait-for-device');
    devices = attached();
  }
  if (devices.length !== 1) throw new Error(`Expected one device, found ${devices.length}: detach the others`);
  for (let i = 0; i < 120 && adb('shell', 'getprop', 'sys.boot_completed').trim() !== '1'; i += 1) await sleep(3000);
  for (const setting of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    adb('shell', 'settings', 'put', 'global', setting, '0');
  }
}

function texts() {
  adb('shell', 'rm', '-f', '/sdcard/check-release.xml');
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/check-release.xml');
  } catch {
    return null;
  }
  const xml = adb('shell', 'cat', '/sdcard/check-release.xml');
  return xml.includes('<hierarchy') ? screenTexts(xml) : null;
}

async function launch(pkg, round, out, expected) {
  adb('shell', 'am', 'force-stop', pkg);
  adb('logcat', '-c');
  adb('shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1');
  let shown = null;
  for (let i = 0; i < 40 && !shown?.includes(SIGN_IN); i += 1) {
    await sleep(1500);
    shown = texts() ?? shown;
  }
  // Stay a while: the crashes worth catching are not always on the first frame.
  await sleep(8000);
  const alive = adb('shell', 'pidof', pkg).trim() !== '' || null;
  const final = texts() ?? shown ?? [];
  writeFileSync(join(out, `launch-${round}.png`), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
  const logcat = adb('logcat', '-d');
  writeFileSync(join(out, `logcat-${round}.txt`), logcat);
  const problems = [];
  if (!alive) problems.push('the app is not running');
  if (!final.includes(SIGN_IN)) problems.push(`"${SIGN_IN}" never appeared`);
  const label = labelProblem(buildLabel(final), expected.version, expected.sha);
  if (label) problems.push(label);
  if (devRowShown(final)) problems.push('the emulator-only sign-in row is showing: this build points at the emulators');
  const crashes = crashLines(logcat, pkg);
  if (crashes.length) problems.push(`the device log reports a crash or ANR:\n    ${crashes.slice(0, 5).join('\n    ')}`);
  return { round, label: buildLabel(final), problems };
}

async function main() {
  const artifact = process.argv[2];
  if (!artifact || !/\.(aab|apk)$/.test(artifact) || !existsSync(artifact)) {
    throw new Error('usage: npm run check:release -- <app.aab|app.apk> [--launches 5] [--commit <sha>] [--out <dir>]');
  }
  const launches = Number(option('--launches', '5'));
  if (!Number.isInteger(launches) || launches < 1 || launches > 50) throw new Error('--launches must be 1 to 50');
  const sha = option('--commit', output('git', ['rev-parse', 'HEAD']).trim());
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('--commit must be a commit hash');
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const expected = { version: app.version, sha };
  const pkg = app.android.package;
  const out = resolve(option('--out', join(process.env.RUNNER_TEMP ?? tmpdir(), 'release-check')));
  mkdirSync(out, { recursive: true });

  const apk = artifact.endsWith('.aab') ? universalApk(resolve(artifact), out) : resolve(artifact);
  await device();
  try {
    adb('uninstall', pkg);
  } catch {
    // Not installed.
  }
  adb('install', apk);
  console.log(`Installed ${pkg}; expecting v${expected.version} · ${sha.slice(0, 7)}`);

  const results = [];
  for (let round = 1; round <= launches; round += 1) {
    const result = await launch(pkg, round, out, expected);
    results.push(result);
    console.log(`launch ${round}: ${result.problems.length ? `FAILED\n  - ${result.problems.join('\n  - ')}` : 'ok'}`);
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify({ pkg, expected, results }, null, 2));
  const failed = results.filter((result) => result.problems.length);
  console.log(`${launches - failed.length} of ${launches} cold starts passed; screens and logs in ${out}`);
  if (failed.length) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
