import { describe, it, expect, afterEach } from 'vitest';
import { APPS_MAIL_SENDER } from '@sabeel/shared';
import { composeMessage, mailbox, resetMailTransport, sendMail, setMailTransport, type MailTransport } from '../../src/mail';

/**
 * What a message from the apps promises its reader: it is from the apps'
 * sender, it reaches the address it names, a reply goes to the person it says,
 * and the subject and the words arrive as written, in any script. Read here
 * the way a mail program reads them: headers unfolded, encoded words and the
 * body decoded.
 */

const AT = new Date(Date.UTC(2026, 9, 16, 15, 4, 5));
const FROM = { name: APPS_MAIL_SENDER.name, address: APPS_MAIL_SENDER.address };

/** The headers, unfolded, by lower-case name; and the body, decoded. */
function parse(raw: string) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, body, head };
}

/**
 * RFC 2047 decoded, as a mail program shows a header: the space between two
 * encoded words is not text, the space after the last one is. Each word is
 * decoded on its own, as RFC 2047 requires, so a character split across two
 * words would show here as a replacement character.
 */
const decoded = (value: string) =>
  value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));

describe('composeMessage', () => {
  const mail = {
    to: { address: 'apps-reports@oursabeel.com' },
    replyTo: { name: 'Fatima Ahmed', address: 'fatima@example.com' },
    subject: '[Sabeel Institute LMS] Report from Fatima Ahmed',
    text: 'Line one.\nLine two, after a newline.',
  };

  it('is from the apps’ sender, to the address given, with replies to the person', () => {
    const { headers } = parse(composeMessage(mail, FROM, AT));
    expect(headers.get('from')).toBe('"Sabeel Apps No Reply" <apps-noreply@oursabeel.com>');
    expect(headers.get('to')).toBe('apps-reports@oursabeel.com');
    expect(headers.get('reply-to')).toBe('"Fatima Ahmed" <fatima@example.com>');
    expect(headers.get('subject')).toBe('[Sabeel Institute LMS] Report from Fatima Ahmed');
    expect(headers.get('date')).toBe('Fri, 16 Oct 2026 15:04:05 +0000');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('content-type')).toBe('text/plain; charset=UTF-8');
  });

  it('carries no Reply-To when none is asked for', () => {
    const { headers } = parse(composeMessage({ ...mail, replyTo: undefined }, FROM, AT));
    expect(headers.has('reply-to')).toBe(false);
  });

  it('delivers the words as written, every line ending CRLF, no line past the limit', () => {
    const long = 'x'.repeat(2000);
    const raw = composeMessage({ ...mail, text: `First.\r\nSecond.\nThird ${long}` }, FROM, AT);
    expect(parse(raw).body).toBe(`First.\r\nSecond.\r\nThird ${long}`);
    expect(raw.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    // No bare LF anywhere: Gmail takes the message as RFC 5322 says it is.
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('keeps Arabic, accents and emoji in the subject, the names and the body, encoded as RFC 2047 asks', () => {
    const name = 'عبد الرحمن الشنقيطي';
    const subject = `[Sabeel Institute LMS] Report from ${name} — about “Session 1” ✓`;
    const raw = composeMessage(
      { ...mail, replyTo: { name, address: 'abd@example.com' }, subject, text: `السلام عليكم. Café ✓ 🙂` },
      FROM,
      AT,
    );
    const { headers, body, head } = parse(raw);
    // Nothing but ASCII in the header block, every encoded word within 75 characters.
    expect(head).toMatch(/^[\x20-\x7e\r\n]*$/);
    for (const word of head.match(/=\?[^?]+\?B\?[^?]*\?=/g) ?? []) expect(word.length).toBeLessThanOrEqual(75);
    expect(decoded(headers.get('subject')!)).toBe(subject);
    expect(decoded(headers.get('reply-to')!)).toBe(`${name} <abd@example.com>`);
    expect(body).toBe('السلام عليكم. Café ✓ 🙂');
  });

  it('never splits a character across two encoded words', () => {
    const subject = '🙂'.repeat(40);
    const words = composeMessage({ ...mail, subject }, FROM, AT).match(/=\?UTF-8\?B\?([^?]*)\?=/g)!;
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      const bytes = Buffer.from(w.slice(10, -2), 'base64');
      expect(bytes.toString('utf8')).not.toContain('�');
    }
  });

  it('cannot be made to carry a header of someone else’s choosing', () => {
    const raw = composeMessage(
      {
        ...mail,
        replyTo: { name: 'Fatima\r\nBcc: everyone@example.com', address: 'fatima@example.com' },
        subject: 'Hello\r\nBcc: everyone@example.com',
      },
      FROM,
      AT,
    );
    const { headers } = parse(raw);
    expect(headers.has('bcc')).toBe(false);
    expect(headers.get('subject')).toBe('Hello Bcc: everyone@example.com');
  });

  it('quotes a name that would otherwise read as syntax', () => {
    expect(mailbox({ name: 'Khan, Bilal "B"', address: 'bilal@example.com' })).toBe('"Khan, Bilal \\"B\\"" <bilal@example.com>');
    expect(mailbox({ address: 'bilal@example.com' })).toBe('bilal@example.com');
  });

  it('refuses an address that is not one', () => {
    for (const address of ['', 'nobody', 'a@b', 'x@example.com\r\nBcc: y@example.com', 'two@at@example.com', 'sp ace@example.com']) {
      expect(() => mailbox({ address }), address).toThrow(/not an address/);
    }
  });
});

describe('sendMail', () => {
  afterEach(() => resetMailTransport());

  it('hands the transport the composed message and returns what it says', async () => {
    const seen: string[] = [];
    const transport: MailTransport = async (raw) => {
      seen.push(raw);
      return { status: 'sent', messageId: 'm1' };
    };
    setMailTransport(transport);
    const out = await sendMail({ to: { address: 'apps-reports@oursabeel.com' }, subject: 'Hi', text: 'Body' }, AT);
    expect(out).toEqual({ status: 'sent', messageId: 'm1' });
    expect(seen).toHaveLength(1);
    expect(parse(seen[0]).headers.get('from')).toBe('"Sabeel Apps No Reply" <apps-noreply@oursabeel.com>');
  });

  it('turns a transport that throws into a failed outcome with its reason, never an exception', async () => {
    setMailTransport(async () => {
      throw new Error('signJwt refused (HTTP 403): Permission denied');
    });
    expect(await sendMail({ to: { address: 'apps-reports@oursabeel.com' }, subject: 'Hi', text: 'Body' })).toEqual({
      status: 'failed',
      error: 'signJwt refused (HTTP 403): Permission denied',
    });
  });

  it('fails a message it cannot compose without reaching the transport', async () => {
    let called = false;
    setMailTransport(async () => {
      called = true;
      return { status: 'skipped' };
    });
    const out = await sendMail({ to: { address: 'not an address' }, subject: 'Hi', text: 'Body' });
    expect(out.status).toBe('failed');
    expect(called).toBe(false);
  });

  it('sends nothing in a test process against the demo project: the default transport skips', async () => {
    resetMailTransport();
    expect(await sendMail({ to: { address: 'apps-reports@oursabeel.com' }, subject: 'Hi', text: 'Body' })).toEqual({ status: 'skipped' });
  });
});
