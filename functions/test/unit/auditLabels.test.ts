import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUDIT_ACTION_LABELS } from '@sabeel/shared';

/**
 * Every action the server audits has a sentence, and every sentence has an
 * action.
 *
 * The audit screen maps an action name to English and falls back to the name
 * itself, so a missing entry is not an error anywhere — it is one camelCase
 * function name sitting in a list of sentences, on the screen people consult to
 * establish what happened. The map's own docblock said "adding an
 * `auditedCall` means adding a line here" from the day it was written, and by
 * the time anyone checked it was wrong in BOTH directions: every Zoom import
 * rendered as `importZoomRecording`, while `assignCatchup` and `updateRecording`
 * labelled actions no callable had written since the catch-up concept was
 * removed. A rule stated in a comment is not a rule.
 *
 * The server's side BY TEXT: what matters is that the list is read from the
 * files that write the actions, not restated here. The words are
 * `AUDIT_ACTION_LABELS` in @sabeel/shared, which `check:documents` also holds
 * every stored entry to.
 *
 * Lives in `functions/test/unit` because that workspace is the only one here
 * with a runner wired up — same reasoning as `emulatorPorts.test.ts` next door.
 */
const REPO = resolve(import.meta.dirname, '../../..');

/**
 * What the server writes into `auditLog.action`.
 *
 * Three shapes, and all are real: `auditedCall('name', …)` wraps a callable;
 * the auth trigger — which has no callable to wrap — hands `writeAudit` an
 * entry carrying its own `action`; and it counts rejected sign-ups in one row
 * a day, written to the log by id. The last two are matched against their
 * writes rather than against a bare `action:` key: `action` is also a Cloud
 * Storage signed-URL option and a discriminant in `provision.ts`, and matching
 * those would have this test demand English for `read` and `ignore`.
 */
function serverActions(): Set<string> {
  const dir = resolve(REPO, 'functions/src');
  const out = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(dir, file), 'utf8');
    for (const m of src.matchAll(/auditedCall\(\s*'([A-Za-z]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/writeAudit\(\{[\s\S]*?action:\s*'([A-Za-z]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/collection\(COLLECTIONS\.auditLog\)\s*\.doc\([^)]*\)\s*\.set\(\s*\{[\s\S]*?action:\s*'([A-Za-z]+)'/g)) {
      out.add(m[1]);
    }
  }
  return out;
}

/** The actions the audit screen has words for. */
const labelledActions = () => new Set(Object.keys(AUDIT_ACTION_LABELS));

describe('audit action labels', () => {
  // A guard on the guard: if either reader stops matching, both sets go empty
  // and every assertion below passes for the wrong reason.
  it('found both lists', () => {
    expect(serverActions().size).toBeGreaterThan(15);
    expect(labelledActions().size).toBeGreaterThan(15);
  });

  it('gives every audited action a sentence', () => {
    const missing = [...serverActions()].filter((a) => !labelledActions().has(a)).sort();
    expect(missing).toEqual([]);
  });

  it('carries no sentence for an action nothing writes', () => {
    const orphaned = [...labelledActions()].filter((a) => !serverActions().has(a)).sort();
    expect(orphaned).toEqual([]);
  });
});
