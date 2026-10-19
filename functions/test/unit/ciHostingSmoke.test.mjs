import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { treeHashes } from '../../../scripts/ci-platform.mjs';
import { hostingChecks, smokePlan, verifyHosting } from '../../../scripts/ci-hosting-smoke.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(extra = '') {
  const artifact = mkdtempSync(join(tmpdir(), 'hosting-smoke-'));
  directories.push(artifact);
  const site = join(artifact, 'site');
  mkdirSync(site);
  const files = {
    'index.html': '<script src="/main.js"></script><link rel="stylesheet" href="/style.css">' + extra,
    'main.js': 'console.log("app");', 'style.css': 'body{}',
    'privacy.html': 'Privacy', 'support.html': 'Support', 'firebase-messaging-sw.js': 'worker',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(site, name), content);
  const input = { artifact, project: 'demo-sabeel-test', commit: 'a'.repeat(40),
    repository: 'Sabeel-Institute/test', repositoryId: '123', runId: '456' };
  writeFileSync(join(artifact, 'build-record.json'), JSON.stringify({
    platform: 'web', ref: 'refs/heads/main', ...input, files: treeHashes(site),
  }));
  const request = async (url, options) => {
    expect(url.origin).toBe('https://demo-sabeel-test.web.app');
    expect(options.method).toBe('GET');
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
    expect(options.headers.authorization).toBeUndefined();
    const name = { '/': 'index.html', '/privacy': 'privacy.html', '/support': 'support.html' }[url.pathname]
      ?? url.pathname.slice(1);
    return new Response(files[name] ?? 'Not found', { status: files[name] ? 200 : 404 });
  };
  return { input, request };
}

describe('read-only post-deployment verification', () => {
  it('preflights artifact provenance and required pages without network access', () => {
    const { input } = fixture();
    expect(hostingChecks(input).checks).toHaveLength(6);
  });
  it('checks exact HTML, entry scripts, styles, legal pages and push worker using only public GETs', async () => {
    const { input, request } = fixture('<script src="https://external.invalid/analytics.js"></script>');
    await verifyHosting(input, { request });
    expect(smokePlan(input.artifact, 'https://demo-sabeel-test.web.app')).toHaveLength(6);
  });
  it('rejects a different repository, build or non-main artifact before network access', async () => {
    const { input } = fixture();
    const request = () => { throw new Error('Unexpected network access'); };
    for (const overrides of [{ runId: '999' }, { repositoryId: '999' }, { commit: 'b'.repeat(40) }]) {
      await expect(verifyHosting({ ...input, ...overrides }, { request })).rejects.toThrow('provenance');
    }
  });
  it('rejects malformed project IDs before network access', async () => {
    const { input } = fixture();
    await expect(verifyHosting({ ...input, project: '../evil.invalid' })).rejects.toThrow('project');
  });
  it('fails on stale HTML or SPA fallbacks instead of accepting any HTTP 200', async () => {
    const { input } = fixture();
    let calls = 0;
    await expect(verifyHosting(input, {
      request: async () => { calls += 1; return new Response('<html>stale</html>'); },
      pause: async () => {},
    })).rejects.toThrow('does not match');
    expect(calls).toBe(3);
  });
  it('retries temporary propagation failures', async () => {
    const { input, request } = fixture();
    let calls = 0;
    await verifyHosting(input, {
      request: async (...args) => ++calls === 1 ? new Response('unavailable', { status: 503 }) : request(...args),
      pause: async () => {},
    });
    expect(calls).toBe(7);
  });
  it('rejects tampered local artifacts and missing application assets', () => {
    const { input } = fixture('<script src="/missing.js"></script>');
    expect(() => smokePlan(input.artifact, 'https://demo-sabeel-test.web.app')).toThrow('missing');
    writeFileSync(join(input.artifact, 'site', 'main.js'), 'tampered');
    expect(() => smokePlan(input.artifact, 'https://demo-sabeel-test.web.app')).toThrow('checksum');
  });
});

describe('workflow release and CI contracts', () => {
  const root = new URL('../../../', import.meta.url);
  const workflow = (name) => readFileSync(new URL('.github/workflows/' + name + '.yml', root), 'utf8');
  it('keeps releases manual and live smoke checks after publishing only', () => {
    const deploy = workflow('web-deploy');
    expect(deploy).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(deploy).toContain('workflow_dispatch:');
    expect(deploy).toContain('default: false');
    expect(deploy.indexOf('Read-only post-deployment checks')).toBeGreaterThan(deploy.indexOf('firebase deploy --only hosting'));
    expect(deploy).toMatch(/name: Read-only post-deployment checks\n\s+if: inputs.deploy/);
    expect(deploy.indexOf('Preserve current release safeguards')).toBeLessThan(deploy.indexOf('ref: ${{ steps.build.outputs.sha }}'));
    expect(deploy).toContain('node "$RUNNER_TEMP/hosting-release/ci-hosting-smoke.mjs"');
  });
  it('keeps a fail-closed aggregate over independent CI jobs', () => {
    const ci = workflow('ci');
    const jobs = [...ci.matchAll(/^ {2}([a-z-]+):\n(?= {4}if:)/gm)].map((match) => match[1]);
    const gate = ci.slice(ci.indexOf('  build-test:'));
    for (const name of ['workflow-validation', 'quality', 'integration', 'browser', 'build-test']) {
      expect(jobs).toContain(name);
    }
    for (const name of jobs.filter((job) => job !== 'build-test')) expect(gate).toContain(name);
    expect(gate).toContain('if: always()');
    expect(gate).toContain('job.result !== "success"');
    expect(ci).toContain('actionlint_1.7.12_linux_amd64.tar.gz');
    expect(ci).toContain('sha256sum -c -');
    expect(ci).toContain('shellcheck --version');
  });
  it('scans JavaScript/TypeScript without platform builds or deployment secrets', () => {
    const codeql = workflow('codeql');
    expect(codeql).toContain('languages: javascript-typescript');
    expect(codeql).toContain('build-mode: none');
    expect(codeql).toContain('schedule:');
    expect(codeql).not.toContain('secrets.');
    expect(codeql).not.toContain('pull_request_target');
  });
});
