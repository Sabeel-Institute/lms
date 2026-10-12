import { getAuth } from 'firebase-admin/auth';
import { defineString } from 'firebase-functions/params';

/**
 * Who this deployment may send push notifications to.
 *
 * Until switchover day the institute's project holds a copy of every real
 * account, seeded from the personal project that still runs the live app and
 * still sends every reminder. A student who signs in here while it is being
 * built would hear about each recording twice — once from each app. So, until
 * the day everyone moves, only the testers named here are notified, and on that
 * day the value becomes `everyone`.
 *
 * The value is per project, in `functions/.env.<projectId>`:
 *
 *   NOTIFY_AUDIENCE=everyone
 *   NOTIFY_AUDIENCE=faisal.shah@oursabeel.com,tester@example.com
 *
 * FAILS CLOSED. Empty or absent means nobody, never everyone, so a project
 * deployed without the file cannot message real people. A value that is
 * neither `everyone` nor a list of email addresses — a uid pasted in, a
 * capitalised "Everyone" — throws, so the trigger fails loudly in the logs
 * rather than quietly notifying nobody or the wrong people.
 */
const NOTIFY_AUDIENCE = defineString('NOTIFY_AUDIENCE', {
  description: '"everyone", or a comma-separated list of the email addresses that may be notified',
});

type Audience = { everyone: true } | { everyone: false; emails: ReadonlySet<string> };

function parseAudience(raw: string): Audience {
  const value = raw.trim();
  if (value === 'everyone') return { everyone: true };
  const emails = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+$/.test(e));
  if (bad.length > 0) {
    throw new Error(
      `NOTIFY_AUDIENCE must be "everyone" or a comma-separated list of email addresses; not ${bad.join(', ')}`,
    );
  }
  // Auth stores addresses lower-cased, so compare that way.
  return { everyone: false, emails: new Set(emails.map((e) => e.toLowerCase())) };
}

/** May this person be notified by this deployment? */
export async function inNotifyAudience(uid: string): Promise<boolean> {
  const audience = parseAudience(NOTIFY_AUDIENCE.value());
  if (audience.everyone) return true;
  if (audience.emails.size === 0) return false;
  try {
    const { email } = await getAuth().getUser(uid);
    return !!email && audience.emails.has(email.toLowerCase());
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/user-not-found') return false;
    throw e;
  }
}
