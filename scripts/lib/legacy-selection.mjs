/**
 * Which part of the live app the switchover seed copies, and which part of
 * this project it keeps.
 *
 * The seed copies chosen cohorts, not the whole live project: their classes,
 * sessions, recordings, registers and listening, the students enrolled in
 * them, every staff account, and the audit entries about any of it. A plan
 * file says which, and names the corrections made on the way (a student
 * left out, a duplicate account folded into the one its owner uses, a test
 * session or a broken recording not carried). It holds account ids, so it is
 * kept out of this public repo and passed on the command line.
 *
 *     {
 *       "cohorts": ["<live cohort id>", ...],
 *       "leaveOut": ["<live student uid>", ...],
 *       "merge": { "<live student uid>": "<live student uid it folds into>" },
 *       "dropSessions": ["<live session id>", ...],
 *       "dropRecordings": ["<live recording id>", ...],
 *       "keepHere": { "cohorts": ["<cohort id here>"], "accounts": ["<uid here>"] }
 *     }
 *
 * Everything works on Firestore REST documents, `{ rel, fields }`, as the
 * seed reads and writes them, so a value passes through in its own encoding.
 *
 * ONE RULE DECIDES WHAT IS DROPPED: a document that names anything not copied
 * (a cohort, class, session or recording left behind, or a student who is not
 * coming) is not copied either. A register is the exception: a student who is
 * not coming has their mark taken out of it, because the session is coming
 * and a register listing a person who does not exist would show a blank row.
 * A session whose recording is dropped keeps its register and loses only the
 * link, so a recording can still be added to it.
 */
import { COLLECTIONS } from '@sabeel/shared';

const PLAN_KEYS = ['cohorts', 'leaveOut', 'merge', 'dropSessions', 'dropRecordings', 'keepHere'];

/** The plan file's contents, checked for shape. Ids are checked against the data by the functions below. */
export function parsePlan(raw) {
  const fail = (why) => {
    throw new Error(`plan: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected a JSON object');
  const unknown = Object.keys(raw).filter((k) => !PLAN_KEYS.includes(k));
  if (unknown.length) fail(`unknown key(s) ${unknown.join(', ')}; expected ${PLAN_KEYS.join(', ')}`);
  const ids = (v, name) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0)) fail(`${name} must be a list of ids`);
    if (new Set(v).size !== v.length) fail(`${name} lists an id twice`);
    return v;
  };
  const cohorts = ids(raw.cohorts, 'cohorts');
  if (cohorts.length === 0) fail('cohorts must name at least one cohort to copy');
  const merge = raw.merge ?? {};
  if (typeof merge !== 'object' || Array.isArray(merge) || !Object.values(merge).every((v) => typeof v === 'string')) {
    fail('merge must map a student uid to the uid it folds into');
  }
  const keepHere = raw.keepHere ?? {};
  if (typeof keepHere !== 'object' || Array.isArray(keepHere)) fail('keepHere must be an object');
  const extra = Object.keys(keepHere).filter((k) => !['cohorts', 'accounts'].includes(k));
  if (extra.length) fail(`keepHere: unknown key(s) ${extra.join(', ')}`);
  const plan = {
    cohorts,
    leaveOut: ids(raw.leaveOut, 'leaveOut'),
    merge,
    dropSessions: ids(raw.dropSessions, 'dropSessions'),
    dropRecordings: ids(raw.dropRecordings, 'dropRecordings'),
    keepHere: { cohorts: ids(keepHere.cohorts, 'keepHere.cohorts'), accounts: ids(keepHere.accounts, 'keepHere.accounts') },
  };
  for (const [from, to] of Object.entries(merge)) {
    if (from === to) fail(`merge folds ${from} into itself`);
    if (merge[to]) fail(`merge folds ${from} into ${to}, which is itself folded away`);
    if (plan.leaveOut.includes(from) || plan.leaveOut.includes(to)) fail(`merge names ${from} → ${to}, and leaveOut names one of them`);
  }
  return plan;
}

// ----------------------------------------------------------- REST walking --

/** `a/b/c/d` → `a/*\/c`, the collection shape. */
const shapeOf = (rel) => rel.split('/').filter((_, i) => i % 2 === 0).join('/');
/** The ids a document path is made of: its segments, and the parts of a compound id (`uid_sessionId`). */
const pathIds = (rel) => rel.split('/').flatMap((s) => [s, ...s.split('_')]);

/** Every string value and map key in a REST value, recursively. */
function collect(value, out) {
  if ('stringValue' in value) out.push(value.stringValue);
  else if ('arrayValue' in value) for (const v of value.arrayValue.values ?? []) collect(v, out);
  else if ('mapValue' in value) collectFields(value.mapValue.fields ?? {}, out);
  return out;
}
function collectFields(fields, out = []) {
  for (const [k, v] of Object.entries(fields)) {
    out.push(k);
    collect(v, out);
  }
  return out;
}
/** Whether a document names any id in `ids`, in its path or anywhere in its fields. */
const names = (rel, fields, ids) => pathIds(rel).some((s) => ids.has(s)) || collectFields(fields).some((s) => ids.has(s));

/** A REST value with every string and map key equal to `from` replaced by `to`. */
function renameValue(value, from, to) {
  if ('stringValue' in value) return value.stringValue === from ? { stringValue: to } : value;
  if ('arrayValue' in value) return { arrayValue: { values: (value.arrayValue.values ?? []).map((v) => renameValue(v, from, to)) } };
  if ('mapValue' in value) return { mapValue: { fields: renameFields(value.mapValue.fields ?? {}, from, to) } };
  return value;
}
function renameFields(fields, from, to) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k === from ? to : k, renameValue(v, from, to)]));
}
const renamePath = (rel, from, to) =>
  rel
    .split('/')
    .map((s) => s.split('_').map((p) => (p === from ? to : p)).join('_'))
    .join('/');

const str = (fields, key) => fields[key]?.stringValue;
const idOf = (rel) => rel.split('/')[1];

// --------------------------------------------------------------- copying --

/**
 * The documents to copy from the live app, and an account of what was left
 * out and why.
 *
 * `candidates` is every document the seed would write for the whole live
 * project, already converted to this project's shapes (`{ rel, fields }`).
 * `accounts` is every live Auth account (`localId`). Returns the documents to
 * write, the uids whose accounts to copy, and the report the dry run prints.
 */
export function selectFromLegacy(candidates, accounts, plan) {
  const of = (collection) => candidates.filter((d) => shapeOf(d.rel) === collection);
  const cohorts = new Set(of(COLLECTIONS.cohorts).map((d) => idOf(d.rel)));
  const courses = new Map(of(COLLECTIONS.courses).map((d) => [idOf(d.rel), str(d.fields, 'cohortId')]));
  const sessions = new Map(of(COLLECTIONS.sessions).map((d) => [idOf(d.rel), str(d.fields, 'courseId')]));
  const recordings = new Map(of(COLLECTIONS.recordings).map((d) => [idOf(d.rel), d.fields]));
  const students = new Set(of(COLLECTIONS.students).map((d) => idOf(d.rel)));
  const staff = new Set(of(COLLECTIONS.staffUsers).map((d) => idOf(d.rel)));

  const missing = plan.cohorts.filter((c) => !cohorts.has(c));
  if (missing.length) throw new Error(`plan: no cohort ${missing.join(', ')} in the live app`);
  const keptCourses = new Set([...courses].filter(([, cohort]) => plan.cohorts.includes(cohort)).map(([id]) => id));
  for (const s of plan.dropSessions) {
    if (!keptCourses.has(sessions.get(s))) throw new Error(`plan: dropSessions names ${s}, which is not a session of a copied class`);
  }
  for (const r of plan.dropRecordings) {
    if (!keptCourses.has(str(recordings.get(r) ?? {}, 'courseId'))) {
      throw new Error(`plan: dropRecordings names ${r}, which is not a recording of a copied class`);
    }
  }

  // The students who come: everyone with any enrolment in a copied class,
  // present or past, less those the plan leaves out or folds away.
  const enrolled = new Set(
    of(COLLECTIONS.enrollments)
      .filter((d) => keptCourses.has(str(d.fields, 'courseId')))
      .map((d) => str(d.fields, 'studentUid')),
  );
  for (const uid of [...plan.leaveOut, ...Object.keys(plan.merge), ...Object.values(plan.merge)]) {
    if (!students.has(uid)) throw new Error(`plan: ${uid} is not a student in the live app`);
    if (!enrolled.has(uid)) throw new Error(`plan: ${uid} has no enrolment in a copied class, so is not copied anyway`);
  }
  const merged = new Map(Object.entries(plan.merge));
  const copiedStudents = new Set([...enrolled].filter((u) => !plan.leaveOut.includes(u) && !merged.has(u)));
  const unaccounted = accounts.filter((a) => !staff.has(a.localId) && !students.has(a.localId));
  if (unaccounted.length) {
    throw new Error(`${unaccounted.length} live account(s) are neither staff nor student, e.g. ${unaccounted[0].localId}`);
  }

  // Everything not coming, by id.
  const droppedSessions = new Set([
    ...[...sessions].filter(([, course]) => !keptCourses.has(course)).map(([id]) => id),
    ...plan.dropSessions,
  ]);
  const dropped = new Set([
    ...[...cohorts].filter((c) => !plan.cohorts.includes(c)),
    ...[...courses.keys()].filter((c) => !keptCourses.has(c)),
    ...droppedSessions,
    ...[...recordings]
      .filter(([, f]) => !keptCourses.has(str(f, 'courseId')) || droppedSessions.has(str(f, 'sessionId')))
      .map(([id]) => id),
    ...plan.dropRecordings,
    ...[...students].filter((u) => !copiedStudents.has(u) && !merged.has(u)),
  ]);

  const writes = [];
  const left = new Map(); // shape → how many not copied
  const marksRemoved = new Map(); // session rel → how many marks taken out
  let moved = 0; // documents moved onto the account a duplicate folds into
  const leave = (rel) => left.set(shapeOf(rel), (left.get(shapeOf(rel)) ?? 0) + 1);

  for (const doc of candidates) {
    let { rel, fields } = doc;
    const shape = shapeOf(rel);
    // A duplicate account's own records go with it; what was done to the
    // student moves onto the account they use. Its creation stays behind:
    // that entry describes an account that is not here.
    const foldedFrom = [...merged.keys()].find(
      (from) =>
        rel === `${COLLECTIONS.students}/${from}` ||
        rel.startsWith(`${COLLECTIONS.notifications}/${from}`) ||
        (shape === COLLECTIONS.auditLog && str(fields, 'action') === 'createStudent' && names(rel, fields, new Set([from]))),
    );
    if (foldedFrom) {
      leave(rel);
      continue;
    }
    for (const [from, to] of merged) {
      if (!names(rel, fields, new Set([from]))) continue;
      if (shape === COLLECTIONS.sessions) {
        const marks = fields.attendance?.mapValue?.fields ?? {};
        if (from in marks && to in marks) throw new Error(`${rel}: both ${from} and ${to} have a mark; cannot fold one into the other`);
      }
      rel = renamePath(rel, from, to);
      fields = renameFields(fields, from, to);
      moved += 1;
    }
    if (shape === COLLECTIONS.sessions) {
      const marks = fields.attendance?.mapValue?.fields ?? {};
      const gone = Object.keys(marks).filter((uid) => dropped.has(uid));
      if (gone.length && !dropped.has(idOf(rel))) {
        marksRemoved.set(rel, gone.length);
        fields = {
          ...fields,
          attendance: { mapValue: { fields: Object.fromEntries(Object.entries(marks).filter(([uid]) => !dropped.has(uid))) } },
        };
      }
      if (dropped.has(str(fields, 'recordingId')) && !dropped.has(idOf(rel))) fields = { ...fields, recordingId: { nullValue: null } };
    }
    // An audit entry that names nothing it touched, in no class, cannot be
    // shown to be about the cohorts copied.
    const unattributable =
      shape === COLLECTIONS.auditLog &&
      Object.keys(fields.targets?.mapValue?.fields ?? {}).length === 0 &&
      !str(fields, 'courseId');
    if (unattributable || names(rel, fields, dropped)) {
      leave(rel);
      continue;
    }
    writes.push({ rel, fields });
  }

  const seen = new Set();
  for (const w of writes) {
    if (seen.has(w.rel)) throw new Error(`two copied documents land on ${w.rel}`);
    seen.add(w.rel);
  }
  return {
    writes,
    uids: new Set([...staff, ...copiedStudents]),
    report: {
      keptCourses,
      copiedStudents,
      merged,
      notEnrolled: [...students].filter((u) => !enrolled.has(u)),
      left,
      marksRemoved,
      moved,
    },
  };
}

// --------------------------------------------------------------- keeping --

/**
 * What of this project survives the seed's wipe: `config/app` (the oldest
 * build allowed to run, and the record that the copy was made), the cohorts
 * the plan keeps with everything in them, and the accounts it keeps with
 * their own records — but not those accounts' work in classes that go.
 *
 * Returns the kept documents and the ids a media key is kept by: a kept
 * recording's files, a kept assignment's attachments and work handed in to it.
 */
export function keptHere(targetDocs, targetAccounts, plan) {
  const { cohorts, accounts } = plan.keepHere;
  const here = new Set(targetDocs.filter((d) => shapeOf(d.rel) === COLLECTIONS.cohorts).map((d) => idOf(d.rel)));
  const noCohort = cohorts.filter((c) => !here.has(c));
  if (noCohort.length) throw new Error(`plan: keepHere names cohort ${noCohort.join(', ')}, which is not in this project`);
  const uids = new Set(targetAccounts.map((a) => a.localId));
  const noAccount = accounts.filter((a) => !uids.has(a));
  if (noAccount.length) throw new Error(`plan: keepHere names account ${noAccount.join(', ')}, which is not in this project`);

  const courses = targetDocs
    .filter((d) => shapeOf(d.rel) === COLLECTIONS.courses && cohorts.includes(str(d.fields, 'cohortId')))
    .map((d) => idOf(d.rel));
  const inCohorts = new Set([...cohorts, ...courses]);
  const own = (rel) =>
    accounts.some(
      (uid) =>
        rel === `${COLLECTIONS.students}/${uid}` ||
        rel === `${COLLECTIONS.staffUsers}/${uid}` ||
        rel === `${COLLECTIONS.notifications}/${uid}` ||
        rel.startsWith(`${COLLECTIONS.notifications}/${uid}/`),
    );
  const docs = targetDocs.filter((d) => d.rel === `${COLLECTIONS.config}/app` || own(d.rel) || names(d.rel, d.fields, inCohorts));

  // A kept class whose student is not kept would be left with an enrolment
  // and a register naming an account the wipe deleted.
  const keptAccounts = new Set(accounts);
  for (const d of docs) {
    const student = str(d.fields, 'studentUid');
    if (student && !keptAccounts.has(student)) throw new Error(`${d.rel} is kept, but its student ${student} is not in keepHere.accounts`);
  }
  const mediaIds = new Set(
    docs.filter((d) => [COLLECTIONS.recordings, COLLECTIONS.coursework].includes(shapeOf(d.rel))).map((d) => idOf(d.rel)),
  );
  return { docs, accounts: keptAccounts, keepsObject: (key) => key.split('/').some((s) => mediaIds.has(s)) };
}
