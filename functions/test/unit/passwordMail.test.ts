import { describe, it, expect } from 'vitest';
import { APP_NAME } from '@sabeel/shared';
import { composeMessage, plainMessage } from '../../src/mail';
import { isLinkable, linkKind, passwordMail, validateLinkEmail } from '../../src/passwordLinks';
import { parseMessage } from '../mailMessage';

/**
 * What a student is promised by a password email: it comes from the
 * institute, says which app and whether they are setting a password or
 * replacing one, carries the one link that does it, in the text and in the
 * HTML alike, and nothing of Firebase's. Who is sent one is held by
 * passwordLinks.integration.test.ts.
 */

const LINK = 'https://oursabeel-lms.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc&apiKey=k&continueUrl=https%3A%2F%2Foursabeel-lms.web.app%2F&lang=en';
const TO = { name: 'Fatima Ahmed', email: 'fatima@example.com' };

describe('passwordMail', () => {
  it('names the institute and the app, and says whether it sets or resets', () => {
    expect(passwordMail('set', TO, LINK).subject).toBe(`Set your password for the ${APP_NAME}`);
    expect(passwordMail('reset', TO, LINK).subject).toBe(`Reset your password for the ${APP_NAME}`);
    expect(APP_NAME).toBe('Sabeel Institute LMS');
  });

  it('goes to the student, by name, with no Reply-To', () => {
    const m = passwordMail('set', TO, LINK);
    expect(m.to).toEqual({ name: 'Fatima Ahmed', address: 'fatima@example.com' });
    expect(m.replyTo).toBeUndefined();
    expect(m.text.startsWith('Hello Fatima Ahmed,\n')).toBe(true);
  });

  it('carries the link in both parts: bare in the text, an anchor in the HTML', () => {
    for (const kind of ['set', 'reset'] as const) {
      const m = passwordMail(kind, TO, LINK);
      expect(m.text.split('\n')).toContain(LINK);
      expect(m.html).toContain(`<a href="${LINK.replace(/&/g, '&amp;')}">`);
      expect(m.html!.match(/<a /g)).toHaveLength(1);
    }
  });

  it('says the same thing in both parts', () => {
    const m = passwordMail('set', TO, LINK);
    const shown = m.html!
      .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");
    for (const paragraph of m.text.split('\n\n').filter((p) => p !== LINK)) expect(shown).toContain(paragraph);
  });

  it('writes one line per paragraph, and nothing of Firebase in the words', () => {
    for (const kind of ['set', 'reset'] as const) {
      const m = passwordMail(kind, TO, LINK);
      for (const p of m.text.split('\n\n')) expect(p).not.toContain('\n');
      expect(m.text.replace(LINK, '')).not.toMatch(/firebase/i);
      expect(m.subject).not.toMatch(/firebase/i);
    }
  });

  it('tells a new student how to sign in once it is set, and the link’s limits', () => {
    const { text } = passwordMail('set', TO, LINK);
    expect(text).toContain('The link works once, within an hour.');
    expect(text).toContain('sign in with fatima@example.com');
  });

  it('escapes a name that would otherwise be markup', () => {
    const { html } = passwordMail('reset', { name: 'Eve <script>x</script>', email: 'eve@example.com' }, LINK);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Hello Eve &lt;script&gt;x&lt;/script&gt;,');
  });

  it('greets without a name when the account has none', () => {
    expect(passwordMail('reset', { name: '', email: 'x@example.com' }, LINK).text.startsWith('Hello,\n')).toBe(true);
  });

  it('composes as multipart/alternative, from the apps’ sender', () => {
    const m = parseMessage(composeMessage(passwordMail('set', TO, LINK), { name: 'Sabeel Apps No Reply', address: 'apps-noreply@oursabeel.com' }, new Date(0)));
    expect(m.headers.get('content-type')).toMatch(/^multipart\/alternative;/);
    expect(m.headers.get('to')).toBe('"Fatima Ahmed" <fatima@example.com>');
    expect(m.text?.replace(/\r\n/g, '\n')).toContain(LINK);
  });
});

describe('plainMessage', () => {
  it('refuses a link that is not http(s)', () => {
    expect(() => plainMessage([{ link: 'javascript:alert(1)', label: 'x' }])).toThrow(/not a link/);
    expect(() => plainMessage([{ link: 'https://ok.example/a b', label: 'x' }])).toThrow(/not a link/);
  });
});

describe('who a link is for', () => {
  const student = { email: 'f@example.com', disabled: false, customClaims: { role: 'student', status: 'active' } };

  it('is an active student, and nobody else', () => {
    expect(isLinkable(student)).toBe(true);
    expect(isLinkable({ ...student, disabled: true })).toBe(false);
    expect(isLinkable({ ...student, customClaims: { role: 'student', status: 'disabled' } })).toBe(false);
    expect(isLinkable({ ...student, customClaims: { role: 'manager', status: 'active' } })).toBe(false);
    expect(isLinkable({ ...student, customClaims: { role: 'admin', status: 'active' } })).toBe(false);
    expect(isLinkable({ ...student, customClaims: undefined })).toBe(false);
    expect(isLinkable({ ...student, email: undefined })).toBe(false);
  });

  it('sets a password for an account that never had one, and resets one otherwise', () => {
    expect(linkKind({ providerData: [] })).toBe('set');
    expect(linkKind({ providerData: [{ providerId: 'password' }] as never })).toBe('reset');
  });
});

describe('validateLinkEmail', () => {
  it('takes an address, trimmed and lower case, and refuses anything else in one sentence', () => {
    expect(validateLinkEmail({ email: '  Fatima@Example.COM ' })).toBe('fatima@example.com');
    for (const email of [undefined, '', 'fatima', 'fatima@', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`, 42]) {
      expect(() => validateLinkEmail({ email }), String(email)).toThrow('Enter the email address your teacher registered.');
    }
  });
});
