#!/usr/bin/env node
/**
 * Does the media store behave the way the app depends on?
 *
 *     node scripts/s3-conformance.mjs local   # SeaweedFS, started and stopped here
 *     node scripts/s3-conformance.mjs r2      # the production R2 bucket
 *
 * The app's media promises rest on a handful of S3 behaviours: signatures and
 * expiry are enforced, a signed PUT creates its object once and only with the
 * signed content type, `Range` works through a signed GET, multipart part
 * ETags are readable, CORS admits the app's origin and nobody else's, and the
 * read key cannot write. The local suites assume SeaweedFS behaves like R2;
 * this checks that assumption against both, with the same code, so a
 * difference shows up here rather than in production.
 *
 * Against R2 it writes and deletes a few small objects under `conformance/`
 * (one of them just over 5 MiB, the smallest multipart part) with the real
 * keys, read from Secret Manager into this process and never printed. Exit
 * status is the number of failed checks.
 */
import { createRequire } from 'node:module';
import { localMediaConfig, startMediaStore } from './lib/media-store.mjs';
import { r2Config, s3For } from './lib/r2.mjs';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const target = process.argv[2];
if (target !== 'local' && target !== 'r2') {
  console.error('usage: s3-conformance.mjs local|r2');
  process.exit(2);
}

let store;
let cfg;
let origin;
if (target === 'local') {
  store = await startMediaStore();
  cfg = localMediaConfig();
  origin = 'http://127.0.0.1:61311';
} else {
  cfg = r2Config();
  origin = 'https://oursabeel-lms.web.app';
}
const B = cfg.bucket;
const read = s3For(cfg.endpoint, cfg.read);
const write = s3For(cfg.endpoint, cfg.write);
const wrongSecret = s3For(cfg.endpoint, { ...cfg.write, secretAccessKey: `${cfg.write.secretAccessKey}x` });
const run = `conformance/${Date.now()}`;
const keys = [];
const key = (name) => {
  const k = `${run}/${name}`;
  keys.push(k);
  return k;
};

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const refused = async (p) => {
  try {
    await p;
    return 'allowed';
  } catch (e) {
    return e.$metadata?.httpStatusCode ?? e.name;
  }
};

console.log(`S3 conformance against ${target} (${cfg.endpoint}, bucket ${B})\n`);

try {
  // 1. Who may do what.
  const seeded = key('seeded.m4a');
  await write.send(new PutObjectCommand({ Bucket: B, Key: seeded, Body: Buffer.alloc(1000, 7), ContentType: 'audio/mp4' }));
  const anon = await fetch(`${cfg.endpoint}/${B}/${seeded}`);
  check('an unsigned GET is refused', anon.status === 403 || anon.status === 400 || anon.status === 401, anon.status);
  const wrong = await refused(wrongSecret.send(new HeadObjectCommand({ Bucket: B, Key: seeded })));
  check('a wrong secret is refused', wrong !== 'allowed', wrong);
  const readGets = await refused(read.send(new HeadObjectCommand({ Bucket: B, Key: seeded })));
  check('the read key reads', readGets === 'allowed', readGets);
  const readPuts = await refused(read.send(new PutObjectCommand({ Bucket: B, Key: key('by-read-key'), Body: 'x' })));
  check('the read key cannot write', readPuts !== 'allowed', readPuts);
  const readDeletes = await refused(read.send(new DeleteObjectCommand({ Bucket: B, Key: seeded })));
  const stillThere = await refused(write.send(new HeadObjectCommand({ Bucket: B, Key: seeded })));
  check('the read key cannot delete', stillThere === 'allowed', `delete: ${readDeletes}`);

  // 2. The upload URL: write-once, type signed.
  const up = key('upload.m4a');
  const putUrl = await getSignedUrl(
    write,
    new PutObjectCommand({ Bucket: B, Key: up, ContentType: 'audio/mp4', IfNoneMatch: '*' }),
    { expiresIn: 600, signableHeaders: new Set(['content-type', 'if-none-match']) },
  );
  const body = Buffer.alloc(300_000, 3);
  const headers = { 'Content-Type': 'audio/mp4', 'If-None-Match': '*' };
  let r = await fetch(putUrl, { method: 'PUT', headers, body });
  check('a signed PUT creates the object', r.status === 200, r.status);
  r = await fetch(putUrl, { method: 'PUT', headers, body: Buffer.alloc(10) });
  check('a second PUT on it is refused (write-once)', r.status === 412, r.status);
  r = await fetch(putUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'video/mp4' }, body });
  check('a PUT with another content type is refused', r.status === 403, r.status);
  r = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/mp4' }, body });
  check('a PUT that drops If-None-Match is refused', r.status === 403, r.status);
  const landed = await write.send(new HeadObjectCommand({ Bucket: B, Key: up }));
  check('what landed is the first PUT', landed.ContentLength === body.length && landed.ContentType === 'audio/mp4');

  // 3. The playback URL: Range, scope, expiry.
  const getUrl = await getSignedUrl(read, new GetObjectCommand({ Bucket: B, Key: up }), { expiresIn: 2 });
  r = await fetch(getUrl, { headers: { Range: 'bytes=100-199' } });
  const part = Buffer.from(await r.arrayBuffer());
  check('a signed GET serves a byte range', r.status === 206 && part.length === 100 && part.every((b) => b === 3), r.status);
  r = await fetch(getUrl.replace('upload.m4a', 'seeded.m4a'));
  check('the URL opens only its own object', r.status === 403, r.status);
  await new Promise((ok) => setTimeout(ok, 3500));
  r = await fetch(getUrl, { headers: { Range: 'bytes=0-9' } });
  check('the URL stops working when it expires', r.status === 403, r.status);

  // 4. Multipart with signed part URLs, as large staff uploads will use.
  const mp = key('multipart.mp4');
  const { UploadId } = await write.send(new CreateMultipartUploadCommand({ Bucket: B, Key: mp, ContentType: 'video/mp4' }));
  const first = Buffer.alloc(5 * 1024 * 1024, 1);
  const parts = [];
  for (const [n, chunk] of [[1, first], [2, Buffer.alloc(1000, 2)]]) {
    const u = await getSignedUrl(write, new UploadPartCommand({ Bucket: B, Key: mp, UploadId, PartNumber: n }), { expiresIn: 600 });
    const pr = await fetch(u, { method: 'PUT', body: chunk, headers: { Origin: origin } });
    parts.push({ PartNumber: n, ETag: pr.headers.get('etag') });
  }
  check('each part URL returns a readable ETag', parts.every((p) => p.ETag), parts.map((p) => p.ETag).join(' '));
  await write.send(new CompleteMultipartUploadCommand({ Bucket: B, Key: mp, UploadId, MultipartUpload: { Parts: parts } }));
  const whole = await write.send(new HeadObjectCommand({ Bucket: B, Key: mp }));
  check('the completed object has the right size and type', whole.ContentLength === first.length + 1000 && whole.ContentType === 'video/mp4');

  // 5. CORS: the app's origin may upload from a browser; others may not.
  r = await fetch(putUrl, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,if-none-match' },
  });
  const allow = r.headers.get('access-control-allow-origin') ?? '';
  check(`a browser upload from ${origin} is allowed`, r.ok && (allow === origin || allow === '*'), `${r.status} allow-origin=${allow}`);
  r = await fetch(putUrl, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' },
  });
  const other = r.headers.get('access-control-allow-origin') ?? '';
  check('a browser upload from any other origin is not', other !== 'https://evil.example' && other !== '*', `${r.status} allow-origin=${other || '(none)'}`);
} finally {
  for (const k of keys) await write.send(new DeleteObjectCommand({ Bucket: B, Key: k })).catch(() => undefined);
  await store?.stop();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed);
