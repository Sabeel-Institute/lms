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
 * connection in the middle of a 6 GB video costs one 16 MiB piece. A part
 * keeps trying for as long as the link has been down for less than
 * OUTAGE_MS: a router restarting or a laptop waking is a pause, not the end
 * of the file. Stopping — the person cancels or leaves the page — removes the
 * half-sent file, so it does not sit on the session as "upload not finished".
 *
 * A file is removed after a failed confirmation only when the server refused
 * the FILE. A confirmation that failed on its way (a timeout, the connection)
 * may have worked: it is asked again, and the server answers a repeat as it
 * answered the first, so a file that landed is never removed for it.
 */

/** Parts in flight at once. Three keeps a phone's memory to ~48 MiB of parts. */
const PARALLEL = 3;
/** Parts signed per call; the server takes up to 16. */
const SIGN_BATCH = 12;
/** Tries per part before the file can be given up. */
const PART_TRIES = 4;
/** How long nothing may arrive before the file is given up. */
const OUTAGE_MS = 3 * 60_000;
/** The longest wait between tries, in units of the first wait. */
const MAX_BACKOFF = 15;
/** Tries of the confirmation when it fails on its way. */
const CONFIRM_TRIES = 3;

/** The server refused the file itself: what it says is the answer, and asking again changes nothing. */
function refused(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? '').replace(/^functions\//, '');
  return ['failed-precondition', 'invalid-argument', 'not-found', 'permission-denied'].includes(code);
}

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
  /** `onSent` hears how many of the part's bytes have gone, where the platform says. */
  send(url: string, body: B, signal: AbortSignal, onSent: (bytes: number) => void): Promise<string>;
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
  /** How long nothing may arrive before the file is given up; the tests set it. */
  outageMs?: number;
}): Promise<{ itemId: string }> {
  const { recordingId, api, io, signal } = opts;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const outageMs = opts.outageMs ?? OUTAGE_MS;
  let confirming = false;
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
    // When a part last arrived: the link is down for as long as none has.
    let arrived = Date.now();
    let sent = 0;
    // Bytes of each part on its way, so the figure moves within a part.
    const moving = new Map<number, number>();
    const report = () => opts.onProgress((sent + [...moving.values()].reduce((a, b) => a + b, 0)) / opts.sizeBytes);
    let next = 1;
    const sendOne = async (n: number) => {
      const start = (n - 1) * partBytes;
      const end = Math.min(start + partBytes, opts.sizeBytes);
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw new UploadCancelled();
        try {
          const url = await urlFor(n, attempt > 1);
          etags.set(
            n,
            await io.send(url, await io.read(start, end), signal, (bytes) => {
              moving.set(n, Math.min(bytes, end - start));
              report();
            }),
          );
          arrived = Date.now();
          moving.delete(n);
          sent += end - start;
          report();
          return;
        } catch (e) {
          moving.delete(n);
          if (signal.aborted) throw new UploadCancelled();
          if (attempt >= PART_TRIES && Date.now() - arrived >= outageMs) throw e;
          await pause(retryDelayMs * Math.min(2 ** (attempt - 1), MAX_BACKOFF));
        }
      }
    };
    const worker = async () => {
      while (next <= partCount) await sendOne(next++);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, partCount) }, worker));

    if (signal.aborted) throw new UploadCancelled();
    opts.onStage('checking');
    confirming = true;
    const parts = [...etags].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag }));
    for (let attempt = 1; ; attempt++) {
      try {
        await api.finalize({ recordingId, itemId, parts });
        return { itemId };
      } catch (e) {
        if (refused(e) || attempt >= CONFIRM_TRIES) throw e;
        await pause(retryDelayMs * 2 ** attempt);
      }
    }
  } catch (e) {
    // A confirmation that never came back may have worked: the file stays,
    // and the session lists it until it is removed or the day's sweep clears
    // an upload never confirmed. Removing it could delete a file that landed.
    if (confirming && !refused(e)) throw e;
    // Otherwise the item goes: one the server refused at finalize is already
    // gone, so removing it again just finds nothing, and anything else would
    // otherwise wait a day for the sweep, blocking Publish.
    await api.cancel({ recordingId, itemId }).catch(() => undefined);
    throw e;
  }
}
