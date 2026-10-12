import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';

/**
 * The web push service worker carries its OWN copy of the Firebase config.
 *
 * It has to: a service worker has no bundler and cannot import
 * `firebase-config.ts`, so `app/public/firebase-messaging-sw.js` restates the
 * four messaging fields as literals. Two copies drift, and this one drifts
 * silently — a worker initialised against the wrong sender id or app id
 * registers, reports no error, and delivers nothing, and the only symptom is
 * a student who never hears about a recording. Hold the copy to the source.
 */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const config = readFileSync(resolve(ROOT, 'app', 'src', 'firebase-config.ts'), 'utf8');
const worker = readFileSync(resolve(ROOT, 'app', 'public', 'firebase-messaging-sw.js'), 'utf8');

/** The value of `key: "…"` / `key: '…'` in a source file. */
function field(src: string, key: string): string | undefined {
  return new RegExp(`\\b${key}:\\s*['"]([^'"]+)['"]`).exec(src)?.[1];
}

describe('the push service worker restates the app’s Firebase config', () => {
  it.each(['apiKey', 'messagingSenderId', 'appId'])('%s matches', (key) => {
    const expected = field(config, key);
    expect(expected, `${key} not found in firebase-config.ts`).toBeTruthy();
    expect(field(worker, key), `${key} in the service worker`).toBe(expected);
  });

  it('projectId matches the shared project id the app config is built from', () => {
    expect(config).toMatch(/\bprojectId:\s*FIREBASE_PROJECT_ID\b/);
    expect(field(worker, 'projectId')).toBe(FIREBASE_PROJECT_ID);
  });

  it('pins the same compat SDK major as the app bundles', () => {
    // A worker that fails to parse does not fall back to anything — push simply
    // stops — so the version is pinned. It should not fall behind the SDK the
    // page itself runs, whose major is in the app's package.json.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'app', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const appMajor = /\d+/.exec(pkg.dependencies.firebase)?.[0];
    const workerMajors = [...worker.matchAll(/firebasejs\/(\d+)\.\d+\.\d+\//g)].map((m) => m[1]);
    expect(workerMajors.length).toBe(2);
    for (const major of workerMajors) expect(major).toBe(appMajor);
  });
});

/**
 * The click on a banner the PAGE shows is handled in the worker, and the two
 * agree on one marker: the page puts `page: true` in the notification's data,
 * the worker acts only when it is there and leaves FCM's own banners to the
 * SDK. Rename either side and a foreground banner's click does nothing.
 */
describe('the click on a page-shown banner', () => {
  const page = readFileSync(resolve(ROOT, 'app', 'src', 'push.web.ts'), 'utf8');

  it('is marked by the page and recognised by the worker', () => {
    expect(page).toMatch(/showNotification\([\s\S]*?data:\s*\{\s*page:\s*true/);
    expect(worker).toMatch(/addEventListener\('notificationclick'/);
    expect(worker).toMatch(/if \(!data \|\| !data\.page\) return;/);
  });

  it('focuses an open window or opens the app', () => {
    expect(worker).toMatch(/clients\.matchAll\(\{ type: 'window'/);
    expect(worker).toMatch(/openWindow\(data\.link\)/);
  });
});
