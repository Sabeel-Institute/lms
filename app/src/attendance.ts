import { collection, query, where } from 'firebase/firestore';
import { COLLECTIONS, type AttendanceRecordDoc } from '@sabeel/shared';
import { db } from './firebase';
import { useLiveQuery } from './liveQuery';
import { read } from './documents';

export interface AttendanceRecordRow extends AttendanceRecordDoc {
  id: string;
}

/**
 * A student's own attendance marks for one course.
 *
 * Reads the server-written projection rather than the session, because a session
 * holds the whole roster's marks and no rule can show one student their own key
 * of that map. Self-constrained on `studentUid`, as the rule requires; adding
 * `courseId` keeps it to one class and costs no index, since both filters are
 * equalities.
 *
 * Ordering is done in the caller rather than with `orderBy`, which would turn
 * this into a composite-index query for a list that is one term long.
 *
 *  `null` until the listener answers, so an empty sentence is never printed for
 *  a question not yet answered.
 */
export function useMyAttendanceState(uid: string | null, courseId: string | null): AttendanceRecordRow[] | null {
  return useLiveQuery<AttendanceRecordRow[] | null>(
    () =>
      uid && courseId
        ? query(
            collection(db, COLLECTIONS.attendanceRecords),
            where('studentUid', '==', uid),
            where('courseId', '==', courseId),
          )
        : null,
    [uid, courseId],
    {
      label: 'myAttendance',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('attendanceRecords', d) })),
      empty: null,
    },
  );
}
