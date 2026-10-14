import { collection, doc, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, type MediaEdit, type RecordingDoc, type RecordingStatus } from '@sabeel/shared';
import { db, functions } from './firebase';
import { useLiveDocState, useLiveQuery } from './liveQuery';
import type { UploadApi } from './upload';
import { read } from './documents';

export interface RecordingRow extends RecordingDoc {
  id: string;
}

/**
 * Recordings for one class.
 *
 * Constrained to a single courseId, which is also what makes the security rule
 * affordable: its staff arm resolves a class lookup per row, and only a
 * single-class query lets that resolve one cached path.
 */
export function useCourseRecordings(courseId: string | null): RecordingRow[] {
  return useCourseRecordingsState(courseId) ?? NO_RECORDINGS;
}

const NO_RECORDINGS: RecordingRow[] = [];

/** The `State` variant: `null` until the listener answers, so an empty sentence is
 *  never printed for a question not yet answered. */
export function useCourseRecordingsState(courseId: string | null): RecordingRow[] | null {
  return useLiveQuery<RecordingRow[] | null>(
    () =>
      courseId
        ? query(
            collection(db, COLLECTIONS.recordings),
            where('courseId', '==', courseId),
            orderBy('createdAt', 'desc'),
          )
        : null,
    [courseId],
    {
      label: 'courseRecordings',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('recordings', d) })),
      empty: null,
      // The library mounts one of these per course a manager teaches, so the
      // label alone cannot say which course a denial came from. Carry the id.
      context: { scope: courseId ?? 'none' },
    },
  );
}

/**
 * Every recording, newest first — ADMIN ONLY (the rules' admin arm lists
 * recordings without a per-row read; a manager must go class by class). The
 * library's admin view.
 *
 *  `null` until the listener answers, so an empty sentence is never printed for
 *  a question not yet answered.
 */
export function useAllRecordingsState(enabled: boolean): RecordingRow[] | null {
  return useLiveQuery<RecordingRow[] | null>(
    () => (enabled ? query(collection(db, COLLECTIONS.recordings), orderBy('createdAt', 'desc')) : null),
    [enabled],
    {
      label: 'allRecordings',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('recordings', d) })),
      empty: null,
    },
  );
}

const call = <I, O>(name: string) => (input: I) =>
  httpsCallable<I, O>(functions, name)(input).then((r) => r.data);

/** Create the draft recording for a session (audio uploaded next). */
export const createRecording = call<{ sessionId: string }, { id: string }>(
  'createRecording',
);

/**
 * One recording, live — a DOCUMENT listener, for the same reason as useCourse.
 *
 * The player resolves its recording through this and is reached by students,
 * whose arm on the recordings rule is a per-document check (published, and they
 * are enrolled in its course). A `__name__` query would be a list instead, and
 * would fail closed on exactly that population.
 */
export function useRecording(recordingId: string | null): RecordingRow | null {
  return useRecordingState(recordingId).value;
}

/**
 * As useRecording, plus whether the listener has answered.
 *
 * `scope` is for the second reader of the same document. Listener errors are
 * keyed by label, so two subscriptions sharing `recording` share one entry: the
 * docked bar's success then clears the banner a screen's genuinely denied read
 * had raised. Anything mounted alongside a screen rather than by it passes one.
 */
export function useRecordingState(
  recordingId: string | null,
  scope?: string,
  /** A student's read: the rules withhold an unpublished recording from them by
   *  design, so a refusal is the recording going away, not a fault. */
  denialIsAnswer = false,
) {
  return useLiveDocState<RecordingRow | null>(
    () => (recordingId ? doc(db, COLLECTIONS.recordings, recordingId) : null),
    [recordingId],
    {
      label: 'recording',
      context: scope ? { scope } : undefined,
      map: (snap) => ({ id: snap.id, ...read('recordings', snap) }),
      empty: null,
      denialIsAnswer,
    },
  );
}

export const setRecordingStatus = call<
  { recordingId: string; status: RecordingStatus },
  unknown
>('setRecordingStatus');

/** Hide or show a file, move a part, or set the version students start on. */
export const editRecordingMedia = call<{ recordingId: string } & MediaEdit, unknown>('editRecordingMedia');

/** Remove one file: a bad one from a draft, or one still on its way in. */
export const removeRecordingMedia = call<{ recordingId: string; itemId: string }, unknown>(
  'removeRecordingMedia',
);

/** Permanent, admin-only, cascading delete. Refused server-side while published. */
export const deleteRecording = call<{ recordingId: string }, unknown>('deleteRecording');

/**
 * The upload callables, in the shape `uploadMedia` drives (upload.ts). The
 * bytes never pass through them: they hand out URLs for parts and confirm
 * what arrived.
 */
export const uploadApi: UploadApi = {
  start: call<Parameters<UploadApi['start']>[0], Awaited<ReturnType<UploadApi['start']>>>('startRecordingUpload'),
  sign: call<Parameters<UploadApi['sign']>[0], Awaited<ReturnType<UploadApi['sign']>>>('signRecordingUploadParts'),
  finalize: call<Parameters<UploadApi['finalize']>[0], unknown>('finalizeRecordingUpload'),
  cancel: (input) => removeRecordingMedia(input),
};
