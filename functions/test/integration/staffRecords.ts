import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { COLLECTIONS, type StaffUserDoc } from '@sabeel/shared';

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
