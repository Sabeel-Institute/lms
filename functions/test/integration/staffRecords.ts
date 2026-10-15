import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { COLLECTIONS, type StaffUserDoc, type StudentDoc } from '@sabeel/shared';

/**
 * The staff records behind the staff tokens a rules suite signs in with.
 *
 * The rules ask a staff member's record as well as their token
 * (`staffRecordAgrees`), as production does, so a staff token with no record
 * is refused like one whose record says they were removed. Every suite that
 * signs in as staff seeds the records its staff would have.
 */
export async function seedStaffRecords(
  env: RulesTestEnvironment,
  staff: Record<string, 'admin' | 'manager'>,
  status: StaffUserDoc['status'] = 'active',
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all(
      Object.entries(staff).map(([uid, role]) =>
        setDoc(doc(db, COLLECTIONS.staffUsers, uid), {
          displayName: uid,
          email: `${uid}@oursabeel.com`,
          photoUrl: null,
          role,
          status,
          createdAt: 1,
        } satisfies StaffUserDoc),
      ),
    );
  });
}

/**
 * The student records behind the student tokens a rules suite writes with.
 *
 * The rules ask a student's record before they let a student write
 * (`isWritingStudent`), as production does, so a student token with no record
 * writes nothing, like one whose record says they were disabled.
 */
export async function seedStudentRecords(
  env: RulesTestEnvironment,
  uids: string[],
  status: StudentDoc['status'] = 'active',
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all(
      uids.map((uid) =>
        setDoc(doc(db, COLLECTIONS.students, uid), {
          displayName: uid,
          email: `${uid}@example.com`,
          role: 'student',
          status,
          createdAt: 1,
          createdBy: 'admin',
        } satisfies StudentDoc),
      ),
    );
  });
}
