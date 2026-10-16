import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import {
  APP_NAME,
  COLLECTIONS,
  RULES_VERSION,
  hasAcceptedRules,
  isStaffRole,
  type Role,
  type StaffUserDoc,
  type StudentDoc,
} from '@sabeel/shared';
import { requireMember } from './guards';
import { reportedCall } from './reported';
import { reportError } from './sentry';
import { sendMail, type MailOutcome } from './mail';
import { reportMail, type ReportPlatform } from './reportMail';

/**
 * THE INSTITUTE'S RULES, ACCEPTED; AND REPORT A PROBLEM.
 *
 * Both are an account acting for itself, so neither is audited (as a hand-in
 * is not): the acceptance is on the account's own record, and a report is its
 * own document. See `@sabeel/shared`'s `conduct.ts` for why they exist.
 */

const db = () => getFirestore();

/** The account's own record: staff and students live in different collections. */
function profileRef(uid: string, role: Role) {
  return db().collection(isStaffRole(role) ? COLLECTIONS.staffUsers : COLLECTIONS.students).doc(uid);
}

/**
 * Record that this account accepts the institute's rules.
 *
 * SERVER-WRITTEN, like every field of a profile: the rules deny clients any
 * write to `staffUsers` and `students`, so the time is the server's and the
 * account cannot claim to have accepted a version it never saw. The FIRST
 * acceptance of the current rules stands; a second call changes nothing.
 */
export const acceptRules = reportedCall(async (req) => {
  const { uid, role } = requireMember(req);
  const ref = profileRef(uid, role);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Your account is not set up yet. Sign out and sign in again.');
    const profile = snap.data() as StaffUserDoc | StudentDoc;
    if (hasAcceptedRules(profile)) return { rulesAcceptedAt: profile.rulesAcceptedAt ?? null };
    const at = Date.now();
    tx.update(ref, { rulesAcceptedAt: at, rulesVersion: RULES_VERSION });
    return { rulesAcceptedAt: at };
  });
});

/** The longest report, in characters as a person counts them. */
export const REPORT_MAX_CHARS = 2000;
/** How many reports one account may send in an hour. */
export const REPORTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/**
 * One report as kept. `mail` is written once the email has been tried; a
 * report without it is one whose send never finished.
 */
export interface ReportDoc {
  app: string;
  uid: string;
  displayName: string;
  email: string | null;
  role: Role;
  text: string;
  createdAt: number;
  platform?: ReportPlatform;
  appVersion?: string;
  mail?: MailOutcome;
}

export interface ReportInput {
  text: string;
  platform?: ReportPlatform;
  appVersion?: string;
}

const PLATFORMS: readonly ReportPlatform[] = ['android', 'ios', 'web'];

/** What the person typed, and where from, checked at the boundary. */
export function validateReport(data: unknown): ReportInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const text = typeof d.text === 'string' ? d.text.trim() : '';
  if (!text) throw new HttpsError('invalid-argument', 'Say what you are reporting before sending.');
  const length = [...text].length;
  if (length > REPORT_MAX_CHARS) {
    throw new HttpsError('invalid-argument', `A report can be up to ${REPORT_MAX_CHARS} characters; this one is ${length}.`);
  }
  const out: ReportInput = { text };
  if (d.platform !== undefined) {
    if (!PLATFORMS.includes(d.platform as ReportPlatform)) throw new HttpsError('invalid-argument', 'platform must be android, ios or web.');
    out.platform = d.platform as ReportPlatform;
  }
  if (d.appVersion !== undefined) {
    if (typeof d.appVersion !== 'string' || !/^\P{Cc}{1,64}$/u.test(d.appVersion)) {
      throw new HttpsError('invalid-argument', 'appVersion must be a line of at most 64 characters.');
    }
    out.appVersion = d.appVersion;
  }
  return out;
}

/**
 * Report a problem: kept as `reports/{id}`, then emailed to the
 * administrators' group with Reply-To set to the person, and the outcome
 * written back onto the report.
 *
 * NOTHING IS KEPT OR SENT FOR AN ACCOUNT THAT IS NOT ACTIVE, nor past the
 * hourly limit, which is counted from the reports themselves inside the
 * transaction that adds the new one, so two sent at once cannot both be the
 * fifth. A send that fails keeps the report (`mail.status: 'failed'`, with
 * Google's reason), tells the person so, and is reported to Sentry; it is not
 * retried.
 */
export const reportProblem = reportedCall(async (req) => {
  const { uid, role } = requireMember(req);
  const input = validateReport(req.data);
  const profile = await profileRef(uid, role).get();
  if (!profile.exists) throw new HttpsError('failed-precondition', 'Your account is not set up yet. Sign out and sign in again.');
  const { displayName, email } = profile.data() as StaffUserDoc | StudentDoc;

  const createdAt = Date.now();
  const reports = db().collection(COLLECTIONS.reports);
  const ref = reports.doc();
  const report: ReportDoc = { app: APP_NAME, uid, displayName, email, role, createdAt, ...input };
  await db().runTransaction(async (tx) => {
    const recent = await tx.get(reports.where('uid', '==', uid).where('createdAt', '>', createdAt - HOUR_MS));
    if (recent.size >= REPORTS_PER_HOUR) {
      throw new HttpsError(
        'resource-exhausted',
        `You have sent ${REPORTS_PER_HOUR} reports in the last hour. Wait a while, then send this one again.`,
      );
    }
    tx.create(ref, report);
  });

  const mail = await sendMail(reportMail({ id: ref.id, ...report }));
  try {
    await ref.update({ mail });
  } catch (e) {
    // The report is kept and the email went or did not; what is lost is the
    // record of which, and that is not worth failing the person's report.
    await reportError(e, { source: 'reportProblem:outcome' });
  }
  if (mail.status === 'failed') {
    await reportError(new Error(`Report ${ref.id} was kept but not emailed: ${mail.error}`), { source: 'reportProblem' });
  }
  return { mail: mail.status };
});
