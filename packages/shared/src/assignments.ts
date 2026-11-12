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
 * One formatter per shape and timezone, built on first use and kept.
 *
 * Building an `Intl.DateTimeFormat` is the expensive part of using one, and on
 * Hermes markedly so. The Zoom picker dates every row it filters and prints
 * the hours of every card on each render — each keystroke in its search box —
 * so building them per call would cost hundreds a keystroke. Formatting with a
 * built one is cheap.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(shape: 'date' | 'clock', timeZone: string): Intl.DateTimeFormat {
  const key = `${shape} ${timeZone}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(
      'en-CA',
      shape === 'date'
        ? { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
        : {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          },
    );
    formatters.set(key, f);
  }
  return f;
}

/**
 * Today's calendar date in a timezone, as `YYYY-MM-DD`.
 *
 * `en-CA` formats as ISO `YYYY-MM-DD`, and `timeZone` makes the rollover happen
 * at local midnight — so at 11pm Houston time on the 24th this returns
 * `...-24`, not the 25th that UTC would give. No date library needed.
 */
export function todayInZone(timeZone: string, now: number = Date.now()): string {
  return formatterFor('date', timeZone).format(new Date(now));
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
  const parts = formatterFor('clock', timeZone).formatToParts(new Date(ms));
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
   * What the student plays under (`listenWindow`), read live; null for staff,
   * and for a student whose reads have not all answered, which the callers do
   * not ask about: "not read yet" must never be taken for "nothing held".
   */
  window: ListenWindow | null,
  /** Null when staff are listening — see `NowPlaying.studentUid`. */
  studentUid: string | null,
): boolean {
  /*
   * STAFF FIRST, AND BEFORE THE COURSE CHECK.
   *
   * Both ways a student's access ends — their dates, and archiving a class with
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
  // A student plays under an open window and nothing else: no window is no
  // permission, never permission with no expiry.
  return window?.state === 'open';
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

// ------------------------------------------------------ given recordings --

/**
 * One recording staff opened to one student until a date: optional, and
 * counted nowhere.
 *
 * The other way a student can play a recording, beside being excused, and
 * deliberately the lesser: it requires nothing, so there is no Mark complete,
 * no Missed and no reminder, and the ledger, the workbooks and the stats never
 * read it. Being excused stays the only thing that makes listening required.
 *
 * NO `active` FLAG. Whether it plays is worked out when it is read, from its
 * date, the student's enrolment, the recording's status and the class's
 * setting, so nothing has to be kept in step with any of them and the
 * attendance reconcile never touches this collection. Leaving the class,
 * unpublishing and archiving close it; undoing them opens it again while its
 * date is good.
 *
 * Document id is `${studentUid}_${recordingId}`: at most one per student per
 * recording. Written only by `giveRecording` and `takeBackRecording`; a
 * student reads their own, staff of the class read the class's.
 */
export interface GivenRecordingDoc {
  studentUid: string;
  recordingId: string;
  /** The recording's class, which never changes: rules and staff queries scope on it. */
  courseId: string;
  /** `YYYY-MM-DD` in the institute timezone: the last day it plays. */
  openUntil: string;
  /**
   * When it was last opened: a give, or a new date on one that had ended.
   * Moving the date of an open one keeps it, which is how the message trigger
   * tells an opening (one message) from a move (none).
   */
  givenAt: number;
  /** Who made that opening. */
  givenBy: string;
}

export function givenRecordingId(studentUid: string, recordingId: string): string {
  return `${studentUid}_${recordingId}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date that exists. The shape alone let `2026-99-99` through: a
 * string compare then kept it "open" until 2027, the day count came out `NaN`
 * (bucketed as upcoming), and the last-day sweep never matched it. Round-trip
 * through the UTC calendar and require the same text back.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The facts about a session that decide who is required to listen to its recording. */
export interface RegisterFacts {
  attendanceSubmittedAt: number | null;
  attendance: Record<string, 'present' | 'absent' | 'excused'>;
  dueDate: string;
}

/**
 * Until when is this student REQUIRED to listen, as of `today`? Null when they
 * are not.
 *
 * The reconcile's own test, read from the SESSION as well as the grant,
 * because the grant follows a submitted register by a few seconds: in that
 * gap the session already says excused and the grant does not exist yet. A
 * check of the grant alone let a teacher give a recording to a student the
 * register had just made required, so the student was told "it is not
 * required" moments before being told it was.
 */
export function requiredUntil(
  studentUid: string,
  facts: {
    session: RegisterFacts;
    grant: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
    enrolled: boolean;
    recordingStatus: string;
    today: string;
  },
): string | null {
  const { session, grant, enrolled, recordingStatus, today } = facts;
  if (grant?.active && !isOverdue(grant.dueDate, today)) return grant.dueDate;
  const excused =
    session.attendanceSubmittedAt !== null &&
    session.attendance[studentUid] === 'excused' &&
    enrolled &&
    recordingStatus === 'published' &&
    !isOverdue(session.dueDate, today);
  return excused ? session.dueDate : null;
}

/** What a give call does to the record it finds. */
export type GiveAction = 'give' | 'move' | 'reopen';

export function giveAction(given: Pick<GivenRecordingDoc, 'openUntil'> | null, today: string): GiveAction {
  if (!given) return 'give';
  return isOverdue(given.openUntil, today) ? 'reopen' : 'move';
}

/**
 * Why this recording cannot be given (or its date changed) as asked, in the
 * sentence the person is shown; null when it can.
 *
 * ONE FUNCTION FOR THE SHEET AND THE SERVER. The sheet hides Save and shows
 * this sentence in its place; the callable throws the same sentence. Two
 * spellings of these conditions would let the sheet offer a Save the server
 * refuses, or hide one it would take.
 *
 * `fromPlus` is a call made from the give list (no record expected), as
 * against a row's own sheet. Moving an open one is allowed while the student
 * is required (given first, then excused): only an opening is refused then.
 */
export function giveRefusal(input: {
  studentUid: string;
  openUntil: string | null;
  today: string;
  session: RegisterFacts;
  recordingStatus: string;
  cls: { effectiveActive: boolean; archivedAccess: boolean };
  enrolled: boolean;
  grant: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
  given: Pick<GivenRecordingDoc, 'openUntil'> | null;
  fromPlus: boolean;
}): string | null {
  const { studentUid, openUntil, today, session, recordingStatus, cls, enrolled, grant, given, fromPlus } = input;
  if (session.attendanceSubmittedAt === null) return 'Take attendance for this session first.';
  if (recordingStatus !== 'published') return 'Only a published recording can be given.';
  if (!canPlayFromCourse(cls)) return 'This class is archived and its recordings are closed.';
  if (!enrolled) return 'That student is not in this class.';
  if (fromPlus && given) return 'It has already been given to them. Change it from their row.';
  if (!openUntil || !isCalendarDate(openUntil)) return 'Choose the last day it stays open.';
  if (isOverdue(openUntil, today)) return 'That date has passed. Choose today or a later day.';
  if (giveAction(given, today) !== 'move') {
    const until = requiredUntil(studentUid, { session, grant, enrolled, recordingStatus, today });
    if (until) return `It is required for them until ${until}. It can be given after that.`;
  }
  return null;
}

/** What a caller saw of a row when it acted: nothing (the give list), or the record as shown. */
export type GivenExpectation = Pick<GivenRecordingDoc, 'givenAt' | 'openUntil'> | null;

/**
 * Has the record changed since the caller's sheet opened? The sentence that
 * says what changed, or null when it is as they saw it.
 *
 * Any teacher of the class may change or take back a given recording,
 * whoever gave it; this is only for two people acting on the same row at
 * once, so the second never silently undoes the first. `expect` is frozen
 * when the sheet opens: read from the live row at the moment of saving, it
 * would follow a colleague's change within a second and overwrite it. The
 * refusal carries the current record, which becomes what the sheet saw, so
 * acting again does what was typed, on purpose.
 *
 * Not stale, so never refused: from the give list (`expect` null) a record
 * that exists is already given, which `giveRefusal` says; a take back that
 * finds nothing is simply done. A save of the date already stored is
 * `unchanged`, which the callable decides before asking this.
 */
export function givenChanged(
  expect: GivenExpectation,
  current: Pick<GivenRecordingDoc, 'givenAt' | 'openUntil'> | null,
  act: 'save' | 'takeBack',
): string | null {
  if (expect === null) return null;
  if (!current) {
    return act === 'takeBack' ? null : 'Someone else took it back just now. Give it again with the plus if they still need it.';
  }
  if (current.givenAt === expect.givenAt && current.openUntil === expect.openUntil) return null;
  const again = act === 'takeBack' ? 'Take back again to take it back anyway.' : 'Save again to use yours.';
  return `Someone else changed the date to ${current.openUntil} just now. ${again}`;
}

/**
 * Whether a student may play a recording right now, and on what terms: the
 * one answer the player, the docked bar, To do and `getPlaybackUrl` all read.
 *
 *  - `open`, required: an excused grant whose date has not passed. `then` is
 *    a given date running later, when it stays open but optional.
 *  - `open`, optional: a given recording whose date has not passed, for an
 *    enrolled student. `listenByWas` is the excused date already passed, for
 *    a student who missed it ("listening now does not change your record").
 *  - `ended`: they held something and its date has passed. `lastDay` is the
 *    LATER of the dates held, so the midnight play-on lets the file finish on
 *    the day that actually closes it; `record` says the excused record stands.
 *  - `none`: nothing to play under.
 *
 * Enrolment is read only for the given arm: an excused grant is deactivated
 * on leaving the class, so it already carries that answer. The recording's
 * status and the class's setting are not here: the rules and `canPlayNow` own
 * those.
 */
export type ListenWindow =
  | { state: 'open'; required: true; until: string; then: string | null }
  | { state: 'open'; required: false; until: string; listenByWas: string | null }
  | { state: 'ended'; lastDay: string; record: boolean }
  | { state: 'none' };

export function listenWindow(
  grant: Pick<AssignmentDoc, 'active' | 'dueDate'> | null,
  given: Pick<GivenRecordingDoc, 'openUntil'> | null,
  enrolled: boolean,
  today: string,
): ListenWindow {
  const held = grant?.active ? grant : null;
  const own = given && enrolled ? given : null;
  if (held && !isOverdue(held.dueDate, today)) {
    return { state: 'open', required: true, until: held.dueDate, then: own && own.openUntil > held.dueDate ? own.openUntil : null };
  }
  if (own && !isOverdue(own.openUntil, today)) {
    return { state: 'open', required: false, until: own.openUntil, listenByWas: held ? held.dueDate : null };
  }
  if (held || own) {
    const lastDay = [held?.dueDate ?? '', own?.openUntil ?? ''].sort().at(-1) as string;
    return { state: 'ended', lastDay, record: held !== null };
  }
  return { state: 'none' };
}

/** The last day this window plays: the day its midnight closes it. Null when it never opened. */
export function windowLastDay(window: ListenWindow): string | null {
  switch (window.state) {
    case 'open':
      return window.required ? (window.then ?? window.until) : window.until;
    case 'ended':
      return window.lastDay;
    case 'none':
      return null;
  }
}

/**
 * Is Mark complete offered? Only while listening is required and open: a
 * given recording requires nothing, and a missed one stays missed.
 */
export function completionShown(window: ListenWindow): boolean {
  return window.state === 'open' && window.required;
}

/**
 * WHO WOULD LOSE A RECORDING THEY CAN PLAY RIGHT NOW, if staff go ahead: the
 * students a confirm names before Archive, Unpublish, or a corrected register
 * closes it at once (`docs/plans/GIVE-A-RECORDING.md`, "Closing at once").
 *
 * "Can play it" is the student's window open, as `canPlayNow` reads it, for
 * an active account in the class. The excused side is read from the SESSION
 * (`requiredUntil`), so a register submitted a second ago counts before its
 * grants exist. A student also holding it given, and open, keeps it through a
 * corrected register, so is not named; archiving or unpublishing closes both,
 * so everyone who can play it is.
 *
 * `after` is the register as it would be submitted; absent, the recording
 * itself is what closes.
 */
export function closesNow(input: {
  students: { uid: string; enrolled: boolean; active: boolean }[];
  session: RegisterFacts;
  after?: Record<string, 'present' | 'absent' | 'excused'>;
  recordingStatus: string;
  cls: { effectiveActive: boolean; archivedAccess: boolean };
  given: ReadonlyMap<string, Pick<GivenRecordingDoc, 'openUntil'>>;
  today: string;
}): string[] {
  const { students, session, after, recordingStatus, cls, given, today } = input;
  if (recordingStatus !== 'published' || !canPlayFromCourse(cls)) return [];
  const canPlay = (uid: string, enrolled: boolean, register: RegisterFacts) => {
    const until = requiredUntil(uid, { session: register, grant: null, enrolled, recordingStatus, today });
    const grant = until ? { active: true, dueDate: until } : null;
    return canPlayNow(cls, listenWindow(grant, given.get(uid) ?? null, enrolled, today), uid);
  };
  const next: RegisterFacts | null = after ? { ...session, attendance: after } : null;
  return students
    .filter((s) => s.active && s.enrolled && canPlay(s.uid, s.enrolled, session))
    .filter((s) => (next ? !canPlay(s.uid, s.enrolled, next) : true))
    .map((s) => s.uid);
}
