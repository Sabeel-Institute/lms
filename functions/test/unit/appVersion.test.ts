import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { versionCodeOf } from '@sabeel/shared';

/**
 * The update gate compares the number the phone build CARRIES with the floor.
 *
 * `app/app.json`'s version is the one version. build.gradle computes the APK's
 * versionCode from it, the iPhone build number is the same number, and
 * `scripts/set-min-version.mjs` writes the floor from a version, all three
 * through ci-tools' `lib/version.mjs`. The app's bundle cannot import ci-tools,
 * so it computes its own code with `versionCodeOf` (@sabeel/shared). If the
 * two ever computed differently, a build could believe itself newer than its
 * APK and pass a floor the APK does not, or be sent to an update screen for a
 * version it already is. This holds the bundle's arithmetic to ci-tools'.
 *
 * That build.gradle and app.json state no version of their own, and that the
 * iPhone build number is the code, is `npx sabeel-ci check-app`'s.
 *
 * Lives in `functions/test/unit` because that workspace runs the repo's tests
 * about files outside any one workspace.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const { versionCode } = (await import(
  resolve(REPO, 'node_modules/@sabeel-institute/ci-tools/lib/version.mjs')
)) as { versionCode: (version: string) => number };

describe('the versionCode the app believes it is', () => {
  it('is the one Gradle stamps for the version in app.json', () => {
    const version = JSON.parse(readFileSync(resolve(REPO, 'app/app.json'), 'utf8')).expo.version as string;
    expect(versionCodeOf(version)).toBe(versionCode(version));
  });

  it('is ci-tools’ code for every shape of version, the edges of each field included', () => {
    for (const version of ['0.0.1', '0.2.1', '0.2.2', '0.9.999', '0.10.0', '1.0.0', '12.345.678', '2100.0.0']) {
      expect(versionCodeOf(version), version).toBe(versionCode(version));
    }
  });

  it('rises with every release, so a newer build is never under an older floor', () => {
    const order = ['0.2.1', '0.2.2', '0.3.0', '1.0.0'];
    const codes = order.map(versionCodeOf);
    expect([...codes].sort((a, b) => a - b)).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
