import { getAuth } from 'firebase-admin/auth';
import { defineString } from 'firebase-functions/params';
import type { TokenClaims } from '@sabeel/shared';

/**
 * Who this deployment may send push notifications to.
 *
 * Until switchover day the institute's project holds a copy of every real
 * account, seeded from the personal project that still runs the live app and
 * still sends every reminder. A student who signs in here while it is being
 * built would hear about each recording twice — once from each app. So, until
 * the day everyone moves, only staff (and any test account named here) are
 * notified, and on that day the value becomes `everyone`.
 *
 * The value is per project, in `functions/.env.<projectId>`:
 *
 *   NOTIFY_AUDIENCE=everyone
 *   NOTIFY_AUDIENCE=staff
 *   NOTIFY_AUDIENCE=staff,test.student@example.com
 *
 * `staff` is every account whose role claim is admin or manager — the token's
 * claim, which is the authority, not the directory mirror.
 *
 * FAILS CLOSED. Empty or absent means nobody, never everyone, so a project
 * deployed without the file cannot message real people. An entry that is
 * neither `staff` nor an email address — a uid pasted in, a capitalised
 * "Everyone", "everyone" inside a list — throws, so the trigger fails loudly in
 * the logs rather than quietly notifying nobody or the wrong people.
 */
const NOTIFY_AUDIENCE = defineString('NOTIFY_AUDIENCE', {
  description: '"everyone", or a comma-separated list of "staff" and email addresses that may be notified',
});

type Audience =
  | { everyone: true }
  | { everyone: false; staff: boolean; emails: ReadonlySet<string> };

function parseAudience(raw: string): Audience {
  const value = raw.trim();
  if (value === 'everyone') return { everyone: true };
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const emails = entries.filter((e) => e !== 'staff');
  const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+$/.test(e));
  if (bad.length > 0) {
    throw new Error(
      `NOTIFY_AUDIENCE must be "everyone" or a comma-separated list of "staff" and email addresses; not ${bad.join(', ')}`,
    );
  }
  return {
    everyone: false,
    staff: entries.includes('staff'),
    // Auth stores addresses lower-cased, so compare that way.
    emails: new Set(emails.map((e) => e.toLowerCase())),
  };
}

/** May this person be notified by this deployment? */
export async function inNotifyAudience(uid: string): Promise<boolean> {
  const audience = parseAudience(NOTIFY_AUDIENCE.value());
  if (audience.everyone) return true;
  if (!audience.staff && audience.emails.size === 0) return false;
  try {
    const user = await getAuth().getUser(uid);
    const role = (user.customClaims as TokenClaims | undefined)?.role;
    if (audience.staff && (role === 'admin' || role === 'manager')) return true;
    return !!user.email && audience.emails.has(user.email.toLowerCase());
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/user-not-found') return false;
    throw e;
  }
}
