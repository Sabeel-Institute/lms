import type { UploadContentType, UploadPlacement } from '@sabeel/shared';

/**
 * Sending one file to a recording, platform-neutral: the callables and the
 * byte-moving are passed in, so the same loop runs on the web, on a phone and
 * under the unit tests.
 *
 *   start → sign parts a batch at a time → PUT up to PARALLEL at once,
 *   each retried → finalize, where the server joins and probes the file
 *
 * A part that fails is sent again on a freshly signed URL, so a dropped
 * connection in the middle of a 6 GB video costs one 16 MiB piece. Stopping —
 * the person cancels or leaves the page — removes the half-sent file, so it
 * does not sit on the session as "upload not finished".
 */

/** Parts in flight at once. Three keeps a phone's memory to ~48 MiB of parts. */
const PARALLEL = 3;
/** Parts signed per call; the server takes up to 16. */
const SIGN_BATCH = 12;
/** Tries per part before the file is given up. */
const PART_TRIES = 4;

export interface UploadApi {
  start(input: {
    recordingId: string;
    contentType: UploadContentType;
    sizeBytes: number;
    placement: UploadPlacement;
  }): Promise<{ itemId: string; partBytes: number; partCount: number }>;
  sign(input: { recordingId: string; itemId: string; partNumbers: number[] }): Promise<{ urls: Record<number, string> }>;
  finalize(input: {
    recordingId: string;
    itemId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<unknown>;
  /** Remove the item, which aborts the upload behind it. */
  cancel(input: { recordingId: string; itemId: string }): Promise<unknown>;
}

export interface PartIO<B> {
  read(start: number, end: number): Promise<B>;
  send(url: string, body: B, signal: AbortSignal): Promise<string>;
}

export type UploadStage = 'sending' | 'checking';

export class UploadCancelled extends Error {
  constructor() {
    super('The upload was cancelled.');
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadMedia<B>(opts: {
  recordingId: string;
  contentType: UploadContentType;
  sizeBytes: number;
  placement: UploadPlacement;
  api: UploadApi;
  io: PartIO<B>;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
  onStage: (stage: UploadStage) => void;
  /** Wait between tries of a part; the tests pass 0. */
  retryDelayMs?: number;
}): Promise<{ itemId: string }> {
  const { recordingId, api, io, signal } = opts;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const { itemId, partBytes, partCount } = await api.start({
    recordingId,
    contentType: opts.contentType,
    sizeBytes: opts.sizeBytes,
    placement: opts.placement,
  });
  try {
    opts.onStage('sending');
    // ONE SIGNING PER PART. The workers start together, and each asking for
    // its own batch signed the first parts three times over; a part already
    // being signed waits for that request instead. A retry asks afresh.
    const urls = new Map<number, Promise<string>>();
    const urlFor = (n: number, fresh: boolean): Promise<string> => {
      const known = urls.get(n);
      if (known && !fresh) return known;
      const batch = fresh
        ? [n]
        : Array.from({ length: SIGN_BATCH }, (_, i) => n + i).filter((k) => k <= partCount && !urls.has(k));
      const signed = api.sign({ recordingId, itemId, partNumbers: batch });
      for (const k of batch) {
        const url = signed.then((s) => s.urls[k]);
        // Handled where the part is sent; this only stops a batch that failed
        // before its later parts were reached from reporting as unhandled.
        url.catch(() => undefined);
        urls.set(k, url);
      }
      return urls.get(n) as Promise<string>;
    };

    const etags = new Map<number, string>();
    let sent = 0;
    let next = 1;
    const sendOne = async (n: number) => {
      const start = (n - 1) * partBytes;
      const end = Math.min(start + partBytes, opts.sizeBytes);
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw new UploadCancelled();
        try {
          const url = await urlFor(n, attempt > 1);
          etags.set(n, await io.send(url, await io.read(start, end), signal));
          sent += end - start;
          opts.onProgress(sent / opts.sizeBytes);
          return;
        } catch (e) {
          if (signal.aborted) throw new UploadCancelled();
          if (attempt >= PART_TRIES) throw e;
          await pause(retryDelayMs * 2 ** (attempt - 1));
        }
      }
    };
    const worker = async () => {
      while (next <= partCount) await sendOne(next++);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, partCount) }, worker));

    if (signal.aborted) throw new UploadCancelled();
    opts.onStage('checking');
    await api.finalize({
      recordingId,
      itemId,
      parts: [...etags].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })),
    });
    return { itemId };
  } catch (e) {
    // Whatever stopped it, the item goes: one the server refused at finalize
    // is already gone, so removing it again just finds nothing, and anything
    // else would otherwise wait a day for the sweep, blocking Publish.
    await api.cancel({ recordingId, itemId }).catch(() => undefined);
    throw e;
  }
}
