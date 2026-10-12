import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Copy one Zoom recording file into the R2 media bucket.
 *
 * Exists so media never leaves Google: copying from a Cloud Function into R2
 * would bill every byte as Google internet egress. The Function resolves Zoom's
 * one-hour file link (no Zoom credential leaves Google) and asks this Worker to
 * copy it; the bytes go Zoom → Cloudflare only.
 *
 * It can do exactly one narrow thing, so a stolen token or a bug in the caller
 * cannot turn it into anything else:
 *
 *  - the caller is the Functions runtime service account, proved by a
 *    Google-signed ID token minted for this Worker's own address;
 *  - the source is an https Zoom address, and a redirect is refused rather than
 *    followed, so it is not an open relay;
 *  - the destination is a recording's audio key, and an existing object is
 *    never overwritten;
 *  - the source's length must equal the size the caller read from Zoom's API.
 *
 * One streamed `put`, not multipart: spike M1 (2026-10-12) measured 3 ms of CPU
 * and 2 subrequests for a 1.2 GB file, inside the Free plan; multipart was
 * slower and over the CPU limit (docs/plans/MEDIA-ON-CLOUDFLARE.md). The object
 * appears only when complete, so a caller whose connection drops can check for
 * it and simply ask again.
 */

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** A recording's audio, as `audioStoragePath` in @sabeel/shared names it. */
const KEY_PATTERN = /^recordings\/[A-Za-z0-9]+\/audio\.m4a$/;
const CONTENT_TYPES = new Set(['audio/mp4']);
/** R2 takes at most 5 GiB in one put; stay clear of the edge. */
export const MAX_BYTES = Math.floor(4.9 * 2 ** 30);

export interface CopyRequest {
  sourceUrl: string;
  key: string;
  size: number;
  contentType: string;
}

/** What the handler needs from outside, so tests can supply their own. */
export interface Deps {
  jwks: JWTVerifyGetKey;
  fetch: typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function isZoomHttps(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && (u.hostname === 'zoom.us' || u.hostname.endsWith('.zoom.us'));
}

/** The reason a request is malformed, or null. */
function invalid(body: Partial<CopyRequest> | null): string | null {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.sourceUrl !== 'string' || !isZoomHttps(body.sourceUrl)) {
    return 'sourceUrl must be an https address on zoom.us';
  }
  if (typeof body.key !== 'string' || !KEY_PATTERN.test(body.key)) return 'key is not a recording audio key';
  if (typeof body.size !== 'number' || !Number.isInteger(body.size) || body.size < 1 || body.size > MAX_BYTES) {
    return `size must be a whole number of bytes from 1 to ${MAX_BYTES}`;
  }
  if (typeof body.contentType !== 'string' || !CONTENT_TYPES.has(body.contentType)) {
    return 'contentType is not allowed';
  }
  return null;
}

async function callerAllowed(req: Request, env: Env, deps: Deps): Promise<boolean> {
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, deps.jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: env.AUDIENCE,
      algorithms: ['RS256'],
    });
    return payload.email === env.ALLOWED_CALLER && payload.email_verified === true;
  } catch {
    return false;
  }
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'POST' || url.pathname !== '/copy') return json({ error: 'not found' }, 404);
  if (!(await callerAllowed(req, env, deps))) return json({ error: 'caller not allowed' }, 403);

  const body = (await req.json().catch(() => null)) as Partial<CopyRequest> | null;
  const reason = invalid(body);
  if (reason) return json({ error: reason }, 400);
  const { sourceUrl, key, size, contentType } = body as CopyRequest;

  if (await env.BUCKET.head(key)) return json({ error: 'an object already exists at that key' }, 409);

  const src = await deps.fetch(sourceUrl, { redirect: 'manual' });
  if (src.status !== 200 || !src.body) {
    await src.body?.cancel();
    return json({ error: `the source answered ${src.status}` }, 502);
  }
  const length = Number(src.headers.get('content-length'));
  if (length !== size) {
    await src.body.cancel();
    return json({ error: `the source is ${length} bytes, not ${size}` }, 502);
  }
  const stored = await env.BUCKET.put(key, src.body, { httpMetadata: { contentType } });
  return json({ size: stored.size, etag: stored.etag });
}

export default {
  fetch: (req, env) => handle(req, env, { jwks: GOOGLE_JWKS, fetch: (...a) => fetch(...a) }),
} satisfies ExportedHandler<Env>;
