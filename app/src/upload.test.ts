import { describe, expect, it } from 'vitest';
import { UploadCancelled, uploadMedia, type UploadApi } from './upload';

/**
 * A fake server and bucket: parts are stored by number as the byte ranges the
 * loop read, so a test can rebuild the file the server would join.
 */
function world(sizeBytes: number, partBytes: number, { failSends = new Map<number, number>() } = {}) {
  const partCount = Math.max(1, Math.ceil(sizeBytes / partBytes));
  const stored = new Map<number, [number, number]>();
  const signedFor = new Map<number, number>();
  const calls = { cancelled: 0, finalized: null as null | { partNumber: number; etag: string }[] };
  const api: UploadApi = {
    start: async () => ({ itemId: 'item1', partBytes, partCount }),
    sign: async ({ partNumbers }) => {
      const urls: Record<number, string> = {};
      for (const n of partNumbers) {
        signedFor.set(n, (signedFor.get(n) ?? 0) + 1);
        urls[n] = `url:${n}:${signedFor.get(n)}`;
      }
      return { urls };
    },
    finalize: async ({ parts }) => {
      calls.finalized = parts;
    },
    cancel: async () => {
      calls.cancelled++;
    },
  };
  const io = {
    read: async (start: number, end: number) => [start, end] as [number, number],
    send: async (url: string, body: [number, number]) => {
      const n = Number(url.split(':')[1]);
      const left = failSends.get(n) ?? 0;
      if (left > 0) {
        failSends.set(n, left - 1);
        throw new Error('network');
      }
      stored.set(n, body);
      return `etag-${n}`;
    },
  };
  return { api, io, stored, calls, signedFor };
}

const run = (w: ReturnType<typeof world>, sizeBytes: number, signal = new AbortController().signal) => {
  const progress: number[] = [];
  const stages: string[] = [];
  const done = uploadMedia({
    recordingId: 'rec1',
    contentType: 'video/mp4',
    sizeBytes,
    placement: { as: 'part' },
    api: w.api,
    io: w.io,
    signal,
    onProgress: (f) => progress.push(f),
    onStage: (s) => stages.push(s),
    retryDelayMs: 0,
  });
  return { done, progress, stages };
};

describe('uploadMedia', () => {
  it('sends every byte exactly once, in parts that rebuild the file, then confirms it', async () => {
    const w = world(1000, 128);
    const { done, progress, stages } = run(w, 1000);
    await done;
    const ranges = [...w.stored].sort(([a], [b]) => a - b).map(([, r]) => r);
    expect(ranges[0][0]).toBe(0);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    expect(ranges.at(-1)?.[1]).toBe(1000);
    expect(w.calls.finalized?.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(w.calls.finalized?.every((p) => p.etag === `etag-${p.partNumber}`)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(stages).toEqual(['sending', 'checking']);
    expect(w.calls.cancelled).toBe(0);
  });

  it('sends a small file as one part', async () => {
    const w = world(10, 128);
    await run(w, 10).done;
    expect(w.calls.finalized).toEqual([{ partNumber: 1, etag: 'etag-1' }]);
  });

  it('resends a part that failed, on a freshly signed URL, without resending the rest', async () => {
    const w = world(1000, 128, { failSends: new Map([[3, 2]]) });
    await run(w, 1000).done;
    expect(w.stored.size).toBe(8);
    // Signed once with its batch, then again for each retry.
    expect(w.signedFor.get(3)).toBe(3);
    expect(w.signedFor.get(5)).toBe(1);
  });

  it('gives up on a part that keeps failing, and takes the half-sent file off the recording', async () => {
    const w = world(1000, 128, { failSends: new Map([[2, 99]]) });
    await expect(run(w, 1000).done).rejects.toThrow('network');
    expect(w.calls.finalized).toBeNull();
    expect(w.calls.cancelled).toBe(1);
  });

  it('stops when cancelled, confirms nothing, and removes the file', async () => {
    const w = world(1000, 128);
    const ctrl = new AbortController();
    const send = w.io.send;
    w.io.send = async (url, body) => {
      ctrl.abort();
      return send(url, body);
    };
    await expect(run(w, 1000, ctrl.signal).done).rejects.toBeInstanceOf(UploadCancelled);
    expect(w.calls.finalized).toBeNull();
    expect(w.calls.cancelled).toBe(1);
  });

  it('passes on a refusal from the server, and leaves nothing behind', async () => {
    const w = world(10, 128);
    w.api.finalize = async () => {
      throw Object.assign(new Error("This video uses a format phones can't play."), { code: 'failed-precondition' });
    };
    await expect(run(w, 10).done).rejects.toThrow(/format phones can't play/);
    expect(w.calls.cancelled).toBe(1);
  });
});
