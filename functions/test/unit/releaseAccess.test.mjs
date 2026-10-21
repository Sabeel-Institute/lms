import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * WHO CAN SIGN, AND WHO CAN RELEASE.
 *
 * Repository secrets reach any workflow on any branch, and two collaborators
 * can push branches, so the signing keys, the App Store Connect key and the
 * build configuration live in the `release-build` environment, which only main
 * and the owner's `v*` tags may enter. Every job that reads one must name that
 * environment, or it reads nothing and a refactor that moves a secret back to
 * the repository goes unnoticed. And every workflow that publishes checks,
 * first, that the owner started it.
 */
const root = new URL('../../../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(root).filter((f) => f.endsWith('.yml')).map((f) => [f, readFileSync(new URL(f, root), 'utf8')]));

const SIGNING = ['APP_ENV_LOCAL', 'ANDROID_KEYSTORE', 'ANDROID_KEYSTORE_PROPERTIES', 'ANDROID_GOOGLE_SERVICES_JSON',
  'IOS_BUILD_ENV', 'IOS_DIST_P12', 'IOS_DIST_P12_PASSWORD', 'IOS_PROFILE', 'ASC_KEY_P8', 'GOOGLE_SERVICE_INFO_PLIST'];
const RELEASES = { 'web-deploy.yml': 'deploy', 'android-publish.yml': 'publish', 'functions-deploy.yml': 'deploy', 'ios.yml': 'testflight' };

/** A workflow's jobs, by name, each the text from its key to the next job's. */
function jobs(text) {
  const start = text.indexOf('\njobs:\n');
  const keys = [...text.slice(start).matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)];
  return Object.fromEntries(keys.map((m, i) =>
    [m[1], text.slice(start + m.index, keys[i + 1] ? start + keys[i + 1].index : text.length)]));
}

describe('release access', () => {
  it('reads signing secrets only in jobs that enter release-build', () => {
    const outside = [];
    for (const [file, text] of Object.entries(workflows)) {
      const header = text.slice(0, text.indexOf('\njobs:\n'));
      for (const name of SIGNING) if (header.includes(`secrets.${name}`)) outside.push(`${file}: workflow-level ${name}`);
      for (const [job, body] of Object.entries(jobs(text))) {
        const uses = SIGNING.filter((name) => new RegExp(`secrets\\.${name}\\b`).test(body));
        if (uses.length && !/^ {4}environment: release-build$/m.test(body)) outside.push(`${file}/${job}: ${uses.join(', ')}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('starts every release by checking the owner started it', () => {
    for (const [file, job] of Object.entries(RELEASES)) {
      const body = jobs(workflows[file])[job];
      expect(body, `${file}/${job}`).toMatch(/ {4}steps:\n {6}- name: Only the owner releases\n/);
      expect(body).toContain('OWNER_ID: ${{ vars.RELEASE_OWNER_ID }}');
      expect(body).toContain('TRIGGERING_ACTOR: ${{ github.triggering_actor }}');
    }
  });
});
