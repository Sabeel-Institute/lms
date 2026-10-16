#!/usr/bin/env node
/**
 * Put the release bundle on Google Play's internal testing track.
 *
 *     node scripts/publish-play.mjs --check      # every gate, and the Play permission; uploads nothing
 *     node scripts/publish-play.mjs --internal   # publish: everyone on the tester list gets it
 *
 * The destination must be named. Publishing reaches every tester, so a bare
 * run, or any flag this script does not know, prints the usage and stops.
 *
 * The bundle is `app/android/app/build/outputs/bundle/release/app-release.aab`,
 * built by `EXPO_PUBLIC_COMMIT=$(git rev-parse --short HEAD) ./gradlew
 * bundleRelease` in app/android (docs/DEPLOY.md). Before anything leaves this
 * machine the script refuses a bundle that:
 *
 *  - is signed with the debug key, or not signed at all;
 *  - does not carry HEAD's commit. `EXPO_PUBLIC_COMMIT` is not a Gradle input,
 *    so a rebuild after a commit that changed no JS reuses the previous JS
 *    bundle and its label (the 2026-10-15 build of 0.1.2 did exactly that);
 *  - names a different versionName from `app/android/app/build.gradle`.
 *
 * Then Play is asked, and the script refuses:
 *
 *  - an app with no release on any track. Its FIRST release is made in Play
 *    Console, because that is where the app signing key is chosen; an upload
 *    through the API before then would have Google generate a new key, and an
 *    app's signing key never changes after its first release;
 *  - an upload whose versionCode, as Play read it, is not build.gradle's.
 *
 * The flow is edit, upload, point the internal track at the new versionCode,
 * commit. Anything failing before the commit discards the edit.
 *
 * The key is the Play publishing service account's JSON, outside the repo
 * (this repo is public): ~/keys/sabeel-play-publisher.json, or the path in
 * PLAY_KEY. One account publishes every Sabeel app; Play Console gives it
 * "Release apps to testing tracks" per app.
 */
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const AAB = join(ROOT, 'app/android/app/build/outputs/bundle/release/app-release.aab');
const GRADLE = join(ROOT, 'app/android/app/build.gradle');
const KEY = process.env.PLAY_KEY || join(homedir(), 'keys', 'sabeel-play-publisher.json');
const API = 'https://androidpublisher.googleapis.com';
const USAGE = `usage: node scripts/publish-play.mjs --check | --internal

  --check      every gate, and proof the publishing account may release this app;
               uploads nothing
  --internal   upload the bundle to the internal testing track; testers get it`;

const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--internal'].includes(args[0])) {
  console.error(USAGE);
  process.exit(args.length === 1 && args[0] === '--help' ? 0 : 2);
}
const check = args[0] === '--check';

const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};
const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const pkg = JSON.parse(readFileSync(join(ROOT, 'app/app.json'), 'utf8')).expo.android.package;
const gradle = readFileSync(GRADLE, 'utf8');
const versionName = /versionName "([^"]+)"/.exec(gradle)?.[1];
const versionCode = Number(/versionCode (\d+)/.exec(gradle)?.[1]);
if (!versionName || !versionCode) die(`Could not read versionName and versionCode from ${GRADLE}.`);
const head = run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).trim();

// ---- the bundle, before anything leaves this machine ----------------------

let size;
try {
  ({ size } = statSync(AAB));
} catch {
  die(`No bundle at ${AAB}.\nBuild it: cd app/android && EXPO_PUBLIC_COMMIT=$(git rev-parse --short HEAD) ./gradlew bundleRelease`);
}

// An AAB is a signed jar, so jarsigner reads it (apksigner does not).
let signer = '';
try {
  signer = /Signed by "([^"]+)"/.exec(run('jarsigner', ['-verify', '-verbose:summary', '-certs', AAB]))?.[1] ?? '';
} catch {
  // jarsigner exits non-zero on an unsigned jar; the empty signer says so below.
}
if (!signer) die(`${AAB} is not signed. app/android/keystore.properties is missing (docs/SECRETS.md).`);
if (/CN=Android Debug/i.test(signer)) die(`${AAB} is signed with the DEBUG key (${signer}).`);

// Hermes keeps string literals readable, so the commit label is findable in
// the compiled JS, as docs/DEPLOY.md does for an APK.
const js = execFileSync('unzip', ['-p', AAB, 'base/assets/index.android.bundle'], { maxBuffer: 256 * 1024 * 1024 });
if (!js.includes(Buffer.from(head))) {
  die(
    `The bundle's JS does not carry HEAD (${head}): it was built from another commit,\n` +
      'or Gradle reused a JS bundle from before the last commit.\n' +
      'Rebuild the JS: cd app/android && EXPO_PUBLIC_COMMIT=$(git rev-parse --short HEAD) \\\n' +
      '  ./gradlew :app:createBundleReleaseJsAndAssets --rerun :app:bundleRelease',
  );
}

// The manifest is binary protobuf, but versionName sits in it as a plain string.
const manifest = execFileSync('unzip', ['-p', AAB, 'base/manifest/AndroidManifest.xml']).toString('latin1');
if (!manifest.includes(versionName)) die(`The bundle does not name versionName ${versionName} (build.gradle's). Rebuild it.`);

console.log(`package   ${pkg}`);
console.log(`version   ${versionName} (${versionCode})`);
console.log(`bundle    ${(size / 1024 / 1024).toFixed(1)} MB, commit ${head}, signed by ${signer}`);

// ---- Play -----------------------------------------------------------------

let account;
try {
  account = JSON.parse(readFileSync(KEY, 'utf8'));
} catch {
  die(`No Play publishing key at ${KEY} (or set PLAY_KEY). docs/SECRETS.md says where it lives.`);
}

// A service account's OAuth token: an RS256 assertion exchanged at Google.
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
  iss: account.client_email,
  scope: 'https://www.googleapis.com/auth/androidpublisher',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
})}`;
const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`;
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
});
const token = (await tokenRes.json()).access_token;
if (!token) {
  die(
    `Google issued no token for ${account.client_email} (HTTP ${tokenRes.status}).\n` +
      'If its key was rotated or deleted, make a new JSON key for that service account and replace the file.',
  );
}

const api = async (method, path, body) => {
  const res = await fetch(`${API}/androidpublisher/v3/applications/${pkg}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}\n${text}`);
  return text ? JSON.parse(text) : {};
};

let edit;
try {
  edit = await api('POST', '/edits');
} catch (e) {
  die(
    `Play refused ${account.client_email}:\n${e.message}\n\n` +
      'In Play Console, Users and permissions, that account needs this app with\n' +
      '"Release apps to testing tracks".',
  );
}

let committed = false;
try {
  const { tracks = [] } = await api('GET', `/edits/${edit.id}/tracks`);
  if (!tracks.some((t) => (t.releases ?? []).length > 0)) {
    throw new Error(
      `${pkg} has no release on any track. Make its first release in Play Console\n` +
        '(Internal testing, Create new release), where the app signing key is chosen.\n' +
        'An upload from here first would have Google generate a new signing key, for good.',
    );
  }

  if (check) {
    await api('DELETE', `/edits/${edit.id}`);
    console.log('\n--check: every gate passes, and the publishing account may release this app.\nNothing was uploaded.');
    process.exit(0);
  }

  console.log('\nUploading to the internal testing track...');
  const res = await fetch(
    `${API}/upload/androidpublisher/v3/applications/${pkg}/edits/${edit.id}/bundles?uploadType=media`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: readFileSync(AAB),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload: HTTP ${res.status}\n${text}`);
  const uploaded = JSON.parse(text).versionCode;
  if (uploaded !== versionCode) {
    throw new Error(`Play read versionCode ${uploaded} from the bundle; build.gradle says ${versionCode}. Rebuild it.`);
  }

  await api('PUT', `/edits/${edit.id}/tracks/internal`, {
    track: 'internal',
    releases: [{ versionCodes: [String(versionCode)], status: 'completed' }],
  });
  await api('POST', `/edits/${edit.id}:commit`);
  committed = true;
  console.log(`\n${versionName} (${versionCode}) is on the internal testing track. Testers get it from Play within minutes.`);
} catch (e) {
  if (!committed) await api('DELETE', `/edits/${edit.id}`).catch(() => {});
  die(`${e.message}\n\nThe edit was discarded; nothing was released.`);
}
