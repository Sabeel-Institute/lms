/**
 * The production media bucket (Cloudflare R2), for operator scripts.
 *
 * Endpoint and bucket come from `functions/.env.oursabeel-lms`, the file the
 * deployed Functions read; the keys come from Secret Manager, read with the
 * oursabeel.com account into this process only. Nothing here prints a key.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { S3Client } = require('@aws-sdk/client-s3');

const ACCOUNT = 'faisal.shah@oursabeel.com';

function secret(name) {
  return execFileSync(
    'gcloud',
    ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${FIREBASE_PROJECT_ID}`, `--account=${ACCOUNT}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** `{ endpoint, bucket, read, write }`, with read and write as S3 credentials. */
export function r2Config() {
  const env = Object.fromEntries(
    readFileSync(new URL(`../../functions/.env.${FIREBASE_PROJECT_ID}`, import.meta.url), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  return {
    endpoint: env.MEDIA_S3_ENDPOINT,
    bucket: env.MEDIA_BUCKET,
    read: { accessKeyId: secret('R2_READ_KEY_ID'), secretAccessKey: secret('R2_READ_SECRET') },
    write: { accessKeyId: secret('R2_WRITE_KEY_ID'), secretAccessKey: secret('R2_WRITE_SECRET') },
  };
}

export function s3For(endpoint, credentials) {
  return new S3Client({
    endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
