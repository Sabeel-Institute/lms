import { UPLOAD_PART_BYTES, type UploadContentType, type UploadPlacement } from '@sabeel/shared';
import { finalizeUpload, signParts, startUpload } from '../../src/uploads';

/**
 * Upload a file the way the app does: start, sign each part, PUT each part
 * straight to the bucket, then finalize. `finalize: false` stops after the
 * parts, which is what a closed tab leaves behind.
 */
export async function uploadFile(
  uid: string,
  recordingId: string,
  bytes: Uint8Array,
  contentType: UploadContentType,
  { placement = { as: 'part' } as UploadPlacement, finalize = true } = {},
) {
  const { itemId, partCount } = await startUpload(uid, { recordingId, contentType, sizeBytes: bytes.length, placement });
  const parts = await sendParts(recordingId, itemId, bytes, partCount);
  if (finalize) await finalizeUpload({ recordingId, itemId, parts });
  return { itemId, parts };
}

/** PUT each part of `bytes`, returning the part numbers and ETags finalize needs. */
async function sendParts(recordingId: string, itemId: string, bytes: Uint8Array, partCount: number) {
  const parts: { partNumber: number; etag: string }[] = [];
  for (let n = 1; n <= partCount; n++) {
    const { urls } = await signParts({ recordingId, itemId, partNumbers: [n] });
    const body = bytes.slice((n - 1) * UPLOAD_PART_BYTES, n * UPLOAD_PART_BYTES);
    const res = await fetch(urls[n], { method: 'PUT', body });
    if (!res.ok) throw new Error(`part ${n}: HTTP ${res.status}`);
    parts.push({ partNumber: n, etag: res.headers.get('etag') ?? '' });
  }
  return parts;
}
