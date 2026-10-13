import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PREF_KEYS } from '@sabeel/shared';

/**
 * The notification-preference whitelist exists twice, and this is what proves
 * the two agree.
 *
 * `firestore.rules` cannot import TypeScript, so its `hasOnly([...])` lists are
 * literals — a second, independent source for the same fact as `PREF_KEYS`.
 * Adding a fourth NotificationKind updates the shared constant automatically and
 * the rules not at all, and the only symptom would be the new switch being
 * denied on write: no build error, no test failure, nothing in the app but a
 * toggle that silently refuses to move.
 *
 * Static rather than an emulator test on purpose — it is about the two lists
 * matching, which needs no Firestore and belongs in the fast suite.
 */

const RULES = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8');

/** The `match /notifications/{uid}` body, up to its device subcollection. */
function notificationsBlock(): string {
  const start = RULES.indexOf('match /notifications/');
  expect(start, 'the notifications match block moved or was renamed').toBeGreaterThan(-1);
  const end = RULES.indexOf('match /devices/', start);
  expect(end, 'the devices subcollection moved out of the notifications block').toBeGreaterThan(
    start,
  );
  return RULES.slice(start, end);
}

function hasOnlyLists(source: string): string[][] {
  return [...source.matchAll(/hasOnly\(\s*\[([^\]]*)\]/g)].map((m) =>
    m[1]
      .split(',')
      .map((k) => k.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  );
}

describe('notification preference keys', () => {
  it('are the same list in firestore.rules as in @sabeel/shared', () => {
    const lists = hasOnlyLists(notificationsBlock());
    // Two arms — create and update — because `resource` is null on a create, so
    // one combined condition would be an evaluation error rather than a denial.
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect([...list].sort()).toEqual([...PREF_KEYS].sort());
    }
  });

  it('covers every kind plus the timestamp, and nothing else', () => {
    // Guards the constant itself: a kind dropped from PREF_KEYS would still
    // satisfy the test above, because the rules would be "corrected" to match it.
    expect([...PREF_KEYS].sort()).toEqual(
      ['assignmentPosted', 'attendanceMissing', 'handInLastDay', 'lastDay', 'recordingReady', 'updatedAt', 'workReturned'],
    );
  });
});
