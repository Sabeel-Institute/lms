import { HttpsError } from 'firebase-functions/v2/https';
import { auditedCall } from './audited';
import { reconcileStudentCoursework } from './coursework';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  ALLOWED_EMAIL_DOMAIN,
  COLLECTIONS,
  NEW_STUDENT_ACCESS,
  enrollmentId,
  isAllowedStaffEmail,
  type CourseDoc,
  type EnrollmentDoc,
  type StudentDoc,
  type UserStatus,
} from '@sabeel/shared';
import { requireAdmin, requireCourseScope, requireStaff } from './guards';
import { shutOutAccount } from './shutOut';

export interface CreateStudentInput {
  displayName: string;
  email: string;
  /** Optional: enrol into this class in the same operation. */
  courseId?: string;
}

export function validateCreateStudent(data: unknown): CreateStudentInput {
  const d = data as Partial<CreateStudentInput> | null;
  const displayName = typeof d?.displayName === 'string' ? d.displayName.trim() : '';
  const email = typeof d?.email === 'string' ? d.email.trim().toLowerCase() : '';
  if (!displayName) throw new HttpsError('invalid-argument', 'Full name is required.');
  if (displayName.length > 120) throw new HttpsError('invalid-argument', 'That name is too long.');
  // Deliberately loose: Firebase Auth is the real validator and rejects a
  // malformed address on creation. Duplicating its rules here would only add a
  // second, subtly different definition of "valid email".
  if (!email.includes('@')) throw new HttpsError('invalid-argument', 'A valid email is required.');
  /*
   * NEVER A STAFF ADDRESS. Staff are Google identities on the institute's
   * domain; a student is an email-and-password account created here with no
   * credential and an unverified address. Make one for a colleague's address
   * and Firebase's one-account-per-email rule folds their first Google sign-in
   * INTO it: no new user, so `onUserCreate` never runs, no staffUsers document,
   * never in the approval queue, and `setStaffAccess` finds nobody — an
   * onboarding lockout only the console can undo.
   */
  if (isAllowedStaffEmail(email, true)) {
    throw new HttpsError(
      'invalid-argument',
      `A ${ALLOWED_EMAIL_DOMAIN} address is a staff account. Staff sign in with Google.`,
    );
  }

  const out: CreateStudentInput = { displayName, email };
  // `null` counts as absent, not as a bad value.
  //
  // The callable wire format cannot tell them apart: the client SDK serializes
  // an explicitly-`undefined` property as `null`, so `{ courseId: undefined }`
  // arrives as `{ courseId: null }`. A guard testing only `!== undefined` then
  // rejects "no class selected" with "courseId must be a class id" — which is
  // what happened to the very first student created in production, before any
  // class existed to select.
  if (d?.courseId !== undefined && d?.courseId !== null) {
    // Trimmed before the emptiness check: '   ' is truthy, so testing the raw
    // value let a whitespace-only id through to a document lookup.
    const courseId = typeof d.courseId === 'string' ? d.courseId.trim() : '';
    if (!courseId) {
      throw new HttpsError('invalid-argument', 'courseId must be a class id.');
    }
    out.courseId = courseId;
  }
  return out;
}

/**
 * Creates a student account: Auth user, claims, and the mirror document.
 *
 * Students arrive ACTIVE — staff creating them is the approval. There is no
 * pending state and no separate email verification: the address was asserted by
 * staff, and completing the set-password link is itself proof of mailbox
 * control.
 *
 * Creating the account WITHOUT a password is what keeps the auth-create trigger
 * from racing this function — a password-less user has no provider at all, which
 * is the trigger's signal for "Admin-SDK provisioned, leave alone" (see
 * provision.ts). It is also, therefore, load-bearing for security: the trigger
 * deletes any account that already has a `password` provider when it fires,
 * because that can only have come from a client-side sign-up.
 */
export async function createStudentAccount(callerUid: string, input: CreateStudentInput) {
  const auth = getAuth();
  const db = getFirestore();

  // The course FIRST, before anything exists. Looked up after the account was
  // created, a stale course id left an Auth user with student claims and no
  // student document — unreachable by the app, and blocking that address
  // ("already has an account") until somebody found it in the console. A
  // manager's scope check already reads the course before this runs; an
  // admin's does not, so this is where the order is guaranteed.
  const cls = input.courseId
    ? await db.collection(COLLECTIONS.courses).doc(input.courseId).get()
    : null;
  if (input.courseId && !cls?.exists) throw new HttpsError('not-found', 'No such course.');

  let user;
  try {
    user = await auth.createUser({
      email: input.email,
      displayName: input.displayName,
      // No password: the student sets their own from the emailed link. Inventing
      // a temporary one would mean a working credential nobody intended to exist.
      emailVerified: false,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'That email already has an account.');
    }
    if (code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'That email address is not valid.');
    }
    throw e;
  }

  try {
    // Claims before the document, for the same reason as the auth trigger: rules
    // trust the token, so a half-completed create leaves an account that can do
    // nothing rather than one that looks authorised but is not.
    await auth.setCustomUserClaims(user.uid, { ...NEW_STUDENT_ACCESS });

    const doc: StudentDoc = {
      displayName: input.displayName,
      email: input.email,
      role: 'student',
      status: 'active',
      createdAt: Date.now(),
      createdBy: callerUid,
    };

    // Student record and enrolment in one batch, so a course picked at creation
    // time cannot end up half-applied — an account with no course is recoverable,
    // an enrolment pointing at a student record that was never written is not.
    const batch = db.batch();
    batch.set(db.collection(COLLECTIONS.students).doc(user.uid), doc);
    if (input.courseId && cls) {
      const enrollment: EnrollmentDoc = {
        studentUid: user.uid,
        courseId: input.courseId,
        cohortId: (cls.data() as CourseDoc).cohortId,
        active: true,
        enrolledAt: Date.now(),
        enrolledBy: callerUid,
      };
      batch.set(
        db.collection(COLLECTIONS.enrollments).doc(enrollmentId(user.uid, input.courseId)),
        enrollment,
      );
    }
    await batch.commit();
  } catch (e) {
    // An account with no student document is one the app cannot reach and the
    // address cannot be reused. Take it back out, so a retry starts clean; the
    // trigger ignores Admin-SDK users, so nothing races this.
    await auth.deleteUser(user.uid).catch(() => undefined);
    throw e;
  }

  // No RECORDING obligations at creation time: listening is attendance-driven
  // and starts from enrolment onward, so nothing published earlier is
  // retroactively granted. ASSIGNMENTS are different — they are the class's
  // current work, so a student created into a course gets every posted one not
  // yet past its due date.
  if (input.courseId) await reconcileStudentCoursework(input.courseId, user.uid);
  return { uid: user.uid, email: input.email, courseId: input.courseId ?? null };
}

export const createStudent = auditedCall('createStudent', async (req, audit) => {
  const input = validateCreateStudent(req.data);
  // Scope is checked BEFORE the account is created: a manager naming a class
  // they do not run must fail with nothing written, not leave an orphan Auth
  // user behind.
  const callerUid = input.courseId
    ? await requireCourseScope(req, input.courseId)
    : requireStaff(req);
  // courseId when enrolled at creation, so the scoped manager sees it in audit.
  if (input.courseId) audit.courseId = input.courseId;
  const created = await createStudentAccount(callerUid, input);
  // THE ACCOUNT IT MADE. Nothing in the request names it — the uid does not
  // exist until the line above — so the derivation had nothing to pick up, and
  // the most privilege-adjacent thing a manager can do audited as "someone
  // created a student", with no way to tell which.
  //
  // Under `studentUid`, the key every other action on a student carries, so
  // that one query — `targets.studentUid == uid` — is the whole of a student's
  // history. It is what the student's page reads.
  audit.targets.studentUid = created.uid;
  audit.detail = { email: created.email };
  return created;
});

export interface StudentAccessInput {
  uid: string;
  status: Extract<UserStatus, 'active' | 'disabled'>;
}

export function validateStudentAccess(data: unknown): StudentAccessInput {
  const d = data as Partial<StudentAccessInput> | null;
  if (!d || typeof d.uid !== 'string' || !d.uid) {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }
  if (d.status !== 'active' && d.status !== 'disabled') {
    throw new HttpsError('invalid-argument', 'status must be active or disabled.');
  }
  return { uid: d.uid, status: d.status };
}

/**
 * Enable or disable a student.
 *
 * Disabling preserves all history, enrollments and ledger entries — the brief is
 * explicit that normal operations never delete. It also shuts the account out
 * (`shutOutAccount`): the Auth user, the tokens already issued and the device
 * registrations, so an already-signed-in session cannot keep working off a
 * cached token and no reminder reaches a phone the account no longer holds.
 */
export async function applyStudentAccess(input: StudentAccessInput) {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.students).doc(input.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such student.');
  if ((snap.data() as StudentDoc).status === 'deleted') throw new HttpsError('failed-precondition', 'That account has been deleted.');

  if (input.status === 'disabled') await shutOutAccount(input.uid);
  else await getAuth().updateUser(input.uid, { disabled: false });
  await getAuth().setCustomUserClaims(input.uid, { role: 'student', status: input.status });
  await ref.update({ status: input.status });
  return { uid: input.uid, status: input.status };
}

// Enable/disable is directory-level (a student spans courses) → admin-only audit.
export const setStudentAccess = auditedCall('setStudentAccess', async (req, audit) => {
  requireAdmin(req);
  const input = validateStudentAccess(req.data);
  // The payload says `uid`; the log says `studentUid`, like every other action
  // on a student, so the student's page finds this with the same query it finds
  // their enrolments.
  audit.targets.studentUid = input.uid;
  audit.detail = { status: input.status };
  return applyStudentAccess(input);
});
