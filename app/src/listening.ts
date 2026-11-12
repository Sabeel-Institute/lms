import { completionShown, unbreakableDate, type ListenWindow } from '@sabeel/shared';
import { playingSinceItsDay } from './instituteDay';

/**
 * What a student's player and docked bar decide from their listening window
 * (`listenWindow` in @sabeel/shared): pure, so each state is tested on its own
 * rather than read off a screen. Several of these decisions once lived inline
 * in the player and the bar, each a slightly different copy, and the states
 * nobody enumerated (playing on past midnight, a class archived before the
 * date) went wrong there unseen.
 */

/** The reads a student's window was worked out from, as far as these decisions need them. */
export interface HeldGrant {
  grant: { active: boolean; dueDate: string } | null;
}

/**
 * MAY IT PLAY ON PAST THE MIDNIGHT THAT CLOSED IT? Only when that midnight is
 * what closed it: the window had this same last day while it was open, and the
 * file has been playing since before that day ended.
 *
 * `openLastDay` is the last day the window had while it was open (see
 * `rememberedOpenDay`). A window that ended because its last day SHRANK, a given
 * date taken back while it played on past an excused midnight, has a different
 * one, and is staff taking it away, which stops it at once.
 */
export function playsOn(window: ListenWindow | null, openLastDay: string | null, playingSince: number | null): boolean {
  if (window?.state !== 'ended') return false;
  return openLastDay === window.lastDay && playingSinceItsDay(playingSince, window.lastDay);
}

/**
 * Was it the excused date that closed it? The excused record stands then, and
 * the closing sentence is the excused one.
 */
function excusedClosedIt(window: ListenWindow | null, reads: HeldGrant | null): boolean {
  return window?.state === 'ended' && window.record && reads?.grant?.dueDate === window.lastDay;
}

/**
 * STILL REQUIRED WHILE IT FINISHES: the file has been playing since before the
 * excused date ended, under a grant that stands. Asked of the excused date
 * itself, not of the window: given until a later date, the window stays open
 * (and optional) past the excused midnight, and a test of "the window ended"
 * took Mark complete away mid-file from a student who held both.
 */
export function requiredPlaysOn(reads: HeldGrant | null, playingThis: boolean, playingSince: number | null): boolean {
  const grant = reads?.grant;
  return !!grant?.active && playingThis && playingSinceItsDay(playingSince, grant.dueDate);
}

/**
 * Is Mark complete offered? While listening is required and open; and while a
 * required recording finishes past its excused midnight (`requiredPlaysOn`),
 * as before that midnight, so it is never called optional while it finishes.
 */
export function markShown(window: ListenWindow | null, stillRequired: boolean): boolean {
  if (!window) return false;
  return completionShown(window) || stillRequired;
}

/**
 * Does the closed screen show "Your record"? Whenever the student holds an
 * excused grant: closed by its date, by a class archived before the date, or by
 * a given date that ran out after it. One only given was never required, so has
 * no record.
 */
export function recordShown(reads: HeldGrant | null): boolean {
  return !!reads?.grant?.active;
}

/**
 * Why a student cannot play this, in the sentence that says what to do about
 * it: the class closed, nothing held, an excused date passed, or a given date
 * passed.
 */
export function closedSentence(classOpen: boolean, window: ListenWindow | null, reads: HeldGrant | null): string {
  if (!classOpen) {
    return recordShown(reads)
      ? 'This course has been archived and its recordings are closed. Your record is kept — ask your teacher if you need access again.'
      : 'This course has been archived and its recordings are closed. Ask your teacher if you need access again.';
  }
  if (window?.state !== 'ended') return 'This recording is not open to you. Ask your teacher if you need it.';
  return excusedClosedIt(window, reads)
    ? `This recording closed on ${window.lastDay}. Your record is kept — ask your teacher if you need it reopened.`
    : `This recording was open to you until ${window.lastDay}. Ask your teacher if you need it again.`;
}

/**
 * The date line under the title: for staff the session's due date; for a
 * student, until when it is open, and, when a given date runs past a required
 * one, both — the day it is required by, then the day it stays open until.
 */
export function dateLine(studentUid: string | null, window: ListenWindow | null, dueDate: string | null, verb: string): string | null {
  if (studentUid === null) return dueDate ? `due\u00A0${unbreakableDate(dueDate)}` : null;
  if (window?.state !== 'open') return null;
  if (window.required && window.then) {
    return `${verb.toLowerCase()} by\u00A0${unbreakableDate(window.until)} · open until\u00A0${unbreakableDate(window.then)}`;
  }
  return `${window.required ? 'available' : 'open'} until\u00A0${unbreakableDate(window.until)}`;
}
