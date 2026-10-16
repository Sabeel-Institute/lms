import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';
import { seedStaffRecords, seedStudentRecords } from './staffRecords';

/**
 * NOBODY'S CLIENT READS OR WRITES A REPORT: not the person who sent it, not an
 * admin. A report names who it is about and is answered by email; the server
 * keeps it (`reportProblem`), and a client that could write one could skip the
 * hourly limit and the email to the administrators.
 *
 * A suite of denials passes on any failure, a dead connection included, so it
 * was shown red with the `reports` rule opened to `if true`; and each case
 * here runs beside one read that must succeed, so a harness that is not
 * connected fails rather than passes.
 */

let testEnv: RulesTestEnvironment;

/** `host:port` from the emulator env var the CLI exports; no fallback (see rules.identity.test.ts). */
function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  return { host: host || '127.0.0.1', port: Number(port) };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      ...hostPort('FIRESTORE_EMULATOR_HOST'),
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

const ADMIN = 'admin1';
const MANAGER = 'manager1';
const STUDENT = 'student1';
const MINE = 'report-of-student1';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [ADMIN]: 'admin', [MANAGER]: 'manager' });
  await seedStudentRecords(testEnv, [STUDENT]);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), COLLECTIONS.reports, MINE), {
      app: 'Sabeel Institute LMS',
      uid: STUDENT,
      displayName: STUDENT,
      email: `${STUDENT}@example.com`,
      role: 'student',
      text: 'A comment on Session 1 was abusive.',
      createdAt: 1,
      mail: { status: 'sent', messageId: 'm1' },
    });
  });
});

const as = (uid: string, role: string) => testEnv.authenticatedContext(uid, { role, status: 'active' }).firestore();
/** Who tries, their uid and role, and the record of their own they can read. */
const PEOPLE: [string, string, string, string][] = [
  ['the student who sent it', STUDENT, 'student', COLLECTIONS.students],
  ['a manager', MANAGER, 'manager', COLLECTIONS.staffUsers],
  ['an admin', ADMIN, 'admin', COLLECTIONS.staffUsers],
];

describe('reports', () => {
  for (const [who, uid, role, ownCollection] of PEOPLE) {
    const db = () => as(uid, role);

    it(`cannot be read by ${who}`, async () => {
      // Connected: the same client reads its own record.
      await assertSucceeds(getDoc(doc(db(), ownCollection, uid)));
      await assertFails(getDoc(doc(db(), COLLECTIONS.reports, MINE)));
      await assertFails(getDocs(collection(db(), COLLECTIONS.reports)));
      await assertFails(getDocs(query(collection(db(), COLLECTIONS.reports), where('uid', '==', uid))));
    });

    it(`cannot be written by ${who}: not made, changed or removed`, async () => {
      await assertSucceeds(getDoc(doc(db(), ownCollection, uid)));
      const report = { uid, text: 'Made by the client', createdAt: 2 };
      await assertFails(addDoc(collection(db(), COLLECTIONS.reports), report));
      await assertFails(setDoc(doc(db(), COLLECTIONS.reports, `new-${uid}`), report));
      await assertFails(updateDoc(doc(db(), COLLECTIONS.reports, MINE), { text: 'Changed by the client' }));
      await assertFails(deleteDoc(doc(db(), COLLECTIONS.reports, MINE)));
    });
  }

  it('cannot be read or written by anyone signed out', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, COLLECTIONS.reports, MINE)));
    await assertFails(setDoc(doc(anon, COLLECTIONS.reports, 'anon'), { text: 'x' }));
  });

  it('is left as the server wrote it', async () => {
    await assertFails(updateDoc(doc(as(STUDENT, 'student'), COLLECTIONS.reports, MINE), { text: 'Changed' }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const r = (await getDoc(doc(ctx.firestore(), COLLECTIONS.reports, MINE))).data();
      if (r?.text !== 'A comment on Session 1 was abusive.') throw new Error(`the report was changed: ${r?.text}`);
      if ((await getDocs(collection(ctx.firestore(), COLLECTIONS.reports))).size !== 1) throw new Error('a client made a report');
    });
  });
});
