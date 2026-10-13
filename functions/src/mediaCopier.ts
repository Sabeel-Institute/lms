import { GoogleAuth } from 'google-auth-library';
import { defineString } from 'firebase-functions/params';
import { head } from './mediaStore';

/**
 * Ask the Cloudflare Worker to copy one file into the media bucket.
 *
 * The Worker (`cloudflare/media-copier`) exists so media never leaves Google:
 * a Function writing to R2 would be billed for every byte as internet egress.
 * The Function sends a few hundred bytes of JSON; the file goes from Zoom to
 * Cloudflare directly.
 *
 * The Worker accepts only a Google-signed ID token minted for its own address
 * by this project's Functions runtime service account, fetched here from the
 * metadata server. There is no shared secret to leak.
 *
 * The copy is one streamed put, and the object appears only when it is
 * complete. So if the connection drops partway, the object either exists with
 * the right size (the copy finished) or does not exist at all; that is checked
 * before the failure is reported, rather than reporting a copy that worked.
 */
const MEDIA_COPIER_URL = defineString('MEDIA_COPIER_URL', {
  description: 'Address of the Cloudflare Worker that copies Zoom files into the media bucket',
});

/**
 * The largest file the Worker copies: R2 takes at most 5 GiB in one put, and
 * the Worker copies in one put. The Worker states the same limit as its
 * `MAX_BYTES`; `mediaConfig.test.ts` holds the two together.
 */
export const MAX_COPY_BYTES = Math.floor(4.9 * 2 ** 30);

/** A 3.5 GB recording takes about 3 minutes at the measured rate; allow 20. */
const COPY_TIMEOUT_MS = 20 * 60 * 1000;

export interface CopyRequest {
  sourceUrl: string;
  key: string;
  size: number;
  contentType: string;
}

const auth = new GoogleAuth();

export async function copyThroughWorker(req: CopyRequest): Promise<void> {
  const base = MEDIA_COPIER_URL.value();
  if (!base.startsWith('https://')) {
    throw new Error('The media copier is not available here (MEDIA_COPIER_URL is not an https address).');
  }
  const client = await auth.getIdTokenClient(base);
  const headers = await client.getRequestHeaders();
  headers.set('content-type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`${base}/copy`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(COPY_TIMEOUT_MS),
    });
  } catch (e) {
    if ((await head(req.key))?.sizeBytes === req.size) return;
    throw e;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`The copy failed: ${body.error ?? `HTTP ${res.status}`}.`);
  }
}
