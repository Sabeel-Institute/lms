import { useMemo } from 'react';
import { addDoc, collection, doc, query, where } from 'firebase/firestore';
import {
  COLLECTIONS,
  type AssignmentDoc,
  type CompletionDoc,
  type CompletionEventDoc,
  type GivenRecordingDoc,
  assignmentId,
  enrollmentId,
  givenRecordingId,
  progressId,
} from '@sabeel/shared';
import { db } from './firebase';
import { useLiveDocState, useLiveQuery } from './liveQuery';
import { persistCompletionState } from './completionOutbox';
import { read } from './documents';

export interface AssignmentRow extends AssignmentDoc {
  id: string;
}

/** Completion state for one recording, from the student's own point of view. */
export interface CompletionState {
  completed: boolean;
  /** The write has not yet reached the server — shown as "Pending sync". */
  pending: boolean;
  /**
   * A teacher set this, not the student.
   *
   * The brief promises a student "their own full accountability details", the
   * rules grant them the read for that reason in as many words, and the manual
   * tells them "if a teacher has overridden your status, their mark takes
   * precedence — that's by design". No student screen read it: a student a
   * teacher had already marked complete still saw the recording as outstanding,
   * still sat under Due soon, and still got the last-day reminder.
   */
  override?: { completed: boolean; reason: string };
  /** When it was marked complete; null when unknown (a teacher's mark). */
  completedAt: number | null;
}

/**
 * The student's active obligations. Self-constrained, as the rule requires.
 *
 * `null` UNTIL THE FIRST SNAPSHOT. An empty array is the answer "you have
 * nothing to listen to", and the student home renders it as exactly that
 * sentence — "Nothing to listen to right now. New recordings will appear here."
 * — so an empty stand-in for "nothing has arrived yet" tells a student with
 * three recordings due that they have none, on the screen that is the whole
 * point of the app for them.
 */
export function useMyAssignments(uid: string | null): AssignmentRow[] | null {
  return useLiveQuery<AssignmentRow[] | null>(
    () =>
      uid
        ? query(
            collection(db, COLLECTIONS.assignments),
            where('studentUid', '==', uid),
            where('active', '==', true),
          )
        : null,
    [uid],
    {
      label: 'myAssignments',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('assignments', d) })),
      empty: null,
    },
  );
}

/**
 * The student's completion state, keyed by recordingId.
 *
 * Subscribes with metadata changes so a completion marked offline flips from
 * `pending: true` to `pending: false` on screen the moment it syncs — the
 * "Pending sync" badge would otherwise stick forever.
 */
export function useMyCompletions(uid: string | null): Map<string, CompletionState> {
  const own = useLiveQuery<Map<string, CompletionState>>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.completions), where('studentUid', '==', uid))
        : null,
    [uid],
    {
      label: 'myCompletions',
      map: (snap) => {
        const map = new Map<string, CompletionState>();
        for (const d of snap.docs) {
          const data = read('completions', d);
          map.set(data.recordingId, {
            completed: data.completed,
            pending: d.metadata.hasPendingWrites,
            completedAt: data.completed ? (data.completedAt ?? data.updatedAt) : null,
          });
        }
        return map;
      },
      empty: new Map(),
      // Needed for the pending→synced transition.
      includeMetadataChanges: true,
    },
  );
  const overrides = useMyOverrides(uid);
  /*
   * FOLDED IN HERE, so every student surface gets it at once. The alternative —
   * each screen joining the two itself — is how the staff side and the student
   * side came to disagree in the first place: `effectiveCompletion` was applied
   * on one and not the other, and nobody could see it from either.
   */
  return useMemo(() => {
    if (overrides.size === 0) return own;
    const merged = new Map(own);
    for (const [recordingId, override] of overrides) {
      merged.set(recordingId, {
        completed: override.completed,
        /*
         * NEVER PENDING under an override.
         *
         * "Pending sync" tells a student their own tap has not reached the
         * server yet. When a teacher's mark is what is being displayed, that
         * sentence is about a different value than the one on screen — the
         * override is on the server by definition — so carrying the student's
         * flag through would put "Pending sync" beside a figure that is not
         * theirs and is not pending. Their queued write is real and still goes;
         * it simply does not change what this shows.
         */
        pending: false,
        override,
        completedAt: own.get(recordingId)?.completedAt ?? null,
      });
    }
    return merged;
  }, [own, overrides]);
}

/**
 * How much of one recording this student has listened to, from the stored row.
 *
 * SEPARATE FROM THE PLAYBACK SESSION, which only knows what it has played this
 * time — and never opens at all for a recording that has closed. The brief
 * promises a student "their own full accountability details"; without this, the
 * moment a listen-by date passed the screen became one sentence and the student
 * could no longer see what they had done, including a recording they finished on
 * time. The rules already let them read their own row.
 *
 * RETURNS `resolved`, NOT JUST THE VALUE. Before the first snapshot the answer
 * is `null`, which is indistinguishable from "this student never played it" —
 * and a caller that renders the value directly states 0% as fact during the
 * window before the document arrives, on the one screen whose whole purpose is
 * to be the student's kept account of what they did.
 */
export function useMyListening(
  uid: string | null,
  recordingId: string,
): { value: { listenedMs: number } | null; resolved: boolean } {
  return useLiveDocState<{ listenedMs: number } | null>(
    () => (uid ? doc(db, COLLECTIONS.listeningProgress, progressId(uid, recordingId)) : null),
    [uid, recordingId],
    {
      label: 'myListening',
      map: (snap) =>
        snap.exists() ? { listenedMs: read('listeningProgress', snap).listenedMs } : null,
      empty: null,
    },
  );
}

/** What a student plays a recording under, as read live: see `useMyListenReads`. */
export interface ListenReads {
  grant: AssignmentRow | null;
  given: GivenRecordingDoc | null;
  enrolled: boolean;
  /** All three have answered. Until then the window is not known, and nothing may be decided from it. */
  answered: boolean;
}

/**
 * Everything a student's access to one recording is decided from, LIVE: their
 * excused grant, the recording staff gave them, and their enrolment in its
 * class. `listenWindow` in @sabeel/shared turns these into whether it plays,
 * and on what terms, where the institute's clock ticks (the player and the
 * docked bar), so the answer changes at midnight while paused.
 *
 * Read here rather than carried in the route. A date captured when the
 * recording was opened went stale two ways: staff move a listen-by date
 * forward to reopen a session (the documented way back in), and a Done row's
 * tap carried no date at all for a recording given since, which stopped the
 * audio and drew Mark complete over a recording the student had missed.
 *
 * `answered` is all three having answered, so "not yet read" is never taken
 * for "nothing held": the two have opposite answers. The enrolment is read
 * whether or not anything is given, so a give landing while the player is
 * open never sees a moment of "not enrolled". A refusal of it is an answer
 * (a student never in the class may not read the row); a refusal of the
 * other two is a fault, reported as one.
 */
export function useMyListenReads(
  uid: string | null,
  recordingId: string | null,
  courseId: string | null,
  scope?: string,
): ListenReads {
  const context = scope ? { scope } : undefined;
  const grant = useLiveDocState<AssignmentRow | null>(
    () => (uid && recordingId ? doc(db, COLLECTIONS.assignments, assignmentId(uid, recordingId)) : null),
    [uid, recordingId],
    {
      label: 'myAssignment',
      context,
      map: (snap) => (snap.exists() ? { id: snap.id, ...read('assignments', snap) } : null),
      empty: null,
    },
  );
  const given = useLiveDocState<GivenRecordingDoc | null>(
    () => (uid && recordingId ? doc(db, COLLECTIONS.givenRecordings, givenRecordingId(uid, recordingId)) : null),
    [uid, recordingId],
    { label: 'myGiven', context, map: (snap) => read('givenRecordings', snap), empty: null },
  );
  const enrolled = useLiveDocState<boolean>(
    () => (uid && courseId ? doc(db, COLLECTIONS.enrollments, enrollmentId(uid, courseId)) : null),
    [uid, courseId],
    { label: 'myEnrolment', context, map: (snap) => read('enrollments', snap).active, empty: false, denialIsAnswer: true },
  );
  return {
    grant: grant.value,
    given: given.value,
    enrolled: enrolled.value,
    answered: grant.resolved && given.resolved && enrolled.resolved,
  };
}

/** A recording staff gave this student, with its id. */
export interface GivenRow extends GivenRecordingDoc {
  id: string;
}

/**
 * Every recording staff have given this student, live: null until the first
 * snapshot, so "nothing given" is never said before it is known.
 * Self-constrained, as the rule requires.
 */
export function useMyGivenRecordings(uid: string | null): GivenRow[] | null {
  return useLiveQuery<GivenRow[] | null>(
    () => (uid ? query(collection(db, COLLECTIONS.givenRecordings), where('studentUid', '==', uid)) : null),
    [uid],
    {
      label: 'myGivenRecordings',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('givenRecordings', d) })),
      empty: null,
    },
  );
}

/**
 * The overrides a teacher has set on this student's own recordings.
 *
 * Self-constrained, as the rule requires — `firestore.rules` lets a student read
 * their own and nobody else's.
 */
function useMyOverrides(uid: string | null): Map<string, { completed: boolean; reason: string }> {
  return useLiveQuery<Map<string, { completed: boolean; reason: string }>>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.completionOverrides), where('studentUid', '==', uid))
        : null,
    [uid],
    {
      label: 'myOverrides',
      map: (snap) =>
        new Map(
          snap.docs.map((d) => {
            const data = read('completionOverrides', d);
            return [data.recordingId, { completed: data.completed, reason: data.reason }];
          }),
        ),
      empty: new Map(),
    },
  );
}

/**
 * One recording's completion state, for the player. Live (with metadata) so the
 * Pending-sync state and cross-device completion both reflect immediately.
 */
export function useCompletion(uid: string | null, recordingId: string): CompletionState {
  const own = useLiveQuery<CompletionState>(
    () =>
      uid
        ? query(
            collection(db, COLLECTIONS.completions),
            where('studentUid', '==', uid),
            where('recordingId', '==', recordingId),
          )
        : null,
    [uid, recordingId],
    {
      label: 'completion',
      map: (snap) => {
        const d = snap.docs[0];
        if (!d) return { completed: false, pending: false, completedAt: null };
        const data = read('completions', d);
        return {
          completed: data.completed,
          pending: d.metadata.hasPendingWrites,
          completedAt: data.completed ? (data.completedAt ?? data.updatedAt) : null,
        };
      },
      empty: { completed: false, pending: false, completedAt: null },
      includeMetadataChanges: true,
    },
  );
  // The teacher's mark takes precedence, which is what the manual tells the
  // student — and what the player used to be the last screen not to show.
  const overrides = useMyOverrides(uid);
  const override = overrides.get(recordingId);
  return useMemo(
    () => (override ? { completed: override.completed, pending: false, override, completedAt: own.completedAt } : own),
    [own, override],
  );
}

/**
 * Mark or unmark a recording complete.
 *
 * Two writes, both direct to Firestore rather than through a callable — the
 * whole point is that this works OFFLINE, which a callable cannot. The
 * persistent cache queues them and `hasPendingWrites` surfaces as "Pending
 * sync" until they flush.
 *
 * The current-state doc drives the UI and reporting; the appended event is the
 * append-only audit trail. The "never played" gate is enforced by the caller
 * (the player disables the control) — deliberately NOT in the rules, because a
 * rule requiring the progress doc would false-reject a completion whose queued
 * progress write has not synced yet.
 */
export async function setCompleted(
  studentUid: string,
  recordingId: string,
  courseId: string,
  completed: boolean,
): Promise<void> {
  const now = Date.now();
  const state: CompletionDoc = {
    studentUid,
    recordingId,
    courseId,
    completed,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  const event: CompletionEventDoc = {
    studentUid,
    recordingId,
    courseId,
    action: completed ? 'complete' : 'uncomplete',
    actor: 'student',
    at: now,
  };
  // The STATE write goes through the durability seam (a native AsyncStorage
  // outbox; a plain setDoc on web). Not awaited: offline it would not resolve
  // until sync and would hang the caller. The event is best-effort audit.
  void persistCompletionState(state);
  void addDoc(collection(db, COLLECTIONS.completionEvents), event);
}
