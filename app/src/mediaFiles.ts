import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import type { PickedFile } from './mediaFileTypes';

/**
 * Native side of the media-file seam (web sibling: mediaFiles.web.ts).
 *
 * NOTHING HERE HOLDS A WHOLE FILE. A class video is gigabytes, and reading it
 * into a Blob (`fetch(uri).blob()`) is how the first phone upload of one would
 * have ended. The picker hands back the file where it is — not copied to the
 * cache, which would double it on the phone — and each part is read at its
 * offset through expo-file-system's FileHandle, then sent with `expo/fetch`,
 * which takes a Uint8Array body natively.
 */
export async function pickMediaFiles(): Promise<PickedFile[] | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['audio/*', 'video/mp4'],
    copyToCacheDirectory: false,
    multiple: true,
  });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets.map((a) => ({ name: a.name, sizeBytes: a.size ?? new File(a.uri).size ?? 0, source: a.uri }));
}

export function readPart(file: PickedFile, start: number, end: number): Promise<Uint8Array> {
  const handle = new File(file.source as string).open();
  try {
    handle.offset = start;
    return Promise.resolve(handle.readBytes(end - start));
  } finally {
    handle.close();
  }
}

/** PUT one part; resolves with the ETag the bucket gave it. */
export async function sendPart(url: string, body: Blob | Uint8Array, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('The storage service gave no ETag.');
  return etag;
}
