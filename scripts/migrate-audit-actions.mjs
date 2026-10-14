#!/usr/bin/env node
/**
 * ONE-OFF: rename the audit entries this project holds under the live app's
 * retired action names to the names written today, so the audit screen has
 * words for every entry and `check:documents` passes.
 *
 *     CHECK_ACCESS_TOKEN="$(gcloud auth print-access-token --account=faisal.shah@oursabeel.com)" \
 *       node scripts/migrate-audit-actions.mjs          # dry run: what would change
 *     ... node scripts/migrate-audit-actions.mjs --yes  # rename them
 *
 * The entries came with the seed from the live app, which still writes these
 * names; the seed now renames them as it copies, with the same map
 * (`scripts/lib/legacy-audit.mjs`). Only `action` is written, in one atomic
 * commit, each entry on condition it has not changed since it was read; who,
 * when, what to and the detail stay as they were. The live app's own log is
 * untouched. Retired once it has run.
 */
import { FIREBASE_PROJECT_ID } from '@sabeel/shared';
import { RENAMED_AUDIT_ACTIONS } from './lib/legacy-audit.mjs';

const TOKEN = process.env.CHECK_ACCESS_TOKEN;
const EXECUTE = process.argv.includes('--yes');
const unknown = process.argv.slice(2).filter((a) => a !== '--yes');
if (!TOKEN || unknown.length) {
  console.error('usage: CHECK_ACCESS_TOKEN=<user token> node scripts/migrate-audit-actions.mjs [--yes]');
  process.exit(2);
}

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)`;
const API = `https://firestore.googleapis.com/v1/${DB}/documents`;
async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`${method} ${new URL(url).pathname}: ${r.status} ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

/** Every audit entry under one of `actions`, as REST documents. */
async function entriesUnder(actions) {
  const rows = await call('POST', `${API}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: 'auditLog' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'action' },
          op: 'IN',
          value: { arrayValue: { values: actions.map((a) => ({ stringValue: a })) } },
        },
      },
    },
  });
  return rows.filter((r) => r.document).map((r) => r.document);
}

const retired = Object.keys(RENAMED_AUDIT_ACTIONS);
const found = await entriesUnder(retired);
console.log(`${FIREBASE_PROJECT_ID}: ${found.length} audit entries under a retired action name`);
for (const from of retired) {
  const n = found.filter((d) => d.fields.action.stringValue === from).length;
  console.log(`  ${String(n).padStart(4)}  ${from} → ${RENAMED_AUDIT_ACTIONS[from]}`);
}
if (!found.length) process.exit(0);
if (!EXECUTE) {
  console.log('\nDry run. Re-run with --yes to rename them.');
  process.exit(0);
}
if (found.length > 500) throw new Error('more than one commit holds: split it');

await call('POST', `https://firestore.googleapis.com/v1/${DB}/documents:commit`, {
  writes: found.map((d) => ({
    update: { name: d.name, fields: { action: { stringValue: RENAMED_AUDIT_ACTIONS[d.fields.action.stringValue] } } },
    updateMask: { fieldPaths: ['action'] },
    currentDocument: { updateTime: d.updateTime },
  })),
});

const left = await entriesUnder(retired);
const ids = new Set(found.map((d) => d.name));
const now = (await entriesUnder(Object.values(RENAMED_AUDIT_ACTIONS))).filter((d) => ids.has(d.name));
console.log(`\nrenamed ${now.length} of ${found.length}; ${left.length} left under a retired name`);
process.exit(left.length === 0 && now.length === found.length ? 0 : 1);
