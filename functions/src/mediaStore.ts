import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { defineSecret, defineString } from 'firebase-functions/params';
import { isEmulatorProject } from './env';

/**
 * The one place class media is stored, signed and deleted.
 *
 * Media lives in a private S3-compatible bucket: Cloudflare R2 in production,
 * SeaweedFS on this machine under the emulator suite
 * (`scripts/lib/media-store.mjs`). Both run THIS code — the same SigV4 signing,
 * the same requests — so a signed URL that would 403 in production 403s in a
 * local test too. Only the endpoint and the keys differ, and both come from the
 * project's own configuration (`functions/.env.<projectId>`), never from a
 * fallback.
 *
 * Nothing here moves media bytes through a Function. Playback and uploads are
 * pre-signed URLs the client uses directly, and Zoom imports are copied by the
 * Cloudflare Worker (`mediaCopier.ts`), so the 60-minute function timeout never
 * meets a two-hour recording and no byte is billed as Google egress.
 *
 * TWO KEYS, scoped to the bucket: a read key that can only sign playback, and a
 * read-write key for uploads and deletes. Each is a secret bound only to the
 * functions that need it, so a function that only plays audio cannot be made to
 * delete it.
 */

const MEDIA_S3_ENDPOINT = defineString('MEDIA_S3_ENDPOINT', {
  description: 'S3 endpoint of the media bucket (R2: https://<account>.r2.cloudflarestorage.com)',
});
const MEDIA_BUCKET = defineString('MEDIA_BUCKET', { description: 'Name of the media bucket' });

const R2_READ_KEY_ID = defineSecret('R2_READ_KEY_ID');
const R2_READ_SECRET = defineSecret('R2_READ_SECRET');
const R2_WRITE_KEY_ID = defineSecret('R2_WRITE_KEY_ID');
const R2_WRITE_SECRET = defineSecret('R2_WRITE_SECRET');

/** Bind to every function that signs playback. */
export const MEDIA_READ_SECRETS = [R2_READ_KEY_ID, R2_READ_SECRET];
/** Bind to every function that uploads, deletes or inspects media. */
export const MEDIA_WRITE_SECRETS = [R2_WRITE_KEY_ID, R2_WRITE_SECRET];

type Access = 'read' | 'write';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Media store is not configured: ${name} is empty.`);
  return value;
}

/**
 * Under the emulator the keys are the throwaway ones the local SeaweedFS was
 * started with, from the same `.env` file as the endpoint. Keyed off the
 * running PROJECT, like every other emulator branch here, so a real project
 * can never take it.
 */
function credentials(access: Access) {
  if (isEmulatorProject()) {
    const prefix = access === 'read' ? 'LOCAL_MEDIA_READ' : 'LOCAL_MEDIA_WRITE';
    return {
      accessKeyId: required(`${prefix}_KEY_ID`, process.env[`${prefix}_KEY_ID`]),
      secretAccessKey: required(`${prefix}_SECRET`, process.env[`${prefix}_SECRET`]),
    };
  }
  const [id, secret] = access === 'read' ? MEDIA_READ_SECRETS : MEDIA_WRITE_SECRETS;
  return {
    accessKeyId: required(id.name, id.value()),
    secretAccessKey: required(secret.name, secret.value()),
  };
}

const clients = new Map<Access, S3Client>();

function client(access: Access): S3Client {
  let c = clients.get(access);
  if (!c) {
    c = new S3Client({
      endpoint: required('MEDIA_S3_ENDPOINT', MEDIA_S3_ENDPOINT.value()),
      // R2 has one region, "auto"; SeaweedFS accepts anything.
      region: 'auto',
      // SeaweedFS serves buckets by path only; R2 serves both.
      forcePathStyle: true,
      credentials: credentials(access),
      // The SDK otherwise adds CRC checksum parameters to every request,
      // including pre-signed ones, which R2 documents as unsupported for
      // pre-signed URLs. Send them only where an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    clients.set(access, c);
  }
  return c;
}

const bucket = () => required('MEDIA_BUCKET', MEDIA_BUCKET.value());

export interface SignedUrl {
  url: string;
  expiresAt: number;
}

/**
 * A URL that reads one object until `expiresAt`, and nothing else.
 *
 * Pre-signed URLs are bearer tokens and cannot be revoked one at a time:
 * rolling the read key is the only way to kill outstanding ones
 * (docs/SECRETS.md). A failure to sign throws; there is no unsigned fallback.
 */
export async function signGet(key: string, ttlMs: number): Promise<SignedUrl> {
  const expiresAt = Date.now() + ttlMs;
  const url = await getSignedUrl(client('read'), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: Math.floor(ttlMs / 1000),
  });
  return { url, expiresAt };
}

export interface SignedPut extends SignedUrl {
  /** Headers the PUT must carry exactly, or the signature does not match. */
  headers: Record<string, string>;
}

/**
 * A URL that creates one object, once, with one content type.
 *
 * WRITE-ONCE: `If-None-Match: *` is part of the signature, so the PUT fails
 * with 412 when the object already exists and with 403 if the header is
 * dropped. A published recording's file can therefore never be swapped
 * underneath students who have listened to it; replacing a bad file goes
 * through `removeRecordingMedia`, which only works on a draft. The content type
 * is signed too. Size cannot be signed reliably on R2, so the caller checks it
 * with `head` afterwards and deletes what is too large.
 */
export async function signPut(key: string, contentType: string, ttlMs: number): Promise<SignedPut> {
  const expiresAt = Date.now() + ttlMs;
  const url = await getSignedUrl(
    client('write'),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, IfNoneMatch: '*' }),
    { expiresIn: Math.floor(ttlMs / 1000), signableHeaders: new Set(['content-type', 'if-none-match']) },
  );
  return { url, expiresAt, headers: { 'Content-Type': contentType, 'If-None-Match': '*' } };
}

/** Size and type of an object, or null if there is none. */
export async function head(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
  try {
    const res = await client('write').send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType ?? '' };
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Delete an object. Deleting one that does not exist is not an error. */
export async function deleteObject(key: string): Promise<void> {
  await client('write').send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
