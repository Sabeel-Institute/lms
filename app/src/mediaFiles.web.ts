import type { PickedFile } from './mediaFileTypes';
import { partSent } from './partSent';

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
  onSent?: (bytes: number) => void,
): Promise<string> {
  if (!onSent) return partSent(signal, () => fetch(url, { method: 'PUT', body: body as BodyInit, signal, headers }));
  return partSent(signal, () => put(url, body, signal, headers, onSent));
}

/*
 * A PUT THAT SAYS HOW FAR IT HAS GOT. fetch reports nothing until a part has
 * gone, so a long file's row sat at 0% for minutes on a phone's uplink, with
 * Stop as the only thing to press. XMLHttpRequest reports the bytes as they
 * leave.
 */
function put(
  url: string,
  body: Blob | Uint8Array,
  signal: AbortSignal,
  headers: Record<string, string>,
  onSent: (bytes: number) => void,
): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () =>
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, headers: { get: (n) => xhr.getResponseHeader(n) } });
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) return xhr.abort();
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}
