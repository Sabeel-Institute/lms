import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID } from '@sabeel/shared';

/**
 * Phase 0: prove the Firestore deny-all baseline.
 *
 * A suite that only asserts denials still earns its place — it proves the rules
 * harness runs, which is the thing later phases depend on. Media has no rules
 * to test: it lives in a private bucket reached only by signed URLs, held by
 * `playback.integration.test.ts` and the upload tests in
 * `recordings.integration.test.ts`.
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
  const fs = hostPort('FIRESTORE_EMULATOR_HOST');
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      ...fs,
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv?.cleanup();
});

const signedIn = () => testEnv.authenticatedContext('someone');
const anon = () => testEnv.unauthenticatedContext();

describe('firestore rules: deny-all baseline', () => {
  // Every collection the product will eventually use. Adding a collection to
  // @sabeel/shared without opening it in the rules should keep failing here,
  // which is exactly the behaviour we want between now and Phase 1. `config`
  // is the one collection readable by everyone, on purpose — the update gate
  // reads it before sign-in — and has its own suite (`rules.config.test.ts`).
  const names = Object.values(COLLECTIONS).filter((n) => n !== COLLECTIONS.config);

  it('denies reads to a signed-in user', async () => {
    const db = signedIn().firestore();
    for (const name of names) {
      await assertFails(getDocs(collection(db, name)));
    }
  });

  it('denies writes to a signed-in user', async () => {
    const db = signedIn().firestore();
    for (const name of names) {
      await assertFails(setDoc(doc(db, name, 'x'), { any: 'thing' }));
    }
  });

  it('denies an anonymous read', async () => {
    const db = anon().firestore();
    await assertFails(getDoc(doc(db, COLLECTIONS.recordings, 'x')));
  });
});
