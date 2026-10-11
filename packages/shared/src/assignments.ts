/**
 * Assignments (required-listening obligations), completion state, and the
 * date-only due-date maths that orders a student's home.
 *
 * Everything here is PURE — no Firestore, no Date-now hidden inside — so every
 * boundary (the day a due date flips to overdue, in the institute timezone) can
 * be tested with a fixed clock and no emulator. Same discipline as
 * `recordings.ts`.
 */
import { canPlayFromCourse } from './structure';
import { DUE_SOON_DAYS } from './constants';

// -------------------------------------------------------------- documents --

/**
 * A student's grant on one recording: both the permission to play it and the
 * obligation to.
 *
 * There is exactly one reason one exists: the student was marked EXCUSED for the
 * session and it has a published recording. So there is no `source` — the
 * reconcile from the session's attendance is the only writer.
 *
 * This document is the whole of a student's access. `firestore.rules` gates the
 * recording's metadata on it, and `getPlaybackUrl` gates the audio on it, so a
 * student who is not excused cannot reach a recording by any route.
 *
 * Document id is `${studentUid}_${recordingId}` — at most one per student per
 * recording, which makes the reconcile idempotent. Written ONLY by the server;
 * clients read their own and never write. `dueDate` is denormalized from the
 * session so a student sees their deadline with no extra read.
 */
export interface AssignmentDoc {
  studentUid: string;
  recordingId: string;
  sessionId: string;
  courseId: string;
  cohortId: string;
  /** Date-only `YYYY-MM-DD` in the institute timezone. The last day the student
   *  may listen: access closes after it. Never null — see `SessionDoc.dueDate`. */
  dueDate: string;
  /**
   * The grant on/off without deleting history. Unpublish, marking the student
   * present or absent, and unenrolling all set this false; the row and its
   * completion history remain for audit.
   *
   * Note it does NOT go false when the due date passes: that would erase the
   * ledger's record of who missed what. Expiry is a function of the date, not a
   * stored flag — see `hasRecordingAccess`.
   */
  active: boolean;
  assignedAt: number;
  assignedBy: string;
}

export function assignmentId(studentUid: string, recordingId: string): string {
  return `${studentUid}_${recordingId}`;
}

/**
 * May this student still open this recording?
 *
 * The single definition of access, shared by `getPlaybackUrl` and the student
 * UI so the app never offers a play button the server will refuse. Deliberately
 * NOT reimplemented in security rules: comparing `request.time` to a date-only
 * string in the institute timezone would be a second copy of the maths below,
 * free to drift. Rules gate the metadata on `active`; this gates the audio.
 */
export function hasRecordingAccess(
  assignment: { active: boolean; dueDate: string },
  today: string,
): boolean {
  return assignment.active && !isOverdue(assignment.dueDate, today);
}

/**
 * A student's current completion STATE for one recording.
 *
 * Client-written, keyed `${studentUid}_${recordingId}`, and independent of any
 * assignment: a student may complete an accessible recording that was never
 * assigned to them (the brief allows it; it just does not count as required).
 * `hasPendingWrites` on this document's snapshot is the "Pending sync" signal.
 */
export interface CompletionDoc {
  studentUid: string;
  recordingId: string;
  courseId: string;
  completed: boolean;
  /** When it was last marked complete; null once unmarked. */
  completedAt: number | null;
  updatedAt: number;
}

export function completionId(studentUid: string, recordingId: string): string {
  return `${studentUid}_${recordingId}`;
}

/**
 * One mark/unmark action — append-only audit.
 *
 * `actor` is `'student'` for self-service; staff overrides (Phase 5) will carry
 * a uid here. Never updated or deleted.
 */
export interface CompletionEventDoc {
  studentUid: string;
  recordingId: string;
  courseId: string;
  action: 'complete' | 'uncomplete';
  actor: 'student';
  at: number;
}

// -------------------------------------------------------- date-only maths --

/**
 * Today's calendar date in a timezone, as `YYYY-MM-DD`.
 *
 * `en-CA` formats as ISO `YYYY-MM-DD`, and `timeZone` makes the rollover happen
 * at local midnight — so at 11pm Houston time on the 24th this returns
 * `...-24`, not the 25th that UTC would give. No date library needed.
 */
export function todayInZone(timeZone: string, now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/**
 * A moment in a timezone, as `YYYY-MM-DD HH:MM` on a 24-hour clock.
 *
 * THE INSTITUTE'S CLOCK, NOT THE READER'S — which is the whole reason this
 * exists rather than `toLocaleString()`. Every date this app shows is a civil
 * date in `INSTITUTE_TIMEZONE`: a session's date, a listen-by date, the
 * rollover that closes access. A timestamp rendered in the viewer's zone sits
 * beside those in the same list and answers a different question, so an
 * override recorded at 23:30 the night before a deadline reads as the morning
 * after it to anyone further east — on the one screen whose entire purpose is
 * to be the record of what happened.
 *
 * THE SHAPE COMES FROM ASSEMBLING THE PARTS, not from the locale — unlike
 * `todayInZone`, which formats directly and gets ISO out of `en-CA`. What the
 * locale tag still decides here is the CALENDAR and the NUMERALS: the same
 * instant is `1405-06-13` under `fa-IR` and `٢٠٢٦-٠٩-٠٤` under `ar-SA`. So it
 * is pinned, and the tests assert the exact string rather than its shape.
 */
export function stampInZone(timeZone: string, ms: number): string {
  const at = wallClock(timeZone, ms);
  return `${at.year}-${at.month}-${at.day} ${at.hour}:${at.minute}`;
}

/**
 * The span between two moments on a 12-hour clock in a timezone:
 * `6:02–8:18 PM`, or `11:30 AM–1:05 PM` when it crosses noon.
 *
 * For a schedule rather than a record. Staff match these against a timetable
 * they say aloud as "the 6 PM class", which is why this is not `stampInZone`'s
 * 24-hour clock. The meridiem is written once when both ends share it.
 *
 * BUILT FROM THE 24-HOUR PARTS rather than from an `hour12` format, for the
 * reason `stampInZone` assembles its own: the locale would pick the marker
 * (`p.m.`, `PM` behind a narrow no-break space in newer ICU) and an engine's
 * Intl decides the rest, so the string would be whatever the device says.
 */
export function clockRangeInZone(timeZone: string, startMs: number, endMs: number): string {
  const clock = (ms: number) => {
    const { hour, minute } = wallClock(timeZone, ms);
    const h = Number(hour);
    return { time: `${h % 12 || 12}:${minute}`, meridiem: h < 12 ? 'AM' : 'PM' };
  };
  const start = clock(startMs);
  const end = clock(endMs);
  const head = start.meridiem === end.meridiem ? start.time : `${start.time} ${start.meridiem}`;
  return `${head}–${end.time} ${end.meridiem}`;
}

/**
 * A moment's calendar and clock fields in a timezone, zero-padded, 24-hour —
 * the one place a wall clock is read. The locale is pinned for the reason
 * `stampInZone` gives; `h23` makes midnight `00` rather than `24`.
 */
function wallClock(
  timeZone: string,
  ms: number,
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: at('year'), month: at('month'), day: at('day'), hour: at('hour'), minute: at('minute') };
}

/**
 * `date` shifted by whole calendar days, as `YYYY-MM-DD`.
 *
 * Parsed as UTC midnight for the same reason `daysUntilDue` is: this is civil
 * date arithmetic, and DST never enters a count of calendar days. Used to
 * prefill a session's due date from its meeting date.
 */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `today` until `dueDate` (negative once past).
 *
 * Both are date-only strings, so they are parsed as UTC midnight purely to
 * count the days between two civil dates — DST never enters a difference of two
 * calendar days, so this is exact. `2026-07-25` minus `2026-07-24` is 1.
 */
export function daysUntilDue(dueDate: string, today: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.round((due - now) / 86_400_000);
}

/**
 * Has this due date passed as of `today`?
 *
 * The due date is the LAST on-time day: a recording due `2026-07-25` is still
 * open all through the 25th and closes on the 26th.
 */
export function isOverdue(dueDate: string, today: string): boolean {
  return today > dueDate;
}

/**
 * A `YYYY-MM-DD` date that will not break across two lines.
 *
 * Non-breaking spaces around it are not enough: the hyphens inside it are
 * themselves break opportunities, so a narrow card split "listen by 2026-" from
 * "09-26" — one token later than the fix that was reached for, and on the one
 * value a student's whole entitlement turns on. U+2011 is the non-breaking
 * hyphen; it renders identically to U+002D.
 *
 * Use it wherever a date sits INSIDE a sentence, beside words that could push it
 * onto the next line. A date that is the whole of its own `Text` cannot break in
 * the first place and does not need it.
 */
export function unbreakableDate(date: string): string {
  return date.replace(/-/g, '\u2011');
}

/**
 * MAY THIS RECORDING STILL BE PLAYED? One rule, for every surface that asks.
 *
 * Two of them do — the player screen and the docked bar — and each held its own
 * copy of the composition. The copies had already drifted once: applying the
 * deadline unconditionally cut a manager off from anything more than a week old
 * the moment they left the player, because the deadline closes a STUDENT's
 * access and nobody else's. That is exactly the shape of bug two spellings of
 * one rule produce, and it is why `formatClock` and `SKIP_BACK_MS` live in one
 * place too.
 *
 * The server is still the authority: `getPlaybackUrl` checks the same facts
 * before it mints anything. This is the client saying the same thing, so a
 * closed recording reads as closed rather than as a button that fails.
 */
export function canPlayNow(
  cls: { effectiveActive: boolean; archivedAccess: boolean },
  /**
   * The listener's own deadline.
   *
   * Null means two different things depending on who is asking, and they have
   * OPPOSITE answers: for staff there is no deadline to apply, and for a student
   * there is no grant — the date comes from their assignment, so its absence IS
   * the absence of the assignment. Written as one `&&` chain this read "no date,
   * so nothing has expired" and returned true for both, which is the fail-open
   * the invariant rules out in as many words: a blank deadline would mean
   * permanent access, so nothing may treat one as permission. The server refuses
   * to mint a URL either way; what this fixes is the client drawing a live
   * transport over a recording the person holds nothing for.
   */
  dueDate: string | null,
  /** Null when staff are listening — see `NowPlaying.studentUid`. */
  studentUid: string | null,
  today: string,
): boolean {
  /*
   * STAFF FIRST, AND BEFORE THE COURSE CHECK.
   *
   * Both ways a student's access ends — the deadline, and archiving a class with
   * listening off — are about students, and `playbackDenial` on the server has
   * always read them that way: its staff branch returns before either. This read
   * them in the other order and cut staff off from an archived class's audio,
   * while the server went on serving it — so the transport vanished and the
   * screen showed the student's own sentence, "ask your teacher if you need
   * access again", to the teacher.
   *
   * That sentence is the reason staff keep access: someone has to be able to
   * hear the recording to decide whether to turn listening back on.
   */
  if (studentUid === null) return true;
  if (!canPlayFromCourse(cls)) return false;
  return dueDate !== null && !isOverdue(dueDate, today);
}

/**
 * Which section of the student home an obligation belongs in.
 *
 *  - `done`     — completed, regardless of due date (Completed / recent history).
 *  - `missed`   — past its due date and not done. Access has closed, so this is
 *                 a final state, not a late-but-still-doable one. Called
 *                 "missed" rather than "overdue" for exactly that reason: staff
 *                 and students should not read it as work still outstanding.
 *  - `dueSoon`  — due within the next `DUE_SOON_DAYS` days (incl. today), not done.
 *  - `upcoming` — due further out than that, not done.
 *
 * `upcoming` is not one of the brief's named sections but is the honest home for
 * an obligation that is neither soon nor missed; the home orders it after
 * `dueSoon`.
 */
export type DueBucket = 'missed' | 'dueSoon' | 'upcoming' | 'done';

const BUCKET_RANK: Record<DueBucket, number> = {
  missed: 0,
  dueSoon: 1,
  upcoming: 2,
  done: 3,
};

/** Sort key for the home list: lower sorts first. */
export function bucketRank(bucket: DueBucket): number {
  return BUCKET_RANK[bucket];
}

export function dueBucket(
  item: { dueDate: string; completed: boolean },
  today: string,
): DueBucket {
  if (item.completed) return 'done';
  if (isOverdue(item.dueDate, today)) return 'missed';
  return daysUntilDue(item.dueDate, today) <= DUE_SOON_DAYS ? 'dueSoon' : 'upcoming';
}
