import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, RULES_VERSION } from '@sabeel/shared';

/**
 * Rules for the two auth populations.
 *
 * Every case here is about the TOKEN, because that is what the rules read. The
 * mirror documents are seeded with security rules disabled — a client can never
 * write them, which is itself one of the assertions.
 */

let testEnv: RulesTestEnvironment;

/**
 * `host:port` from the emulator env var the CLI exports.
 *
 * NO fallback port, deliberately. `emulators:exec` always sets these
 * (`firebase-tools/lib/emulator/env.js`), so an unset var means the suite is
 * running outside the wrapper — and a hardcoded default does not rescue that,
 * it points at whatever happens to be on that port. On a machine where three
 * checkouts run emulators, that is a SIBLING's: it reads and writes happily and
 * turns a rules suite green against the wrong database. Failing loudly is the
 * only safe behaviour.
 */
function hostPort(envName: string) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is unset — run via npm run test:emulator`);
  const [host, port] = value.split(':');
  // Literal 127.0.0.1, never 'localhost': the emulators bind IPv4 only, while
  // 'localhost' can resolve to IPv6 ::1 first and fail at connect.
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
const PENDING = 'pending1';
const DISABLED = 'disabled1';
const STUDENT = 'student1';
const OTHER_STUDENT = 'student2';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const staff = (uid: string, role: string, status: string) =>
      setDoc(doc(db, COLLECTIONS.staffUsers, uid), {
        displayName: uid,
        email: `${uid}@oursabeel.com`,
        photoUrl: null,
        role,
        status,
        createdAt: 1,
      });
    const student = (uid: string, status: string) =>
      setDoc(doc(db, COLLECTIONS.students, uid), {
        displayName: uid,
        email: `${uid}@example.com`,
        role: 'student',
        status,
        createdAt: 1,
        createdBy: ADMIN,
      });
    await Promise.all([
      staff(ADMIN, 'admin', 'active'),
      staff(MANAGER, 'manager', 'active'),
      staff(PENDING, 'manager', 'pending'),
      staff(DISABLED, 'manager', 'disabled'),
      student(STUDENT, 'active'),
      student(OTHER_STUDENT, 'active'),
    ]);
  });
});

const ctx = (uid: string, role: string, status: string) =>
  testEnv.authenticatedContext(uid, { role, status }).firestore();
const admin = () => ctx(ADMIN, 'admin', 'active');
const manager = () => ctx(MANAGER, 'manager', 'active');
const pending = () => ctx(PENDING, 'manager', 'pending');
const disabled = () => ctx(DISABLED, 'manager', 'disabled');
const student = () => ctx(STUDENT, 'student', 'active');
const anon = () => testEnv.unauthenticatedContext().firestore();

describe('staffUsers', () => {
  it('lets staff list the roster', async () => {
    await assertSucceeds(getDocs(collection(admin(), COLLECTIONS.staffUsers)));
    await assertSucceeds(getDocs(collection(manager(), COLLECTIONS.staffUsers)));
  });

  it('lets a PENDING user read their own document', async () => {
    // Load-bearing: the gate screen reads this to show status, and it is how
    // approval becomes visible without a sign-out.
    await assertSucceeds(getDoc(doc(pending(), COLLECTIONS.staffUsers, PENDING)));
  });

  it('does not let a pending user read anyone else, or list', async () => {
    await assertFails(getDoc(doc(pending(), COLLECTIONS.staffUsers, ADMIN)));
    await assertFails(getDocs(collection(pending(), COLLECTIONS.staffUsers)));
  });

  it('treats a disabled account like a stranger, apart from its own document', async () => {
    await assertSucceeds(getDoc(doc(disabled(), COLLECTIONS.staffUsers, DISABLED)));
    await assertFails(getDocs(collection(disabled(), COLLECTIONS.staffUsers)));
  });

  it('does not let students read staff', async () => {
    await assertFails(getDoc(doc(student(), COLLECTIONS.staffUsers, ADMIN)));
    await assertFails(getDocs(collection(student(), COLLECTIONS.staffUsers)));
  });

  it('denies anonymous access entirely', async () => {
    await assertFails(getDoc(doc(anon(), COLLECTIONS.staffUsers, ADMIN)));
  });

  it('lets NOBODY write — not even an admin, not even themselves', async () => {
    // Access changes go through the setStaffAccess callable, which re-checks the
    // caller. If clients could write here, self-promotion would be one
    // updateDoc away.
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.staffUsers, MANAGER), { role: 'admin' }));
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.staffUsers, ADMIN), { role: 'admin' }));
    await assertFails(
      updateDoc(doc(manager(), COLLECTIONS.staffUsers, MANAGER), { role: 'admin' }),
    );
    await assertFails(
      updateDoc(doc(pending(), COLLECTIONS.staffUsers, PENDING), { status: 'active' }),
    );
  });
});

/*
 * ACCEPTING THE INSTITUTE'S RULES IS THE SERVER'S RECORD. The app shows the
 * rules screen to an account whose record says it has not accepted, and only
 * `acceptRules` writes that it has, with the server's time. An account that
 * could write the two fields itself could skip the screen without ever seeing
 * the rules, or back-date its agreement.
 */
describe("the institute's rules, accepted", () => {
  const accepted = { rulesAcceptedAt: 1_760_000_000_000, rulesVersion: RULES_VERSION };

  it('cannot be written onto a record by the account it belongs to, student or staff', async () => {
    await assertFails(updateDoc(doc(student(), COLLECTIONS.students, STUDENT), accepted));
    await assertFails(setDoc(doc(student(), COLLECTIONS.students, STUDENT), accepted, { merge: true }));
    await assertFails(updateDoc(doc(manager(), COLLECTIONS.staffUsers, MANAGER), accepted));
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.staffUsers, ADMIN), accepted));
  });

  it('cannot be written onto anyone else’s record either, by an admin included', async () => {
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.students, STUDENT), accepted));
    await assertFails(updateDoc(doc(admin(), COLLECTIONS.staffUsers, MANAGER), accepted));
  });

  it('leaves the records as they were', async () => {
    await assertFails(updateDoc(doc(student(), COLLECTIONS.students, STUDENT), accepted));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const rec = (await getDoc(doc(ctx.firestore(), COLLECTIONS.students, STUDENT))).data();
      if (rec?.rulesVersion !== undefined) throw new Error('the student’s record says they accepted');
    });
  });
});

describe('students', () => {
  it('lets staff list students', async () => {
    await assertSucceeds(getDocs(collection(admin(), COLLECTIONS.students)));
    await assertSucceeds(getDocs(collection(manager(), COLLECTIONS.students)));
  });

  it('lets a student read only their own record', async () => {
    await assertSucceeds(getDoc(doc(student(), COLLECTIONS.students, STUDENT)));
    await assertFails(getDoc(doc(student(), COLLECTIONS.students, OTHER_STUDENT)));
    await assertFails(getDocs(collection(student(), COLLECTIONS.students)));
  });

  it('does not let a student edit their own record', async () => {
    // Their name is part of the accountability record staff read.
    await assertFails(
      updateDoc(doc(student(), COLLECTIONS.students, STUDENT), { displayName: 'Someone Else' }),
    );
    await assertFails(
      updateDoc(doc(student(), COLLECTIONS.students, STUDENT), { status: 'active' }),
    );
  });

  it('does not let staff write students directly', async () => {
    await assertFails(
      updateDoc(doc(admin(), COLLECTIONS.students, STUDENT), { status: 'disabled' }),
    );
  });
});

describe('collections not yet opened', () => {
  it('stay denied even to an admin', async () => {
    /*
     * Two different closures, and calling them one thing was already wrong.
     *
     * `backendStats` is unopened — Phase 8 — and denied to everybody by the
     * catch-all. `notifications` IS open, but only ever to the OWNER of the
     * document: `notifications/{uid}` and its devices are the person's own
     * preferences, so an admin is refused there not because the collection is
     * shut but because an admin is not that person. The two assertions below
     * each fail on their own guard, so either could be dropped and this stayed
     * green while it read as a claim about the collection.
     */
    for (const name of [COLLECTIONS.notifications, COLLECTIONS.backendStats]) {
      await assertFails(getDocs(collection(admin(), name)));
      await assertFails(setDoc(doc(admin(), name, 'x'), { any: 'thing' }));
    }
  });

  it('opens a person’s notification preferences to that person and nobody else', async () => {
    // The other half of the pair above: this is what makes the admin denial a
    // statement about OWNERSHIP rather than about a shut collection.
    await assertSucceeds(getDoc(doc(admin(), COLLECTIONS.notifications, ADMIN)));
    await assertFails(getDoc(doc(admin(), COLLECTIONS.notifications, 'someone-else')));
  });

  it('stay WRITE-denied on the collections opened for reading', async () => {
    // Opening a collection to reads must not have opened it to writes: every
    // mutation goes through a callable (or the fan-out trigger) that re-checks
    // scope. An admin can READ all of these; none may be written by any client
    // (the student-written ones reject an admin because admin is not the owner).
    for (const name of [
      COLLECTIONS.cohorts,
      COLLECTIONS.courses,
      COLLECTIONS.enrollments,
      COLLECTIONS.recordings,
      COLLECTIONS.assignments,
      COLLECTIONS.auditLog,
      COLLECTIONS.completions,
      COLLECTIONS.completionEvents,
      COLLECTIONS.listeningProgress,
      COLLECTIONS.bookmarks,
      COLLECTIONS.completionOverrides,
    ]) {
      await assertFails(setDoc(doc(admin(), name, 'x'), { any: 'thing' }));
    }
  });
});
