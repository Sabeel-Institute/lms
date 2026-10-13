import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Direct access to the local media store (SeaweedFS), for arranging and
 * inspecting what the code under test reads and writes.
 *
 * With the WRITE key the functions use, from the demo project's `.env` that
 * `test/setup.ts` loads, so a test cannot see a bucket the code does not.
 */
const s3 = new S3Client({
  endpoint: process.env.MEDIA_S3_ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.LOCAL_MEDIA_WRITE_KEY_ID ?? '',
    secretAccessKey: process.env.LOCAL_MEDIA_WRITE_SECRET ?? '',
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const Bucket = process.env.MEDIA_BUCKET ?? '';

export async function putObject(key: string, body: Uint8Array, contentType = 'audio/mp4') {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}

/** Size and last-modified time, or null when there is no object. */
export async function objectInfo(key: string): Promise<{ size: number; modified: number } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { size: r.ContentLength ?? 0, modified: r.LastModified?.getTime() ?? 0 };
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function objectExists(key: string): Promise<boolean> {
  return (await objectInfo(key)) !== null;
}

/** Remove every object under a prefix. */
export async function clearPrefix(prefix: string) {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
  const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key as string }));
  if (keys.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
}

/** Whether a multipart upload is still open, holding parts that cost storage. */
export async function uploadIsOpen(key: string, uploadId: string): Promise<boolean> {
  try {
    await s3.send(new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId }));
    return true;
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}
