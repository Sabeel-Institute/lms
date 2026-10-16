/**
 * Send a message through Gmail as a Workspace user, with no password and no
 * key: domain-wide delegation, signed by IAM.
 *
 * Three requests, each a plain HTTPS call:
 *
 *  1. IAM Credentials `signJwt`, with this function's own credentials, signs a
 *     token as the mailer service account. The claims name the Workspace user
 *     to act as (`sub`) and the one scope delegated to the account in the
 *     Admin console, `gmail.send`. The function's runtime account needs Token
 *     Creator on the mailer account for this, and nothing else
 *     (`docs/DEPLOY.md`); no key for the mailer account exists anywhere.
 *  2. Google's token endpoint exchanges the signed token for an access token.
 *  3. Gmail's `messages.send` takes the message, as the user it was issued for.
 *
 * Pure of configuration: the accounts, the caller's own token and the three
 * addresses come in as arguments, which is what lets `gmail.test.ts` stand a
 * local server in for Google and run this exact code. Proved against Google
 * by hand on 2026-10-16 with the same three calls, from each project's
 * mailer account to `apps-reports@`.
 */

/** Where each of the three requests goes. */
export interface GoogleEndpoints {
  iamCredentials: string;
  token: string;
  gmail: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  iamCredentials: 'https://iamcredentials.googleapis.com',
  token: 'https://oauth2.googleapis.com/token',
  gmail: 'https://gmail.googleapis.com',
};

/** The audience Google requires of a delegation token, wherever the request is sent. */
const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';

/** The one scope the mailer account is delegated. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Long enough for a slow answer, short enough that a hung one cannot hold a callable. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface GmailSend {
  /** The service account authorised for domain-wide delegation. */
  serviceAccount: string;
  /** The Workspace user the message is sent as. */
  sender: string;
  /** This function's own access token, for the IAM call. */
  accessToken: () => Promise<string>;
  endpoints?: GoogleEndpoints;
  now?: number;
}

/** POST, and the parsed answer; a refusal is thrown with Google's own words. */
async function post(step: string, url: string, init: { headers: Record<string, string>; body: string }): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const error = body.error as { message?: string } | string | undefined;
    const reason =
      (typeof error === 'object' ? error?.message : undefined) ??
      (body.error_description as string | undefined) ??
      (typeof error === 'string' ? error : undefined) ??
      text.slice(0, 200);
    throw new Error(`${step} refused (HTTP ${res.status}): ${reason}`);
  }
  return body;
}

/** Send one RFC 5322 message; returns Gmail's id for it. */
export async function sendWithGmail(raw: string, opts: GmailSend): Promise<string> {
  const endpoints = opts.endpoints ?? GOOGLE_ENDPOINTS;
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims = {
    iss: opts.serviceAccount,
    sub: opts.sender,
    scope: GMAIL_SEND_SCOPE,
    aud: TOKEN_AUDIENCE,
    iat,
    exp: iat + 3600,
  };

  const signed = await post(
    'signJwt',
    `${endpoints.iamCredentials}/v1/projects/-/serviceAccounts/${encodeURIComponent(opts.serviceAccount)}:signJwt`,
    {
      headers: { authorization: `Bearer ${await opts.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
    },
  );
  if (typeof signed.signedJwt !== 'string') throw new Error('signJwt answered without a signed token');

  const exchanged = await post('the token exchange', endpoints.token, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signed.signedJwt,
    }).toString(),
  });
  if (typeof exchanged.access_token !== 'string') throw new Error('the token exchange answered without an access token');

  const sent = await post('Gmail', `${endpoints.gmail}/gmail/v1/users/me/messages/send`, {
    headers: { authorization: `Bearer ${exchanged.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
  });
  if (typeof sent.id !== 'string') throw new Error('Gmail answered without a message id');
  return sent.id;
}
