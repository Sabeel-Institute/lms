import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

/**
 * Delete a disabled account, a student's or a colleague's: their sign-in,
 * address and notification settings go; their name and record stay. Admin-only
 * and website-only; the callable enforces both the role and that the account
 * was disabled first.
 */
export async function deleteAccount(uid: string): Promise<void> {
  await httpsCallable(functions, 'deleteAccount')({ uid });
}
