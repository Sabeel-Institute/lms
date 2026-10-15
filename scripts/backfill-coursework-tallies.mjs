/**
 * Give every assignment its stored tally (`courseworkTallies`).
 *
 * The tallies arrive with the triggers that keep them (functions/src/
 * courseworkTallies.ts); an assignment written before then has none, and its
 * course's pages would show it as empty until its work next changed.
 * Migrated, not accommodated: this computes each with `courseworkTally`,
 * exactly as the trigger does, from the same work and grades, and writes it.
 *
 * ONLY WHERE NONE IS STORED. It runs after the triggers are deployed, and a
 * change to the work while it runs brings that assignment's trigger, whose
 * tally is newer than anything read here: each write is made only if the
 * document does not exist yet, so a trigger's answer is never overwritten.
 *
 * Run once on the live project when the triggers are deployed: an assignment
 * made after that has its tally from the first write to its work, and the
 * switchover seed copies the legacy app, which has no assignments. Dry run
 * unless --yes:
 *
 *     node scripts/backfill-coursework-tallies.mjs          # says what it would do
 *     node scripts/backfill-coursework-tallies.mjs --yes    # does it
 *
 * Reads and writes with the oursabeel.com account's token; prints none.
 */
import { execFileSync } from 'node:child_process';
import { FIREBASE_PROJECT_ID, INSTITUTE_TIMEZONE, courseworkTally } from '@sabeel/shared';
import { listDocuments } from './lib/firestore-rest.mjs';

const ACCOUNT = 'faisal.shah@oursabeel.com';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node scripts/backfill-coursework-tallies.mjs [--yes]`);
  process.exit(2);
}
const write = args.includes('--yes');
const token = execFileSync('gcloud', ['auth', 'print-access-token', `--account=${ACCOUNT}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** A plain value as Firestore's REST `Value`, as an SDK would store it. */
function encode(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
}

const byWork = (rows) => {
  const out = new Map();
  for (const { data } of rows) {
    if (!out.has(data.courseworkId)) out.set(data.courseworkId, []);
    out.get(data.courseworkId).push(data);
  }
  return out;
};
const all = async (collection) => {
  const rows = [];
  for await (const row of listDocuments(FIREBASE_PROJECT_ID, collection, token)) rows.push(row);
  return rows;
};

const [coursework, submissions, grades] = await Promise.all([all('coursework'), all('submissions'), all('grades')]);
const subsOf = byWork(submissions);
const gradesOf = byWork(grades);

const DB = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
let written = 0;
let kept = 0;
for (const { id, data: cw } of coursework) {
  const tally = courseworkTally(
    cw.grading,
    subsOf.get(id) ?? [],
    new Map((gradesOf.get(id) ?? []).map((g) => [g.studentUid, g])),
    INSTITUTE_TIMEZONE,
  );
  const doc = { ...tally, courseId: cw.courseId, updatedAt: Date.now() };
  console.log(
    `${write ? 'writing' : 'would write'} ${id} (${cw.title}): ${tally.handedIn} in, ${tally.toGrade} to grade, ` +
      `${tally.waiting.reduce((n, g) => n + g.count, 0)} with nothing in, ${tally.notRequired} not required`,
  );
  if (!write) continue;
  const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/courseworkTallies/${id}?currentDocument.exists=false`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': FIREBASE_PROJECT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encode(doc).mapValue.fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (/FAILED_PRECONDITION|ALREADY_EXISTS/.test(text)) {
      console.log(`  ${id} already has a tally, kept by its trigger: left as it is`);
      kept++;
      continue;
    }
    throw new Error(`courseworkTallies/${id}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  written++;
}
console.log(
  `${coursework.length} assignments; ${write ? `${written} tallies written, ${kept} already there` : 'nothing written (dry run; --yes to write)'}`,
);
