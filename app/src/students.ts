import { collection, doc, orderBy, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, type StudentDoc, type UserStatus } from '@sabeel/shared';
import { db, functions } from './firebase';
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
 * Create a student; the server sends them a link to set their own password.
 *
 * The account is created with no password at all, and the set-password email
 * goes from the institute's own address (`functions/src/passwordLinks.ts`).
 * If the email fails, the account still exists and staff can resend, so the
 * answer says which of the two things happened.
 */
export async function createStudent(input: {
  displayName: string;
  email: string;
  courseId?: string;
}): Promise<{ uid: string; emailSent: boolean }> {
  const res = await httpsCallable<typeof input, { uid: string; emailSent: boolean }>(functions, 'createStudent')(input);
  return { uid: res.data.uid, emailSent: res.data.emailSent };
}

/** What a send came to: `failed` is the email alone, said to the person. */
type LinkMail = { mail: 'sent' | 'failed' | 'skipped' };
const EMAIL_FAILED = 'The email did not go out. Try again in a moment.';
const sent = (r: { data: LinkMail }) => {
  if (r.data.mail === 'failed') throw new Error(EMAIL_FAILED);
};

/**
 * A signed-in student asks for a link to their OWN account, from More →
 * Change password. First-party, an emailed link, so it engages nothing under
 * App Store Guideline 4.8, and it creates no account, so nothing under
 * 5.1.1(v) either.
 */
export async function sendMyPasswordReset(): Promise<void> {
  sent(await httpsCallable<object, LinkMail>(functions, 'sendMyPasswordLink')({}));
}

/** Staff send an existing student a link to set (or reset) their password. */
export async function resendPasswordSetup(studentUid: string): Promise<void> {
  sent(await httpsCallable<{ uid: string }, LinkMail>(functions, 'sendPasswordLink')({ uid: studentUid }));
}

/**
 * The sign-in screen's "Email me a password link". The answer is the same
 * sentence for every address (`PASSWORD_LINK_ANSWER`); the server sends a
 * link afterwards, and only to a student.
 */
export async function requestPasswordLink(email: string): Promise<string> {
  const res = await httpsCallable<{ email: string }, { message: string }>(functions, 'requestPasswordLink')({ email });
  return res.data.message;
}

export async function setStudentAccess(input: {
  uid: string;
  status: Extract<UserStatus, 'active' | 'disabled'>;
}): Promise<void> {
  await httpsCallable(functions, 'setStudentAccess')(input);
}
