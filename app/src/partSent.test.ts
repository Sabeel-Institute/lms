import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEND_DROPPED, SEND_REFUSED, partSent } from './partSent';

const answer = (ok: boolean, status: number, etag: string | null) => ({
  ok,
  status,
  headers: { get: (name: string) => (name === 'etag' ? etag : null) },
});

afterEach(() => vi.restoreAllMocks());

describe('a part sent, or a sentence saying why not', () => {
  it('gives the ETag the store answered with', async () => {
    await expect(partSent(new AbortController().signal, async () => answer(true, 200, '"abc"'))).resolves.toBe('"abc"');
  });

  it('a dropped connection reads as one, not as the Java exception the phone throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = partSent(new AbortController().signal, async () => {
      throw new TypeError('fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:61307');
    });
    await expect(dropped).rejects.toThrow(SEND_DROPPED);
  });

  it('a refusal (a link that ran out) reads as a sentence, not "HTTP 403"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(partSent(new AbortController().signal, async () => answer(false, 403, null))).rejects.toThrow(SEND_REFUSED);
    // Stored with no ETag is not stored as far as the upload can tell.
    await expect(partSent(new AbortController().signal, async () => answer(true, 200, null))).rejects.toThrow(SEND_REFUSED);
  });

  it('a stopped upload goes back as it came: the caller stopped it, and checks its own signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stopped = new DOMException('The operation was aborted.', 'AbortError');
    await expect(
      partSent(ctrl.signal, async () => {
        throw stopped;
      }),
    ).rejects.toBe(stopped);
  });
});
