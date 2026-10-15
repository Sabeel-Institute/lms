import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * A BUCKET THAT NEVER ANSWERS IS GIVEN UP ON, NOT WAITED ON. One request to
 * R2 on a connection that never answered held a file's confirmation for the
 * Function's whole five minutes, and the app then removed the file. A server
 * that accepts the connection and says nothing is how a stalled connection
 * looks from the Function: every call to it must fail, and soon, so the
 * caller can answer. Here and not in the unit suite: each call takes its
 * full time limit to fail, twice over.
 */
let server: Server;
const sockets: Socket[] = [];
afterAll(() => {
  for (const s of sockets) s.destroy();
  server?.close();
});

describe('a stalled bucket', () => {
  it('fails every call within its time limit', async () => {
    server = createServer((s) => {
      sockets.push(s);
      s.on('data', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { head, readRange, deleteObject } = await import('../../src/mediaStore');
    const t0 = Date.now();
    const outcomes = await Promise.all(
      [head('media/r/i'), readRange('media/r/i', 0, 15), deleteObject('media/r/i')].map((p) =>
        p.then(
          () => 'answered',
          () => 'failed',
        ),
      ),
    );
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    // Two tries of fifteen seconds and the pause between: well inside the
    // confirmation's own limit, which is what the bound is for.
    expect(Date.now() - t0).toBeLessThan(45_000);
  }, 60_000);
});
