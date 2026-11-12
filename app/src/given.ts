import { collection, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useMemo } from 'react';
import {
  COLLECTIONS,
  closesNow,
  type GivenExpectation,
  type GivenRecordingDoc,
  type RegisterFacts,
} from '@sabeel/shared';
import { useRosterState } from './structure';
import { useStudentsState } from './students';
import { db, functions } from './firebase';
import { useLiveQuery } from './liveQuery';
import { read } from './documents';
import type { GiveOutcome } from './givenWords';

/**
 * A recording given to one student, as staff see it on its Progress page:
 * the live list and the two calls. What each row says is `givenWords.ts`,
 * kept free of Firebase so it is tested on its own.
 * `docs/plans/GIVE-A-RECORDING.md`.
 */

export interface GivenRow extends GivenRecordingDoc {
  id: string;
}

/**
 * The recording's given recordings, by student, live. `courseId ==` and
 * `recordingId ==`: the class scope is what the staff rule requires. Null
 * until the first snapshot.
 */
export function useGivenRecordings(recording: { id: string; courseId: string } | null): Map<string, GivenRow> | null {
  const courseId = recording?.courseId ?? null;
  const recordingId = recording?.id ?? null;
  return useLiveQuery<Map<string, GivenRow> | null>(
    () =>
      courseId && recordingId
        ? query(
            collection(db, COLLECTIONS.givenRecordings),
            where('courseId', '==', courseId),
            where('recordingId', '==', recordingId),
          )
        : null,
    [courseId, recordingId],
    {
      label: 'givenRecordings',
      map: (snap) =>
        new Map(
          snap.docs.map((d) => {
            const g = read('givenRecordings', d);
            return [g.studentUid, { id: d.id, ...g }];
          }),
        ),
      empty: null,
    },
  );
}


export async function giveRecording(input: {
  recordingId: string;
  studentUid: string;
  openUntil: string;
  expect: GivenExpectation;
}): Promise<GiveOutcome> {
  const res = await httpsCallable<typeof input, { outcome: GiveOutcome }>(functions, 'giveRecording')(input);
  return res.data.outcome;
}

export async function takeBackRecording(input: {
  recordingId: string;
  studentUid: string;
  expect: GivenExpectation;
}): Promise<'taken' | 'gone'> {
  const res = await httpsCallable<typeof input, { outcome: 'taken' | 'gone' }>(functions, 'takeBackRecording')(input);
  return res.data.outcome;
}


/**
 * WHO WOULD LOSE THIS RECORDING AT ONCE, for the confirms that ask before
 * Archive, Unpublish or a corrected register closes it to someone playing it
 * (`closesNow` in @sabeel/shared). Null until the roster, the accounts and
 * the given recordings have answered: a confirm that skipped itself because
 * nothing had loaded would close a recording on someone without asking.
 */
export function useWhoLosesIt(
  session: RegisterFacts & { courseId: string },
  recording: { id: string; courseId: string; status: string } | null,
  cls: { effectiveActive: boolean; archivedAccess: boolean },
  today: string,
): { closes: (after?: RegisterFacts['attendance']) => string[]; nameOf: (uid: string) => string } | null {
  const roster = useRosterState(session.courseId);
  const students = useStudentsState(true);
  const given = useGivenRecordings(recording);
  return useMemo(() => {
    if (!recording) return { closes: () => [], nameOf: (uid: string) => uid };
    if (!roster || !students || !given) return null;
    const account = new Map(students.map((s) => [s.uid, s]));
    const people = roster.map((e) => ({
      uid: e.studentUid,
      enrolled: e.active,
      active: account.get(e.studentUid)?.status === 'active',
    }));
    return {
      closes: (after?: RegisterFacts['attendance']) =>
        closesNow({ students: people, session, after, recordingStatus: recording.status, cls, given, today }),
      nameOf: (uid: string) => account.get(uid)?.displayName ?? uid,
    };
  }, [recording, roster, students, given, session, cls, today]);
}
