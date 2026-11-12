import { collection, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useMemo } from 'react';
import {
  COLLECTIONS,
  type GivenExpectation,
  type GivenRecordingDoc,
  type RegisterFacts,
} from '@sabeel/shared';
import { useRosterState } from './structure';
import { useStudentsState } from './students';
import { whoLosesIt, type WhoLosesIt } from './givenWords';
import { db, functions } from './firebase';
import { useListenerFailed, useLiveQuery } from './liveQuery';
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
 * until the first snapshot (`confirmed`: the server's).
 */
export function useGivenRecordings(
  recording: { id: string; courseId: string } | null,
  confirmed = false,
): Map<string, GivenRow> | null {
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
      confirmed,
      // Its own key: the ordinary list's, torn down elsewhere, forgot this one's refusal.
      context: confirmed ? { scope: 'confirmed' } : undefined,
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


/** Gives, moves or reopens; answers with the record as it now stands, which the caller's sheet adopts. */
export async function giveRecording(input: {
  recordingId: string;
  studentUid: string;
  openUntil: string;
  expect: GivenExpectation;
}): Promise<GiveAnswer> {
  const res = await httpsCallable<typeof input, GiveAnswer>(functions, 'giveRecording')(input);
  return res.data;
}

/** The record as it now stands, and whether a message about it already went to them today. */
interface GiveAnswer {
  outcome: GiveOutcome;
  current: { givenAt: number; openUntil: string };
  toldToday: boolean;
}

export async function takeBackRecording(input: {
  recordingId: string;
  studentUid: string;
  expect: NonNullable<GivenExpectation>;
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
  session: RegisterFacts & { courseId: string; recordingId: string | null },
  recording: { value: { id: string; courseId: string; status: string } | null; resolved: boolean },
  cls: { effectiveActive: boolean; archivedAccess: boolean },
  today: string,
): WhoLosesIt | 'unchecked' | null {
  // FROM THE SERVER: who would lose it, decided from this browser's cache,
  // missed a colleague's give since, and the confirm did not ask.
  const roster = useRosterState(session.courseId, true);
  const students = useStudentsState(true, true);
  const given = useGivenRecordings(recording.value, true);
  // A refused read never answers, so it is said, not waited for: waited
  // for, a correction's Submit stayed busy for good.
  const failed = useListenerFailed(['roster', 'students', 'givenRecordings']);
  const who = useMemo(
    () => whoLosesIt({ session, recording, roster, students, given, cls, today }),
    [session, recording, roster, students, given, cls, today],
  );
  return who === null && failed ? 'unchecked' : who;
}
