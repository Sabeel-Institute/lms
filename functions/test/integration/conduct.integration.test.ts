import { describe, it, beforeAll, beforeEach, afterEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, RULES_VERSION, type Role, type UserStatus } from '@sabeel/shared';
import { acceptRules, reportProblem, REPORTS_PER_HOUR } from '../../src/conduct';
import { resetMailTransport, setMailTransport, type MailOutcome, type OutgoingMail } from '../../src/mail';
import { idTokenFor } from './emulatorToken';

/*
 * THE INSTITUTE'S RULES AND REPORT A PROBLEM, driven through the callables as
 * the app calls them, against the Firestore and Auth emulators.
 *
 * The promises, in a person's words:
 *  - accepting the rules is recorded on my own account, by the server, once;
 *  - a report from someone whose account is not active, or who is not signed
 *    in, is neither kept nor emailed;
 *  - my report is kept once and emailed once, to the administrators, and a
 *    reply comes back to me;
 *  - a sixth report inside an hour is refused, and neither kept nor emailed;
 *  - a report whose email fails is still kept, and I am told.
 *
 * "Emailed" is observed at the transport: every test swaps in one that
 * records the composed RFC 5322 message, which is what Gmail would be handed
 * (`gmail.test.ts` holds the hand-over itself).
 */

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const db = () => getFirestore();

const STUDENT = 'conduct-student';
const MANAGER = 'conduct-manager';
const PENDING = 'conduct-pending';
const DISABLED = 'conduct-disabled';
const ALL = [STUDENT, MANAGER, PENDING, DISABLED];

/** Every message the server tried to send, as composed. */
let sent: { raw: string; mail: OutgoingMail }[] = [];
let answer: MailOutcome = { status: 'sent', messageId: 'gmail-1' };

beforeEach(async () => {
  sent = [];
  answer = { status: 'sent', messageId: 'gmail-1' };
  setMailTransport(async (raw, mail) => {
    sent.push({ raw, mail });
    return answer;
  });
  await Promise.all(
    (await db().collection(COLLECTIONS.reports).where('uid', 'in', ALL).get()).docs.map((d) => d.ref.delete()),
  );
  const staff = (uid: string, role: 'manager', status: UserStatus) =>
    db().collection(COLLECTIONS.staffUsers).doc(uid).set({
      displayName: 'Maryam Teacher',
      email: `${uid}@oursabeel.com`,
      photoUrl: null,
      role,
      status,
      createdAt: 1,
    });
  await Promise.all([
    db().collection(COLLECTIONS.students).doc(STUDENT).set({
      displayName: 'Fatima Ahmed',
      email: 'fatima@example.com',
      role: 'student',
      status: 'active',
      createdAt: 1,
      createdBy: 'admin',
    }),
    db().collection(COLLECTIONS.students).doc(DISABLED).set({
      displayName: 'Bilal Khan',
      email: 'bilal@example.com',
      role: 'student',
      status: 'disabled',
      createdAt: 1,
      createdBy: 'admin',
    }),
    staff(MANAGER, 'manager', 'active'),
    staff(PENDING, 'manager', 'pending'),
  ]);
});

afterEach(async () => {
  resetMailTransport();
  await getAuth().updateUser(DISABLED, { disabled: false }).catch(() => undefined);
});

/** A call as the app makes it: a real ID token for the account, its claims as given. */
async function as(uid: string, role: Role, status: UserStatus, data: unknown): Promise<CallableRequest> {
  return { auth: { uid, token: { role, status }, rawToken: await idTokenFor(uid) }, data } as unknown as CallableRequest;
}
const signedOut = (data: unknown) => ({ data }) as unknown as CallableRequest;

const reportsBy = async (uid: string) =>
  (await db().collection(COLLECTIONS.reports).where('uid', '==', uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

/** The refusal's message, or null when the call went through. */
async function refusal(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** One header of a composed message, unfolded. */
const header = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, 'mi').exec(raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]/g, ' '))?.[1];

describe('acceptRules', () => {
  const profile = async (collection: string, uid: string) => (await db().collection(collection).doc(uid).get()).data()!;

  it('records the acceptance on the student’s own record, with the server’s time and the rules’ version', async () => {
    const before = Date.now();
    await acceptRules.run(await as(STUDENT, 'student', 'active', {}));
    const p = await profile(COLLECTIONS.students, STUDENT);
    expect(p.rulesVersion).toBe(RULES_VERSION);
    expect(p.rulesAcceptedAt).toBeGreaterThanOrEqual(before);
    expect(p.rulesAcceptedAt).toBeLessThanOrEqual(Date.now());
  });

  it('records it on a staff member’s record too', async () => {
    await acceptRules.run(await as(MANAGER, 'manager', 'active', {}));
    expect((await profile(COLLECTIONS.staffUsers, MANAGER)).rulesVersion).toBe(RULES_VERSION);
  });

  it('keeps the first acceptance: accepting again changes nothing', async () => {
    await acceptRules.run(await as(STUDENT, 'student', 'active', {}));
    const first = (await profile(COLLECTIONS.students, STUDENT)).rulesAcceptedAt as number;
    await new Promise((r) => setTimeout(r, 20));
    await acceptRules.run(await as(STUDENT, 'student', 'active', {}));
    expect((await profile(COLLECTIONS.students, STUDENT)).rulesAcceptedAt).toBe(first);
  });

  it('records nothing for an account waiting for approval, or for nobody', async () => {
    expect(await refusal(acceptRules.run(await as(PENDING, 'manager', 'pending', {})))).toMatch(/not active/);
    expect(await refusal(acceptRules.run(signedOut({})))).toMatch(/Sign in/);
    expect((await profile(COLLECTIONS.staffUsers, PENDING)).rulesVersion).toBeUndefined();
  });
});

describe('reportProblem', () => {
  const TEXT = 'A comment on Session 1 called another student names.';

  it('keeps one report and emails it once, to the administrators, with replies to the reporter', async () => {
    const before = Date.now();
    const out = await reportProblem.run(
      await as(STUDENT, 'student', 'active', { text: `  ${TEXT}\n`, platform: 'web', appVersion: 'v0.1.3 · abc1234' }),
    );
    expect(out).toEqual({ mail: 'sent' });

    const kept = await reportsBy(STUDENT);
    expect(kept).toHaveLength(1);
    const [r] = kept as unknown as (Record<string, unknown> & { id: string; createdAt: number })[];
    expect(r).toMatchObject({
      app: 'Sabeel Institute LMS',
      uid: STUDENT,
      displayName: 'Fatima Ahmed',
      email: 'fatima@example.com',
      role: 'student',
      text: TEXT,
      platform: 'web',
      appVersion: 'v0.1.3 · abc1234',
      mail: { status: 'sent', messageId: 'gmail-1' },
    });
    expect(r.createdAt).toBeGreaterThanOrEqual(before);

    expect(sent).toHaveLength(1);
    const { raw } = sent[0];
    expect(header(raw, 'From')).toBe('"Sabeel Apps No Reply" <apps-noreply@oursabeel.com>');
    expect(header(raw, 'To')).toBe('apps-reports@oursabeel.com');
    expect(header(raw, 'Reply-To')).toBe('"Fatima Ahmed" <fatima@example.com>');
    expect(header(raw, 'Subject')).toBe('[Sabeel Institute LMS] Report from Fatima Ahmed');
    const body = Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(body).toContain(TEXT);
    expect(body).toContain(`Report:  ${r.id}`);
  });

  it('takes a report from staff as from a student', async () => {
    expect(await reportProblem.run(await as(MANAGER, 'manager', 'active', { text: TEXT }))).toEqual({ mail: 'sent' });
    expect(await reportsBy(MANAGER)).toHaveLength(1);
    expect(header(sent[0].raw, 'Reply-To')).toBe(`"Maryam Teacher" <${MANAGER}@oursabeel.com>`);
  });

  it('keeps and sends nothing for someone not signed in', async () => {
    expect(await refusal(reportProblem.run(signedOut({ text: TEXT })))).toMatch(/Sign in/);
    expect(sent).toHaveLength(0);
  });

  it('keeps and sends nothing for an account waiting for approval', async () => {
    expect(await refusal(reportProblem.run(await as(PENDING, 'manager', 'pending', { text: TEXT })))).toMatch(/not active/);
    expect(await reportsBy(PENDING)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('keeps and sends nothing for an account disabled while its token still says active', async () => {
    const req = await as(DISABLED, 'student', 'active', { text: TEXT });
    await getAuth().updateUser(DISABLED, { disabled: true });
    expect(await refusal(reportProblem.run(req))).toMatch(/not active/);
    expect(await reportsBy(DISABLED)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('keeps and sends nothing when there is nothing to report', async () => {
    expect(await refusal(reportProblem.run(await as(STUDENT, 'student', 'active', { text: '   ' })))).toMatch(/Say what/);
    expect(await reportsBy(STUDENT)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it(`refuses the ${REPORTS_PER_HOUR + 1}th report inside an hour, and keeps and sends nothing for it`, async () => {
    for (let i = 1; i <= REPORTS_PER_HOUR; i += 1) {
      await reportProblem.run(await as(STUDENT, 'student', 'active', { text: `Report ${i}` }));
    }
    expect(sent).toHaveLength(REPORTS_PER_HOUR);
    const sixth = await refusal(reportProblem.run(await as(STUDENT, 'student', 'active', { text: 'One more' })));
    expect(sixth).toBe(`You have sent ${REPORTS_PER_HOUR} reports in the last hour. Wait a while, then send this one again.`);
    expect(await reportsBy(STUDENT)).toHaveLength(REPORTS_PER_HOUR);
    expect(sent).toHaveLength(REPORTS_PER_HOUR);
    // Another account is not held to this one's count.
    expect(await reportProblem.run(await as(MANAGER, 'manager', 'active', { text: TEXT }))).toEqual({ mail: 'sent' });
  });

  it('counts only the last hour: reports older than that do not hold a new one back', async () => {
    const old = Date.now() - 61 * 60 * 1000;
    await Promise.all(
      Array.from({ length: REPORTS_PER_HOUR }, () =>
        db().collection(COLLECTIONS.reports).add({ uid: STUDENT, createdAt: old, text: 'old', mail: { status: 'sent', messageId: 'x' } }),
      ),
    );
    expect(await reportProblem.run(await as(STUDENT, 'student', 'active', { text: TEXT }))).toEqual({ mail: 'sent' });
    expect(sent).toHaveLength(1);
  });

  it('keeps a report whose email failed, with the reason, and says so', async () => {
    answer = { status: 'failed', error: 'signJwt refused (HTTP 403): Permission denied' };
    expect(await reportProblem.run(await as(STUDENT, 'student', 'active', { text: TEXT }))).toEqual({ mail: 'failed' });
    const [r] = await reportsBy(STUDENT);
    expect((r as Record<string, unknown>).mail).toEqual({ status: 'failed', error: 'signJwt refused (HTTP 403): Permission denied' });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing under the emulator’s own transport, and records that it did not', async () => {
    resetMailTransport();
    expect(await reportProblem.run(await as(STUDENT, 'student', 'active', { text: TEXT }))).toEqual({ mail: 'skipped' });
    const [r] = await reportsBy(STUDENT);
    expect((r as Record<string, unknown>).mail).toEqual({ status: 'skipped' });
    expect(sent).toHaveLength(0);
  });
});
