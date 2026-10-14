/**
 * Read every document the app reads, in the REAL project, the way the app
 * checks it against its type (`documentShapes` in @sabeel/shared) and runs
 * the screens' helpers on it — and fail on what would hurt:
 *
 *   - a field its type requires that a document LACKS: data to migrate;
 *   - a helper that THROWS on a document: a screen that crashes for whoever
 *     opens it.
 *
 *     npm run check:documents
 *
 * Read-only: nothing is written. Run it before every release and after every
 * migration (docs/DEPLOY.md). With `CHECK_ACCESS_TOKEN` set it reads over REST
 * as that user, as check:queries does, since this machine's Application
 * Default Credentials may belong to another Google account.
 *
 * WHY THIS CANNOT BE AN EMULATOR TEST: the emulator holds only what today's
 * code and fixtures wrote, and the documents that hurt are the ones nobody
 * wrote today.
 */
import { createRequire } from 'node:module';
import { listDocuments } from './lib/firestore-rest.mjs';
import {
  APP_CONFIG_DOC,
  DOCUMENT_SHAPES,
  FIREBASE_PROJECT_ID,
  INSTITUTE_TIMEZONE,
  SCREEN_CHECKS,
  checkStored,
  storedDoc,
  todayInZone,
} from '@sabeel/shared';

// Resolved from the functions workspace, which already depends on the Admin
// SDK, as check:queries does.
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT_ID = process.env.CHECK_PROJECT ?? FIREBASE_PROJECT_ID;
const TOKEN = process.env.CHECK_ACCESS_TOKEN;
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const today = todayInZone(INSTITUTE_TIMEZONE);
const PAGE = 500;
const EXAMPLES = 3;

/** Every document of a collection the app reads, a page at a time: `{ id, data }`. */
async function* documents(collection) {
  if (TOKEN) {
    for await (const d of listDocuments(PROJECT_ID, collection, TOKEN)) {
      // The app reads one document of `config`; the others are not its.
      if (collection !== 'config' || d.id === APP_CONFIG_DOC) yield d;
    }
    return;
  }
  if (collection === 'config') {
    const snap = await db.collection(collection).doc(APP_CONFIG_DOC).get();
    if (snap.exists) yield { id: snap.id, data: snap.data() };
    return;
  }
  let last = null;
  for (;;) {
    let q = db.collection(collection).orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const d of page.docs) yield { id: d.id, data: d.data() };
    if (page.size < PAGE) return;
    last = page.docs[page.size - 1];
  }
}

const add = (map, key, id) => {
  const entry = map.get(key) ?? { count: 0, ids: [] };
  entry.count += 1;
  if (entry.ids.length < EXAMPLES) entry.ids.push(id);
  map.set(key, entry);
};

let failures = 0;
console.log(`Documents in ${PROJECT_ID}${TOKEN ? ' (REST, user token)' : ''}, read as the app reads them:\n`);
for (const collection of Object.keys(DOCUMENT_SHAPES)) {
  let read = 0;
  const missing = new Map();
  const thrown = new Map();
  for await (const { id, data } of documents(collection)) {
    read += 1;
    for (const path of checkStored(collection, data)) add(missing, path, id);
    for (const [i, check] of (SCREEN_CHECKS[collection] ?? []).entries()) {
      try {
        check(storedDoc(collection, data), today);
      } catch (e) {
        add(thrown, `screen check ${i + 1}: ${e instanceof Error ? e.message : String(e)}`, id);
      }
    }
  }
  const bad = missing.size + thrown.size;
  failures += bad;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${collection.padEnd(20)} ${String(read).padStart(6)} read`);
  const list = (label, map) => {
    for (const [what, { count, ids }] of map) {
      console.log(`       ${label} ${what}: ${count} (e.g. ${ids.join(', ')})`);
    }
  };
  list('LACKS', missing);
  list('THROWS', thrown);
}
console.log(
  failures
    ? `\n${failures} problem(s): documents lack fields their type requires (migrate them), or a screen would crash on one.`
    : '\nEvery document reads, and every screen check runs on it.',
);
process.exit(failures ? 1 : 0);
