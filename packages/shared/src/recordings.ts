/**
 * Recording lifecycle.
 *
 * The states and the legal moves between them come straight from the diagram in
 * docs/PRODUCT_BRIEF.md § Recording lifecycle. Kept pure so every transition can
 * be tested without an emulator, and so the client and the callables cannot
 * disagree about what is allowed.
 */
import { hasNoMedia, isPlayable, type MediaMap, type MediaVersion } from './media';

export type RecordingStatus =
  | 'draft'
  | 'published'
  | 'archived'
  | 'unpublished'
  | 'needsAttention';

/** How the recording was started: an upload, or a Zoom import. Each media item
 *  carries its own source as well, since a recording can hold both. */
export type RecordingSource = 'manual' | 'zoom';

/**
 * The media of a session — its files, lifecycle, and the student-facing
 * display copy of its session.
 *
 * The `SessionDoc` is the source of truth for the meeting metadata (and owns the
 * private attendance map). But students CANNOT read sessions — that is what keeps
 * attendance private — so the display fields a student needs to see what they are
 * listening to (`title`, `notes`, `date`) are denormalized here, on the
 * published recording they are allowed to read. `dueDate` is likewise
 * denormalized onto the student's own assignment. Staff edit the session; the
 * create/update-session paths keep these copies in sync. `courseId`/`cohortId`
 * are denormalized too, for queries and the assignment fan-out.
 */
export interface RecordingDoc {
  sessionId: string;
  courseId: string;
  cohortId: string;
  /** Denormalized from the session (source of truth) so students can display it. */
  title: string;
  notes: string;
  /** The session's meeting date, `YYYY-MM-DD`. Denormalized for student display. */
  date: string;
  status: RecordingStatus;
  source: RecordingSource;
  /** The recording's media, by item id (`media.ts`). Empty until something
   *  has been uploaded or imported. */
  media: MediaMap;
  /** The version a student starts on the first time. */
  defaultVersion: MediaVersion;
  /** DERIVED by the server whenever media changes (`deriveDurationSec`), so
   *  the ledger's listened percent and the workbook keep one number. */
  durationSec: number | null;
  /** Why it needs attention. Present only while status is needsAttention. */
  attentionReason?: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  publishedAt?: number;
}

/**
 * Legal status moves, exactly as the brief's diagram draws them.
 *
 * Two shapes worth noticing, because both are deliberate and look like
 * omissions:
 *
 *  - `unpublished` goes back to `draft`, never straight to `published`. Bringing
 *    a withdrawn recording back forces a trip through the metadata gate, which
 *    is the point — it was withdrawn for a reason.
 *  - `archived` returns to `published` directly, because archiving is a
 *    filing decision rather than a correction.
 */
const TRANSITIONS: Record<RecordingStatus, readonly RecordingStatus[]> = {
  // A fresh upload, or a failed import that staff have retried.
  draft: ['published', 'needsAttention'],
  published: ['archived', 'unpublished'],
  archived: ['published'],
  unpublished: ['draft'],
  needsAttention: ['draft'],
};

export function canTransition(from: RecordingStatus, to: RecordingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The moves available from a state — drives which buttons a screen offers. */
export function allowedTransitions(from: RecordingStatus): readonly RecordingStatus[] {
  return TRANSITIONS[from] ?? [];
}

export type PublishBlocker = 'media' | 'pending' | 'failed' | 'status';

/**
 * What still stands between a recording and being published.
 *
 * Returns the reasons rather than a boolean so the UI can say which is missing
 * instead of leaving a disabled button unexplained. Publishing needs something
 * a student can play — a row in every student's list that plays nothing is the
 * one failure a student cannot work around — and nothing still on its way into
 * the bucket or failed there, so nothing is published that staff have not seen
 * settle. The title lives on the session, which always has one.
 */
export function publishBlockers(recording: {
  media: MediaMap;
  status: RecordingStatus;
}): PublishBlocker[] {
  const items = Object.values(recording.media);
  const blockers: PublishBlocker[] = [];
  if (!items.some(isPlayable)) blockers.push('media');
  if (items.some((i) => i.status === 'uploading' || i.status === 'copying')) blockers.push('pending');
  if (items.some((i) => i.status === 'failed')) blockers.push('failed');
  if (!canTransition(recording.status, 'published')) blockers.push('status');
  return blockers;
}

export function canPublish(recording: { media: MediaMap; status: RecordingStatus }): boolean {
  return publishBlockers(recording).length === 0;
}

/**
 * A recording that holds nothing right now: no media, and not live.
 *
 * NOT A PROOF THAT IT NEVER HELD ANYTHING, and it used to be read as one. A
 * recording that was published and then walked back — `published →
 * unpublished → draft`, then its media removed — arrives at exactly this shape with
 * a full term of assignments, completions and progress still pointing at it. So
 * this says "needs media", which is what the UI keys off: a normal, recoverable
 * state (a just-created draft mid-upload, an upload that failed, media removed
 * for replacement), not an error.
 *
 * The delete gate asks `hasRecordingHistory` as well, because only the
 * collections can answer whether there is anything to destroy.
 */
export function isEmptyDraft(recording: { media: MediaMap; status: RecordingStatus }): boolean {
  return (
    hasNoMedia(recording.media) &&
    (recording.status === 'draft' || recording.status === 'needsAttention')
  );
}

/**
 * A recording that can be thrown away rather than permanently deleted.
 *
 * `isEmptyDraft` says "needs media" — a state a recording can arrive in from
 * either direction. This says "and it never held anything", which is the
 * question the delete gate is actually asking, and `publishedAt` is what answers
 * it: set on the first publish and never cleared, so a recording walked back
 * (`published → unpublished → draft`, then its media removed) is excluded even though
 * its shape is identical to a fresh draft's.
 *
 * The SERVER does not trust this — `requireDeleteRights` asks the collections,
 * which is the only authority and also covers a recording predating the field.
 * This is what lets the CLIENT offer the right button and the right words:
 * "Discard … nothing is lost" over a recording with a term of listening history
 * behind it was the confirmation getting it wrong, and a manager was shown a
 * Discard that could only ever return permission-denied.
 */
export function isDiscardable(recording: {
  media: MediaMap;
  status: RecordingStatus;
  publishedAt?: number;
}): boolean {
  return isEmptyDraft(recording) && !recording.publishedAt;
}

/** Students only ever see published recordings. */
export function isVisibleToStudents(status: RecordingStatus): boolean {
  return status === 'published';
}

/**
 * A recording whose listening ledger is worth opening: published now, or
 * published once — since archived, unpublished, or walked all the way back to
 * a draft to replace its file, which `publishedAt` remembers (set once, never
 * cleared) and status alone does not. Archiving is how a term ENDS — and the
 * term's record of who listened and who missed is the ledger, which offered
 * its button on a published recording alone, so the history was unreachable
 * from the moment it mattered most. A draft that was never published has no
 * ledger: nobody was ever granted it.
 */
export function hasLedger(recording: { status: RecordingStatus; publishedAt?: number }): boolean {
  return (
    recording.status === 'published' ||
    recording.status === 'archived' ||
    recording.status === 'unpublished' ||
    !!recording.publishedAt
  );
}

/**
 * How much of one recording a student has listened to: the evidence staff
 * read on the ledger.
 *
 * Document id is `${studentUid}_${recordingId}`, so it is a single get and
 * the rules can check ownership without reading anything else.
 *
 * Written by the CLIENT rather than a callable, which is a deliberate departure
 * from this codebase's "all mutation through callables" rule. A callable every
 * fifteen seconds per listening student is pure overhead, and the stakes are
 * low: listened time is audit evidence, not the gate. Completion is
 * student-attested and blocked only if they never played, so inflating this
 * gains nothing that letting the audio run would not.
 *
 * NOT WHERE THEY ARE. The place is kept on each device (`placeStore` in the
 * app) and a student moves it between devices on purpose, with a bookmark
 * (`BookmarkDoc`): a place shared through the server was moved back by any
 * device left open on an older one (decision 2026-10-15, PRODUCT_BRIEF).
 */
export interface ListeningProgressDoc {
  studentUid: string;
  recordingId: string;
  courseId: string;
  /**
   * Total time actually listened, which is NOT the same as position: seeking
   * forward must not manufacture listening that did not happen. The sum of
   * `sittings`, kept beside them because it is what every staff screen reads.
   */
  listenedMs: number;
  /**
   * EACH SITTING'S LISTENING, by the sitting's id: a sitting is one opening of
   * the recording in a player, on any device. Added up, never merged by the
   * larger: two devices, or a tab left open and taken up again later, each
   * count what they played, and a save replayed or sent twice cannot count
   * twice because each sitting only ever raises its own entry.
   */
  sittings: Record<string, number>;
  /** The sitting this save came from: the one entry of `sittings` it may change. */
  sitting: string;
  /** When it was last listened to. */
  updatedAt: number;
}

export function progressId(studentUid: string, recordingId: string): string {
  return `${studentUid}_${recordingId}`;
}

/**
 * The most sittings one progress document holds. Firestore's rules restate
 * it, and refuse a save that would hold more. A student opens a recording
 * once a sitting; a few hundred is far past any class's use of one.
 */
export const MAX_SITTINGS = 500;

/** How often progress is sent to the server while audio is playing. */
export const PROGRESS_WRITE_INTERVAL_MS = 15_000;

/** One sitting's save: its listening so far, and when. */
export interface SittingSave {
  sitting: string;
  listenedMs: number;
  updatedAt: number;
}

/** How far past the reader's clock a save may be stamped and still be taken for a later one. */
const CLOCK_AHEAD_MS = 60 * 60 * 1000;

/**
 * The stored listening with one sitting's save added in.
 *
 * The sitting's entry only ever grows: a save older than one already there
 * (a replay, a retry) changes nothing. The total is the sum of every
 * sitting's.
 *
 * `updatedAt` is when it was last listened to: the later of the two, unless
 * the stored one is stamped more than an hour past `now`, the reader's clock.
 * That was stamped by a clock running ahead, not later, and kept it would
 * hold "last listened" in the future until real time caught up, which for a
 * clock set years ahead is never.
 */
export function withSitting(
  stored: Pick<ListeningProgressDoc, 'sittings' | 'updatedAt'> | null,
  save: SittingSave,
  now: number,
): Pick<ListeningProgressDoc, 'sittings' | 'sitting' | 'listenedMs' | 'updatedAt'> {
  const sittings = { ...(stored?.sittings ?? {}) };
  sittings[save.sitting] = Math.max(sittings[save.sitting] ?? 0, Math.round(save.listenedMs));
  const keptAt = stored && stored.updatedAt <= now + CLOCK_AHEAD_MS ? stored.updatedAt : 0;
  return {
    sittings,
    sitting: save.sitting,
    listenedMs: Object.values(sittings).reduce((sum, ms) => sum + ms, 0),
    updatedAt: Math.max(keptAt, save.updatedAt),
  };
}

/**
 * A student's bookmark in one recording: the place they chose to come back
 * to, on any device. One per recording; setting it again moves it.
 *
 * Document id is `${studentUid}_${recordingId}` (`progressId`). Written by the
 * student's own client, like their listening, and read by nobody else.
 */
export interface BookmarkDoc {
  studentUid: string;
  recordingId: string;
  courseId: string;
  /**
   * The file it is in, by its id: a part keeps its files' ids when staff move
   * it, so the bookmark stays on the stretch of class it was set in.
   */
  itemId: string;
  positionMs: number;
  setAt: number;
}

/** Fraction listened, for a progress bar. Guards a missing or zero duration so
 *  a recording with no duration renders an empty bar rather than NaN. */
export function listenedFraction(listenedMs: number, durationSec: number | null): number {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.min(1, listenedMs / (durationSec * 1000));
}

/**
 * Fraction listened, for a ledger row — or null when it cannot be known.
 *
 * `listenedFraction` answers 0 for a recording with no length because a bar has
 * to draw something; a row that printed that 0 as "0% listened" beside "last
 * listened yesterday" was a confident wrong answer on the screen staff use to
 * decide who to chase. Somebody who has played nothing is 0 whatever the
 * length; somebody who has, on a recording of unknown length, is unknown.
 */
export function listenedShare(listenedMs: number, durationSec: number | null): number | null {
  if (listenedMs <= 0) return 0;
  if (!durationSec || durationSec <= 0) return null;
  return Math.min(1, listenedMs / (durationSec * 1000));
}
