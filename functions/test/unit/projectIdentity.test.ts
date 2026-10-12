import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_NAME, APP_SHORT_NAME, FIREBASE_PROJECT_ID } from '@sabeel/shared';

/**
 * Nothing in this checkout can reach the retired personal project, and the
 * files that must restate the institute's project say the same thing.
 *
 * This repo began as a full-history copy of an app that still runs, live, on a
 * personal Firebase project until switchover day. A single stale id in a script
 * default, a `.firebaserc` or a client config sends a deploy, a migration or a
 * real student's sign-in to the LIVE app — and every one of those succeeds
 * quietly. The CLI's per-directory account pin is the backstop; this is the
 * first line.
 *
 * Prose may name the legacy project — the switchover plan has to — so Markdown
 * and `docs/` are skipped. Every other tracked file is code or config.
 */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The legacy project's id, its project number (sender id, OAuth client
 *  prefix) and the old Android package. */
const LEGACY = ['sabeel-class-recordings', '977423479850', 'com.sabeelinstitute.classrecordings'];

function trackedCodeAndConfig(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && !p.startsWith('docs/') && !p.endsWith('.md'));
}

describe('the retired project', () => {
  it('is named by no code or config in this checkout', () => {
    const offenders: string[] = [];
    for (const path of trackedCodeAndConfig()) {
      const buf = readFileSync(resolve(ROOT, path));
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      for (const id of LEGACY) if (text.includes(id)) offenders.push(`${path}: ${id}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the files that cannot import the project id agree with it', () => {
  it('.firebaserc deploys to it by default', () => {
    expect(JSON.parse(read('.firebaserc')).projects).toEqual({ default: FIREBASE_PROJECT_ID });
  });
});

/**
 * The Android identity lives in four places Expo and Gradle each read one of.
 * `android/` is committed rather than prebuilt, so `app.json` does not feed
 * Gradle: a package changed in one and not the other builds an APK whose id
 * matches no Firebase registration, and Google sign-in fails with the opaque
 * DEVELOPER_ERROR.
 */
describe('the Android identity', () => {
  const expo = JSON.parse(read('app/app.json')).expo as {
    name: string;
    android: { package: string };
  };
  const pkg = expo.android.package;
  const gradle = read('app/android/app/build.gradle');

  it('is one package id in app.json, Gradle and the Kotlin sources', () => {
    expect(pkg).toBe('com.sabeelinstitute.lms');
    expect(/applicationId '([^']+)'/.exec(gradle)?.[1]).toBe(pkg);
    expect(/namespace '([^']+)'/.exec(gradle)?.[1]).toBe(pkg);
    const dir = `app/android/app/src/main/java/${pkg.replace(/\./g, '/')}`;
    for (const file of ['MainActivity.kt', 'MainApplication.kt']) {
      expect(read(`${dir}/${file}`)).toMatch(new RegExp(`^package ${pkg.replace(/\./g, '\\.')}$`, 'm'));
    }
  });

  it('carries the app’s names', () => {
    expect(expo.name).toBe(APP_NAME);
    const label = /<string name="app_name">([^<]+)<\/string>/.exec(
      read('app/android/app/src/main/res/values/strings.xml'),
    )?.[1];
    expect(label).toBe(APP_SHORT_NAME);
  });
});
