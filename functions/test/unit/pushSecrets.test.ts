import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every function that can send a notification is given Apple's key.
 *
 * A secret that is not bound to a function reads as empty inside it, so a
 * sender added without `PUSH_SECRETS` would deliver to Android phones and
 * browsers, and refuse every iPhone — loudly in the log (`messaging.ts`), and
 * silently to the person who was meant to hear. Nothing else would show it:
 * the emulator never sends, and no other test reaches Apple.
 *
 * The senders are FOUND, not listed: every exported function whose body calls
 * one of the notify entry points. A list would have to be remembered by the
 * person adding the next one, which is the failure this exists to catch.
 */

const SRC = resolve(import.meta.dirname, '..', '..', 'src');
const source = (file: string) => readFileSync(resolve(SRC, file), 'utf8');

/** What sends: `notifyOnce`, and every notify function the two job modules export. */
const ENTRY_MODULES = ['notify.ts', 'notifyJobs.ts', 'notifyCoursework.ts'];
const entryPoints = ENTRY_MODULES.flatMap((file) =>
  [...source(file).matchAll(/^export async function (notify\w*)\(/gm)].map((m) => m[1]),
);

/** The exported functions (deployed ones are `export const X = on…/…Call(`) that call an entry point. */
function senders(): string[] {
  const found = new Set<string>();
  const call = new RegExp(`\\b(${entryPoints.join('|')})\\(`);
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && !ENTRY_MODULES.includes(f))) {
    let current: string | null = null;
    for (const line of source(file).split('\n')) {
      const start = /^export const (\w+) = /.exec(line);
      if (start) current = start[1];
      else if (/^(export )?(async )?function |^const \w+ = /.test(line)) current = null;
      if (current && call.test(line)) found.add(current);
    }
  }
  return [...found].sort();
}

describe('push senders', () => {
  it('are found, so the scan cannot pass by finding nothing', () => {
    expect(entryPoints).toEqual(expect.arrayContaining(['notifyOnce', 'notifyRecordingReady', 'notifyReturned']));
    // The ones that send today. A new sender joins this list by being found;
    // one that stops sending leaves it. Either way this line is updated
    // knowingly, and the next test covers whatever is found.
    expect(senders()).toEqual([
      'onAssignmentWritten',
      'onMorning',
      'postCoursework',
      'returnWork',
      'saveGrade',
      'updateCoursework',
    ]);
  });

  it('are each bound to APNS_KEY', async () => {
    const fns = (await import('../../src/index')) as unknown as Record<
      string,
      { __endpoint?: { secretEnvironmentVariables?: { key: string }[] } }
    >;
    for (const name of senders()) {
      const keys = fns[name]?.__endpoint?.secretEnvironmentVariables?.map((s) => s.key) ?? [];
      expect({ name, keys }).toEqual({ name, keys: expect.arrayContaining(['APNS_KEY']) });
    }
  });
});
