import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, enrollmentId } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

/**
 * A staff member disabled or demoted a moment ago still holds a token that
 * says otherwise, for up to an hour, and Firestore cannot ask whether it was
 * revoked. The callables can (`assertAccountLive`). For READS the rules ask
 * the staff record, which `setStaffAccess` writes as part of the change. So
 * what such a token can read is asserted here against a record that has
 * changed, beside the same token against a record that has not. The second
 * half is what shows that the record, and nothing else, refuses the first.
 */

let testEnv: RulesTestEnvironment;

/** `host:port` from the emulator env var the CLI exports (see rules.audit.test.ts). */
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

const MANAGER = 'mgr1';
const ADMIN = 'adm1';
const STUDENT = 'stu1';
const CLASS = 'class1';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all([
      setDoc(doc(db, COLLECTIONS.courses, CLASS), { cohortId: 'c1', managerUids: [MANAGER] }),
      setDoc(doc(db, COLLECTIONS.students, STUDENT), {
        displayName: 'Aminah',
        email: 'aminah@example.com',
        role: 'student',
        status: 'active',
        createdAt: 1,
        createdBy: ADMIN,
      }),
      setDoc(doc(db, COLLECTIONS.enrollments, enrollmentId(STUDENT, CLASS)), {
        studentUid: STUDENT,
        courseId: CLASS,
        cohortId: 'c1',
        active: true,
        stretches: [{ from: 1, to: null }],
      }),
      setDoc(doc(db, COLLECTIONS.auditLog, 'someone-elses'), {
        at: 1,
        actorUid: 'another-admin',
        actorRole: 'admin',
        action: 'setStaffAccess',
        courseId: null,
        targets: { uid: 'x' },
      }),
    ]);
  });
});

/** Signed in with the claims the token still carries. */
const asTheyWere = (uid: string, role: 'manager' | 'admin') =>
  testEnv.authenticatedContext(uid, { role, status: 'active' }).firestore();

/** What a manager of CLASS reads: the directory, a student, the class and its roster. */
const managerReads = (db: ReturnType<typeof asTheyWere>): Promise<unknown>[] => [
  getDocs(collection(db, COLLECTIONS.students)),
  getDoc(doc(db, COLLECTIONS.students, STUDENT)),
  getDoc(doc(db, COLLECTIONS.courses, CLASS)),
  getDocs(query(collection(db, COLLECTIONS.enrollments), where('courseId', '==', CLASS))),
];

describe('a staff token whose staff record has changed', () => {
  it('a manager disabled a moment ago reads no student, no class and no roster', async () => {
    await seedStaffRecords(testEnv, { [MANAGER]: 'manager' }, 'disabled');
    for (const read of managerReads(asTheyWere(MANAGER, 'manager'))) await assertFails(read);
  });

  it('the same token, while the record still says active, reads all of them', async () => {
    await seedStaffRecords(testEnv, { [MANAGER]: 'manager' });
    for (const read of managerReads(asTheyWere(MANAGER, 'manager'))) await assertSucceeds(read);
  });

  it('an admin just made a manager reads nothing only an admin may, nor anything at all', async () => {
    await seedStaffRecords(testEnv, { [ADMIN]: 'manager' });
    const db = asTheyWere(ADMIN, 'admin');
    await assertFails(getDocs(collection(db, COLLECTIONS.auditLog)));
    await assertFails(getDocs(collection(db, COLLECTIONS.students)));
    await assertFails(getDoc(doc(db, COLLECTIONS.courses, CLASS)));
  });

  it('the same token, while the record still says admin, reads them', async () => {
    await seedStaffRecords(testEnv, { [ADMIN]: 'admin' });
    const db = asTheyWere(ADMIN, 'admin');
    await assertSucceeds(getDocs(collection(db, COLLECTIONS.auditLog)));
    await assertSucceeds(getDocs(collection(db, COLLECTIONS.students)));
    await assertSucceeds(getDoc(doc(db, COLLECTIONS.courses, CLASS)));
  });

  it('a staff token with no staff record at all reads nothing', async () => {
    for (const read of managerReads(asTheyWere(MANAGER, 'manager'))) await assertFails(read);
  });

  it('a student is not asked for a staff record, and still reads their own', async () => {
    const db = testEnv.authenticatedContext(STUDENT, { role: 'student', status: 'active' }).firestore();
    await assertSucceeds(getDoc(doc(db, COLLECTIONS.students, STUDENT)));
  });
});
