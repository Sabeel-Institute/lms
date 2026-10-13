import type { PickedFile } from './mediaFileTypes';

/**
 * Web side of the media-file seam (native sibling: mediaFiles.ts): choose
 * files, read a slice of one, and send a slice to a signed URL.
 *
 * A `File` is read lazily: `slice` makes a view, not a copy, so an 8 GB video
 * costs only the part being sent.
 */
export function pickMediaFiles(): Promise<PickedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,video/mp4,.m4a,.mp3,.wav,.mp4';
    // Resolving null on cancel rather than never settling: a promise that hangs
    // would leave the button spinning with no way back.
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      resolve(files.length ? files.map((f) => ({ name: f.name, sizeBytes: f.size, source: f })) : null);
    });
    input.click();
  });
}

export function readPart(file: PickedFile, start: number, end: number): Promise<Blob> {
  return Promise.resolve((file.source as File).slice(start, end));
}

/**
 * PUT one part, or a whole small file; resolves with the ETag the bucket gave
 * it. `headers` are the ones a signed URL was signed with, sent exactly.
 */
export async function sendPart(
  url: string,
  body: Blob | Uint8Array,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: body as BodyInit, signal, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('The storage service gave no ETag.');
  return etag;
}
