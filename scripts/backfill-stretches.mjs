/**
 * Give every enrolment its stretches in the class, and take away the two
 * dates they replace.
 *
 * An enrolment kept `enrolledAt` (the first joining) and `unenrolledAt` (the
 * LAST leaving), so a second removal erased the first and the workbooks
 * charged "Missed deadline" for a date that passed while the student was out
 * of the class. It now keeps every stretch (`EnrollmentDoc.stretches`), and
 * the callables add to them; an enrolment written before has none, and the
 * workbooks, the attendance report and `check:documents` need them.
 * Migrated, not accommodated: each is rebuilt from the audit log, which
 * records every joining, leaving and return (`stretchesFromHistory` in
 * @sabeel/shared, through scripts/lib/stretches.mjs), with the two
 * stored dates winning where the log falls short. One where they disagreed
 * is printed as INFERRED, to look at.
 *
 * ONLY WHERE NONE IS STORED, and each write only onto the document as it was
 * read: an enrolment a callable changed meanwhile is left for the next run.
 *
 * Run once on the live project, after the functions that keep the stretches
 * are deployed and before the website that reads them. Dry run unless --yes:
 *
 *     node scripts/backfill-stretches.mjs          # says what it would do
 *     node scripts/backfill-stretches.mjs --yes    # does it
 *
 * Reads and writes with the oursabeel.com account's token; prints none.
 */
import { execFileSync } from 'node:child_process';
import { FIREBASE_PROJECT_ID, INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { encodeValue, listDocuments } from './lib/firestore-rest.mjs';
import { convertEnrolment, enrolmentHistory } from './lib/stretches.mjs';

const ACCOUNT = 'faisal.shah@oursabeel.com';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node scripts/backfill-stretches.mjs [--yes]`);
  process.exit(2);
}
const write = args.includes('--yes');
const token = execFileSync('gcloud', ['auth', 'print-access-token', `--account=${ACCOUNT}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const all = async (collection) => {
  const rows = [];
  for await (const row of listDocuments(FIREBASE_PROJECT_ID, collection, token)) rows.push(row);
  return rows;
};
const [enrolments, audit] = await Promise.all([all('enrollments'), all('auditLog')]);
const history = enrolmentHistory(audit.map((r) => r.data));

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const day = (ms) => todayInZone(INSTITUTE_TIMEZONE, ms);
const said = (stretches) => stretches.map((s) => `${day(s.from)}–${s.to === null ? 'now' : day(s.to)}`).join(', ');
let written = 0;
let kept = 0;
let inferred = 0;
let already = 0;
for (const { id, data, updateTime } of enrolments) {
  const converted = convertEnrolment(data, history.get(id));
  if (!converted) {
    already++;
    continue;
  }
  if (converted.inferred) inferred++;
  console.log(
    `${write ? 'writing' : 'would write'} ${id}: ${said(converted.data.stretches)}${converted.inferred ? '  INFERRED: the log and the stored dates disagree' : ''}`,
  );
  if (!write) continue;
  const mask = ['stretches', 'enrolledAt', 'unenrolledAt'].map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/enrollments/${id}?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    // The two dates are in the mask and not in the body: the write removes them.
    body: JSON.stringify({ fields: { stretches: encodeValue(converted.data.stretches) } }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (/FAILED_PRECONDITION/.test(text)) {
      console.log(`  ${id} changed since it was read: left for the next run`);
      kept++;
      continue;
    }
    throw new Error(`enrollments/${id}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  written++;
}
console.log(
  `${enrolments.length} enrolments, ${already} with stretches already, ${inferred} inferred; ` +
    (write ? `${written} written, ${kept} changed meanwhile (run again)` : 'nothing written (dry run; --yes to write)'),
);
