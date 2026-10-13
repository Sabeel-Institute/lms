import { collection, doc, getDoc, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  COLLECTIONS,
  submissionId,
  type AttachmentFile,
  type CourseworkDoc,
  type DraftDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
import { db, functions } from './firebase';
import { useLiveDocState, useLiveQuery } from './liveQuery';

/**
 * Assignments, from the app's side (docs/plans/ASSIGNMENTS.md). The records
 * are `coursework` (the assignment) and `submissions` (one student's work on
 * it); only the screens say "assignment".
 */

export interface SubmissionRow extends SubmissionDoc {
  id: string;
}

export interface CourseworkRow extends CourseworkDoc {
  id: string;
}

const call = <I, O>(name: string) => (input: I) =>
  httpsCallable<I, O>(functions, name)(input).then((r) => r.data);

/**
 * The student's work on every assignment they have, in courses they are still
 * in. `null` until the first snapshot: "nothing to do" is an answer, and a
 * stand-in for "not arrived yet" must not give it.
 */
export function useMySubmissions(uid: string | null): SubmissionRow[] | null {
  return useLiveQuery<SubmissionRow[] | null>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.submissions), where('studentUid', '==', uid), where('active', '==', true))
        : null,
    [uid],
    {
      label: 'mySubmissions',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as SubmissionDoc) })),
      empty: null,
    },
  );
}

/** Which assignments the student has an unsent draft on, for "draft saved". */
export function useMyDraftIds(uid: string | null): Set<string> {
  return useLiveQuery<Set<string>>(
    () => (uid ? query(collection(db, COLLECTIONS.drafts), where('studentUid', '==', uid)) : null),
    [uid],
    {
      label: 'myDrafts',
      map: (snap) => new Set(snap.docs.map((d) => (d.data() as DraftDoc).courseworkId)),
      empty: new Set(),
    },
  );
}

/** One assignment, live. A student is refused one they no longer hold, which is an answer. */
export function useCourseworkState(id: string | null, denialIsAnswer = false) {
  return useLiveDocState<CourseworkRow | null>(
    () => (id ? doc(db, COLLECTIONS.coursework, id) : null),
    [id],
    {
      label: 'coursework',
      map: (snap) => ({ id: snap.id, ...(snap.data() as CourseworkDoc) }),
      empty: null,
      denialIsAnswer,
    },
  );
}

/** One student's work on one assignment, live — the grade arrives here when returned. */
export function useSubmissionState(studentUid: string | null, courseworkId: string) {
  return useLiveDocState<SubmissionRow | null>(
    () => (studentUid ? doc(db, COLLECTIONS.submissions, submissionId(studentUid, courseworkId)) : null),
    [studentUid, courseworkId],
    {
      label: 'submission',
      map: (snap) => ({ id: snap.id, ...(snap.data() as SubmissionDoc) }),
      empty: null,
    },
  );
}

/** The student's own unsent work, live. */
export function useMyDraft(uid: string | null, courseworkId: string): DraftDoc | null {
  return useLiveDocState<DraftDoc | null>(
    () => (uid ? doc(db, COLLECTIONS.drafts, submissionId(uid, courseworkId)) : null),
    [uid, courseworkId],
    { label: 'myDraft', map: (snap) => snap.data() as DraftDoc, empty: null },
  ).value;
}

/**
 * Save the note on the student's draft — the one thing they write directly.
 * An update when the draft exists (a file may have created it), a create
 * otherwise; the rules hold the create to an empty file list.
 */
export async function saveDraftNote(uid: string, courseworkId: string, courseId: string, note: string): Promise<void> {
  const ref = doc(db, COLLECTIONS.drafts, submissionId(uid, courseworkId));
  if ((await getDoc(ref)).exists()) {
    await updateDoc(ref, { note, updatedAt: Date.now() });
    return;
  }
  const draft: DraftDoc = { studentUid: uid, courseworkId, courseId, note, files: {}, updatedAt: Date.now() };
  await setDoc(ref, draft);
}

export const handIn = call<{ courseworkId: string }, { handedInAt: number; late: boolean }>('handIn');
export const takeBack = call<{ courseworkId: string }, { takenBackAt: number }>('takeBack');

export const startAttachmentUpload = call<
  { target: 'coursework' | 'work'; courseworkId: string; name: string; sizeBytes: number },
  { fileId: string; url: string; headers: Record<string, string>; expiresAt: number }
>('startAttachmentUpload');
export const finalizeAttachment = call<{ courseworkId: string; fileId: string }, { file: AttachmentFile }>(
  'finalizeAttachment',
);
export const removeAttachment = call<{ courseworkId: string; fileId: string }, unknown>('removeAttachment');
export const getAttachmentUrl = call<
  { courseworkId: string; fileId: string; studentUid?: string },
  { url: string; expiresAt: number; name: string; contentType: string }
>('getAttachmentUrl');
