#!/usr/bin/env node
/**
 * Where every student stands with their account: has a password ever been
 * set, when, and have they signed in since. READ-ONLY, against the REAL project.
 *
 *     npm run students:report                          # every student
 *     npm run students:report -- --email <address>     # one student, with their audited history
 *
 * WHY THIS EXISTS: a student who cannot get in reports the page Firebase hosts
 * for the emailed link, "Try resetting your password again", and that page
 * says the same thing for every failure. Measured against production on
 * 2026-10-07 (docs/DEV-TOOLING.md, "A student can't set a password"): a link
 * dies the moment a newer one is sent, once it has been used, when it is cut
 * off, and an hour after it was sent; a disabled account opens the form and
 * fails at Save. The app records none of it. Every link goes out through the
 * client's `sendPasswordResetEmail` — at creation, from Resend, from "Email
 * me a password link" — so no callable sees a send and the audit log holds
 * no resend, and Firebase Auth outside Identity Platform logs nothing per user.
 * The Auth user record is the one place that says whether a link ever worked:
 * `passwordUpdatedAt` is the moment one did, and an account created by
 * `createStudent` has no password until then.
 *
 * The Admin SDK's UserRecord does not carry `passwordUpdatedAt`, and the field
 * that looks like a substitute does not substitute: `tokensValidAfterTime`
 * moves when a password is set AND when an account is disabled, so it dates a
 * disable as a password. So the Auth half reads `accounts:lookup` directly.
 *
 * NOT EVERY STUDENT RECORD IS A STUDENT. Staff open student accounts on their
 * personal addresses, to see the student side or to listen to a course such as
 * board meetings, and testing leaves accounts behind. Counted with the class
 * they would hide the answer: on 2026-10-07 every sign-in in the collection was
 * a staff or test account, and no student had ever signed in. So the counts
 * cover students only, and the rest are listed apart with the reason:
 *
 *  - a name beginning "Test";
 *  - an institute address — `createStudent` refuses one, so a student record
 *    on it predates that guard and is not a student;
 *  - a staff member's own name: the same first name as someone in
 *    `staffUsers`, and the same surname to within one letter ("Ahamed" for
 *    "Ahmed") or no surname on one side ("Afshan" for "Afshan Hashmi").
 *    Staff sign in with Google on the institute domain, so there is no email
 *    to match on; the name is what the two records share.
 *
 * Reads Firestore `students`, `staffUsers`, `auditLog` and `courses`, and Auth
 * user records. Writes nothing. Emails are masked in the full list — rows are
 * told apart by name, and this output lands in terminals and agent
 * transcripts; `--email` prints back only the address it was given.
 */
import { createRequire } from 'node:module';
import { COLLECTIONS, FIREBASE_PROJECT_ID, INSTITUTE_TIMEZONE, isAllowedStaffEmail } from '@sabeel/shared';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = FIREBASE_PROJECT_ID;
const USAGE = 'usage: npm run students:report [-- --email <student address>]';

const args = process.argv.slice(2);
let email = null;
if (args.length === 2 && args[0] === '--email' && /^[^\s@]+@[^\s@]+$/.test(args[1].trim())) {
  // Stored addresses are lowercased by createStudent; match them the same way.
  email = args[1].trim().toLowerCase();
} else if (args.length !== 0) {
  console.error(USAGE);
  process.exit(2);
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('An emulator host is set — this script reads production only.');
}

const credential = admin.credential.applicationDefault();
admin.initializeApp({ projectId: PROJECT, credential });
const db = admin.firestore();

/** Auth's own records, keyed by uid; `query` is `{ localId: [...] }` or `{ email: [...] }`. */
async function lookup(query) {
  const { access_token: token } = await credential.getAccessToken();
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-goog-user-project': PROJECT,
    },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error(`accounts:lookup ${res.status}: ${await res.text()}`);
  return new Map(((await res.json()).users ?? []).map((u) => [u.localId, u]));
}

async function lookupUids(uids) {
  const all = new Map();
  for (let i = 0; i < uids.length; i += 100) {
    for (const [uid, u] of await lookup({ localId: uids.slice(i, i + 100) })) all.set(uid, u);
  }
  return all;
}

const when = (ms) =>
  ms ? new Date(Number(ms)).toLocaleString('sv-SE', { timeZone: INSTITUTE_TIMEZONE, dateStyle: 'short', timeStyle: 'short' }) : 'never';
const mask = (address) => String(address).replace(/^(.)[^@]*@/, '$1***@');

const nameTokens = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** At most one insertion, deletion or substitution apart. */
function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length >= b.length) i += 1;
    if (a.length <= b.length) j += 1;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Why a student record is not counted as a student, or null when it is one. */
function notAStudent(student, staff) {
  if (/^test\b/i.test(String(student.displayName).trim())) return 'test account';
  if (isAllowedStaffEmail(student.email, true)) return 'institute address';
  const s = nameTokens(student.displayName);
  const match = s.length && staff.find((member) => {
    const t = nameTokens(member.displayName);
    if (t.length === 0 || t[0] !== s[0]) return false;
    return s.length === 1 || t.length === 1 || oneEditApart(s[s.length - 1], t[t.length - 1]);
  });
  return match ? `staff: ${match.displayName} (${match.role})` : null;
}

/** One student's state, from their document and their Auth record. */
function facts(student, user, staff) {
  const passwordSet = !!user?.providerUserInfo?.some((p) => p.providerId === 'password');
  const lastRefresh = user?.lastRefreshAt ? Date.parse(user.lastRefreshAt) : null;
  // The document drives the app, the Auth flag drives sign-in; setStudentAccess
  // moves both, so a disagreement is itself a finding.
  let status = student.status;
  if (!user) status = 'NO AUTH USER';
  else if (student.status === 'disabled' && user.disabled) status = 'disabled';
  else if (student.status === 'disabled' || user.disabled) status = 'MISMATCH';
  return {
    name: student.displayName,
    email: student.email,
    excluded: notAStudent(student, staff),
    status,
    created: student.createdAt,
    passwordSet,
    passwordAt: passwordSet ? user.passwordUpdatedAt : null,
    lastSignIn: user?.lastLoginAt ?? null,
    lastActive: lastRefresh,
  };
}

/** What the state means for the next set-password link — the question a report brings. */
function reading(f) {
  if (f.status === 'NO AUTH USER') {
    return 'There is no Auth account behind this student record, so no link can work. Investigate before resending.';
  }
  if (f.status !== 'active') {
    return 'The account is switched off (or half switched off). A link opens the form, and Save then shows "Try resetting your password again".';
  }
  if (!f.passwordSet) {
    return 'No link has ever worked for this account. Only the most recent link sent can, and only for an hour after it was sent; every earlier one opens "Try resetting your password again".';
  }
  if (!f.lastSignIn) {
    return `A link worked on ${when(f.passwordAt)}, and nobody has signed in to this account since. That link now opens "Try resetting your password again"; the password chosen then still works.`;
  }
  return `This account has a password and last signed in on ${when(f.lastSignIn)}. A forgotten password takes one new link, used within the hour.`;
}

const staff = (await db.collection(COLLECTIONS.staffUsers).get()).docs.map((d) => d.data());

if (email) {
  const found = (await db.collection(COLLECTIONS.students).where('email', '==', email).get()).docs;
  if (found.length === 0) {
    const auth = await lookup({ email: [email] });
    console.log(auth.size
      ? `${email} has an account but no student record (a staff account?).`
      : `No account uses ${email}. Check the spelling against the student's page.`);
    process.exit(1);
  }
  const doc = found[0];
  const f = facts(doc.data(), (await lookupUids([doc.id])).get(doc.id), staff);
  const rows = [
    ['Student', `${f.name} <${email}>`],
    ['Counted as', f.excluded ? `not a student (${f.excluded})` : 'a student'],
    ['Account', f.status],
    ['Created', when(f.created)],
    ['Password', f.passwordSet ? `set ${when(f.passwordAt)}` : 'never set'],
    ['Last sign-in', when(f.lastSignIn)],
    ['Last active', when(f.lastActive)],
  ];
  console.log(`Times are ${INSTITUTE_TIMEZONE}.\n`);
  for (const [k, v] of rows) console.log(`${k.padEnd(13)} ${v}`);
  console.log(`\n${reading(f)}\n`);

  const history = (await db.collection(COLLECTIONS.auditLog).where('targets.studentUid', '==', doc.id).get()).docs
    .map((d) => d.data())
    .sort((a, b) => a.at - b.at);
  const courseIds = [...new Set(history.map((h) => h.courseId).filter(Boolean))];
  const titles = new Map(
    await Promise.all(courseIds.map(async (id) => {
      const course = await db.collection(COLLECTIONS.courses).doc(id).get();
      return [id, course.exists ? course.data().name : `a course since deleted (${id})`];
    })),
  );
  console.log('Audited history');
  for (const h of history) {
    console.log(`  ${when(h.at)}  ${h.action.padEnd(20)} ${String(h.actorRole).padEnd(8)} ${h.courseId ? titles.get(h.courseId) : ''}`.trimEnd());
  }
  if (history.length === 0) console.log('  (none)');
  console.log('  Password links are never in it: every send is a client-side call that no callable sees.');
  process.exit(0);
}

const records = (await db.collection(COLLECTIONS.students).get()).docs;
const users = await lookupUids(records.map((d) => d.id));
const all = records
  .map((d) => facts(d.data(), users.get(d.id), staff))
  .sort((a, b) => b.created - a.created);
const students = all.filter((f) => !f.excluded);
const others = all.filter((f) => f.excluded);

function print(table) {
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const [i, r] of table.entries()) {
    console.log(r.map((c, j) => String(c).padEnd(widths[j])).join('  ').trimEnd());
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  }
}
const columns = ['Account', 'Created', 'Password set', 'Last sign-in', 'Last active'];
const cells = (f) => [f.status, when(f.created), f.passwordSet ? when(f.passwordAt) : 'NEVER', when(f.lastSignIn), when(f.lastActive)];

const never = students.filter((f) => !f.passwordSet).length;
const unused = students.filter((f) => f.passwordSet && !f.lastSignIn).length;
const signedIn = students.filter((f) => f.lastSignIn).length;
console.log(`${students.length} students: ${never} never set a password, ${unused} set one but never signed in, ${signedIn} signed in.`);
console.log(`${others.length} other student records are not counted; they are listed after the students.`);
console.log(`Times are ${INSTITUTE_TIMEZONE}. Emails masked; --email <address> shows one record in full.\n`);
print([['Name', 'Email', ...columns], ...students.map((f) => [f.name, mask(f.email), ...cells(f)])]);
if (others.length) {
  console.log('\nNot counted');
  print([['Name', 'Email', 'Why', ...columns], ...others.map((f) => [f.name, mask(f.email), f.excluded, ...cells(f)])]);
}
process.exit(0);
