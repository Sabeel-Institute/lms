import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AUDIT_ACTION_LABELS } from '@sabeel/shared';

/**
 * The rename the switchover seed applies to every audit entry it copies from
 * the live app.
 *
 * What it promises a person: an entry the live app wrote reads on this app's
 * audit screen as words saying what was done, with who, when and what to as
 * they were. The words are `AUDIT_ACTION_LABELS`; an entry under a name with
 * none prints as a function name, and `check:documents` fails on it.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const mod = (await import(resolve(REPO, 'scripts/lib/legacy-audit.mjs'))) as {
  RENAMED_AUDIT_ACTIONS: Readonly<Record<string, string>>;
  convertAuditEntry: (fields: Record<string, unknown>) => Record<string, unknown>;
};

const entry = {
  at: { integerValue: '1700000000000' },
  actorUid: { stringValue: 'adm' },
  actorRole: { stringValue: 'admin' },
  action: { stringValue: 'importZoomRecording' },
  courseId: { stringValue: 'c1' },
  targets: { mapValue: { fields: { recordingId: { stringValue: 'r1' } } } },
  detail: { mapValue: { fields: { zoomUuid: { stringValue: 'u==' } } } },
};

describe('convertAuditEntry', () => {
  it('renames each retired action to one this app has words for', () => {
    const renames = Object.entries(mod.RENAMED_AUDIT_ACTIONS);
    expect(renames.length).toBeGreaterThan(0);
    for (const [from, to] of renames) {
      expect(Object.hasOwn(AUDIT_ACTION_LABELS, from), `${from} still has words: it is not retired`).toBe(false);
      expect(Object.hasOwn(AUDIT_ACTION_LABELS, to), `${to} has no words`).toBe(true);
      expect(mod.convertAuditEntry({ ...entry, action: { stringValue: from } }).action).toEqual({ stringValue: to });
    }
  });

  it('keeps who, when, what to and the detail exactly as they were', () => {
    const { action: _renamed, ...rest } = mod.convertAuditEntry(entry);
    const { action: _old, ...was } = entry;
    expect(rest).toEqual(was);
  });

  it('passes an entry under a current name through untouched', () => {
    const current = { ...entry, action: { stringValue: 'setCourseManagers' } };
    expect(mod.convertAuditEntry(current)).toBe(current);
    // An inherited name is not a rename.
    const odd = { ...entry, action: { stringValue: 'constructor' } };
    expect(mod.convertAuditEntry(odd)).toBe(odd);
  });
});
