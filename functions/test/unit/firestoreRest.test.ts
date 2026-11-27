import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

/**
 * `canonicalFields`, which the switchover seed's settle step compares a
 * written document with its stored copy by.
 *
 * What it promises: a document Firestore stored exactly as written is never
 * reported as changed, and one a trigger did change always is. Firestore hands
 * an empty array back as `{ arrayValue: {} }` however it was written, and
 * five classes with no closed stretches were "changed" on every pass of the
 * first real run for that reason alone.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const { canonicalFields } = (await import(resolve(REPO, 'scripts/lib/firestore-rest.mjs'))) as {
  canonicalFields: (f: Record<string, unknown> | undefined) => string;
};

describe('canonicalFields', () => {
  it('reads an empty array or map the same however it is spelled, and keys in any order', () => {
    const written = {
      name: { stringValue: 'Arabic' },
      recordingsClosed: { arrayValue: { values: [] } },
      extra: { mapValue: { fields: {} } },
      nested: { mapValue: { fields: { b: { arrayValue: { values: [] } }, a: { integerValue: '1' } } } },
    };
    const stored = {
      nested: { mapValue: { fields: { a: { integerValue: '1' }, b: { arrayValue: {} } } } },
      extra: { mapValue: {} },
      recordingsClosed: { arrayValue: {} },
      name: { stringValue: 'Arabic' },
    };
    expect(canonicalFields(stored)).toBe(canonicalFields(written));
  });

  it('still sees a real change, a missing field and a missing document', () => {
    const written = { active: { booleanValue: true }, closed: { arrayValue: { values: [{ stringValue: 'x' }] } } };
    expect(canonicalFields({ ...written, active: { booleanValue: false } })).not.toBe(canonicalFields(written));
    expect(canonicalFields({ ...written, closed: { arrayValue: {} } })).not.toBe(canonicalFields(written));
    expect(canonicalFields({ active: written.active })).not.toBe(canonicalFields(written));
    expect(canonicalFields(undefined)).not.toBe(canonicalFields(written));
  });
});
