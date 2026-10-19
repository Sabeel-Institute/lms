import { execFileSync } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
const required = (name) => {
  if (!process.env[name]) throw new Error('Missing ' + name);
  return process.env[name];
};
const fingerprint = (value) => value.replaceAll(':', '').toLowerCase();

export function androidIdentity(app, gradle) {
  const literalCode = /^\s*versionCode\s+(\d+)\b/m.exec(gradle)?.[1];
  const literalName = /^\s*versionName\s+"([^"]+)"/m.exec(gradle)?.[1];
  let versionCode;
  if (literalCode && literalName) {
    if (literalName !== app.version) throw new Error('Android native and app versions differ');
    versionCode = Number(literalCode);
  } else {
    if (!/versionCode\s+computedVersionCode\b/.test(gradle) || !/versionName\s+expoVersion\b/.test(gradle)
      || !/^\d+\.\d+\.\d+$/.test(app.version)) throw new Error('Unsupported Android version configuration');
    const [major, minor, patch] = app.version.split('.').map(Number);
    if (minor > 999 || patch > 999) throw new Error('Android version components exceed the versionCode scheme');
    versionCode = major * 1000000 + minor * 1000 + patch;
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000
    || (app.android.versionCode !== undefined && app.android.versionCode !== versionCode)) {
    throw new Error('Invalid or inconsistent Android versionCode');
  }
  return { packageName: app.android.package, versionName: app.version, versionCode };
}

export function assertManifest(manifest, expected) {
  const root = /<manifest\b([\s\S]*?)>/.exec(manifest)?.[1] ?? '';
  const actual = {
    packageName: /\bpackage="([^"]+)"/.exec(root)?.[1],
    versionName: /\bandroid:versionName="([^"]+)"/.exec(root)?.[1],
    versionCode: Number(/\bandroid:versionCode="(\d+)"/.exec(root)?.[1]),
  };
  if (actual.packageName !== expected.packageName || actual.versionName !== expected.versionName
    || actual.versionCode !== expected.versionCode) throw new Error('AAB manifest package/version differs from the selected source');
}

function verifyArtifact() {
  const artifact = join(required('RUNNER_TEMP'), 'play-artifact');
  const bundle = join(artifact, 'app-release.aab');
  const recordPath = join(artifact, 'build-record.json');
  for (const path of [bundle, recordPath]) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Expected regular artifact files');
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const commit = command('git', ['rev-parse', 'HEAD']).trim();
  if (record.platform !== 'android' || record.commit !== commit || record.ref !== 'refs/heads/main'
    || record.repository !== required('GITHUB_REPOSITORY') || String(record.repositoryId) !== required('GITHUB_REPOSITORY_ID')
    || String(record.runId) !== required('BUILD_RUN_ID')) throw new Error('Android artifact provenance mismatch');
  const body = readFileSync(bundle);
  if (record.bytes !== body.length || record.sha256 !== createHash('sha256').update(body).digest('hex')) {
    throw new Error('Android artifact checksum mismatch');
  }
  const approved = fingerprint(required('ANDROID_SIGNING_CERT_SHA256'));
  command('jarsigner', ['-verify', bundle]);
  const certificate = /SHA256:\s*([A-Fa-f0-9:]+)/.exec(command('keytool', ['-printcert', '-jarfile', bundle]))?.[1];
  if (!certificate || fingerprint(certificate) !== approved || record.signingCertificate !== approved) {
    throw new Error('AAB signing certificate differs from the approved upload key');
  }
  const shortCommit = command('git', ['rev-parse', '--short', 'HEAD']).trim();
  const javascript = execFileSync('unzip', ['-p', bundle, 'base/assets/index.android.bundle'], { maxBuffer: 256 * 1024 * 1024 });
  if (!javascript.includes(Buffer.from(shortCommit))) throw new Error('AAB JavaScript does not carry the selected commit');
  if (javascript.includes(Buffer.from(shortCommit + '+'))) {
    if (process.env.PUBLISH_PLAY === 'true') throw new Error('Refusing a dirty build; choose a clean Android build');
    console.log('Permission check only: this dirty-marked artifact is not eligible for publishing');
  }
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const expected = androidIdentity(app, readFileSync('app/android/app/build.gradle', 'utf8'));
  const manifest = command('java', ['-jar', required('BUNDLETOOL_JAR'), 'dump', 'manifest', '--bundle=' + bundle, '--module=base']);
  assertManifest(manifest, expected);
  const target = resolve('app/android/app/build/outputs/bundle/release/app-release.aab');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(bundle, target);
  console.log('Verified ' + expected.packageName + ' ' + expected.versionName + ' (' + expected.versionCode + '), commit ' + shortCommit);
  return expected;
}

export async function checkPlayAccess(credential, packageName, request = fetch) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({
    iss: credential.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const assertion = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(credential.private_key, 'base64url');
  const auth = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(30000),
  });
  if (!auth.ok) throw new Error('Play credential authentication failed: HTTP ' + auth.status);
  const token = (await auth.json()).access_token;
  if (!token) throw new Error('Play credential authentication returned no token');
  console.log('::add-mask::' + token);
  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(packageName) + '/edits';
  const options = { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) };
  const inserted = await request(url, { ...options, method: 'POST' });
  if (!inserted.ok) throw new Error('Play refused testing-track access for ' + packageName + ': HTTP ' + inserted.status);
  const edit = await inserted.json();
  if (!edit.id) throw new Error('Play returned no permission-check edit');
  const discarded = await request(url + '/' + encodeURIComponent(edit.id), { ...options, method: 'DELETE', signal: AbortSignal.timeout(30000) });
  if (!discarded.ok) throw new Error('Could not discard Play permission-check edit: HTTP ' + discarded.status);
  console.log('Play testing access verified for ' + packageName + '; nothing uploaded or released');
}

async function release() {
  const publish = process.env.PUBLISH_PLAY ?? 'false';
  if (!['true', 'false'].includes(publish)) throw new Error('PUBLISH_PLAY must be true or false');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_REPOSITORY_OWNER !== 'Sabeel-Institute') throw new Error('Play releases require a manual Institute main-branch run');
  const expected = verifyArtifact();
  const credential = JSON.parse(required('PLAY_PUBLISHER_JSON'));
  if (credential.type !== 'service_account' || credential.client_email !== required('PLAY_PUBLISHER_ACCOUNT') || !credential.private_key) {
    throw new Error('Unexpected Play publisher credential');
  }
  console.log('::add-mask::' + credential.private_key.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
  if (publish === 'false') {
    await checkPlayAccess(credential, expected.packageName);
    return;
  }
  copyFileSync(required('PLAY_PUBLISHER_SCRIPT'), 'scripts/publish-play.mjs');
  const directory = mkdtempSync(join(required('RUNNER_TEMP'), 'play-credential-'));
  try {
    const path = join(directory, 'publisher.json');
    writeFileSync(path, JSON.stringify(credential), { mode: 0o600 });
    const env = { ...process.env, PLAY_KEY: path, SK_PLAY_KEY: path };
    delete env.PLAY_PUBLISHER_JSON;
    command('node', ['scripts/publish-play.mjs', '--internal'], { env, stdio: 'inherit' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'verify') verifyArtifact();
  else if (process.argv[2] === 'release') await release();
  else throw new Error('Unknown Play release task');
}
