import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { androidIdentity, assertManifest } from '../../../scripts/ci-play.mjs';

const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'scripts/ci-play.mjs');
const commit = 'c'.repeat(40);
const certificate = 'ab'.repeat(32);
const app = { version: '0.2.0', android: { package: 'com.test.app', versionCode: 38 } };
const gradle = 'versionCode 38\nversionName "0.2.0"\n';
const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.test.app" android:versionCode="38" android:versionName="0.2.0"/>';
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-play-'));
  fixtures.push(directory);
  const put = (path, value, mode = 0o600) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), value, { mode });
  };
  const tool = (name, body) => put('bin/' + name, '#!/usr/bin/env node\n' + body, 0o700);
  const bundle = Buffer.from('signed bundle fixture');
  const record = {
    platform: 'android', commit, ref: 'refs/heads/main', repository: 'Sabeel-Institute/test',
    repositoryId: '123', runId: '456', bytes: bundle.length, signingCertificate: certificate,
    sha256: createHash('sha256').update(bundle).digest('hex'),
  };
  put('play-artifact/app-release.aab', bundle);
  put('play-artifact/build-record.json', JSON.stringify(record));
  put('app/app.json', JSON.stringify({ expo: app }));
  put('app/android/app/build.gradle', gradle);
  tool('git', 'process.stdout.write(process.argv.includes("--short") ? "' + commit.slice(0, 7) + '" : "' + commit + '");');
  tool('jarsigner', 'process.exit(process.env.BAD_SIGNATURE ? 1 : 0);');
  tool('keytool', 'process.stdout.write("SHA256: " + (process.env.FAKE_CERT || "' + certificate + '"));');
  tool('unzip', 'process.stdout.write(process.env.FAKE_JS || "' + commit + '");');
  tool('java', 'process.stdout.write(process.env.FAKE_MANIFEST || ' + JSON.stringify(manifest) + ');');
  put('scripts/publish-play.mjs', [
    "import {readFileSync,statSync,writeFileSync} from 'node:fs';",
    "const key=process.env.PLAY_KEY;",
    "const data={flag:process.argv[2],keyPath:key,mode:statSync(key).mode&0o777,matchingPaths:key===process.env.SK_PLAY_KEY,secretInEnvironment:'PLAY_PUBLISHER_JSON' in process.env};",
    "JSON.parse(readFileSync(key,'utf8'));",
    "writeFileSync('publisher-call.json',JSON.stringify(data));",
    "if(process.env.FAIL_PUBLISHER) process.exit(1);",
  ].join('\n'));
  const run = (task = 'verify', env = {}) => execFileSync(process.execPath, [script, task], {
    cwd: directory, encoding: 'utf8', stdio: 'pipe', env: {
      ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH,
      RUNNER_TEMP: directory, BUNDLETOOL_JAR: join(directory, 'bundletool.jar'),
      GITHUB_REPOSITORY: 'Sabeel-Institute/test', GITHUB_REPOSITORY_ID: '123', BUILD_RUN_ID: '456',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY_OWNER: 'Sabeel-Institute',
      ANDROID_SIGNING_CERT_SHA256: certificate, PLAY_PUBLISHER_ACCOUNT: 'publisher@example.test',
      PLAY_PUBLISHER_JSON: JSON.stringify({ type: 'service_account', client_email: 'publisher@example.test', private_key: 'FAKE\nPRIVATE\nKEY' }),
      ...env,
    },
  });
  return { directory, put, record, run };
}

describe('manual Play artifact releases', () => {
  it('handles computed Kanban/Time Tracker and explicit LMS native versions', () => {
    expect(androidIdentity(app, gradle)).toEqual({ packageName: 'com.test.app', versionName: '0.2.0', versionCode: 38 });
    expect(androidIdentity({ ...app, android: { package: 'com.test.app' } }, 'versionCode computedVersionCode\nversionName expoVersion')).toEqual({
      packageName: 'com.test.app', versionName: '0.2.0', versionCode: 2000,
    });
    expect(() => androidIdentity(app, 'versionCode 39\nversionName "0.2.0"')).toThrow(/versionCode/);
    expect(() => androidIdentity(app, 'versionCode 38\nversionName "0.3.0"')).toThrow(/versions differ/);
    expect(() => androidIdentity(app, '')).toThrow(/Unsupported/);
  });

  it('reads exact package and versions from the decoded AAB manifest', () => {
    const expected = androidIdentity(app, gradle);
    expect(() => assertManifest(manifest, expected)).not.toThrow();
    for (const change of [{ packageName: 'com.wrong' }, { versionName: '0.2.1' }, { versionCode: 39 }]) {
      expect(() => assertManifest(manifest, { ...expected, ...change })).toThrow(/manifest/);
    }
  });

  it('verifies and stages the exact signed build without invoking the publisher', () => {
    const test = fixture();
    expect(test.run()).toContain('Verified com.test.app 0.2.0 (38)');
    expect(readFileSync(join(test.directory, 'app/android/app/build/outputs/bundle/release/app-release.aab'), 'utf8')).toBe('signed bundle fixture');
    expect(existsSync(join(test.directory, 'publisher-call.json'))).toBe(false);
  });

  it.each([
    ['repositoryId', '999'], ['runId', '999'], ['commit', 'd'.repeat(40)],
    ['ref', 'refs/heads/untrusted'], ['platform', 'web'],
  ])('rejects mismatched artifact %s before using credentials', (field, value) => {
    const test = fixture();
    test.put('play-artifact/build-record.json', JSON.stringify({ ...test.record, [field]: value }));
    expect(() => test.run('release')).toThrow(/provenance/);
    expect(existsSync(join(test.directory, 'publisher-call.json'))).toBe(false);
  });

  it('rejects a modified bundle, bad signature, unexpected certificate and stale JS', () => {
    const test = fixture();
    test.put('play-artifact/app-release.aab', 'tampered');
    expect(() => test.run()).toThrow(/checksum/);
    test.put('play-artifact/app-release.aab', 'signed bundle fixture');
    expect(() => test.run('verify', { BAD_SIGNATURE: '1' })).toThrow();
    expect(() => test.run('verify', { FAKE_CERT: 'ff'.repeat(32) })).toThrow(/certificate/);
    expect(() => test.run('verify', { FAKE_JS: 'old commit' })).toThrow(/selected commit/);
    expect(() => test.run('verify', { FAKE_MANIFEST: manifest.replace('com.test.app', 'com.wrong') })).toThrow(/manifest/);
  });

  it('defaults to permission checks with a private, temporary credential', () => {
    const test = fixture();
    const output = test.run('release', { PUBLISH_PLAY: 'false' });
    const call = JSON.parse(readFileSync(join(test.directory, 'publisher-call.json'), 'utf8'));
    expect(call.flag).toBe('--check');
    expect(call.mode).toBe(0o600);
    expect(call.matchingPaths).toBe(true);
    expect(call.secretInEnvironment).toBe(false);
    expect(existsSync(call.keyPath)).toBe(false);
    expect(output).toContain('::add-mask::FAKE%0APRIVATE%0AKEY');
    expect(output).not.toContain('FAKE\nPRIVATE\nKEY');
  });

  it('publishes internally only with the explicit true input', () => {
    const test = fixture();
    test.run('release', { PUBLISH_PLAY: 'true' });
    const call = JSON.parse(readFileSync(join(test.directory, 'publisher-call.json'), 'utf8'));
    expect(call.flag).toBe('--internal');
    expect(existsSync(call.keyPath)).toBe(false);
    expect(() => test.run('release', { PUBLISH_PLAY: 'yes' })).toThrow(/true or false/);
  });

  it('rejects automatic, non-main, foreign-owner and wrong-account release contexts', () => {
    const test = fixture();
    for (const env of [
      { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' },
      { GITHUB_REPOSITORY_OWNER: 'other' }, { PLAY_PUBLISHER_ACCOUNT: 'wrong@example.test' },
    ]) expect(() => test.run('release', env)).toThrow();
    expect(existsSync(join(test.directory, 'publisher-call.json'))).toBe(false);
  });

  it('cleans up its temporary credential even if the publisher fails', () => {
    const test = fixture();
    expect(() => test.run('release', { FAIL_PUBLISHER: '1' })).toThrow();
    const call = JSON.parse(readFileSync(join(test.directory, 'publisher-call.json'), 'utf8'));
    expect(existsSync(call.keyPath)).toBe(false);
  });

  it('keeps the workflow manual, main-only, isolated and rebuild-free', () => {
    const workflow = readFileSync(join(root, '.github/workflows/android-publish.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|workflow_run):/m);
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('environment: play-internal');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('resolve-android-build');
    expect(workflow).toContain('sha256sum --check');
    expect(workflow).toContain('cp scripts/ci-platform.mjs scripts/ci-play.mjs "$RUNNER_TEMP/play-release/"');
    expect(workflow.indexOf('PLAY_PUBLISHER_JSON:')).toBeGreaterThan(workflow.indexOf('run: npm ci'));
    expect(workflow).not.toMatch(/bundleRelease|build:aab|gradlew|workflow_run:|production.*track/);
  });
});
