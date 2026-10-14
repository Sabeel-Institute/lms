import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

/**
 * `notifications/{uid}` — the first document either population may write.
 *
 * Three owners under one id, and the assertions are about keeping them apart: a
 * person owns their switches and their device tokens, and NOBODY owns the record
 * of what was already sent, because a client that could create one would silence
 * its own notifications.
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

const STUDENT = 'stu1';
const OTHER = 'stu2';
const MANAGER = 'mgr1';

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { [MANAGER]: 'manager' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, COLLECTIONS.notifications, STUDENT), { lastDay: false, updatedAt: 1 });
    await setDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'devices', 'tok-a'), {
      token: 'tok-a',
      platform: 'web',
      registeredAt: 1,
    });
    await setDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'sent', 'recordingReady_rec1'), {
      kind: 'recordingReady',
      targetId: 'rec1',
      at: 1,
    });
  });
});

const ctx = (uid: string, role: string) =>
  testEnv.authenticatedContext(uid, { role, status: 'active' });
const student = () => ctx(STUDENT, 'student');
const other = () => ctx(OTHER, 'student');
const manager = () => ctx(MANAGER, 'manager');
const pending = () => testEnv.authenticatedContext(STUDENT, { role: 'student', status: 'pending' });

describe('notification preferences', () => {
  it('lets a person read and change their own switches', async () => {
    const db = student().firestore();
    await assertSucceeds(getDoc(doc(db, COLLECTIONS.notifications, STUDENT)));
    await assertSucceeds(
      updateDoc(doc(db, COLLECTIONS.notifications, STUDENT), { lastDay: true, updatedAt: 2 }),
    );
  });

  it('lets staff do the same — this is the first document they may write', async () => {
    await assertSucceeds(
      setDoc(doc(manager().firestore(), COLLECTIONS.notifications, MANAGER), {
        attendanceMissing: false,
        updatedAt: 1,
      }),
    );
  });

  it('does NOT let anyone touch someone else\'s switches', async () => {
    const db = other().firestore();
    await assertFails(getDoc(doc(db, COLLECTIONS.notifications, STUDENT)));
    await assertFails(
      updateDoc(doc(db, COLLECTIONS.notifications, STUDENT), { lastDay: true, updatedAt: 2 }),
    );
  });

  it('refuses keys outside the switch list, on create and on update', async () => {
    // Without hasOnly this document quietly becomes a place to store anything —
    // client-writable, per-user, and never re-audited.
    const db = student().firestore();
    await assertFails(
      updateDoc(doc(db, COLLECTIONS.notifications, STUDENT), { role: 'admin' }),
    );
    await assertFails(
      setDoc(doc(other().firestore(), COLLECTIONS.notifications, OTHER), {
        lastDay: true,
        somethingElse: 1,
      }),
    );
  });

  it('refuses a gated account, and refuses deletion outright', async () => {
    await assertFails(getDoc(doc(pending().firestore(), COLLECTIONS.notifications, STUDENT)));
    await assertFails(deleteDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT)));
  });
});

describe('device tokens', () => {
  it('lets a person register and unregister their own devices', async () => {
    const db = student().firestore();
    await assertSucceeds(
      setDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'devices', 'tok-b'), {
        token: 'tok-b',
        platform: 'android',
        registeredAt: 2,
      }),
    );
    await assertSucceeds(getDocs(collection(db, COLLECTIONS.notifications, STUDENT, 'devices')));
    await assertSucceeds(
      deleteDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'devices', 'tok-a')),
    );
  });

  it('lets a device RE-register — the second visit to the settings screen', async () => {
    // The row already exists, so this is an UPDATE, not a create. Denying it made
    // the settings screen report a registered, working device as unable to
    // receive push, every time after the first.
    await assertSucceeds(
      setDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-a'), {
        token: 'tok-a',
        platform: 'web',
        registeredAt: 99,
      }),
    );
  });

  /*
   * THE ROW IS READ BY THE SEND PATH AND ORDERED BY A TRIGGER, so a field
   * nobody expects is a field nobody validates. `registeredAt` in particular is
   * bounded: a row claiming to be registered in the year 50,000 is a claim about
   * ordering, and the one decision on this platform a client should not be able
   * to buy. (`onDeviceRegistered` orders by Firestore's own `updateTime` for
   * exactly that reason — this is the second lock on the same door.)
   */
  it('does NOT let a device row carry a field the shape has no room for', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-c'), {
        token: 'tok-c',
        platform: 'web',
        registeredAt: 2,
        priority: 'always-mine',
      }),
    );
  });

  /** A whole number of milliseconds, which is what `Date.now()` is. */
  it('does NOT let registeredAt be a non-integer', async () => {
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-e'), {
        token: 'tok-e',
        platform: 'web',
        registeredAt: 1.5,
      }),
    );
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-f'), {
        token: 'tok-f',
        platform: 'web',
        registeredAt: 'now',
      }),
    );
  });

  it('does NOT let anyone read or plant a token on someone else', async () => {
    const db = other().firestore();
    await assertFails(getDocs(collection(db, COLLECTIONS.notifications, STUDENT, 'devices')));
    await assertFails(
      setDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'devices', 'tok-evil'), {
        token: 'tok-evil',
        platform: 'web',
        registeredAt: 2,
      }),
    );
  });

  it('does NOT let a token be edited into another one', async () => {
    // The id is the token, so a row whose `token` field says otherwise is a
    // registration pointing at a device this document does not name.
    await assertFails(
      updateDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-a'), {
        token: 'tok-c',
      }),
    );
    await assertFails(
      setDoc(doc(student().firestore(), COLLECTIONS.notifications, STUDENT, 'devices', 'tok-d'), {
        token: 'tok-e',
        platform: 'web',
        registeredAt: 1,
      }),
    );
  });
});

describe('sent records', () => {
  it('are server-only in both directions', async () => {
    const db = student().firestore();
    // Reading teaches nothing the app asks; CREATING would let a student
    // pre-claim their own notifications and never hear from the app again.
    await assertFails(
      getDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'sent', 'recordingReady_rec1')),
    );
    await assertFails(
      setDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'sent', 'recordingReady_rec2'), {
        kind: 'recordingReady',
        targetId: 'rec2',
        at: 2,
      }),
    );
    await assertFails(
      deleteDoc(doc(db, COLLECTIONS.notifications, STUDENT, 'sent', 'recordingReady_rec1')),
    );
  });
});
