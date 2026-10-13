import type { RecordingDoc } from '@sabeel/shared';

/** A recording as Firestore hands it over: one written before `media` existed has none. */
type AsRead = Omit<RecordingDoc, 'media' | 'defaultVersion'> & Partial<Pick<RecordingDoc, 'media' | 'defaultVersion'>>;

/**
 * A recording as the screens read it, with `media` always a map.
 *
 * READ FROM A CACHE, A DOCUMENT CAN BE OLDER THAN THE CODE. The web app keeps
 * Firestore's persistent cache and a listener answers from it first, so a
 * phone that had opened the library before recordings carried `media` drew
 * those copies on the live site for the moment before the server's arrived —
 * and `Object.values(undefined)` in the first row blanked the whole app
 * (SABEEL-RECORDING-WEB-7). Such a copy reads as a recording with nothing to
 * play, which every screen can draw, until the server's replaces it. Legacy
 * recordings were one audio file, so audio is the version they start on.
 */
export function recordingRow(id: string, data: AsRead): RecordingDoc & { id: string } {
  return { id, ...data, media: data.media ?? {}, defaultVersion: data.defaultVersion ?? 'audio' };
}
