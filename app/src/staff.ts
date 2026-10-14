import { collection, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, type Role, type StaffUserDoc, type UserStatus } from '@sabeel/shared';
import { db, functions } from './firebase';
import { useLiveQuery } from './liveQuery';
import { read } from './documents';

export interface StaffRow extends StaffUserDoc {
  uid: string;
}

/**
 * Staff awaiting approval. Ordered oldest-first: the person who has been waiting
 * longest is the one to deal with next.
 */
const NO_STAFF: StaffRow[] = [];

/** The `State` variant: `null` until the listener answers, so an empty sentence is
 *  never printed for a question not yet answered. */
export function usePendingStaffState(enabled: boolean): StaffRow[] | null {
  return useLiveQuery<StaffRow[] | null>(
    () =>
      enabled
        ? query(
            collection(db, COLLECTIONS.staffUsers),
            where('status', '==', 'pending'),
            orderBy('createdAt', 'asc'),
          )
        : null,
    [enabled],
    {
      label: 'pendingStaff',
      map: (snap) => snap.docs.map((d) => ({ uid: d.id, ...read('staffUsers', d) })),
      empty: null,
    },
  );
}

/** Everyone who is not pending — the running list of who has access. */
export function useDecidedStaff(enabled: boolean): StaffRow[] {
  return useDecidedStaffState(enabled) ?? NO_STAFF;
}

/** The `State` variant: `null` until the listener answers, so an empty sentence is
 *  never printed for a question not yet answered. */
export function useDecidedStaffState(enabled: boolean): StaffRow[] | null {
  return useLiveQuery<StaffRow[] | null>(
    () =>
      enabled
        ? query(
            collection(db, COLLECTIONS.staffUsers),
            where('status', 'in', ['active', 'disabled', 'deleted']),
            orderBy('displayName', 'asc'),
          )
        : null,
    [enabled],
    {
      label: 'decidedStaff',
      map: (snap) => snap.docs.map((d) => ({ uid: d.id, ...read('staffUsers', d) })),
      empty: null,
    },
  );
}

/** Admin-only; the callable enforces it regardless of what the UI shows. */
export async function setStaffAccess(input: {
  uid: string;
  role?: Extract<Role, 'admin' | 'manager'>;
  status?: Extract<UserStatus, 'active' | 'disabled'>;
}): Promise<void> {
  await httpsCallable(functions, 'setStaffAccess')(input);
}
