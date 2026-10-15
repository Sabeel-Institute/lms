import { todayInZone } from './assignments';
import type { AuditEntryDoc } from './audit';
import { canPlayFromCourse, deriveEffectiveActive } from './structure';
import type { CourseDoc } from './types';

/**
 * TIME KEPT AS STRETCHES: a student's in a class, and a class's recordings
 * closed to its students.
 *
 * A STUDENT'S TIME IN A CLASS, and the one answer to "were they in it then?".
 *
 * An enrolment keeps every stretch the student has spent in the class: one
 * opens when they join or come back, and closes when they leave. It kept only
 * the first joining and the LAST leaving once, so a second removal erased the
 * first: the workbooks then charged "Missed deadline" for a recording whose
 * date passed while the student was out of the class, and counted registers
 * held in their absence as "without a mark for them", while the attendance
 * report, knowing no dates at all, counted every register taken before a
 * newcomer joined or after a student left as "not marked".
 *
 * Every view that asks whether a student was in a class at some moment asks
 * it here — the attendance report, both workbooks' registers, and whether a
 * date that has gone was missed or closed — so they cannot drift apart. The
 * stretches themselves are kept and read by the helpers below them, which
 * know nothing about classes.
 */

/** A stretch of time; `to` is null while it lasts, and is the first moment after it. */
export interface Stretch {
  from: number;
  to: number | null;
}

// ------------------------------------------------------------ stretches --
// Any record kept as stretches of time: a student in a class, a class's
// recordings closed to its students.

/** Inside one of them at this moment? */
export function covers(stretches: readonly Stretch[], at: number): boolean {
  return stretches.some((s) => s.from <= at && (s.to === null || at < s.to));
}

/** Inside one of them for any part of this day (`YYYY-MM-DD` in `zone`)? */
export function coversPartOf(stretches: readonly Stretch[], day: string, zone: string): boolean {
  return stretches.some((s) => todayInZone(zone, s.from) <= day && (s.to === null || todayInZone(zone, s.to - 1) >= day));
}

/** Inside one of them at the last moment of this day: when a due date on it closed? */
export function coversEndOf(stretches: readonly Stretch[], day: string, zone: string): boolean {
  return stretches.some((s) => todayInZone(zone, s.from) <= day && (s.to === null || todayInZone(zone, s.to) > day));
}

/** A stretch opens at `at`. */
export function openStretch(stretches: readonly Stretch[], at: number): Stretch[] {
  return [...stretches, { from: at, to: null }];
}

/** The stretch that is open closes at `at`. */
export function closeStretch(stretches: readonly Stretch[], at: number): Stretch[] {
  return stretches.map((s) => (s.to === null ? { ...s, to: at } : s));
}

/**
 * Stretches that say one consistent thing: oldest first, none overlapping,
 * every one closed but the last, and the last open exactly when `open` says
 * the state they record holds now. Throws on any other; `check:documents`
 * runs it over every stored list, so a migration that wrote something else
 * is caught.
 */
export function checkStretches(stretches: readonly Stretch[], open: boolean): void {
  stretches.forEach((s, i) => {
    const last = i === stretches.length - 1;
    if (!last && s.to === null) throw new Error(`stretch ${i} is open, and is not the last`);
    if (s.to !== null && s.to < s.from) throw new Error(`stretch ${i} ends before it starts`);
    if (i > 0 && s.from < (stretches[i - 1].to as number)) throw new Error(`stretch ${i} starts before the one before it ended`);
  });
  const lastOpen = stretches.length > 0 && stretches[stretches.length - 1].to === null;
  if (lastOpen !== open) throw new Error(open ? 'no stretch is open, and one should be' : 'a stretch is open, and none should be');
}

// --------------------------------------------------------- in the class --

/** Anything that keeps a student's stretches in a class: an enrolment. */
interface Membership {
  stretches: readonly Stretch[];
}

/** In the class at this moment? */
export function inClassAt(m: Membership | undefined, at: number): boolean {
  return !!m && covers(m.stretches, at);
}

/** In the class for any part of this day (`YYYY-MM-DD` in `zone`)? */
export function inClassOn(m: Membership | undefined, day: string, zone: string): boolean {
  return !!m && coversPartOf(m.stretches, day, zone);
}

/**
 * Still in the class when this day ran out: when a due date on it closed.
 * A student out of the class at that moment had the date pass while they
 * could not open the recording, which is Closed, never Missed.
 */
export function inClassWhenDayEnds(m: Membership | undefined, day: string, zone: string): boolean {
  return !!m && coversEndOf(m.stretches, day, zone);
}

/** An enrolment's stretches tell one story: at least one, the last open exactly while it is active. */
export function checkEnrolmentStretches(e: { stretches: readonly Stretch[]; active: boolean }): void {
  if (e.stretches.length === 0) throw new Error('an enrolment with no stretch in its class');
  checkStretches(e.stretches, e.active);
}

/**
 * Should this register hold a mark for them?
 *
 * Only if they were in the class on the session's day, and — once it has
 * been taken — on the roster when it was: the register lists the class as it
 * stands when it is taken, so a student out of the class then could not have
 * been marked on it, and a newcomer added after a class met was not there to
 * mark. A mark that IS on a register counts whatever this says: a newcomer is
 * caught up by being marked on an earlier session's register.
 */
export function registerExpects(
  m: Membership | undefined,
  session: { date: string; attendanceSubmittedAt: number | null },
  zone: string,
): boolean {
  return (
    inClassOn(m, session.date, zone) &&
    (session.attendanceSubmittedAt === null || inClassAt(m, session.attendanceSubmittedAt))
  );
}

/** The day they first joined. */
export function joinedOn(m: Membership | undefined, zone: string): string | null {
  const first = m?.stretches[0];
  return first ? todayInZone(zone, first.from) : null;
}

/** The day they last left, while they are out of the class; null while they are in it. */
export function leftOn(m: Membership | undefined, zone: string): string | null {
  const last = m?.stretches[m.stretches.length - 1];
  return last && last.to !== null ? todayInZone(zone, last.to) : null;
}

/** The times they were out of the class and came back, as days. */
export function timesAway(m: Membership | undefined, zone: string): { left: string; back: string }[] {
  const s = m?.stretches ?? [];
  return s.slice(1).map((next, i) => ({ left: todayInZone(zone, s[i].to ?? next.from), back: todayInZone(zone, next.from) }));
}

// -------------------------------------------------- recordings closed --

/**
 * The class's `recordingsClosed` after a change that may open or close its
 * recordings to students: a stretch opens, at `at`, when they stop being
 * playable, and closes when they can be played again. Every writer of
 * `effectiveActive` or `archivedAccess` writes this beside them.
 */
export function recordingsClosedAfter(
  before: Pick<CourseDoc, 'effectiveActive' | 'archivedAccess' | 'recordingsClosed'>,
  after: { effectiveActive: boolean; archivedAccess: boolean },
  at: number,
): Stretch[] {
  const was = canPlayFromCourse(before);
  const now = canPlayFromCourse(after);
  if (was === now) return [...before.recordingsClosed];
  return now ? closeStretch(before.recordingsClosed, at) : openStretch(before.recordingsClosed, at);
}

/**
 * A class's `recordingsClosed`, rebuilt from the audit log: the migration
 * for classes written before they kept it.
 *
 * `history` is the log's `updateCourse` rows for this class and
 * `setCohortArchived` rows for its cohort, any order; their `detail` says
 * which flags moved. The class starts running with access off, inside a
 * cohort that stood as its first row turned it from (or as it stands now,
 * if no row moved it). A row written before the detail was recorded says
 * nothing and is passed over. The stored flags win at the end: when the log
 * does not arrive at them, the last stretch opens or closes at the last row
 * (or at creation), and `inferred` says so.
 */
export function recordingsClosedFromHistory(
  course: Pick<CourseDoc, 'createdAt' | 'effectiveActive' | 'archivedAccess'> & { cohortArchived: boolean },
  history: readonly Pick<AuditEntryDoc, 'at' | 'action' | 'detail'>[],
): { recordingsClosed: Stretch[]; inferred: boolean } {
  const rows = [...history].filter((r) => r.at >= course.createdAt).sort((a, b) => a.at - b.at);
  const firstCohortRow = rows.find((r) => r.action === 'setCohortArchived' && typeof r.detail?.archived === 'boolean');
  let cohortArchived = firstCohortRow ? !firstCohortRow.detail?.archived : course.cohortArchived;
  let archived = false;
  let access = false;
  const playable = () => canPlayFromCourse({ effectiveActive: deriveEffectiveActive(cohortArchived, archived), archivedAccess: access });
  let closed: Stretch[] = playable() ? [] : [{ from: course.createdAt, to: null }];
  for (const r of rows) {
    const was = playable();
    const d = r.detail ?? {};
    if (r.action === 'setCohortArchived' && typeof d.archived === 'boolean') cohortArchived = d.archived;
    if (r.action === 'updateCourse' && typeof d.archived === 'boolean') archived = d.archived;
    if (r.action === 'updateCourse' && typeof d.archivedAccess === 'boolean') access = d.archivedAccess;
    const now = playable();
    if (was !== now) closed = now ? closeStretch(closed, r.at) : openStretch(closed, r.at);
  }
  if (playable() === canPlayFromCourse(course)) return { recordingsClosed: closed, inferred: false };
  const at = rows.length ? rows[rows.length - 1].at : course.createdAt;
  return { recordingsClosed: canPlayFromCourse(course) ? closeStretch(closed, at) : openStretch(closed, at), inferred: true };
}

// ------------------------------------------- enrolments, from the log --

/** Two rows this close, with no direction recorded, are one tap twice. */
const SAME_TAP_MS = 60_000;

/**
 * An enrolment's stretches, rebuilt from the audit log: the migration for
 * enrolments written when they kept only `enrolledAt` (the first joining,
 * kept across returns) and `unenrolledAt` (the last leaving).
 *
 * `history` is the log's rows for this student in this class, any order.
 * `createEnrollment` and `createStudent` (an account made straight into a
 * class) join; `setEnrollmentActive` leaves or comes back as its
 * `detail.active` says — and a row written before that was recorded turns
 * the enrolment round, which is all it can have done (a repeat within a
 * minute is the same tap twice). The enrolment's own fields win where the
 * log falls short: the first stretch starts at `enrolledAt`, a student out
 * of the class left at `unenrolledAt`, and one in it has an open stretch.
 * `inferred` says when the log and the fields disagreed: a return the log
 * does not hold is taken to have followed the last leaving at once.
 */
export function stretchesFromHistory(
  enrolment: { active: boolean; enrolledAt: number; unenrolledAt?: number },
  history: readonly Pick<AuditEntryDoc, 'at' | 'action' | 'detail'>[],
): { stretches: Stretch[]; inferred: boolean } {
  let stretches: Stretch[] = [{ from: enrolment.enrolledAt, to: null }];
  const open = () => stretches[stretches.length - 1].to === null;
  let lastToggle = -Infinity;
  for (const row of [...history].sort((a, b) => a.at - b.at)) {
    if (row.at < enrolment.enrolledAt) continue;
    const said = row.detail?.active;
    const join =
      row.action === 'createEnrollment' || row.action === 'createStudent'
        ? true
        : row.action === 'setEnrollmentActive'
          ? typeof said === 'boolean'
            ? said
            : row.at - lastToggle <= SAME_TAP_MS
              ? null
              : !open()
          : null;
    if (row.action === 'setEnrollmentActive' && typeof said !== 'boolean') lastToggle = row.at;
    if (join === true && !open()) stretches = openStretch(stretches, row.at);
    if (join === false && open()) stretches = closeStretch(stretches, row.at);
  }

  let inferred = false;
  const last = stretches[stretches.length - 1];
  if (!enrolment.active) {
    // The stored leaving is the last one, and it is the record. A leaving the
    // log does not hold (an account deleted takes its student out of every
    // class without a row per class) is simply taken from it.
    const left = enrolment.unenrolledAt ?? last.to ?? last.from;
    const kept = stretches.filter((s, i) => i === 0 || s.from <= left);
    if (kept.length !== stretches.length || (last.to !== null && Math.abs(last.to - left) > SAME_TAP_MS)) inferred = true;
    const end = kept[kept.length - 1];
    stretches = [...kept.slice(0, -1), { ...end, to: Math.max(end.from, left) }];
  } else if (last.to !== null) {
    inferred = true;
    stretches = [...stretches.slice(0, -1), { ...last, to: null }];
  }
  return { stretches, inferred };
}
