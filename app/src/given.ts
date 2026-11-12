import { collection, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, type GivenExpectation, type GivenRecordingDoc } from '@sabeel/shared';
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
export function useGivenRecordings(recording: { id: string; courseId: string }): Map<string, GivenRow> | null {
  return useLiveQuery<Map<string, GivenRow> | null>(
    () =>
      query(
        collection(db, COLLECTIONS.givenRecordings),
        where('courseId', '==', recording.courseId),
        where('recordingId', '==', recording.id),
      ),
    [recording.courseId, recording.id],
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

