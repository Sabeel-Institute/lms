import { collection, doc, orderBy, query } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, type StudentDoc, type UserStatus } from '@sabeel/shared';
import { auth, db, functions } from './firebase';
import { useLiveDocState, useLiveQuery } from './liveQuery';
import { read } from './documents';

export interface StudentRow extends StudentDoc {
  uid: string;
}

/**
 * One student, live. The whole staff directory is readable by any staff member
 * (a deliberate privacy call recorded on the `students` rule), so this needs no
 * scoping — but it is a document listener so the student's own screen could use
 * the same hook, where a list would be denied.
 */
export function useStudent(uid: string | null): StudentRow | null {
  return useStudentState(uid).value;
}

/** As useStudent, plus whether the listener has answered — a student page is
 *  reachable by URL, so it has to be able to say "no such student". */
export function useStudentState(uid: string | null) {
  return useLiveDocState<StudentRow | null>(
    () => (uid ? doc(db, COLLECTIONS.students, uid) : null),
    [uid],
    {
      label: 'student',
      map: (snap) => ({ uid: snap.id, ...read('students', snap) }),
      empty: null,
    },
  );
}

export function useStudents(enabled: boolean): StudentRow[] {
  return useStudentsState(enabled) ?? NO_STUDENTS;
}

const NO_STUDENTS: StudentRow[] = [];

/** The `State` variant: `null` until the listener answers, so an empty sentence is
 *  never printed for a question not yet answered. */
export function useStudentsState(enabled: boolean): StudentRow[] | null {
  return useLiveQuery<StudentRow[] | null>(
    () =>
      enabled
        ? query(collection(db, COLLECTIONS.students), orderBy('displayName', 'asc'))
        : null,
    [enabled],
    {
      label: 'students',
      map: (snap) => snap.docs.map((d) => ({ uid: d.id, ...read('students', d) })),
      empty: null,
    },
  );
}

/**
 * Create a student and send them a link to set their own password.
 *
 * The account is created server-side with no password at all, then Firebase's
 * own password-reset email carries the set-password link — no email service,
 * no template hosting, nothing to operate. The console template is reworded
 * from "reset" to "set" so it reads correctly for someone who never had a
 * password (TODO.md).
 *
 * If the email fails to send, the account still exists and staff can resend —
 * so the failure is reported rather than rolled back, and the returned flag
 * lets the UI say which of the two things happened.
 */
export async function createStudent(input: {
  displayName: string;
  email: string;
  courseId?: string;
}): Promise<{ uid: string; emailSent: boolean }> {
  const res = await httpsCallable<typeof input, { uid: string; email: string }>(
    functions,
    'createStudent',
  )(input);
  try {
    await sendPasswordResetEmail(auth, res.data.email);
    return { uid: res.data.uid, emailSent: true };
  } catch {
    return { uid: res.data.uid, emailSent: false };
  }
}

/**
 * A signed-in student asks for their OWN password reset link.
 *
 * Same Firebase call as the staff-initiated resend, and deliberately a separate
 * export: this one is reached from the student's own More menu, and the two
 * would otherwise read as one function serving two different permissions. It is
 * first-party — an emailed link, no third-party login service — so it engages
 * nothing under App Store Guideline 4.8, and it creates no account, so it
 * engages nothing under 5.1.1(v) either.
 */
export async function sendMyPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

/** Resend the set-password link for an existing student. */
export async function resendPasswordSetup(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export async function setStudentAccess(input: {
  uid: string;
  status: Extract<UserStatus, 'active' | 'disabled'>;
}): Promise<void> {
  await httpsCallable(functions, 'setStudentAccess')(input);
}
