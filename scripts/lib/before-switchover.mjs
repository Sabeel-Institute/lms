/**
 * Refuse to run once the institute has moved to this project.
 *
 * Switchover day sets `NOTIFY_AUDIENCE=everyone` (docs/plans/SWITCHOVER.md),
 * after the final seed. From then on the project holds real students' work:
 * a demo seed would put invented hand-ins, grades and listening on their
 * records, and the legacy seed would wipe everything made since the move and
 * put the frozen legacy copy in its place. Each calls this before reading
 * anything; the demo wipe is safe either way (it removes only what carries
 * the demo marks).
 */
import { readFileSync } from 'node:fs';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';

export function refuseAfterSwitchover(script, harm) {
  const env = readFileSync(new URL(`../../functions/.env.${FIREBASE_PROJECT_ID}`, import.meta.url), 'utf8');
  const audience = /^NOTIFY_AUDIENCE=(.*)$/m.exec(env)?.[1]?.trim();
  if (audience === 'everyone') {
    console.error(
      `${script}: refused. This project is the live app now (NOTIFY_AUDIENCE=everyone), and ${harm}.`,
    );
    process.exit(2);
  }
}
