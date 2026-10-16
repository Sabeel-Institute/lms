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
 * Then, in two steps:
 *
 *  1. The bundle goes up as a DRAFT release on the internal track, which no
 *     tester sees, replacing whatever draft was there. The script refuses an
 *     upload whose versionCode, as Play read it, is not build.gradle's.
 *  2. Play turns the bundle into the APKs phones install. The script waits for
 *     them and refuses unless they are signed with the key the bundle is
 *     signed with: the LMS release key, which is also its Play app signing
 *     key (docs/DEPLOY.md). Play Console now gives every new app a
 *     Google-generated key the moment it is created, and copies generated
 *     before the key was changed stay signed with Google's. Only then does the
 *     draft become a completed release that testers get.
 *
 * Play keeps an app's very first release a draft if the API may not complete
 * it; the script says so, and one "Start rollout" in Play Console sends it.
 * A rerun after a failure picks up a bundle Play already has.
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

// The certificate the bundle is signed with: this app's release key, which is
// also the key Play must sign the installed app with.
const certSha256 = /SHA256: ([0-9A-F:]+)/.exec(run('keytool', ['-printcert', '-jarfile', AAB]))?.[1];
if (!certSha256) die(`Could not read the signing certificate of ${AAB}.`);

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

/** Runs `fn` in a fresh edit; the edit is discarded unless `fn` commits it. */
const inEdit = async (fn) => {
  const { id } = await api('POST', '/edits');
  let committed = false;
  try {
    await fn(id, async () => {
      await api('POST', `/edits/${id}:commit`);
      committed = true;
    });
  } finally {
    if (!committed) await api('DELETE', `/edits/${id}`).catch(() => {});
  }
};

const release = (status) => ({
  track: 'internal',
  releases: [{ versionCodes: [String(versionCode)], status }],
});

try {
  await inEdit(async () => {});
} catch (e) {
  die(
    `Play refused ${account.client_email}:\n${e.message}\n\n` +
      'In Play Console, Users and permissions, that account needs this app with\n' +
      '"Release apps to testing tracks".',
  );
}
if (check) {
  console.log('\n--check: every gate passes, and the publishing account may release this app.\nNothing was uploaded.');
  process.exit(0);
}

try {
  // 1. Up as a draft no tester sees.
  await inEdit(async (id, commit) => {
    const { bundles = [] } = await api('GET', `/edits/${id}/bundles`);
    if (bundles.some((b) => b.versionCode === versionCode)) {
      console.log(`\nPlay already has ${versionName} (${versionCode}); not uploading it again.`);
    } else {
      console.log('\nUploading...');
      const res = await fetch(`${API}/upload/androidpublisher/v3/applications/${pkg}/edits/${id}/bundles?uploadType=media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: readFileSync(AAB),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Upload: HTTP ${res.status}\n${text}`);
      const uploaded = JSON.parse(text).versionCode;
      if (uploaded !== versionCode) {
        throw new Error(`Play read versionCode ${uploaded} from the bundle; build.gradle says ${versionCode}. Rebuild it.`);
      }
    }
    await api('PUT', `/edits/${id}/tracks/internal`, release('draft'));
    await commit();
  });
  console.log('A draft release on the internal track holds it; no tester sees a draft.');

  // 2. What will phones install? Play generates the APKs after the commit.
  let hashes = [];
  for (let i = 0; i < 60 && hashes.length === 0; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 10_000));
    const { generatedApks = [] } = await api('GET', `/generatedApks/${versionCode}`).catch(() => ({}));
    hashes = generatedApks.map((g) => g.certificateSha256Hash);
  }
  if (hashes.length === 0) throw new Error('Play generated no APKs from the bundle within 10 minutes. Rerun later.');
  if (hashes.some((h) => h !== certSha256)) {
    throw new Error(
      `Play signs this build with ${hashes.join(', ')},\nnot with this app's own key, ${certSha256}.\n` +
        'It stays an unreleased draft. If Play Console, App integrity, App signing shows this\n' +
        "app's own key, the build was processed before the key changed: release a new version.\n" +
        'If it does not: "Change key", then "Export and upload a key from Java keystore" (docs/DEPLOY.md).',
    );
  }
  console.log('Play signs the APKs phones install with this app\'s own key.');

  // 3. Out to the testers.
  let draftOnly = false;
  await inEdit(async (id, commit) => {
    await api('PUT', `/edits/${id}/tracks/internal`, release('completed'));
    try {
      await commit();
    } catch (e) {
      // "Only releases with status draft may be created on draft app."
      if (!/draft app/i.test(e.message)) throw e;
      draftOnly = true;
    }
  });
  if (draftOnly) {
    console.log(
      `\n${versionName} (${versionCode}) is a draft on the internal testing track: Play keeps an app's first\n` +
        'release a draft until it is rolled out in Play Console (Internal testing, Start rollout).',
    );
  } else {
    console.log(`\n${versionName} (${versionCode}) is on the internal testing track. Testers get it from Play within minutes.`);
  }
} catch (e) {
  die(`${e.message}\n\nNothing reached the testers.`);
}
