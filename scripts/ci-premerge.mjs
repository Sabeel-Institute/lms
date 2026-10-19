import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSdk } from '../app/ci-sdk.mjs';

const run = (program, args, options = {}) => execFileSync(program, args, { stdio: 'inherit', ...options });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const app = () => json('app/app.json').expo;
const temporary = () => {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
    throw new Error('Fixture preparation and native compilation require an isolated GitHub runner');
  }
  return process.env.RUNNER_TEMP;
};

export function firebaseFixtures(configuration) {
  for (const identifier of [configuration.android.package, configuration.ios.bundleIdentifier]) {
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(identifier)) throw new Error('Invalid application identifier');
  }
  const project = 'demo-sabeel-ci';
  const sender = '123456789012';
  const client = sender + '-ci.apps.googleusercontent.com';
  return {
    android: {
      project_info: { project_number: sender, project_id: project, storage_bucket: project + '.appspot.com' },
      client: [{
        client_info: { mobilesdk_app_id: '1:' + sender + ':android:0000000000000000',
          android_client_info: { package_name: configuration.android.package } },
        oauth_client: [{ client_id: client, client_type: 3 }],
        api_key: [{ current_key: 'ci-placeholder-not-a-real-api-key' }],
        services: { appinvite_service: { other_platform_oauth_client: [] } },
      }],
      configuration_version: '1',
    },
    ios: '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
      + '<key>CLIENT_ID</key><string>' + client + '</string>'
      + '<key>REVERSED_CLIENT_ID</key><string>com.googleusercontent.apps.' + sender + '-ci</string>'
      + '<key>API_KEY</key><string>ci-placeholder-not-a-real-api-key</string>'
      + '<key>GCM_SENDER_ID</key><string>' + sender + '</string>'
      + '<key>PLIST_VERSION</key><string>1</string>'
      + '<key>BUNDLE_ID</key><string>' + configuration.ios.bundleIdentifier + '</string>'
      + '<key>PROJECT_ID</key><string>' + project + '</string>'
      + '<key>GOOGLE_APP_ID</key><string>1:' + sender + ':ios:0000000000000000</string>'
      + '<key>IS_GCM_ENABLED</key><true/><key>IS_SIGNIN_ENABLED</key><true/>'
      + '</dict></plist>\n',
  };
}

function prepare() {
  const directory = temporary();
  for (const path of ['app/android/keystore.properties', 'app/android/sentry.properties',
    'app/.env.local', 'app/.env.sentry-build-plugin']) {
    if (existsSync(path)) throw new Error('Pre-merge builds must not load private configuration: ' + path);
  }
  const fixtures = firebaseFixtures(app());
  writeFileSync('app/GoogleService-Info.plist', fixtures.ios);
  writeFileSync('app/google-services.json', JSON.stringify(fixtures.android));
  writeFileSync('app/android/app/google-services.json', JSON.stringify(fixtures.android));
  writeFileSync(join(directory, 'pr-unsigned.gradle'), [
    'gradle.beforeProject { target ->',
    '  target.pluginManager.withPlugin("com.android.application") {',
    '    target.extensions.getByName("androidComponents").finalizeDsl { androidDsl ->',
    '      androidDsl.buildTypes.getByName("release").signingConfig = null',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'));
}

function android() {
  const directory = temporary();
  run('./gradlew', [':app:bundleRelease', '--no-daemon',
    '--init-script', join(directory, 'pr-unsigned.gradle'), '-PreactNativeArchitectures=arm64-v8a'],
  { cwd: 'app/android' });
  const bundle = 'app/android/app/build/outputs/bundle/release/app-release.aab';
  if (!statSync(bundle).size) throw new Error('Release bundle is empty');
  const entries = run('unzip', ['-Z1', bundle], { encoding: 'utf8', stdio: 'pipe' }).split('\n');
  if (!entries.includes('base/assets/index.android.bundle')) throw new Error('Release JavaScript bundle is missing');
  if (entries.some((entry) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(entry))) {
    throw new Error('PR bundles must not be signed');
  }
  console.log('Unsigned arm64 release AAB and bundled production JavaScript verified; nothing uploaded');
}

export function podVersions(lock) {
  const match = /^PODS:\n[\s\S]*?(?=^DEPENDENCIES:)/m.exec(lock);
  if (!match) throw new Error('Pod lockfile has no dependency versions');
  return match[0];
}

export function appScheme(project, projectName) {
  const schemes = project.schemes.filter((name) => !/Tests?$/.test(name));
  if (schemes.includes(projectName)) return projectName;
  if (schemes.length !== 1) throw new Error('Cannot identify exactly one application scheme');
  return schemes[0];
}

function ios() {
  const directory = temporary();
  if (process.platform !== 'darwin') throw new Error('iOS compilation requires macOS');
  run('npx', ['--no-install', 'expo', 'prebuild', '--platform', 'ios', '--no-install'], { cwd: 'app' });
  copyFileSync('app/Podfile.lock', 'app/ios/Podfile.lock');
  run('pod', ['install', '--repo-update'], { cwd: 'app/ios' });
  if (podVersions(readFileSync('app/Podfile.lock', 'utf8'))
    !== podVersions(readFileSync('app/ios/Podfile.lock', 'utf8'))) {
    throw new Error('Native pods changed; update and commit app/Podfile.lock with the dependency PR');
  }
  const one = (extension) => {
    const matches = readdirSync('app/ios').filter((name) => name.endsWith(extension));
    if (matches.length !== 1) throw new Error('Expected exactly one application ' + extension);
    return join('app/ios', matches[0]);
  };
  const project = one('.xcodeproj');
  const workspace = one('.xcworkspace');
  const listing = JSON.parse(run('xcodebuild', ['-project', project, '-list', '-json'],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }));
  const scheme = appScheme(listing.project, basename(project, '.xcodeproj'));
  const archive = join(directory, 'pr-ios.xcarchive');
  console.log('Compiling unsigned Release archive for application scheme ' + scheme);
  run('xcodebuild', ['-workspace', workspace, '-scheme', scheme, '-configuration', 'Release',
    '-destination', 'generic/platform=iOS', '-archivePath', archive,
    '-derivedDataPath', join(directory, 'pr-derived-data'),
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'DEVELOPMENT_TEAM=', 'archive']);
  const applications = join(archive, 'Products/Applications');
  const products = readdirSync(applications).filter((name) => name.endsWith('.app'));
  if (products.length !== 1) throw new Error('Archive does not contain exactly one app');
  const product = join(applications, products[0]);
  const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', join(product, 'Info.plist')],
    { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (identifier !== app().ios.bundleIdentifier || !statSync(join(product, 'main.jsbundle')).size
    || existsSync(join(product, '_CodeSignature'))) throw new Error('Unsigned release application verification failed');
  console.log('Unsigned device Release archive and production JavaScript verified; no IPA exported or uploaded');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const task = process.argv[2];
  if (task === 'sdk') checkSdk();
  else if (task === 'prepare') prepare();
  else if (task === 'android') android();
  else if (task === 'ios') ios();
  else throw new Error('Unknown pre-merge task');
}
