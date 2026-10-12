/**
 * The local media store: SeaweedFS standing in for Cloudflare R2.
 *
 * Every suite that runs the functions emulator also needs somewhere to put
 * media, and the app signs URLs for it with the same code production uses
 * (`functions/src/mediaStore.ts`). SeaweedFS checks SigV4 signatures, expiry,
 * `If-None-Match` and `Range` the way R2 does, which is why it was chosen over
 * a test double (docs/plans/MEDIA-ON-CLOUDFLARE.md, "Why SeaweedFS").
 * `scripts/s3-conformance.mjs` runs the same checks against both.
 *
 * `weed server`, not `weed mini`: mini also starts an admin server and a plugin
 * worker, which bind ports outside this checkout's block (one on every
 * interface) and cannot be switched off. Every port here is pinned, from
 * `ports.mjs`, and bound to 127.0.0.1 only.
 *
 * The bucket, endpoint and keys come from `functions/.env.demo-sabeel-recordings`,
 * the file the functions emulator reads, so the server and the code talking to
 * it cannot disagree. Each run gets a fresh data directory; nothing persists.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MEDIA_STORE_PORTS as P } from './ports.mjs';
import { EMULATOR_PROJECT_ID } from './project.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { S3Client, CreateBucketCommand, PutBucketCorsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

/** The pinned release (docs/DEV-TOOLING.md); `WEED_BIN` overrides, CI sets it. */
const WEED_BIN = process.env.WEED_BIN ?? join(homedir(), 'opt', 'seaweedfs-4.47', 'weed');

/**
 * Browser origins that may upload to the local store: the dev servers. The
 * methods and headers come from the production bucket's own CORS file, so a
 * header the app needs and R2 does not allow fails here too.
 */
const DEV_ORIGINS = [
  'http://127.0.0.1:61310',
  'http://127.0.0.1:61311',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
];

/** The demo project's function parameters, as `KEY=value` lines. */
export function localMediaConfig() {
  const file = new URL(`../../functions/.env.${EMULATOR_PROJECT_ID}`, import.meta.url);
  const env = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const need = (k) => {
    if (!env[k]) throw new Error(`${k} is missing from functions/.env.${EMULATOR_PROJECT_ID}`);
    return env[k];
  };
  const endpoint = need('MEDIA_S3_ENDPOINT');
  if (endpoint !== `http://127.0.0.1:${P.s3}`) {
    throw new Error(`MEDIA_S3_ENDPOINT is ${endpoint}, but the local store listens on 127.0.0.1:${P.s3}`);
  }
  return {
    endpoint,
    bucket: need('MEDIA_BUCKET'),
    read: { accessKeyId: need('LOCAL_MEDIA_READ_KEY_ID'), secretAccessKey: need('LOCAL_MEDIA_READ_SECRET') },
    write: { accessKeyId: need('LOCAL_MEDIA_WRITE_KEY_ID'), secretAccessKey: need('LOCAL_MEDIA_WRITE_SECRET') },
  };
}

/** An S3 client for the local store with the read or the write key. */
function localS3(access = 'write') {
  const cfg = localMediaConfig();
  return new S3Client({
    endpoint: cfg.endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials: cfg[access],
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Put one object into the running local store, as the seed scripts need. */
export async function putLocalObject(key, body, contentType) {
  const { bucket } = localMediaConfig();
  await localS3('write').send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function waitForPort(url, child, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`SeaweedFS exited early (code ${child.exitCode})`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`SeaweedFS did not answer on ${url} within ${ms} ms`);
}

/**
 * Start SeaweedFS with the bucket created and CORS set. Resolves to `stop()`.
 *
 * Three identities: an admin used only here to create the bucket, and the read
 * and write keys the functions use, with the same split as the two R2 tokens
 * (read signs playback; write uploads and deletes).
 */
export async function startMediaStore({ log = process.stderr } = {}) {
  if (!existsSync(WEED_BIN)) {
    throw new Error(`SeaweedFS not found at ${WEED_BIN}. Install it (docs/DEV-TOOLING.md) or set WEED_BIN.`);
  }
  const cfg = localMediaConfig();
  const dir = mkdtempSync(join(tmpdir(), 'sabeel-lms-media-'));
  mkdirSync(join(dir, 'data'));
  const admin = { accessKeyId: 'local-media-admin', secretAccessKey: 'local-media-admin-secret-0000' };
  writeFileSync(
    join(dir, 'identities.json'),
    JSON.stringify({
      identities: [
        { name: 'admin', credentials: [{ accessKey: admin.accessKeyId, secretKey: admin.secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] },
        { name: 'read', credentials: [{ accessKey: cfg.read.accessKeyId, secretKey: cfg.read.secretAccessKey }], actions: [`Read:${cfg.bucket}`] },
        { name: 'write', credentials: [{ accessKey: cfg.write.accessKeyId, secretKey: cfg.write.secretAccessKey }], actions: [`Read:${cfg.bucket}`, `Write:${cfg.bucket}`, `List:${cfg.bucket}`] },
      ],
    }),
  );
  const child = spawn(
    WEED_BIN,
    [
      'server',
      `-dir=${join(dir, 'data')}`,
      '-ip=127.0.0.1',
      '-ip.bind=127.0.0.1',
      `-master.port=${P.master}`,
      `-master.port.grpc=${P.masterGrpc}`,
      `-volume.port=${P.volume}`,
      `-volume.port.grpc=${P.volumeGrpc}`,
      '-filer',
      `-filer.port=${P.filer}`,
      `-filer.port.grpc=${P.filerGrpc}`,
      '-s3',
      `-s3.port=${P.s3}`,
      `-s3.port.grpc=${P.s3Grpc}`,
      '-s3.port.iceberg=0',
      '-s3.port.lance=0',
      `-s3.config=${join(dir, 'identities.json')}`,
      '-master.volumeSizeLimitMB=64',
      '-volume.max=16',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  writeFileSync(join(dir, 'weed.log'), '');
  child.stderr.on('data', (b) => writeFileSync(join(dir, 'weed.log'), b, { flag: 'a' }));

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitForPort(cfg.endpoint, child, 30_000);
    const s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: admin,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    // The filer needs a moment after the port opens before it takes writes.
    for (let i = 0; ; i++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
        break;
      } catch (e) {
        if (i >= 50) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const cors = JSON.parse(readFileSync(new URL('../../cloudflare/media-bucket/cors.json', import.meta.url), 'utf8'));
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: cfg.bucket,
        CORSConfiguration: {
          CORSRules: cors.rules.map((r) => ({
            AllowedOrigins: DEV_ORIGINS,
            AllowedMethods: r.allowed.methods,
            AllowedHeaders: r.allowed.headers,
            ExposeHeaders: r.exposeHeaders,
            MaxAgeSeconds: r.maxAgeSeconds,
          })),
        },
      }),
    );
  } catch (e) {
    log.write(`media store failed to start; log follows\n${readFileSync(join(dir, 'weed.log'), 'utf8').slice(-3000)}\n`);
    await stop();
    throw e;
  }
  log.write(`media store: SeaweedFS on ${cfg.endpoint}, bucket ${cfg.bucket}\n`);
  return { stop, config: cfg };
}
