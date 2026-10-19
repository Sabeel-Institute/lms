import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

vi.mock('@sentry/node', () => sentry);

describe('server error reporting privacy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, 'disabled', 'not-a-dsn'])('does not initialize for %s', async (dsn) => {
    vi.stubEnv('SENTRY_DSN', dsn);
    const { reportError } = await import('../../src/sentry');
    await reportError(new Error('test'));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('preserves restrictive collection, reports and flushes once initialized', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    const { reportError } = await import('../../src/sentry');
    const error = new Error('test');
    await reportError(error, { operation: 'test' });
    await reportError(error);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init).toHaveBeenCalledWith({
      dsn: 'https://public@example.invalid/1',
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: {
          request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
          response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        },
        httpBodies: [],
        urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
      },
    });
    expect(sentry.captureException).toHaveBeenCalledWith(error, { tags: { operation: 'test' } });
    expect(sentry.flush).toHaveBeenCalledTimes(2);
    expect(sentry.flush).toHaveBeenCalledWith(2000);
  });
});
