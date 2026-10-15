/**
 * Give every enrolment and every class the stretches they now keep.
 *
 *  - An enrolment kept `enrolledAt` (the first joining) and `unenrolledAt`
 *    (the LAST leaving), so a second removal erased the first and the
 *    workbooks charged "Missed deadline" for a date that passed while the
 *    student was out of the class. It now keeps every stretch
 *    (`EnrollmentDoc.stretches`), and the two dates go.
 *  - A class kept only whether its recordings are closed to its students now,
 *    so once a date passed, a class archived before it read as Missed. It now
 *    keeps every stretch they were closed (`CourseDoc.recordingsClosed`).
 *
 * The callables keep both from now on; a record written before has none, and
 * the ledgers, the workbooks, the attendance report and `check:documents`
 * need them. Migrated, not accommodated: each is rebuilt from the audit log,
 * which records every joining, leaving, return and archive
 * (`stretchesFromHistory` and `recordingsClosedFromHistory` in
 * @sabeel/shared, through scripts/lib/stretches.mjs), with what is stored
 * winning where the log falls short. One where they disagreed is printed as
 * INFERRED, to look at.
 *
 * ONLY WHERE NONE IS STORED, and each write only onto the document as it was
 * read: a record a callable changed meanwhile is left for the next run.
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
import { archiveHistory, convertCourse, convertEnrolment, enrolmentHistory } from './lib/stretches.mjs';

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
const [enrolments, courses, cohorts, audit] = await Promise.all([all('enrollments'), all('courses'), all('cohorts'), all('auditLog')]);
const auditRows = audit.map((r) => r.data);
const joins = enrolmentHistory(auditRows);
const archives = archiveHistory(auditRows);
const cohortOf = new Map(cohorts.map((c) => [c.id, c.data]));

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const day = (ms) => todayInZone(INSTITUTE_TIMEZONE, ms);
const said = (stretches) => (stretches.length ? stretches.map((s) => `${day(s.from)}–${s.to === null ? 'now' : day(s.to)}`).join(', ') : 'never');
const tally = { written: 0, kept: 0, inferred: 0, already: 0, todo: 0 };

/**
 * Write `field` (and remove `drop`) on one document, only as it was read.
 * True when written; false when a callable changed it meanwhile.
 */
async function patch(collection, id, updateTime, field, value, drop = []) {
  const mask = [field, ...drop].map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/${collection}/${id}?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    // Fields in the mask and not in the body are removed.
    body: JSON.stringify({ fields: { [field]: encodeValue(value) } }),
  });
  if (res.ok) return true;
  const text = await res.text();
  if (/FAILED_PRECONDITION/.test(text)) return false;
  throw new Error(`${collection}/${id}: HTTP ${res.status} ${text.slice(0, 200)}`);
}

async function migrate(collection, id, updateTime, converted, field, drop) {
  if (!converted) {
    tally.already++;
    return;
  }
  tally.todo++;
  if (converted.inferred) tally.inferred++;
  console.log(
    `${write ? 'writing' : 'would write'} ${collection}/${id}: ${said(converted.data[field])}${converted.inferred ? '  INFERRED: the log and what is stored disagree' : ''}`,
  );
  if (!write) return;
  if (await patch(collection, id, updateTime, field, converted.data[field], drop)) tally.written++;
  else {
    console.log(`  ${collection}/${id} changed since it was read: left for the next run`);
    tally.kept++;
  }
}

for (const { id, data, updateTime } of enrolments) {
  await migrate('enrollments', id, updateTime, convertEnrolment(data, joins.get(id)), 'stretches', ['enrolledAt', 'unenrolledAt']);
}
for (const { id, data, updateTime } of courses) {
  await migrate('courses', id, updateTime, convertCourse(id, data, cohortOf.get(data.cohortId), archives), 'recordingsClosed');
}
console.log(
  `${enrolments.length} enrolments and ${courses.length} classes: ${tally.already} with their stretches already, ` +
    `${tally.todo} to give them, ${tally.inferred} inferred; ` +
    (write ? `${tally.written} written, ${tally.kept} changed meanwhile (run again)` : 'nothing written (dry run; --yes to write)'),
);
