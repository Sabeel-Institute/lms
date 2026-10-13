import { HttpsError } from 'firebase-functions/v2/https';
import { reportedCall } from './reported';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  assignmentId,
  canPlayFromCourse,
  hasRecordingAccess,
  isStaffRole,
  SIGNED_URL_TTL_MS,
  todayInZone,
  type AssignmentDoc,
  type CourseDoc,
  type MediaItem,
  type RecordingDoc,
  type TokenClaims,
} from '@sabeel/shared';
import { MEDIA_READ_SECRETS, signGet } from './mediaStore';

export type PlaybackDenial =
  | 'not-published'
  | 'not-assigned'
  | 'past-due'
  | 'class-listening-off'
  | 'not-your-class'
  | 'no-media';

/**
 * May this caller play this recording, and if not, why?
 *
 * Pure, so every branch is unit-testable without an emulator or a signing
 * service. `playbackDenial` returning null means allowed.
 *
 * A student's whole entitlement is their assignment: it exists because they were
 * marked excused, and it is in date until the session's due date. Enrolment is
 * not consulted, because it cannot add anything an assignment does not already
 * prove — unenrolling deactivates them (`deactivateStudentAssignmentsInCourse`).
 */
export function playbackDenial(input: {
  claims: TokenClaims;
  recording: Pick<RecordingDoc, 'status'>;
  /** The file asked for, or null if the recording has no such item. */
  item: Pick<MediaItem, 'status' | 'hidden'> | null;
  cls: Pick<CourseDoc, 'effectiveActive' | 'archivedAccess' | 'managerUids'>;
  uid: string;
  assignment: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
  today: string;
}): PlaybackDenial | null {
  const { claims, recording, item, cls, uid, assignment, today } = input;
  if (!item || item.status !== 'ready') return 'no-media';

  if (isStaffRole(claims.role)) {
    // Staff may play ANY status — the brief requires them to listen in order to
    // verify an import or check metadata before publishing.
    if (claims.role === 'admin') return null;
    return cls.managerUids.includes(uid) ? null : 'not-your-class';
  }

  // Students: only published recordings, only ones granted to them, and only
  // until the deadline they were given. A hidden file is withdrawn from them
  // even inside a recording they may play; staff still hear it to decide.
  if (item.hidden) return 'no-media';
  if (recording.status !== 'published') return 'not-published';
  if (!assignment || !assignment.active) return 'not-assigned';
  if (!hasRecordingAccess(assignment, today)) return 'past-due';
  // The archived-access rule from Phase 1 still does its work on top: an
  // archived class turns listening off unless staff deliberately kept it on.
  if (!canPlayFromCourse(cls)) return 'class-listening-off';
  return null;
}

const MESSAGES: Record<PlaybackDenial, string> = {
  'no-media': 'That file is not available.',
  'not-published': 'That recording is not published.',
  'not-assigned': 'That recording was not assigned to you.',
  'past-due': 'The due date for this recording has passed.',
  'class-listening-off': 'This class is archived and listening has been turned off.',
  'not-your-class': 'You are not assigned to that class.',
};

/**
 * Mint a playback URL for one file of one recording.
 *
 * Authorization happens HERE, not in security rules, because the media bucket
 * has no rules: the URL is signed with the bucket's read key and is good for
 * anyone holding it until it expires. This callable is the only thing standing
 * between a signed-in user and the audio.
 */
export const getPlaybackUrl = reportedCall(async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const claims = (req.auth.token ?? {}) as TokenClaims;
    if (claims.status !== 'active') {
      throw new HttpsError('permission-denied', 'Account is not active.');
    }

    const recordingId = req.data?.recordingId;
    if (typeof recordingId !== 'string' || !recordingId) {
      throw new HttpsError('invalid-argument', 'recordingId is required.');
    }
    const itemId = req.data?.itemId;
    if (typeof itemId !== 'string' || !itemId) {
      throw new HttpsError('invalid-argument', 'itemId is required.');
    }

    const db = getFirestore();
    const recSnap = await db.collection(COLLECTIONS.recordings).doc(recordingId).get();
    if (!recSnap.exists) throw new HttpsError('not-found', 'No such recording.');
    const recording = recSnap.data() as RecordingDoc;
    const item = recording.media[itemId] ?? null;

    const [clsSnap, asgSnap] = await Promise.all([
      db.collection(COLLECTIONS.courses).doc(recording.courseId).get(),
      db.collection(COLLECTIONS.assignments).doc(assignmentId(req.auth.uid, recordingId)).get(),
    ]);
    if (!clsSnap.exists) throw new HttpsError('not-found', 'No such class.');

    const denial = playbackDenial({
      claims,
      recording,
      item,
      cls: clsSnap.data() as CourseDoc,
      uid: req.auth.uid,
      assignment: asgSnap.exists ? (asgSnap.data() as AssignmentDoc) : null,
      today: todayInZone(INSTITUTE_TIMEZONE),
    });
    if (denial) throw new HttpsError('permission-denied', MESSAGES[denial]);

    return signGet((item as MediaItem).storageKey, SIGNED_URL_TTL_MS);
  }, MEDIA_READ_SECRETS);
