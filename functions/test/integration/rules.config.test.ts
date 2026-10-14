import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { APP_CONFIG_DOC, COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';
import { seedStaffRecords } from './staffRecords';

/**
 * `config/app` — the oldest Android build allowed to run — is read by the app
 * BEFORE anyone signs in, so a retired build lands on the update screen on its
 * first frame rather than after a sign-in the rules then refuse. That is why
 * the read is open to a signed-out reader, which no other collection is; and
 * why nobody but the Admin SDK writes it, which is the half that keeps an open
 * read from being a hole.
 */
let testEnv: RulesTestEnvironment;

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

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedStaffRecords(testEnv, { adm: 'admin' });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), COLLECTIONS.config, APP_CONFIG_DOC), { minVersionCode: 32 });
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe('config/app', () => {
  it('is readable before sign-in, and by any account', async () => {
    await assertSucceeds(getDoc(doc(testEnv.unauthenticatedContext().firestore(), COLLECTIONS.config, APP_CONFIG_DOC)));
    await assertSucceeds(
      getDoc(doc(testEnv.authenticatedContext('stu', { role: 'student', status: 'active' }).firestore(), COLLECTIONS.config, APP_CONFIG_DOC)),
    );
  });

  it('is written by nobody — not even an admin', async () => {
    const admin = testEnv.authenticatedContext('adm', { role: 'admin', status: 'active' }).firestore();
    await assertFails(setDoc(doc(admin, COLLECTIONS.config, APP_CONFIG_DOC), { minVersionCode: 1 }));
    await assertFails(setDoc(doc(testEnv.unauthenticatedContext().firestore(), COLLECTIONS.config, APP_CONFIG_DOC), { minVersionCode: 1 }));
  });

  it('opens no other document under config than the one the app reads', async () => {
    // The rule is `config/{doc}`, so a second document would be readable too;
    // there is none, and a write to create one is refused above. This pins
    // that the read-open collection is not the deny-all catch-all by mistake.
    await assertSucceeds(getDoc(doc(testEnv.unauthenticatedContext().firestore(), COLLECTIONS.config, 'other')));
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), COLLECTIONS.backendStats, 'x')));
  });
});
