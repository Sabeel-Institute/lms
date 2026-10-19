import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { treeHashes } from './ci-platform.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function smokePlan(artifact, origin) {
  const build = JSON.parse(readFileSync(join(artifact, 'build-record.json'), 'utf8'));
  const site = join(artifact, 'site');
  if (JSON.stringify(treeHashes(site)) !== JSON.stringify(build.files)) {
    throw new Error('Web artifact checksum mismatch');
  }
  const paths = new Map([['/', 'index.html'], ['/privacy', 'privacy.html'], ['/support', 'support.html']]);
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  let scripts = 0;
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    if (tag[1].toLowerCase() === 'link' && !/\brel=["']stylesheet["']/i.test(tag[0])) continue;
    const attribute = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag[0]);
    if (!attribute) continue;
    const url = new URL(attribute[1].replaceAll('&amp;', '&'), origin);
    if (url.origin !== origin) continue;
    const file = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!Object.hasOwn(build.files, file)) throw new Error('HTML references an asset missing from the artifact');
    paths.set(url.pathname + url.search, file);
    if (tag[1].toLowerCase() === 'script') scripts += 1;
  }
  if (!scripts) throw new Error('No same-origin application script found');
  for (const file of ['firebase-messaging-sw.js', 'get-app.html']) {
    if (Object.hasOwn(build.files, file)) paths.set('/' + file, file);
  }
  return [...paths].map(([path, file]) => {
    if (!Object.hasOwn(build.files, file)) throw new Error('Required page missing: ' + file);
    return { path, hash: build.files[file] };
  });
}

export function hostingChecks(input) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.project ?? '')) throw new Error('Invalid Firebase project ID');
  const build = JSON.parse(readFileSync(join(input.artifact, 'build-record.json'), 'utf8'));
  if (build.platform !== 'web' || build.ref !== 'refs/heads/main'
    || build.commit !== input.commit || build.repository !== input.repository
    || String(build.repositoryId) !== input.repositoryId || String(build.runId) !== input.runId) {
    throw new Error('Smoke test artifact provenance mismatch');
  }
  const origin = 'https://' + input.project + '.web.app';
  const checks = smokePlan(input.artifact, origin);
  return { origin, checks };
}

export async function verifyHosting(input, { request = fetch, pause = setTimeout } = {}) {
  const { origin, checks } = hostingChecks(input);
  for (const check of checks) {
    let passed = false;
    let failure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const url = new URL(check.path, origin);
        url.searchParams.set('sabeel_smoke', input.runId + '-' + Date.now() + '-' + attempt);
        const response = await request(url, {
          method: 'GET', redirect: 'error', credentials: 'omit',
          headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (digest(bytes) !== check.hash) throw new Error('Published content does not match the selected artifact');
        passed = true;
        break;
      } catch (error) {
        failure = error;
        if (attempt < 2) await pause(5000);
      }
    }
    if (!passed) throw new Error('Read-only Hosting check failed for ' + check.path + ': ' + failure.message);
    console.log('Verified GET ' + check.path);
  }
  console.log('Read-only Hosting verification passed; no backend data was accessed or changed');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const input = {
    artifact: join(process.env.RUNNER_TEMP, 'hosting-artifact'),
    project: process.env.FIREBASE_PROJECT_ID,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    runId: process.env.BUILD_RUN_ID,
  };
  if (process.argv[2] === '--preflight') {
    hostingChecks(input);
    console.log('Hosting smoke-check plan validated without network access');
  } else {
    await verifyHosting(input);
  }
}
