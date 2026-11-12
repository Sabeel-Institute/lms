import {
  closesNow,
  isOverdue,
  requiredUntil,
  unbreakableDate,
  type AssignmentDoc,
  type GivenExpectation,
  type GivenRecordingDoc,
  type RegisterFacts,
} from '@sabeel/shared';

/**
 * What staff read about a recording given to one student, and what the
 * sheet makes of a colleague's change: pure, and free of Firebase, so the
 * app's node suite tests it.
 */

export type GiveOutcome = 'opened' | 'moved' | 'reopened' | 'unchanged';

/**
 * The record as it stands, from a refusal that says someone else changed it:
 * what the sheet saw becomes this, so acting again does what was typed on
 * purpose. Undefined for any other error. Read before `errorText`, which
 * keeps only the sentence.
 */
export function changedSince(e: unknown): GivenExpectation | undefined {
  const err = e as { code?: string; details?: { current?: unknown } } | null;
  if (!err || !String(err.code ?? '').endsWith('failed-precondition')) return undefined;
  const current = err.details?.current;
  if (current === null) return null;
  const c = current as { givenAt?: unknown; openUntil?: unknown } | undefined;
  if (c && typeof c.givenAt === 'number' && typeof c.openUntil === 'string') return { givenAt: c.givenAt, openUntil: c.openUntil };
  return undefined;
}

/** Why the recording's open given recordings are closed now, as the page's other rows say it. */
export type ClosedBy = 'recording archived' | 'recording unpublished' | 'course archived' | null;

/** The facts a given recording's openness is read against, on Progress. */
interface GivenFacts {
  given: Pick<GivenRecordingDoc, 'openUntil' | 'studentUid'>;
  closedBy: ClosedBy;
  enrolled: boolean;
  /** The student's account is active: a disabled one plays nothing. */
  accountActive: boolean;
  today: string;
}

/**
 * Does it play for them right now? The one answer both the Given to row and
 * the "given until" note on the student's other row read: worked out apart,
 * the note said "given until" beside a row saying "Left the class".
 */
export function givenOpen({ given, closedBy, enrolled, accountActive, today }: GivenFacts): boolean {
  return closedBy === null && enrolled && accountActive && !isOverdue(given.openUntil, today);
}

/**
 * What a row under "Given to" says, the first that applies: closed with the
 * recording or its class; the student has left or their account is not
 * active; required now (and until when it stays open after); ended; or open
 * until its date.
 */
export function givenStatus(
  input: GivenFacts & {
    session: RegisterFacts;
    grant: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
    recordingStatus: string;
  },
): string {
  const { given, closedBy, enrolled, accountActive, session, grant, recordingStatus, today } = input;
  if (closedBy) return `Closed (${closedBy})`;
  if (!enrolled) return 'Left the class';
  if (!accountActive) return 'Account not active';
  // Dates that never break across a line, inside a sentence: see `unbreakableDate`.
  const d = unbreakableDate;
  const required = requiredUntil(given.studentUid, { session, grant, enrolled, recordingStatus, today });
  if (required) {
    return given.openUntil > required
      ? `Required until ${d(required)}, then open until ${d(given.openUntil)}`
      : `Required until ${d(required)}`;
  }
  if (!givenOpen(input)) return `Ended ${d(given.openUntil)}`;
  return `Open until ${d(given.openUntil)}`;
}

/**
 * What a give, move or reopen says once it has worked. Never a claim that
 * anything was delivered, and no promise of a message when one already went
 * today (`toldToday`, from the server): an opening sends at most one a day.
 */
export function giveResult(outcome: GiveOutcome, name: string, openUntilDate: string, today: string, toldToday = false): string {
  const tonight = openUntilDate === today ? ' It closes at midnight tonight.' : '';
  const openUntil = unbreakableDate(openUntilDate);
  switch (outcome) {
    case 'opened':
      return toldToday
        ? `Given to ${name} until ${openUntil}. It is on their To do under Optional. No message this time: they get one a day at most, and today's has gone.${tonight}`
        : `Given to ${name} until ${openUntil}. It is on their To do under Optional, with a message if their notifications are on.${tonight}`;
    case 'moved':
      return `Now open until ${openUntil}.${tonight}`;
    case 'reopened':
      return toldToday
        ? `Open again until ${openUntil}. No message this time: they get one a day at most, and today's has gone.${tonight}`
        : `Open again until ${openUntil}. They get a message if their notifications are on.${tonight}`;
    case 'unchanged':
      return `Open until ${openUntil}.${tonight}`;
  }
}

/** Up to three names, then how many more: "Aisha, Omar and 2 others". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - 3;
  return `${names.slice(0, 3).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/** Who a staff action would close a recording to right now, and their names. */
export interface WhoLosesIt {
  closes: (after?: RegisterFacts['attendance']) => string[];
  nameOf: (uid: string) => string;
}

/**
 * The data behind the confirms that ask before Archive, Unpublish or a
 * corrected register closes a recording to someone who can play it
 * (`closesNow` in @sabeel/shared). NULL WHILE ANY OF IT IS STILL ARRIVING,
 * the session's recording included: a recording not yet read and a session
 * with none both looked like "nothing", and the register confirm skipped
 * itself on a slow load and closed a recording on someone without asking.
 */
export function whoLosesIt(input: {
  session: RegisterFacts & { recordingId: string | null };
  recording: { value: { id: string; courseId: string; status: string } | null; resolved: boolean };
  roster: { studentUid: string; active: boolean }[] | null;
  students: { uid: string; displayName: string; status: string }[] | null;
  given: ReadonlyMap<string, Pick<GivenRecordingDoc, 'openUntil'>> | null;
  cls: { effectiveActive: boolean; archivedAccess: boolean };
  today: string;
}): WhoLosesIt | null {
  const { session, recording, roster, students, given, cls, today } = input;
  if (session.recordingId !== null && !recording.resolved) return null;
  const rec = recording.value;
  if (!rec) return { closes: () => [], nameOf: (uid) => uid };
  if (!roster || !students || !given) return null;
  const account = new Map(students.map((s) => [s.uid, s]));
  const people = roster.map((e) => ({
    uid: e.studentUid,
    enrolled: e.active,
    active: account.get(e.studentUid)?.status === 'active',
  }));
  return {
    closes: (after) => closesNow({ students: people, session, after, recordingStatus: rec.status, cls, given, today }),
    nameOf: (uid) => account.get(uid)?.displayName ?? uid,
  };
}
