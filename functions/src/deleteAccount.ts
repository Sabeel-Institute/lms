import { HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, type EnrollmentDoc, type StaffUserDoc, type StudentDoc } from '@sabeel/shared';
import { auditedCall } from './audited';
import { applyEnrollmentActive } from './enrollments';
import { requireAdmin } from './guards';

/**
 * DELETING AN ACCOUNT (Faisal's choice, 2026-10-14): admin-only, on the
 * website, and only for a person already disabled, so it is always the second
 * of two decisions. It removes what the privacy policy says deletion removes —
 * the sign-in, the contact details and the notification settings — and keeps
 * the academic record, under the person's name, marked deleted.
 *
 * Deleting someone in the Firebase console instead left them in People as
 * active, and every action on them failed.
 *
 * - Goes: the Auth user; the address on their directory row (and a
 *   colleague's photo); the address copied into the audit rows about them,
 *   their creation and their first sign-in; their notification settings and
 *   devices.
 * - Changes: a student leaves every class they are in, as removing them from
 *   it would; a colleague stops managing the courses they managed.
 * - Stays: their name, and everything they did or had done to them —
 *   attendance, listening, work, grades, and the history.
 *
 * ORDER, for a failure part-way: everything first, the directory row LAST.
 * Until it reads `deleted` the person still shows as disabled, with Delete on
 * offer, and pressing it again runs every step again; each is safe to repeat.
 */
export async function deleteAccountRecord(callerUid: string, uid: string): Promise<{ uid: string; changed: boolean; population: 'student' | 'staff' }> {
  const db = getFirestore();
  const studentRef = db.collection(COLLECTIONS.students).doc(uid);
  const staffRef = db.collection(COLLECTIONS.staffUsers).doc(uid);
  const [studentSnap, staffSnap] = await Promise.all([studentRef.get(), staffRef.get()]);
  const person = (studentSnap.data() ?? staffSnap.data()) as StudentDoc | StaffUserDoc | undefined;
  if (!person) throw new HttpsError('not-found', 'No such account.');
  const population = studentSnap.exists ? 'student' : 'staff';
  if (uid === callerUid) throw new HttpsError('failed-precondition', 'You cannot delete your own account.');
  if (person.status === 'deleted') return { uid, changed: false, population };
  if (person.status !== 'disabled') throw new HttpsError('failed-precondition', 'Disable the account before deleting it.');

  if (population === 'student') {
    const enrolled = await db.collection(COLLECTIONS.enrollments).where('studentUid', '==', uid).where('active', '==', true).get();
    for (const e of enrolled.docs) {
      await applyEnrollmentActive({ studentUid: uid, courseId: (e.data() as EnrollmentDoc).courseId, active: false });
    }
  } else {
    const managed = await db.collection(COLLECTIONS.courses).where('managerUids', 'array-contains', uid).get();
    await Promise.all(managed.docs.map((c) => c.ref.update({ managerUids: FieldValue.arrayRemove(uid) })));
  }

  await db.recursiveDelete(db.collection(COLLECTIONS.notifications).doc(uid));

  // Their address, wherever the history copied it: a student's creation is
  // filed under `studentUid`, a colleague's first sign-in under `uid`.
  const about = await Promise.all([
    db.collection(COLLECTIONS.auditLog).where('targets.studentUid', '==', uid).get(),
    db.collection(COLLECTIONS.auditLog).where('targets.uid', '==', uid).get(),
  ]);
  const withAddress = about.flatMap((q) => q.docs).filter((d) => d.data().detail?.email !== undefined);
  await Promise.all(withAddress.map((d) => d.ref.update({ 'detail.email': FieldValue.delete() })));

  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    // Gone already: an earlier press got this far.
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e;
  }

  if (population === 'student') await studentRef.update({ status: 'deleted', email: null });
  else await staffRef.update({ status: 'deleted', email: null, photoUrl: null });
  return { uid, changed: true, population };
}

function validateDeleteAccount(data: unknown): string {
  const uid = (data as { uid?: unknown } | null)?.uid;
  if (typeof uid !== 'string' || !uid || uid.length > 128) throw new HttpsError('invalid-argument', 'uid is required.');
  return uid;
}

export const deleteAccount = auditedCall('deleteAccount', async (req, audit) => {
  const callerUid = requireAdmin(req);
  const uid = validateDeleteAccount(req.data);
  const res = await deleteAccountRecord(callerUid, uid);
  // Under the key the person's own history reads, as every other action on
  // them is: a student's page finds its rows by `studentUid`. A colleague's
  // row keeps the `uid` the request carries.
  if (res.population === 'student') audit.targets.studentUid = uid;
  audit.detail = { account: res.population };
  audit.noop = !res.changed;
  return res;
});
