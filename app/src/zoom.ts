import { httpsCallable } from 'firebase/functions';
import type { ZoomMeetingRow } from '@sabeel/shared';
import { functions } from './firebase';

const call = <I, O>(name: string) => (input: I) =>
  httpsCallable<I, O>(functions, name)(input).then((r) => r.data);

/** The central account's meetings, with their importable files, in a date range (YYYY-MM-DD). */
export const listZoomRecordings = call<{ from: string; to: string }, ZoomMeetingRow[]>('listZoomRecordings');

/**
 * Import Zoom files into a session's recording. Returns as soon as the files
 * are claimed and their copies queued; the session page follows each file as
 * it arrives.
 */
export const importZoomFiles = call<
  { sessionId: string; files: { meetingUuid: string; fileId: string }[] },
  { recordingId: string; itemIds: string[] }
>('importZoomFiles');

/** Queue a recording's failed Zoom files again. */
export const retryZoomImport = call<{ recordingId: string }, { recordingId: string; itemIds: string[] }>(
  'retryZoomImport',
);
