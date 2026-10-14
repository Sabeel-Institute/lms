/**
 * Refuse to run once the institute has moved to this project.
 *
 * Switchover day sets `NOTIFY_AUDIENCE=everyone` (docs/plans/SWITCHOVER.md).
 * From then on the project holds real students, and a demo seed would put
 * invented hand-ins, grades, feedback and listening on their records. The
 * demo seeds call this first; the wipe is safe either way (it removes only
 * what carries the demo marks).
 */
import { readFileSync } from 'node:fs';
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';

export function refuseAfterSwitchover(script) {
  const env = readFileSync(new URL(`../../functions/.env.${FIREBASE_PROJECT_ID}`, import.meta.url), 'utf8');
  const audience = /^NOTIFY_AUDIENCE=(.*)$/m.exec(env)?.[1]?.trim();
  if (audience === 'everyone') {
    console.error(
      `${script}: refused. This project is the live app now (NOTIFY_AUDIENCE=everyone), and demo data would land on real students' records.`,
    );
    process.exit(2);
  }
}
