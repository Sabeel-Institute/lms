import { describe, it, beforeAll, beforeEach, expect, vi } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, PASSWORD_LINK_ANSWER } from '@sabeel/shared';
import { setBackgroundTriggers } from '../backgroundTriggers';

/*
 * THE SIGN-IN SCREEN'S ANSWER CANNOT DEPEND ON WHO HAS AN ACCOUNT, in its
 * words or in the time it takes, because nothing on the way to it asks.
 * Proved by taking Auth away: every call to it throws here, and the answer
 * still comes, the same for every address, with one request queued for each.
 * Which addresses get a link is decided afterwards, where nobody waits
 * (passwordLinks.integration.test.ts).
 *
 * A timing measurement would be the direct test, and a flaky one on a shared
 * machine; this is the property that makes the timing equal.
 */
vi.mock('firebase-admin/auth', () => ({
  getAuth: () =>
    new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('the answer asked Auth');
        },
      },
    ),
}));

const { requestPasswordLink } = await import('../../src/passwordLinks');

beforeAll(async () => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
  await setBackgroundTriggers(false);
  return () => setBackgroundTriggers(true);
});

beforeEach(async () => {
  for (const c of [COLLECTIONS.passwordLinkRequests, COLLECTIONS.passwordLinkLimits]) {
    await getFirestore().recursiveDelete(getFirestore().collection(c));
  }
});

describe('requestPasswordLink', () => {
  it('answers without asking Auth anything, the same for every address', async () => {
    const answers = [];
    for (const email of ['a-student@example.com', 'faisal.shah@oursabeel.com', 'nobody-at-all@example.com']) {
      answers.push(await requestPasswordLink.run({ data: { email } } as unknown as CallableRequest));
    }
    expect(answers).toEqual([1, 2, 3].map(() => ({ message: PASSWORD_LINK_ANSWER })));
    expect((await getFirestore().collection(COLLECTIONS.passwordLinkRequests).get()).size).toBe(3);
  });
});
