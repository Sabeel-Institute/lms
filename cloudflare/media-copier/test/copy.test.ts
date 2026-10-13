import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from 'jose';
import { handle, type Deps } from '../src/index';

/**
 * The copier's promises, driven through its handler inside workerd with a real
 * (local) R2 bucket. Google's signing keys and Zoom are the two things outside:
 * tokens are signed here with a key the handler is told to trust, standing in
 * for Google's JWKS, and Zoom is a fake fetch that records whether it was ever
 * called. "Nothing was fetched" is half of most refusals below: a refused
 * caller must not be able to make the Worker download anything.
 */

const KEY = 'media/rec1/item1';
const SOURCE = 'https://ssrweb.zoom.us/file/abc?Policy=x&Signature=y';
const AUDIO = Uint8Array.from({ length: 3000 }, (_, i) => i % 256);

let googleKey: CryptoKey;
let jwks: JWTVerifyGetKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  googleKey = pair.privateKey;
  const pub: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'google-1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [pub] });
  strangerKey = (await generateKeyPair('RS256')).privateKey;
});

interface Claims {
  iss?: string;
  aud?: string;
  email?: string;
  email_verified?: boolean;
  expiresIn?: string;
  key?: CryptoKey;
}

async function token(c: Claims = {}): Promise<string> {
  return new SignJWT({ email: c.email ?? env.ALLOWED_CALLER, email_verified: c.email_verified ?? true })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-1' })
    .setIssuer(c.iss ?? 'https://accounts.google.com')
    .setAudience(c.aud ?? env.AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(c.expiresIn ?? '1h')
    .sign(c.key ?? googleKey);
}

let fetched: string[] = [];
let redirectModes: (string | undefined)[] = [];
let zoomAnswer: () => Response;
const deps = (): Deps => ({
  jwks,
  fetch: async (input, init) => {
    fetched.push(String(input));
    redirectModes.push(init?.redirect);
    return zoomAnswer();
  },
});

const zoomFile = (bytes = AUDIO, length = bytes.length) =>
  new Response(bytes, { headers: { 'content-length': String(length), 'content-type': 'audio/mp4' } });

function copy(body: Record<string, unknown>, auth?: string) {
  const req = new Request(`${env.AUDIENCE}/copy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
  return handle(req, env, deps());
}

const valid = { sourceUrl: SOURCE, key: KEY, size: AUDIO.length, contentType: 'audio/mp4' };

beforeEach(async () => {
  fetched = [];
  redirectModes = [];
  zoomAnswer = () => zoomFile();
  await env.BUCKET.delete(KEY);
});

async function stored(key = KEY): Promise<Uint8Array | null> {
  const o = await env.BUCKET.get(key);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

describe('the copy', () => {
  it('stores the Zoom file, byte for byte, with its type', async () => {
    const res = await copy(valid, `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: AUDIO.length });
    expect(await stored()).toEqual(AUDIO);
    expect((await env.BUCKET.head(KEY))?.httpMetadata?.contentType).toBe('audio/mp4');
    expect(fetched).toEqual([SOURCE]);
  });

  it('never overwrites: an existing object is left as it was, and nothing is fetched', async () => {
    const before = new Uint8Array([9, 9, 9]);
    await env.BUCKET.put(KEY, before);
    const res = await copy(valid, `Bearer ${await token()}`);
    expect(res.status).toBe(409);
    expect(await stored()).toEqual(before);
    expect(fetched).toEqual([]);
  });

  it('refuses a source whose length is not the size Zoom listed, and stores nothing', async () => {
    zoomAnswer = () => zoomFile(AUDIO.slice(0, 1000));
    const res = await copy(valid, `Bearer ${await token()}`);
    expect(res.status).toBe(502);
    expect(await stored()).toBeNull();
  });

  /*
   * A FAKE FETCH CANNOT FOLLOW A REDIRECT, so whether the Worker would follow
   * one is asserted on what it ASKS for (`redirect: 'manual'`), and what it does
   * with the 302 it then gets is asserted on the outcome. Following redirects
   * would let a Zoom-looking address send the Worker anywhere.
   */
  it('does not follow a redirect away from the link it was given', async () => {
    zoomAnswer = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } });
    const res = await copy(valid, `Bearer ${await token()}`);
    expect(res.status).toBe(502);
    expect(await stored()).toBeNull();
    expect(fetched).toEqual([SOURCE]);
    expect(redirectModes).toEqual(['manual']);
  });
});

describe('who may ask', () => {
  const refusedWith = async (auth: string | undefined) => {
    const res = await copy(valid, auth);
    expect(res.status).toBe(403);
    expect(fetched, 'a refused caller made the Worker fetch').toEqual([]);
    expect(await stored()).toBeNull();
  };

  it('nobody without a token', () => refusedWith(undefined));
  it('nobody with a token signed by any key but Google’s', async () =>
    refusedWith(`Bearer ${await token({ key: strangerKey })}`));
  it('nobody with an expired token', async () => refusedWith(`Bearer ${await token({ expiresIn: '-1m' })}`));
  it('nobody with a token minted for another audience', async () =>
    refusedWith(`Bearer ${await token({ aud: 'https://some-other.workers.dev' })}`));
  it('nobody but the Functions service account', async () =>
    refusedWith(`Bearer ${await token({ email: 'someone-else@developer.gserviceaccount.com' })}`));
  it('nobody whose email is not verified', async () =>
    refusedWith(`Bearer ${await token({ email_verified: false })}`));
  it('nobody with a token from another issuer', async () =>
    refusedWith(`Bearer ${await token({ iss: 'https://evil.example' })}`));
});

describe('what it may be asked to do', () => {
  const badRequest = async (overrides: Record<string, unknown>) => {
    const res = await copy({ ...valid, ...overrides }, `Bearer ${await token()}`);
    expect(res.status).toBe(400);
    expect(fetched).toEqual([]);
  };

  it.each([
    'http://ssrweb.zoom.us/file/abc',
    'https://evil.example/file',
    'https://zoom.us.evil.example/file',
    'https://evilzoom.us/file',
    'not a url',
  ])('fetches nothing but https on zoom.us: %s', (sourceUrl) => badRequest({ sourceUrl }));

  it.each(['recordings/rec1/audio.m4a', 'media/../secret', 'media/rec1/item1.mp4', 'media/a/b/c', 'media/rec1/'])(
    'writes nowhere but a media item’s object: %s',
    (key) => badRequest({ key }),
  );

  it('takes only sizes R2 can store in one put', async () => {
    await badRequest({ size: 0 });
    await badRequest({ size: 5 * 2 ** 30 });
    await badRequest({ size: 1.5 });
  });

  it('takes only audio/mp4', () => badRequest({ contentType: 'text/html' }));
});
