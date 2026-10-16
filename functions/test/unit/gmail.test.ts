import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APPS_MAIL_SENDER } from '@sabeel/shared';
import { sendWithGmail, GMAIL_SEND_SCOPE, type GoogleEndpoints } from '../../src/gmail';
import { composeMessage } from '../../src/mail';
import { reportMail } from '../../src/reportMail';

/**
 * What the server is promised: a report reaches the administrators as an
 * email from the apps' sender, through the three requests Google's
 * domain-wide delegation takes, signed by IAM with no key anywhere. Google
 * cannot be reached from a test, so one local server stands in for all three
 * services and records every request; each answers as Google would. The code
 * that runs is the code a deployed function runs, with only the addresses
 * changed.
 *
 * Not covered here, because only Google can say: that IAM signs for the
 * function's real runtime account (the Token Creator grant, `docs/DEPLOY.md`)
 * and that the Admin console's delegation lets the mailer account send as
 * `apps-noreply@`. Both were proved by hand on 2026-10-16 with these same three
 * calls; after a deploy, a report sent from the live app is the check.
 */

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Answer = { status: number; body: unknown };

const SA = 'report-mailer@oursabeel-lms.iam.gserviceaccount.com';
const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Google, as three paths on one local server. `answer` may override any step. */
async function fakeGoogle(answer: (path: string) => Answer | null = () => null) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({ path, headers: req.headers, body });
      const given = answer(path);
      const out: Answer =
        given ??
        (path.includes(':signJwt')
          ? { status: 200, body: { keyId: 'k1', signedJwt: 'header.claims.signature' } }
          : path === '/token'
            ? { status: 200, body: { access_token: 'delegated-token', token_type: 'Bearer', expires_in: 3599 } }
            : path === '/gmail/v1/users/me/messages/send'
              ? { status: 200, body: { id: 'gmail-msg-1', threadId: 't1', labelIds: ['SENT'] } }
              : { status: 404, body: { error: { message: 'no such path' } } });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  opened.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleEndpoints = { iamCredentials: origin, token: `${origin}/token`, gmail: origin };
  return { seen, endpoints };
}

const NOW = Date.UTC(2026, 9, 16, 15, 4, 5);

/** The raw message a real report becomes. */
const RAW = composeMessage(
  reportMail({
    id: 'r1',
    uid: 'u1',
    displayName: 'Fatima Ahmed',
    email: 'fatima@example.com',
    role: 'student',
    text: 'Something was posted in Session 1 that should not have been.',
    createdAt: NOW,
  }),
  APPS_MAIL_SENDER,
  new Date(NOW),
);

const send = (endpoints: GoogleEndpoints) =>
  sendWithGmail(RAW, {
    serviceAccount: SA,
    sender: APPS_MAIL_SENDER.address,
    accessToken: async () => 'function-own-token',
    endpoints,
    now: NOW,
  });

describe('sendWithGmail', () => {
  it('signs a delegation token as the mailer account, exchanges it, and sends the message as apps-noreply@', async () => {
    const { seen, endpoints } = await fakeGoogle();
    expect(await send(endpoints)).toBe('gmail-msg-1');
    expect(seen.map((s) => s.path)).toEqual([
      `/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`,
      '/token',
      '/gmail/v1/users/me/messages/send',
    ]);

    // 1. IAM, with the function's OWN token, asked to sign claims that
    //    delegate gmail.send, and nothing wider, to the sender, for an hour.
    const [sign, exchange, gmail] = seen;
    expect(sign.headers.authorization).toBe('Bearer function-own-token');
    const claims = JSON.parse((JSON.parse(sign.body) as { payload: string }).payload) as Record<string, unknown>;
    expect(claims).toEqual({
      iss: SA,
      sub: 'apps-noreply@oursabeel.com',
      scope: GMAIL_SEND_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(GMAIL_SEND_SCOPE).toBe('https://www.googleapis.com/auth/gmail.send');

    // 2. The token endpoint, given the signed token as a JWT bearer grant.
    const form = new URLSearchParams(exchange.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')).toBe('header.claims.signature');
    expect(exchange.headers['content-type']).toBe('application/x-www-form-urlencoded');

    // 3. Gmail, with the DELEGATED token, carrying the message unchanged.
    expect(gmail.headers.authorization).toBe('Bearer delegated-token');
    const raw = Buffer.from((JSON.parse(gmail.body) as { raw: string }).raw, 'base64url').toString('utf8');
    expect(raw).toBe(RAW);
    expect(raw).toMatch(/^From: "Sabeel Apps No Reply" <apps-noreply@oursabeel\.com>\r\n/m);
    expect(raw).toMatch(/^To: apps-reports@oursabeel\.com\r\n/m);
    expect(raw).toMatch(/^Reply-To: "Fatima Ahmed" <fatima@example\.com>\r\n/m);
  });

  it('stops at a refusal, says which step refused in Google’s own words, and sends nothing after it', async () => {
    const { seen, endpoints } = await fakeGoogle((path) =>
      path.includes(':signJwt')
        ? { status: 403, body: { error: { code: 403, message: "Permission 'iam.serviceAccounts.signJwt' denied", status: 'PERMISSION_DENIED' } } }
        : null,
    );
    await expect(send(endpoints)).rejects.toThrow(/^signJwt refused \(HTTP 403\): Permission 'iam\.serviceAccounts\.signJwt' denied$/);
    expect(seen).toHaveLength(1);
  });

  it('reports a delegation the Admin console has not authorised as the token exchange refusing it', async () => {
    const { seen, endpoints } = await fakeGoogle((path) =>
      path === '/token'
        ? { status: 401, body: { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method.' } }
        : null,
    );
    await expect(send(endpoints)).rejects.toThrow(/^the token exchange refused \(HTTP 401\): Client is unauthorized/);
    expect(seen.map((s) => s.path)).not.toContain('/gmail/v1/users/me/messages/send');
  });

  it('reports Gmail’s own refusal', async () => {
    const { endpoints } = await fakeGoogle((path) =>
      path.startsWith('/gmail/') ? { status: 400, body: { error: { code: 400, message: 'Invalid To header' } } } : null,
    );
    await expect(send(endpoints)).rejects.toThrow(/^Gmail refused \(HTTP 400\): Invalid To header$/);
  });
});
