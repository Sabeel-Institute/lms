import { randomBytes } from 'node:crypto';
import { defineString } from 'firebase-functions/params';
import { GoogleAuth } from 'google-auth-library';
import { APPS_MAIL_SENDER } from '@sabeel/shared';
import { isEmulatorProject } from './env';
import { sendWithGmail } from './gmail';

/**
 * EMAIL FROM THE INSTITUTE'S APPS: any message, from `apps-noreply@`.
 *
 * Two halves. `composeMessage` is pure: the RFC 5322 message, headers and
 * body, which the unit tests read byte for byte. `sendMail` hands it to the
 * transport in effect, which is Gmail through domain-wide delegation in a
 * deployed function (`gmail.ts`) and nothing at all under the emulator. Tests
 * swap the transport with `setMailTransport`, as `messaging.ts` lets them swap
 * the push sender, so a test records what would have gone and nothing goes.
 *
 * `sendMail` never throws: every message ends sent, failed (with the reason)
 * or skipped, and the caller decides what an outcome means.
 */

/** A person's name and address, as a header carries them. */
export interface Mailbox {
  name?: string;
  address: string;
}

/**
 * One message from the apps' sender, UTF-8.
 *
 * `text` is the message as plain text, ONE LINE PER PARAGRAPH: a mail
 * program on a phone wraps it to the screen, and a line broken by hand at a
 * fixed width reads ragged there. `html` is the same message as plain HTML;
 * when it is given, the two go together as multipart/alternative and the
 * reader's mail program shows the one it prefers, so they must say the same
 * thing.
 */
export interface OutgoingMail {
  to: Mailbox;
  /** Where a reply goes, when it is not the sender (who reads nothing). */
  replyTo?: Mailbox;
  subject: string;
  text: string;
  html?: string;
}

export type MailOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

/** What carries a composed message: the RFC 5322 text, and the mail it was made from. */
export type MailTransport = (raw: string, mail: OutgoingMail) => Promise<MailOutcome>;

/**
 * An address as a header may carry it: one `@`, nothing that could end the
 * header or start another. The callers' addresses come from the institute's
 * own records; this is the line a bad one stops at, before it is a header.
 */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** A header value with no line break or other control character in it: one line, always. */
const oneLine = (s: string) => s.replace(/\p{Cc}+/gu, ' ').trim();

/** The most bytes one encoded word carries: 45 bytes is 60 base64 characters, 72 with its delimiters. */
const WORD_BYTES = 45;

/**
 * RFC 2047 encoded words, split between characters, never inside one. A
 * header line may run to 998 characters and an encoded word to 75, so a long
 * Arabic subject becomes several words, folded onto lines of their own.
 */
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;
  for (const ch of text) {
    const bytes = Buffer.from(ch, 'utf8');
    if (size + bytes.length > WORD_BYTES) {
      words.push(Buffer.concat(chunk).toString('base64'));
      chunk = [];
      size = 0;
    }
    chunk.push(bytes);
    size += bytes.length;
  }
  if (chunk.length) words.push(Buffer.concat(chunk).toString('base64'));
  return words.map((w) => `=?UTF-8?B?${w}?=`).join('\r\n ');
}

/** Plain ASCII that needs no encoding. */
const isAscii = (s: string) => /^[\u0020-\u007e]*$/.test(s);

/** A header's free text: as is in ASCII, encoded words otherwise. */
function headerText(value: string): string {
  const line = oneLine(value);
  return isAscii(line) && line.length <= 900 ? line : encodedWords(line);
}

/** `Name <address>`: the name quoted when it is ASCII, encoded when it is not. */
export function mailbox(box: Mailbox): string {
  if (!ADDRESS.test(box.address)) throw new Error(`not an address a message can carry: ${JSON.stringify(box.address)}`);
  const name = oneLine(box.name ?? '');
  if (!name) return box.address;
  const phrase = isAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodedWords(name);
  return `${phrase} <${box.address}>`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** The `Date` header, in UTC: `Fri, 16 Oct 2026 15:04:05 +0000`. */
function rfc5322Date(at: Date): string {
  return `${DAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000`;
}

/** Text for HTML, element content or a quoted attribute alike: `&`, `<`, `>` and both quotes escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A person's own words in HTML: escaped, every line break kept as `<br>`. */
export function htmlLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(escapeHtml)
    .join('<br>\n');
}

/** A link that writes to `address`, for an address `mailbox` would accept. */
export function mailtoLink(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`not an address a message can carry: ${JSON.stringify(address)}`);
  const at = address.lastIndexOf('@');
  const href = `mailto:${encodeURIComponent(address.slice(0, at))}@${address.slice(at + 1)}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(address)}</a>`;
}

/** CRLF line ends, then base64 in lines of 76: no line of the message can pass 998. */
const base64Body = (content: string) =>
  Buffer.from(content.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n')
    .replace(/\r\n$/, '');

/** One body part's headers and content. */
const bodyPart = (type: 'text/plain' | 'text/html', content: string) =>
  [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Body(content)].join('\r\n');

/**
 * A boundary no part can contain: `_` is not in the base64 alphabet, and every
 * part is base64. Random, so no two messages share one.
 */
const newBoundary = () => `sabeel_alt_${randomBytes(12).toString('hex')}`;

/**
 * The message as Gmail's `messages.send` takes it, CRLF throughout.
 *
 * Every body is base64 UTF-8: a report is free text up to 2000 characters, and
 * one long paragraph would break the 998-character line limit as it stands.
 * With `html`, the message is multipart/alternative, the plain text first and
 * the HTML last, as RFC 2046 orders them (last is preferred).
 */
export function composeMessage(mail: OutgoingMail, from: Mailbox, at: Date, boundary: string = newBoundary()): string {
  const headers = [
    `From: ${mailbox(from)}`,
    `To: ${mailbox(mail.to)}`,
    ...(mail.replyTo ? [`Reply-To: ${mailbox(mail.replyTo)}`] : []),
    `Subject: ${headerText(mail.subject)}`,
    `Date: ${rfc5322Date(at)}`,
    'MIME-Version: 1.0',
  ];
  if (mail.html === undefined) return `${headers.join('\r\n')}\r\n${bodyPart('text/plain', mail.text)}\r\n`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    bodyPart('text/plain', mail.text),
    `--${boundary}`,
    bodyPart('text/html', mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * The service account the server signs the delegation token as. Not a secret:
 * it is an address, and only the runtime account granted Token Creator on it
 * can use it (`docs/DEPLOY.md`). Per project, in `functions/.env.<project>`.
 */
const MAILER_SERVICE_ACCOUNT = defineString('MAILER_SERVICE_ACCOUNT', {
  description: 'The service account authorised for domain-wide delegation to send as the apps sender',
});

let adc: GoogleAuth | null = null;

/** Through Gmail, as the apps' sender, with this function's own credentials. */
const gmailTransport: MailTransport = async (raw) => {
  adc ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const auth = adc;
  const messageId = await sendWithGmail(raw, {
    serviceAccount: MAILER_SERVICE_ACCOUNT.value(),
    sender: APPS_MAIL_SENDER.address,
    accessToken: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('no access token for this function’s own account');
      return token;
    },
  });
  return { status: 'sent', messageId };
};

/**
 * Under the emulator, and in this repo's tests, nothing leaves: the message is
 * logged where the emulator's log shows it, and the outcome says it was not
 * sent. Keyed on the project as well as the emulator flag, so a test process
 * against the demo project cannot reach Gmail with whatever credentials its
 * machine happens to hold.
 */
const skippedTransport: MailTransport = async (raw) => {
  console.log(`[emulator] mail not sent:\n${raw}`);
  return { status: 'skipped' };
};

function defaultTransport(): MailTransport {
  return process.env.FUNCTIONS_EMULATOR === 'true' || isEmulatorProject() ? skippedTransport : gmailTransport;
}

let transport: MailTransport = defaultTransport();

/** Swap the transport. Tests only; a deployed function never calls this. */
export function setMailTransport(next: MailTransport): void {
  transport = next;
}

/** Put the default back, whatever it is here: the emulator's, in a test. */
export function resetMailTransport(): void {
  transport = defaultTransport();
}

/**
 * Send one message as the apps' sender. Never throws: a message that cannot be
 * composed or carried comes back failed, with the reason.
 */
export async function sendMail(mail: OutgoingMail, at: Date = new Date()): Promise<MailOutcome> {
  try {
    return await transport(composeMessage(mail, APPS_MAIL_SENDER, at), mail);
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
