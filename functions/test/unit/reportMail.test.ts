import { describe, it, expect } from 'vitest';
import { APP_NAME, APPS_REPORTS_ADDRESS } from '@sabeel/shared';
import { instituteTime, reportMail, type ReportFacts } from '../../src/reportMail';
import { composeMessage } from '../../src/mail';
import { parseMessage } from '../mailMessage';

/**
 * What an administrator reading a report needs from the email: who sent it
 * and how to answer them (a reply goes straight back to that person), when in
 * the institute's own time, from which app and build, and the person's words
 * exactly as they wrote them.
 */

const REPORT: ReportFacts = {
  id: 'r123',
  uid: 'uid-fatima',
  displayName: 'Fatima Ahmed',
  email: 'fatima@example.com',
  role: 'student',
  // 2026-10-16 15:04 UTC is 10:04 in Houston (CDT, UTC-5).
  createdAt: Date.UTC(2026, 9, 16, 15, 4, 5),
  text: '  A comment on Session 1 was abusive.\n\nIt was posted by "Bilal".  ',
  platform: 'android',
  appVersion: 'v0.1.3 · abc1234',
};

describe('reportMail', () => {
  it('goes to the administrators’ group, and a reply goes to the person who reported', () => {
    const m = reportMail(REPORT);
    expect(m.to).toEqual({ address: APPS_REPORTS_ADDRESS });
    expect(APPS_REPORTS_ADDRESS).toBe('apps-reports@oursabeel.com');
    expect(m.replyTo).toEqual({ name: 'Fatima Ahmed', address: 'fatima@example.com' });
  });

  it('is titled by the app and the person', () => {
    expect(reportMail(REPORT).subject).toBe(`[${APP_NAME}] Report from Fatima Ahmed`);
    expect(APP_NAME).toBe('Sabeel Institute LMS');
  });

  it('says who, when in the institute’s time, from which app and build, then the words verbatim', () => {
    const { text } = reportMail(REPORT);
    expect(text).toContain('Name:    Fatima Ahmed');
    expect(text).toContain('Email:   fatima@example.com');
    expect(text).toContain('Role:    student');
    expect(text).toContain('Account: uid-fatima');
    expect(text).toMatch(/When: {4}Friday, October 16, 2026 at 10:04\sAM CDT\n/);
    expect(text).toContain('App:     Sabeel Institute LMS v0.1.3 · abc1234 on Android');
    expect(text).toContain('Report:  r123');
    // Verbatim: the spaces and the blank line inside it kept.
    expect(text).toContain(`What they wrote:\n\n${REPORT.text}\n`);
    expect(text.indexOf('What they wrote:')).toBeGreaterThan(text.indexOf('Report:  r123'));
  });

  it('names staff as staff', () => {
    expect(reportMail({ ...REPORT, role: 'admin' }).text).toContain('Role:    staff (admin)');
    expect(reportMail({ ...REPORT, role: 'manager' }).text).toContain('Role:    staff (manager)');
  });

  it('leaves out what the app did not send', () => {
    const { text } = reportMail({ ...REPORT, platform: undefined, appVersion: undefined });
    expect(text).toContain(`App:     ${APP_NAME}\n`);
  });

  it('carries no Reply-To for an account with no address, and says a reply reaches nobody', () => {
    const m = reportMail({ ...REPORT, email: null });
    expect(m.replyTo).toBeUndefined();
    expect(m.text).toContain('a reply here reaches nobody');
  });
});

describe('reportMail, as text and as HTML', () => {
  /** What a reader sees of an HTML part: tags gone, entities read. */
  const shown = (html: string) =>
    html
      .replace(/<br>\n?/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');

  it('carries the same facts in both parts', () => {
    const { text, html } = reportMail(REPORT);
    const facts = [
      'Fatima Ahmed sent this with Report a problem.',
      'Fatima Ahmed',
      'fatima@example.com',
      'student',
      'uid-fatima',
      'Friday, October 16, 2026 at 10:04',
      'Sabeel Institute LMS v0.1.3 · abc1234 on Android',
      'r123',
      'What they wrote:',
      REPORT.text.trim(),
      'Reply to this email to answer Fatima Ahmed; it goes to fatima@example.com.',
    ];
    for (const fact of facts) {
      expect(text, fact).toContain(fact);
      expect(shown(html!).replace(/\u202f/g, ' '), fact).toContain(fact);
    }
  });

  it('writes one line per paragraph in the text: nothing wrapped by hand', () => {
    const long = 'word '.repeat(120).trim();
    const { text } = reportMail({ ...REPORT, text: long, displayName: 'Abd al-Rahman ibn Muhammad al-Shinqiti' });
    expect(text.split('\n')).toContain(long);
    expect(text.split('\n')).toContain('Abd al-Rahman ibn Muhammad al-Shinqiti sent this with Report a problem.');
  });

  it('cannot be made to carry markup by what the person typed', () => {
    const hostile = {
      ...REPORT,
      displayName: 'Eve <img src=x onerror=alert(1)>',
      text: '</p><script>alert("x")</script> & <a href=\'https://evil.example\'>click</a>\nline two',
    };
    const { html } = reportMail(hostile);
    // Escaped, the words are text: no element of theirs is in the page.
    expect(html).not.toMatch(/<script|<img|<a href='https/i);
    expect(html).toContain('&lt;/p&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;a href=&#39;https://evil.example&#39;&gt;click&lt;/a&gt;<br>\nline two');
    expect(html).toContain('Eve &lt;img src=x onerror=alert(1)&gt;');
    // The one link is the reporter's address.
    expect(html!.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<a href="mailto:fatima@example.com">fatima@example.com</a>');
    // No styling, no images, no scripts of its own.
    expect(html).not.toMatch(/<style|style=|<img|<script|class=/i);
  });

  it('keeps the person’s line breaks in the HTML', () => {
    const { html } = reportMail({ ...REPORT, text: 'First.\n\nSecond.' });
    expect(html).toContain('<p>First.<br>\n<br>\nSecond.</p>');
  });

  it('goes as multipart/alternative, both parts readable back to the same words', () => {
    const m = parseMessage(composeMessage(reportMail(REPORT), { address: 'apps-noreply@oursabeel.com' }, new Date(REPORT.createdAt)));
    expect(m.headers.get('content-type')).toMatch(/^multipart\/alternative; boundary="/);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    expect(lf(m.text!)).toContain(REPORT.text);
    expect(shown(lf(m.html!))).toContain(REPORT.text.trim());
  });
});

describe('instituteTime', () => {
  it('reads the clock in Houston, through daylight saving', () => {
    expect(instituteTime(Date.UTC(2026, 0, 15, 18, 30))).toMatch(/^Thursday, January 15, 2026 at 12:30\sPM CST$/);
    expect(instituteTime(Date.UTC(2026, 6, 15, 18, 30))).toMatch(/^Wednesday, July 15, 2026 at 1:30\sPM CDT$/);
  });
});
