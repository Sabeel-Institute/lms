import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { APP_ID } from '@sabeel/shared';

/**
 * What an iPhone is promised: Apple is asked, in the form Apple accepts, to
 * show this message on this phone, and a tap on it opens the thing it is
 * about. Apple itself cannot be reached from a test, so two local HTTP/2
 * servers stand in for its sandbox and production services and record every
 * request; each answers what Apple would.
 *
 * Not covered here, because only Apple can say: that Apple accepts this
 * project's real key and topic (`npm run check:push` asks it, with a token
 * that cannot exist), and that a phone shows the result (a device, through
 * TestFlight). Plain-text HTTP/2 stands in for TLS; the requests are the same.
 */

const MESSAGE = { title: 'A recording is ready', body: 'Listen by Friday', path: 'recordings/r1' };
const TOKEN = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

interface Seen {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A stand-in for one of Apple's services: records requests, answers per token. */
async function fakeApple(answer: (token: string) => { status: number; reason?: string } = () => ({ status: 200 })) {
  const seen: Seen[] = [];
  const server: Http2Server = createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (c: Buffer) => (body += c.toString()));
    stream.on('end', () => {
      seen.push({ headers, body });
      const token = String(headers[':path']).replace('/3/device/', '');
      const { status, reason } = answer(token);
      stream.respond({ ':status': status, 'content-type': 'application/json' });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, origin, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let keys: { privatePem: string; publicKey: KeyObject };
const creds = () => ({ key: keys.privatePem, keyId: 'KEY1234567', teamId: 'TEAM123456' });
const opened: { close: () => Promise<void> }[] = [];

beforeEach(() => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  keys = {
    privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey,
  };
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
  vi.resetModules();
});

/** The module keeps its provider token between sends, so each test starts clean. */
async function fresh() {
  vi.resetModules();
  return import('../../src/apns');
}

async function both(answer?: Parameters<typeof fakeApple>[0]) {
  const production = await fakeApple(answer);
  const development = await fakeApple(answer);
  opened.push(production, development);
  return { production, development, origins: { production: production.origin, development: development.origin } };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
const bearer = (s: Seen) => String(s.headers.authorization).replace(/^bearer /, '');

describe('a notification to an iPhone', () => {
  it('asks Apple to show the words, for this app, now', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    const out = await sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), apple.origins);

    expect(out).toEqual({ delivered: [TOKEN], dead: [], failed: [] });
    expect(apple.production.seen).toHaveLength(1);
    const [req] = apple.production.seen;
    expect(req.headers[':method']).toBe('POST');
    expect(req.headers[':path']).toBe(`/3/device/${TOKEN}`);
    // The topic is the app: Apple refuses a push whose topic is not the bundle
    // id the token was issued to.
    expect(req.headers['apns-topic']).toBe(APP_ID);
    // An alert, delivered now: a background push would arrive and show nothing.
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
    expect(JSON.parse(req.body).aps).toEqual({
      alert: { title: MESSAGE.title, body: MESSAGE.body },
      sound: 'default',
    });
  });

  /*
   * THE TAP OPENS THE THING. expo-notifications on iOS gives the app a remote
   * notification's `userInfo.body` dictionary as its data, and nothing beside
   * it, and the app opens `data.path` (app/src/pushTaps.ts). A path anywhere
   * else arrives and opens nothing.
   */
  it('puts the path where the app reads it on an iPhone: inside a `body` dictionary', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    await sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), apple.origins);
    const payload = JSON.parse(apple.production.seen[0].body) as Record<string, unknown>;
    expect(payload.body).toEqual({ path: MESSAGE.path });
    expect(Object.keys(payload).sort()).toEqual(['aps', 'body']);
  });

  /*
   * THE PROVIDER TOKEN APPLE WILL ACCEPT. An ES256 JWT naming the key and the
   * team, signed with the key — and signed in JOSE's raw r||s form. Node's
   * default is DER, a perfectly valid ECDSA signature that Apple answers with
   * InvalidProviderToken; verifying it here in the raw form is what fails if
   * the encoding ever slips back to the default.
   */
  it('proves itself with a token signed by the team’s key, in the form Apple reads', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    const now = Date.UTC(2026, 9, 15, 12, 0, 0);
    await sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), apple.origins, now);

    const [header, claims, signature] = bearer(apple.production.seen[0]).split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decode(claims)).toEqual({ iss: 'TEAM123456', iat: now / 1000 });
    const raw = Buffer.from(signature, 'base64url');
    expect(raw).toHaveLength(64);
    expect(
      verify('sha256', Buffer.from(`${header}.${claims}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, raw),
    ).toBe(true);
  });

  it('sends each token to the service that issued it, never the other', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    const out = await sendToApns(
      [
        { token: TOKEN, apnsEnvironment: 'production', message: MESSAGE },
        { token: OTHER, apnsEnvironment: 'development', message: MESSAGE },
      ],
      creds(),
      apple.origins,
    );
    expect(out.delivered.sort()).toEqual([TOKEN, OTHER].sort());
    expect(apple.production.seen.map((s) => s.headers[':path'])).toEqual([`/3/device/${TOKEN}`]);
    expect(apple.development.seen.map((s) => s.headers[':path'])).toEqual([`/3/device/${OTHER}`]);
  });

  /*
   * EACH PHONE ITS OWN WORDS. A send carries its message, so two people
   * reached in one call each hear what was meant for them: a mix-up would
   * show one student another's recording, and open it on a tap.
   */
  it('gives each phone the message sent to it', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    const other = { title: 'Work returned', body: 'Your essay has a grade', path: 'work/w1' };
    await sendToApns(
      [
        { token: TOKEN, apnsEnvironment: 'production', message: MESSAGE },
        { token: OTHER, apnsEnvironment: 'production', message: other },
      ],
      creds(),
      apple.origins,
    );
    const payloads = Object.fromEntries(
      apple.production.seen.map((s) => [String(s.headers[':path']).replace('/3/device/', ''), JSON.parse(s.body)]),
    );
    expect(payloads[TOKEN]).toEqual({ aps: { alert: { title: MESSAGE.title, body: MESSAGE.body }, sound: 'default' }, body: { path: MESSAGE.path } });
    expect(payloads[OTHER]).toEqual({ aps: { alert: { title: other.title, body: other.body }, sound: 'default' }, body: { path: other.path } });
  });
});

/*
 * WHOSE PHONE GOES SILENT. A token Apple calls dead is deleted, and that
 * person hears nothing on that phone again until the app registers it anew,
 * so only an answer about the TOKEN may do it. An answer about the MESSAGE
 * would come back for every device at once and unregister everyone.
 */
describe('what Apple answers', () => {
  const cases: [string, number, string | undefined, 'delivered' | 'dead' | 'failed'][] = [
    ['delivered', 200, undefined, 'delivered'],
    ['the app was removed', 410, 'Unregistered', 'dead'],
    ['the token expired', 410, 'ExpiredToken', 'dead'],
    ['not a token Apple issued (or the other service’s)', 400, 'BadDeviceToken', 'dead'],
    ['another app’s token', 400, 'DeviceTokenNotForTopic', 'dead'],
    ['a message Apple will not carry', 400, 'BadPayload', 'failed'],
    ['a topic Apple does not know', 400, 'BadTopic', 'failed'],
    ['too many requests', 429, 'TooManyRequests', 'failed'],
    ['Apple’s own trouble', 503, 'ServiceUnavailable', 'failed'],
    ['a provider token refused', 403, 'InvalidProviderToken', 'failed'],
  ];

  it.each(cases)('%s (%i %s): %s', async (_what, status, reason, verdict) => {
    const { sendToApns } = await fresh();
    const apple = await both(() => ({ status, reason }));
    const out = await sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), apple.origins);
    expect(out.delivered).toEqual(verdict === 'delivered' ? [TOKEN] : []);
    expect(out.dead).toEqual(verdict === 'dead' ? [TOKEN] : []);
    expect(out.failed.map((f) => f.token)).toEqual(verdict === 'failed' ? [TOKEN] : []);
    if (verdict === 'failed') expect(out.failed[0].reason).toBe(reason);
  });

  it('answers for each phone separately', async () => {
    const { sendToApns } = await fresh();
    const apple = await both((token) => (token === OTHER ? { status: 410, reason: 'Unregistered' } : { status: 200 }));
    const out = await sendToApns(
      [
        { token: TOKEN, apnsEnvironment: 'production', message: MESSAGE },
        { token: OTHER, apnsEnvironment: 'production', message: MESSAGE },
      ],
      creds(),
      apple.origins,
    );
    expect(out).toEqual({ delivered: [TOKEN], dead: [OTHER], failed: [] });
  });

  it('calls a token that never came from Apple dead, and sends it nowhere', async () => {
    const { sendToApns } = await fresh();
    const apple = await both();
    const out = await sendToApns(
      [{ token: '../../../x', apnsEnvironment: 'production', message: MESSAGE }],
      creds(),
      apple.origins,
    );
    expect(out.dead).toEqual(['../../../x']);
    expect(apple.production.seen).toHaveLength(0);
  });

  it('keeps the phone when Apple cannot be reached at all', async () => {
    const { sendToApns } = await fresh();
    const gone = await fakeApple();
    await gone.close();
    const out = await sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), {
      production: gone.origin,
      development: gone.origin,
    });
    expect(out.dead).toEqual([]);
    expect(out.delivered).toEqual([]);
    expect(out.failed.map((f) => f.token)).toEqual([TOKEN]);
  });
});

/*
 * ONE PROVIDER TOKEN AT A TIME. Apple refuses a token older than an hour and
 * pushes back on a server that changes it more than every twenty minutes.
 */
describe('the provider token', () => {
  const at = Date.UTC(2026, 9, 15, 12, 0, 0);
  const minutes = (n: number) => n * 60_000;

  async function sendAt(api: Awaited<ReturnType<typeof fresh>>, apple: Awaited<ReturnType<typeof both>>, now: number) {
    await api.sendToApns([{ token: TOKEN, apnsEnvironment: 'production', message: MESSAGE }], creds(), apple.origins, now);
    return bearer(apple.production.seen[apple.production.seen.length - 1]);
  }

  it('is reused inside fifty minutes and replaced after', async () => {
    const api = await fresh();
    const apple = await both();
    const first = await sendAt(api, apple, at);
    expect(await sendAt(api, apple, at + minutes(30))).toBe(first);
    const later = await sendAt(api, apple, at + minutes(51));
    expect(later).not.toBe(first);
    expect(decode(later.split('.')[1]).iat).toBe((at + minutes(51)) / 1000);
  });

  it('is replaced as soon as Apple refuses it', async () => {
    const api = await fresh();
    let refuse = true;
    const apple = await both(() => (refuse ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
    const first = await sendAt(api, apple, at);
    refuse = false;
    const second = await sendAt(api, apple, at + minutes(1));
    expect(second).not.toBe(first);
    expect(decode(second.split('.')[1]).iat).toBe((at + minutes(1)) / 1000);
  });
});
