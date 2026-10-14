import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postJson } from '../../src/mediaCopier';

/**
 * The copier's Worker answers only once a copy is done, which for a large
 * recording is many minutes. Node's fetch gave up on that answer at five
 * minutes, whatever signal it was handed, so a large Zoom file failed every
 * attempt and every Retry.
 *
 * What can be asserted in a test's time is that the only limit is the one
 * given: an answer slower than it fails, one within it arrives whole. That no
 * five-minute limit hides behind it cannot be shown here without waiting six
 * minutes; it was shown once, against a server that answered after five and a
 * half, when this changed.
 */

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A server that answers `answer` after `delayMs`, or never when null. */
async function slowServer(delayMs: number | null, answer = { size: 3 }): Promise<string> {
  server = createServer((req, res) => {
    let received = '';
    req.on('data', (c: Buffer) => (received += c.toString()));
    req.on('end', () => {
      if (delayMs === null) return;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...answer, received: JSON.parse(received) }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/copy`;
}

describe('the request to the media copier', () => {
  it('waits as long as it is told, and reads the whole answer', async () => {
    const url = await slowServer(300);
    const res = await postJson(url, { authorization: 'Bearer x' }, JSON.stringify({ key: 'media/r/i' }), 2_000);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ size: 3, received: { key: 'media/r/i' } });
  });

  it('gives up when nothing comes back within the limit', async () => {
    const url = await slowServer(null);
    await expect(postJson(url, {}, '{}', 300)).rejects.toThrow(/No answer from the media copier/);
  });
});
