import { describe, expect, it } from 'vitest';
import { minimalEnvelope } from './sentryEnvelope';

const DSN = 'https://0123abcd@o1.ingest.sentry.io/4507';
const base = {
  release: '1.4.0 (abc1234)',
  role: 'manager',
  page: 'https://lms.example/people/AbCdEfGhIjKlMnOpQrStUvWxYz12/ledger',
  eventId: 'f'.repeat(32),
  now: Date.UTC(2026, 9, 14, 12),
};

/*
 * AN ERROR STILL REACHES SENTRY WHEN ITS LIBRARY CANNOT LOAD, and says no
 * more than the library would: the build, the role and the page without the
 * account id in its address.
 */
describe('the fallback report', () => {
  it('goes to the DSN’s envelope address, with the error, the build and the role', () => {
    const env = minimalEnvelope(DSN, { ...base, error: new TypeError('x is undefined'), tags: { source: 'grade' } })!;
    expect(env.url).toBe('https://o1.ingest.sentry.io/api/4507/envelope/?sentry_key=0123abcd&sentry_version=7');
    const [head, item, event] = env.body.split('\n').map((l) => JSON.parse(l));
    expect(head.event_id).toBe(base.eventId);
    expect(item).toEqual({ type: 'event' });
    expect(event).toMatchObject({
      release: base.release,
      tags: { role: 'manager', source: 'grade' },
      exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
    });
  });

  it('names nobody: the account id leaves the page address', () => {
    const env = minimalEnvelope(DSN, { ...base, error: new Error('boom') })!;
    expect(env.body).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz12');
    expect(JSON.parse(env.body.split('\n')[2]).request).toEqual({ url: 'https://lms.example/people/:id/ledger' });
  });

  it('sends nothing for a DSN it cannot read', () => {
    expect(minimalEnvelope('not a dsn', { ...base, error: new Error('boom') })).toBeNull();
  });
});
