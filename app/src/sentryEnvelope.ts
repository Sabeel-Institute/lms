import { withoutIds } from './withoutIds';

/**
 * One error as Sentry's own envelope, for when the Sentry library cannot be
 * loaded: a tab opened before a deploy asks for the old build's copy of it,
 * which is gone, and every error after that was dropped without a word.
 *
 * The least an event can be: what failed, the build, the role and the page
 * with its ids taken out, as the library's own `beforeSend` leaves it. Nobody
 * is named, as the privacy policy says.
 */
export function minimalEnvelope(
  dsn: string,
  report: { error: unknown; release: string; role: string; page: string; tags?: Record<string, string>; eventId: string; now: number },
): { url: string; body: string } | null {
  const m = /^https:\/\/([0-9a-f]+)@([^/]+)\/(\d+)$/.exec(dsn);
  if (!m) return null;
  const [, key, host, project] = m;
  const e = report.error;
  const type = e instanceof Error ? e.name : typeof e;
  const value = e instanceof Error ? e.message : String(e);
  const event = {
    event_id: report.eventId,
    timestamp: report.now / 1000,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release: report.release,
    tags: { ...report.tags, role: report.role, reporter: 'fallback' },
    exception: { values: [{ type, value }] },
    request: { url: withoutIds(report.page) },
  };
  return {
    url: `https://${host}/api/${project}/envelope/?sentry_key=${key}&sentry_version=7`,
    body: [
      JSON.stringify({ event_id: report.eventId, sent_at: new Date(report.now).toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n'),
  };
}
