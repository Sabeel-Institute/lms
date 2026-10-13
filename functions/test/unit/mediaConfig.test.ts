import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIREBASE_PROJECT_ID, mediaStorageKey } from '@sabeel/shared';

/**
 * The Zoom copier Worker and the Functions that call it describe the same
 * bucket, address and caller in two files that cannot import each other:
 * `cloudflare/media-copier/wrangler.jsonc` and `functions/.env.<projectId>`.
 *
 * A mismatch fails only in production, and quietly: a wrong audience or caller
 * makes the Worker refuse every copy with 403, and a wrong bucket makes it copy
 * into a bucket playback never signs for. So the two are held together here.
 */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function envFile(projectId: string): Record<string, string> {
  return Object.fromEntries(
    read(`functions/.env.${projectId}`)
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

/** wrangler.jsonc with its line comments removed. */
function wrangler(): {
  r2_buckets: { binding: string; bucket_name: string }[];
  vars: { ALLOWED_CALLER: string; AUDIENCE: string };
} {
  const text = read('cloudflare/media-copier/wrangler.jsonc')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(text);
}

describe('the copier Worker and the Functions agree', () => {
  const env = envFile(FIREBASE_PROJECT_ID);
  const w = wrangler();

  it('on the bucket, which is also the one the bucket settings are applied to', () => {
    expect(w.r2_buckets).toEqual([{ binding: 'BUCKET', bucket_name: env.MEDIA_BUCKET }]);
    const script = JSON.parse(read('cloudflare/media-copier/package.json')).scripts['bucket-config'] as string;
    const targets = [...script.matchAll(/r2 bucket \w+ set (\S+)/g)].map((m) => m[1]);
    expect(targets).toEqual([env.MEDIA_BUCKET, env.MEDIA_BUCKET]);
  });

  it('on where uploads may come from: the web app this project serves', () => {
    const cors = JSON.parse(read('cloudflare/media-bucket/cors.json')) as {
      rules: { allowed: { origins: string[] } }[];
    };
    expect(cors.rules.flatMap((r) => r.allowed.origins).sort()).toEqual(
      [`https://${FIREBASE_PROJECT_ID}.firebaseapp.com`, `https://${FIREBASE_PROJECT_ID}.web.app`].sort(),
    );
  });

  it('on the Worker’s address, which is the token audience', () => {
    expect(env.MEDIA_COPIER_URL).toMatch(/^https:\/\//);
    expect(w.vars.AUDIENCE).toBe(env.MEDIA_COPIER_URL);
  });

  it('on the caller: this project’s Functions runtime service account', () => {
    // Gen-2 functions run as the Compute Engine default service account,
    // `<project number>-compute@…`. The number is the messaging sender id.
    const number = /messagingSenderId:\s*'(\d+)'/.exec(read('app/src/firebase-config.ts'))?.[1];
    expect(number).toBeTruthy();
    expect(w.vars.ALLOWED_CALLER).toBe(`${number}-compute@developer.gserviceaccount.com`);
  });

  it('on where a copy may be written: the key a media item is stored under', () => {
    // The Worker refuses any other key, so a key layout changed in one place
    // and not the other fails every Zoom import, and only in production.
    const source = read('cloudflare/media-copier/src/index.ts');
    const literal = /const KEY_PATTERN = \/(.+)\/;/.exec(source)?.[1];
    expect(literal).toBeTruthy();
    const pattern = new RegExp(literal as string);
    // Firestore auto-ids, which is what both ids are.
    expect(pattern.test(mediaStorageKey('AbC123xyz0AbC123xyz0', 'XyZ987abc0XyZ987abc0'))).toBe(true);
    expect(pattern.test(mediaStorageKey('AbC123xyz0AbC123xyz0', '..'))).toBe(false);
  });
});
