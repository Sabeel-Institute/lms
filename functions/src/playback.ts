import { HttpsError } from 'firebase-functions/v2/https';
import { reportedCall } from './reported';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  assignmentId,
  canPlayFromCourse,
  enrollmentId,
  givenRecordingId,
  isStaffRole,
  listenWindow,
  SIGNED_URL_TTL_MS,
  todayInZone,
  type AssignmentDoc,
  type CourseDoc,
  type EnrollmentDoc,
  type GivenRecordingDoc,
  type MediaItem,
  type RecordingDoc,
  type TokenClaims,
} from '@sabeel/shared';
import { MEDIA_READ_SECRETS, signGet } from './mediaStore';

export type PlaybackDenial =
  | 'not-published'
  | 'not-assigned'
  | 'past-due'
  | 'given-ended'
  | 'class-listening-off'
  | 'not-your-class'
  | 'no-media';

/**
 * May this caller play this recording, and if not, why?
 *
 * Pure, so every branch is unit-testable without an emulator or a signing
 * service. `playbackDenial` returning null means allowed.
 *
 * A student plays under their assignment — it exists because they were marked
 * excused, and it is in date until the session's due date — or under a
 * recording staff gave them, in date until its own. `listenWindow` in
 * @sabeel/shared decides between them, the same function the player and To do
 * read. Enrolment matters to the given arm only: unenrolling already
 * deactivates an assignment (`deactivateStudentAssignmentsInCourse`), while a
 * given recording has no flag and is closed by the enrolment itself.
 */
export function playbackDenial(input: {
  claims: TokenClaims;
  recording: Pick<RecordingDoc, 'status'>;
  /** The file asked for, or null if the recording has no such item. */
  item: Pick<MediaItem, 'status' | 'hidden'> | null;
  cls: Pick<CourseDoc, 'effectiveActive' | 'archivedAccess' | 'managerUids'>;
  uid: string;
  assignment: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
  given: Pick<GivenRecordingDoc, 'openUntil'> | null;
  /** Whether the student's enrolment in the recording's class is active; read only when `given` is set. */
  enrolled: boolean;
  today: string;
}): PlaybackDenial | null {
  const { claims, recording, item, cls, uid, assignment, given, enrolled, today } = input;
  if (!item || item.status !== 'ready') return 'no-media';

  if (isStaffRole(claims.role)) {
    // Staff may play ANY status — the brief requires them to listen in order to
    // verify an import or check metadata before publishing.
    if (claims.role === 'admin') return null;
    return cls.managerUids.includes(uid) ? null : 'not-your-class';
  }

  // Students: only published recordings, only ones excused or given to them,
  // and only until the date that holds. A hidden file is withdrawn from them
  // even inside a recording they may play; staff still hear it to decide.
  if (item.hidden) return 'no-media';
  if (recording.status !== 'published') return 'not-published';
  const window = listenWindow(assignment, given, enrolled, today);
  if (window.state === 'none') return 'not-assigned';
  if (window.state === 'ended') {
    // The excused date being the later one is the excused record's sentence;
    // a given recording that ran later has its own.
    return window.record && assignment?.dueDate === window.lastDay ? 'past-due' : 'given-ended';
  }
  // The archived-access rule from Phase 1 still does its work on top: an
  // archived class turns listening off unless staff deliberately kept it on.
  if (!canPlayFromCourse(cls)) return 'class-listening-off';
  return null;
}

const MESSAGES: Record<PlaybackDenial, string> = {
  'no-media': 'That file is not available.',
  'not-published': 'That recording is not published.',
  'not-assigned': 'That recording is not open to you.',
  'past-due': 'The due date for this recording has passed.',
  'given-ended': 'This recording is no longer open to you.',
  'class-listening-off': 'This class is archived and its recordings are closed.',
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

    const [clsSnap, asgSnap, givenSnap] = await Promise.all([
      db.collection(COLLECTIONS.courses).doc(recording.courseId).get(),
      db.collection(COLLECTIONS.assignments).doc(assignmentId(req.auth.uid, recordingId)).get(),
      db.collection(COLLECTIONS.givenRecordings).doc(givenRecordingId(req.auth.uid, recordingId)).get(),
    ]);
    if (!clsSnap.exists) throw new HttpsError('not-found', 'No such class.');
    // The enrolment only when there is a given recording: it closes that arm
    // alone, and every excused play would otherwise pay for the read.
    const enrolled = givenSnap.exists
      ? !!(
          (await db.collection(COLLECTIONS.enrollments).doc(enrollmentId(req.auth.uid, recording.courseId)).get()).data() as
            | EnrollmentDoc
            | undefined
        )?.active
      : false;

    const denial = playbackDenial({
      claims,
      recording,
      item,
      cls: clsSnap.data() as CourseDoc,
      uid: req.auth.uid,
      assignment: asgSnap.exists ? (asgSnap.data() as AssignmentDoc) : null,
      given: givenSnap.exists ? (givenSnap.data() as GivenRecordingDoc) : null,
      enrolled,
      today: todayInZone(INSTITUTE_TIMEZONE),
    });
    if (denial) throw new HttpsError('permission-denied', MESSAGES[denial]);

    return signGet((item as MediaItem).storageKey, SIGNED_URL_TTL_MS);
  }, MEDIA_READ_SECRETS);
