import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const command = (program, args, options = {}) => execFileSync(program, args, { maxBuffer: 64 * 1024 * 1024, ...options });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export function environmentValues(text) {
  return Object.values(parseEnv(text)).filter(Boolean);
}

function maskEnvironment(text) {
  for (const value of environmentValues(text)) {
    console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  }
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
}

function prepare(android) {
  const env = required('APP_ENV_LOCAL');
  maskEnvironment(env);
  writePrivate('app/.env.local', env);
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join('app', name);
    if (existsSync(path) && /^\s*EXPO_PUBLIC_USE_EMULATORS\s*=\s*['"]?1\b/m.test(readFileSync(path, 'utf8'))) {
      throw new Error('Production builds must not use Firebase emulators');
    }
  }
  if (!android) return;
  const settings = required('ANDROID_KEYSTORE_PROPERTIES');
  maskEnvironment(settings);
  const keystore = join(required('RUNNER_TEMP'), 'android-signing.keystore');
  const properties = join(required('RUNNER_TEMP'), 'android-keystore.properties');
  writePrivate(keystore, Buffer.from(required('ANDROID_KEYSTORE'), 'base64'));
  const normalized = settings.replace(/^\s*storeFile\s*[=:].*(?:\r?\n|$)/gm, '').trimEnd() + `\nstoreFile=${keystore}\n`;
  for (const name of ['storePassword', 'keyPassword', 'keyAlias']) {
    if (!new RegExp(`^\\s*${name}\\s*[=:]\\s*\\S`, 'm').test(normalized)) throw new Error(`Missing signing property ${name}`);
  }
  writePrivate(properties, normalized);
  writePrivate('app/android/keystore.properties', normalized);
  appendFileSync(required('GITHUB_ENV'), `SABEEL_TT_KEYSTORE_PROPERTIES=${properties}\nSABEEL_LMS_KEYSTORE_PROPERTIES=${properties}\n`);
  if (process.env.ANDROID_GOOGLE_SERVICES_JSON) {
    const googleServices = JSON.parse(process.env.ANDROID_GOOGLE_SERVICES_JSON);
    const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
    if (!googleServices.client?.some((client) => client.client_info?.android_client_info?.package_name === app.android.package)) {
      throw new Error('Android Firebase configuration has the wrong package');
    }
    writePrivate('app/android/app/google-services.json', JSON.stringify(googleServices));
  }
}

export function treeHashes(directory) {
  const result = {};
  function walk(path, prefix) {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error('Build artifacts must not contain symlinks');
      if (info.isDirectory()) walk(full, relative);
      else result[relative] = sha256(readFileSync(full));
    }
  }
  walk(directory, '');
  return result;
}

function record(platform, artifact, additional = {}) {
  const commit = command('git', ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(artifact, 'build-record.json'), JSON.stringify({
    platform, commit, repository: required('GITHUB_REPOSITORY'), repositoryId: required('GITHUB_REPOSITORY_ID'),
    runId: required('GITHUB_RUN_ID'), ref: required('GITHUB_REF'), ...additional,
  }, null, 2) + '\n');
}

function android() {
  const commit = command('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  const env = { ...process.env, EXPO_PUBLIC_COMMIT: commit };
  if (existsSync('scripts/gen-build-info.mjs')) command('node', ['scripts/gen-build-info.mjs'], { stdio: 'inherit', env });
  if (existsSync('scripts/build-aab.sh')) command('bash', ['scripts/build-aab.sh'], { stdio: 'inherit', env });
  else command('./gradlew', ['bundleRelease', '--no-daemon'], { cwd: 'app/android', stdio: 'inherit', env });
  const bundle = 'app/android/app/build/outputs/bundle/release/app-release.aab';
  command('jarsigner', ['-verify', bundle]);
  const certificate = command('keytool', ['-printcert', '-jarfile', bundle]).toString();
  const fingerprint = /SHA256:\s*([A-Fa-f0-9:]+)/.exec(certificate)?.[1].replaceAll(':', '').toLowerCase();
  if (!fingerprint || fingerprint !== required('ANDROID_SIGNING_CERT_SHA256').replaceAll(':', '').toLowerCase()) {
    throw new Error('AAB certificate does not match the existing release/upload key');
  }
  const javascript = command('unzip', ['-p', bundle, 'base/assets/index.android.bundle']);
  if (!javascript.includes(Buffer.from(commit))) throw new Error('AAB does not carry the build commit');
  if (javascript.includes(Buffer.from(commit + '+'))) throw new Error('AAB is marked as built from uncommitted changes');
  const artifact = join(required('RUNNER_TEMP'), 'android-artifact');
  mkdirSync(artifact, { recursive: true });
  copyFileSync(bundle, join(artifact, 'app-release.aab'));
  record('android', artifact, { sha256: sha256(readFileSync(bundle)), signingCertificate: fingerprint, bytes: statSync(bundle).size });
}

function web() {
  command('npm', ['run', 'web:export', '-w', '@sabeel/app'], { stdio: 'inherit' });
  if (existsSync('scripts/check-web-push.mjs')) command('node', ['scripts/check-web-push.mjs'], { stdio: 'inherit' });
  const artifact = join(required('RUNNER_TEMP'), 'web-artifact');
  const source = resolve('app/dist-web');
  const hashes = treeHashes(source);
  if (!hashes['index.html'] || Object.keys(hashes).some((path) => /\.map$|(^|\/)\.env/.test(path))) {
    throw new Error('Web artifact must contain index.html and no source maps or environment files');
  }
  for (const path of Object.keys(hashes)) {
    const target = join(artifact, 'site', path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
  record('web', artifact, { files: hashes });
}

function resolveBuild(platform = 'web') {
  const id = required('BUILD_RUN_ID');
  if (!/^\d+$/.test(id)) throw new Error('Build run ID must be numeric');
  const repo = required('GITHUB_REPOSITORY');
  const api = (path) => JSON.parse(command('gh', ['api', path]).toString());
  const run = api(`repos/${repo}/actions/runs/${id}`);
  const workflow = api(`repos/${repo}/actions/workflows/${platform}.yml`);
  if (run.workflow_id !== workflow.id || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_branch !== 'main' || String(run.head_repository.id) !== required('GITHUB_REPOSITORY_ID')
    || !['push', 'workflow_dispatch'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error(`Choose a successful ${platform === 'web' ? 'Web' : 'Android'} build from this repository main branch`);
  }
  const checks = api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${run.head_sha}&status=completed&per_page=50`);
  if (!checks.workflow_runs.some((check) => check.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(check.event))) {
    throw new Error('CI must pass on the exact build commit before deployment');
  }
  appendFileSync(required('GITHUB_OUTPUT'), `sha=${run.head_sha}\nrun_id=${id}\n`);
}

export function hostingConfig(source, site) {
  if (!source.hosting || Array.isArray(source.hosting)) throw new Error('Expected one Hosting site');
  const { predeploy, postdeploy, ...hosting } = source.hosting;
  void predeploy;
  void postdeploy;
  return { hosting: { ...hosting, public: resolve(site) } };
}

function deployConfig() {
  const artifact = join(required('RUNNER_TEMP'), 'hosting-artifact');
  const build = JSON.parse(readFileSync(join(artifact, 'build-record.json'), 'utf8'));
  const commit = command('git', ['rev-parse', 'HEAD']).toString().trim();
  if (build.platform !== 'web' || build.commit !== commit || build.repository !== required('GITHUB_REPOSITORY')
    || String(build.repositoryId) !== required('GITHUB_REPOSITORY_ID') || String(build.runId) !== required('BUILD_RUN_ID')) {
    throw new Error('Downloaded artifact provenance does not match the selected build');
  }
  const site = join(artifact, 'site');
  if (JSON.stringify(treeHashes(site)) !== JSON.stringify(build.files)) throw new Error('Web artifact checksum mismatch');
  const source = JSON.parse(readFileSync('firebase.json', 'utf8'));
  writeFileSync(join(required('RUNNER_TEMP'), 'firebase-hosting.json'), JSON.stringify(hostingConfig(source, site)));
}

async function validateAuthentication() {
  const token = command('gcloud', ['auth', 'print-access-token']).toString().trim();
  const project = required('FIREBASE_PROJECT_ID');
  const response = await fetch(`https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Hosting identity validation failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.sites?.some((site) => site.name.endsWith(`/sites/${project}`))) throw new Error('Expected Hosting site not found');
  console.log('Hosting deployment identity validated; no release published');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const task = process.argv[2];
  if (task === 'prepare-web') prepare(false);
  else if (task === 'prepare-android') prepare(true);
  else if (task === 'android') android();
  else if (task === 'web') web();
  else if (task === 'resolve-build') resolveBuild();
  else if (task === 'resolve-android-build') resolveBuild('android');
  else if (task === 'deploy-config') deployConfig();
  else if (task === 'validate-auth') await validateAuthentication();
  else throw new Error('Unknown CI platform task');
}
