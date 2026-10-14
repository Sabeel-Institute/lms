/**
 * Run every query shape the app issues against the REAL project, and fail on
 * any that needs a composite index which does not exist.
 *
 *     npm run check:queries
 *
 * WHY THIS CANNOT BE AN EMULATOR TEST: the Firestore emulator builds indexes on
 * demand and never returns FAILED_PRECONDITION. Every query passes locally
 * whether or not `firestore.indexes.json` contains anything at all — which is
 * exactly how this repo shipped with an EMPTY index file and two admin screens
 * that failed the moment a real user opened them (2026-07-22).
 *
 * Rules are irrelevant here — the Admin SDK bypasses them — and so is the data:
 * whether a query needs an index is a property of its SHAPE, so empty
 * collections and made-up ids exercise it perfectly well.
 *
 * Keep this list in step with the app. If you add a `where` + `orderBy` on
 * different fields, add the shape here in the same change.
 */
import { createRequire } from 'node:module';
import { AUDIT_PAGE, FIREBASE_PROJECT_ID } from '@sabeel/shared';

// Resolved from the functions workspace, which already depends on the Admin SDK.
// Adding it at the root would be a second copy of a large package for one
// script, so knip is told to expect the unlisted import instead.
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT_ID = process.env.CHECK_PROJECT ?? FIREBASE_PROJECT_ID;
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

// Placeholders: shape is what matters, not whether anything matches.
const ID = '__shape_probe__';

const shapes = [
  ['students — the directory', () => db.collection('students').orderBy('displayName', 'asc')],
  ['cohorts — newest first', () => db.collection('cohorts').orderBy('createdAt', 'desc')],
  [
    'staffUsers — waiting for approval',
    () => db.collection('staffUsers').where('status', '==', 'pending').orderBy('createdAt', 'asc'),
  ],
  [
    'staffUsers — everyone already decided',
    () =>
      db
        .collection('staffUsers')
        .where('status', 'in', ['active', 'disabled'])
        .orderBy('displayName', 'asc'),
  ],
  [
    'courses — within a cohort',
    () => db.collection('courses').where('cohortId', '==', ID).orderBy('createdAt', 'asc'),
  ],
  [
    "courses — a manager's own",
    () => db.collection('courses').where('managerUids', 'array-contains', ID),
  ],
  [
    'recordings — staff library for a class',
    () => db.collection('recordings').where('courseId', '==', ID).orderBy('createdAt', 'desc'),
  ],
  [
    "sessions — a class's sessions, newest first",
    () => db.collection('sessions').where('courseId', '==', ID).orderBy('date', 'desc'),
  ],
  ['enrollments — a class roster', () => db.collection('enrollments').where('courseId', '==', ID)],
  [
    "enrollments — a student's courses",
    () => db.collection('enrollments').where('studentUid', '==', ID),
  ],
  [
    'staffUsers — does an admin exist (bootstrap)',
    () =>
      db
        .collection('staffUsers')
        .where('role', '==', 'admin')
        .where('status', '==', 'active')
        .limit(1),
  ],
  [
    'courses — cascade over a cohort (server)',
    () => db.collection('courses').where('cohortId', '==', ID),
  ],
  // ---- Phase 4: assignments, completions ----
  [
    "assignments — a student's active obligations (home)",
    () => db.collection('assignments').where('studentUid', '==', ID).where('active', '==', true),
  ],
  [
    'assignments — a class roster (staff/move)',
    () => db.collection('assignments').where('courseId', '==', ID).where('active', '==', true),
  ],
  [
    "assignments — a recording's rows (deactivate fan-out)",
    () => db.collection('assignments').where('recordingId', '==', ID).where('active', '==', true),
  ],
  [
    "assignments — a student's rows in a class (unenrol)",
    () => db.collection('assignments').where('studentUid', '==', ID).where('courseId', '==', ID),
  ],
  [
    'enrollments — active roster (fan-out)',
    () => db.collection('enrollments').where('courseId', '==', ID).where('active', '==', true),
  ],
  // ---- attendanceRecords: the student's own marks ----
  [
    "attendanceRecords — a student's marks in one class",
    () =>
      db.collection('attendanceRecords').where('studentUid', '==', ID).where('courseId', '==', ID),
  ],
  [
    "attendanceRecords — a session's rows (mirror reconcile)",
    () => db.collection('attendanceRecords').where('sessionId', '==', ID),
  ],
  // ---- Phase 7: the morning notification sweep (server-side) ----
  [
    'assignments — grants closing today (last-day reminder)',
    () => db.collection('assignments').where('active', '==', true).where('dueDate', '==', ID),
  ],
  [
    'sessions — met but never marked (attendance reminder)',
    () =>
      db
        .collection('sessions')
        .where('attendanceSubmittedAt', '==', null)
        .where('date', '<=', ID),
  ],
  [
    "completions — a student's own (home join)",
    () => db.collection('completions').where('studentUid', '==', ID),
  ],
  // ---- Phase 5: staff ledger reads ----
  [
    'completions — a class ledger (staff)',
    () => db.collection('completions').where('courseId', '==', ID),
  ],
  [
    'listeningProgress — a class ledger (staff)',
    () => db.collection('listeningProgress').where('courseId', '==', ID),
  ],
  [
    'completionEvents — a class ledger (staff)',
    () => db.collection('completionEvents').where('courseId', '==', ID),
  ],
  [
    'completionOverrides — a class ledger (staff)',
    () => db.collection('completionOverrides').where('courseId', '==', ID),
  ],
  [
    "completionOverrides — a student's own",
    () => db.collection('completionOverrides').where('studentUid', '==', ID),
  ],
  [
    "assignments — a student's rows in a class (student ledger, manager)",
    () => db.collection('assignments').where('studentUid', '==', ID).where('courseId', '==', ID),
  ],
  // Both carry AUDIT_PAGE, because both are sent that way: the audit log is the
  // one collection here that only grows, and an unlimited live subscription to
  // it is a download of every change ever made. A `limit` does not change which
  // index a shape needs, so it is here to keep the list honest rather than to
  // exercise anything new.
  [
    'auditLog — a class, newest first (manager audit view)',
    () =>
      db.collection('auditLog').where('courseId', '==', ID).orderBy('at', 'desc').limit(AUDIT_PAGE),
  ],
  [
    'auditLog — global, newest first (admin audit view)',
    () => db.collection('auditLog').orderBy('at', 'desc').limit(AUDIT_PAGE),
  ],
  [
    "auditLog — one person's own actions (More → my history)",
    () =>
      db.collection('auditLog').where('actorUid', '==', ID).orderBy('at', 'desc').limit(AUDIT_PAGE),
  ],
  // A student's history, on their page. The admin reads it by the student
  // alone; a manager's read is pinned to the courses they run, because the
  // manager arm of the audit rule resolves a course lookup from each row.
  [
    "auditLog — one student's history (admin)",
    () =>
      db
        .collection('auditLog')
        .where('targets.studentUid', '==', ID)
        .orderBy('at', 'desc')
        .limit(AUDIT_PAGE),
  ],
  [
    "auditLog — one student's history in the courses a manager runs",
    () =>
      db
        .collection('auditLog')
        .where('courseId', 'in', [ID])
        .where('targets.studentUid', '==', ID)
        .orderBy('at', 'desc')
        .limit(AUDIT_PAGE),
  ],
  /*
   * THE ONE SHAPE NO SCREEN SENDS — `onDeviceRegistered`'s sweep.
   *
   * A COLLECTION GROUP query, and Firestore does NOT create single-field
   * indexes for collection-group scope automatically: it needs the
   * `fieldOverrides` entry in `firestore.indexes.json`. Nothing else here would
   * notice a missing one, because the emulator serves any shape and the trigger
   * fails silently from a user's point of view — the symptom is a device
   * quietly staying registered to a previous account, which is the leak the
   * trigger exists to close.
   */
  [
    'devices — the same token under any other account (onDeviceRegistered)',
    () => db.collectionGroup('devices').where('token', '==', ID),
  ],
  // ---- Phase 5c: recording-ledger reads ----
  //
  // All four pin courseId. That is not an optimisation and it is not optional:
  // the staff arm of these rules resolves get(/courses/$(resource.data.courseId)),
  // and Firestore judges a `list` against the QUERY's constraints, so an
  // unpinned courseId is refused outright. These shapes must be the ones
  // app/src/ledger.ts actually sends — this list carried the pre-fix,
  // recordingId-only shapes for a while after the app stopped sending them,
  // which made this check pass while covering queries no longer issued and
  // missing the ones that were.
  [
    "assignments — every grant a recording made (recording ledger)",
    () => db.collection('assignments').where('courseId', '==', ID).where('recordingId', '==', ID),
  ],
  [
    "completions — a recording's roster (recording ledger)",
    () => db.collection('completions').where('courseId', '==', ID).where('recordingId', '==', ID),
  ],
  [
    "completionOverrides — a recording's (recording ledger)",
    () =>
      db.collection('completionOverrides').where('courseId', '==', ID).where('recordingId', '==', ID),
  ],
  [
    "listeningProgress — a recording's (recording ledger)",
    () =>
      db.collection('listeningProgress').where('courseId', '==', ID).where('recordingId', '==', ID),
  ],

  // ---- assignments (coursework). Equality only throughout, so none should
  // need a composite index; listed so a range or an orderBy added later is
  // caught here rather than by a teacher.
  ['coursework — a course’s assignments', () => db.collection('coursework').where('courseId', '==', ID)],
  ['coursework — posted in a course (reconcile)', () => db.collection('coursework').where('courseId', '==', ID).where('status', '==', 'posted')],
  ['coursework — Today across managed courses', () => db.collection('coursework').where('courseId', 'in', [ID])],
  ['submissions — a student’s own (To do)', () => db.collection('submissions').where('studentUid', '==', ID).where('active', '==', true)],
  ['submissions — a course’s (staff pages)', () => db.collection('submissions').where('courseId', '==', ID)],
  ['submissions — handed in, Today', () => db.collection('submissions').where('courseId', 'in', [ID]).where('state', '==', 'handedIn')],
  ['submissions — one assignment’s (server)', () => db.collection('submissions').where('courseworkId', '==', ID)],
  ['submissions — a student in a course (reconcile, student workbook)', () => db.collection('submissions').where('courseId', '==', ID).where('studentUid', '==', ID)],
  ['submissions — active in a course (reconcile)', () => db.collection('submissions').where('courseId', '==', ID).where('active', '==', true)],
  [
    'submissions — last day to hand in (7 AM sweep)',
    () => db.collection('submissions').where('dueDate', '==', '2026-01-01').where('state', '==', 'open').where('active', '==', true),
  ],
  ['drafts — a student’s own', () => db.collection('drafts').where('studentUid', '==', ID)],
  ['grades — a course’s (staff pages)', () => db.collection('grades').where('courseId', '==', ID)],
  ['grades — a student in a course (student workbook)', () => db.collection('grades').where('studentUid', '==', ID).where('courseId', '==', ID)],
  ['grades — Today across managed courses', () => db.collection('grades').where('courseId', 'in', [ID])],
  ['grades — any on an assignment (server)', () => db.collection('grades').where('courseworkId', '==', ID).limit(1)],
  [
    'submissionEvents — one student’s hand-in history',
    () =>
      db.collection('submissionEvents').where('courseId', '==', ID).where('courseworkId', '==', ID).where('studentUid', '==', ID),
  ],
  ['attachmentUploads — abandoned (daily sweep)', () => db.collection('attachmentUploads').where('startedAt', '<', 1)],
  [
    'attachmentUploads — one person’s pending on an assignment',
    () => db.collection('attachmentUploads').where('courseworkId', '==', ID).where('studentUid', '==', ID),
  ],
];

/**
 * A query, run — over REST with `CHECK_ACCESS_TOKEN` when it is set.
 *
 * The Admin SDK reaches Firestore only through a service account or
 * Application Default Credentials, and the ADC on a machine shared with other
 * projects may belong to a different Google account. A user token
 * (`gcloud auth print-access-token --account=<owner>`) answers the same
 * question: the query is the SDK's own (`toProto()`), sent to `:runQuery`, so
 * the shape checked is the shape the code sends. Two fields are written the
 * way JSON wants them rather than the proto: `limit` as a number, and 64-bit
 * integers as strings.
 */
const TOKEN = process.env.CHECK_ACCESS_TOKEN;
async function runShape(query) {
  if (!TOKEN) return (await query.get()).size;
  const { parent, structuredQuery } = query.toProto();
  if (structuredQuery.limit?.value !== undefined) structuredQuery.limit = structuredQuery.limit.value;
  const body = JSON.stringify({ structuredQuery }, (key, value) => (key === 'integerValue' ? String(value) : value));
  const r = await fetch(`https://firestore.googleapis.com/v1/${parent}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`${out.error?.status ?? r.status}: ${out.error?.message ?? r.statusText}`);
  return out.filter((row) => row.document).length;
}

console.log(`Query shapes against ${PROJECT_ID}${TOKEN ? ' (REST, user token)' : ''}\n`);

const failures = [];
for (const [name, build] of shapes) {
  try {
    const size = await runShape(build());
    console.log(`  ok   ${name} — ${size} doc(s)`);
  } catch (e) {
    // FAILED_PRECONDITION is the missing-index signal; anything else is still a
    // failure worth surfacing rather than swallowing.
    const missingIndex = /FAILED_PRECONDITION|requires an index/i.test(e.message);
    failures.push(name);
    console.log(`  FAIL ${name} — ${missingIndex ? 'MISSING INDEX' : 'error'}: ${e.message.split('\n')[0]}`);
    if (missingIndex && /https:\/\/\S+/.test(e.message)) {
      console.log(`       ${e.message.match(/https:\/\/\S+/)[0]}`);
    }
  }
}

console.log(failures.length ? `\n${failures.length} shape(s) FAILED` : '\nevery query shape is servable');
process.exit(failures.length ? 1 : 0);
