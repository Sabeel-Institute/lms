import {
  isOverdue,
  requiredUntil,
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

/**
 * What a row under "Given to" says, the first that applies: closed with the
 * recording or its class; the student has left; required now (and until when
 * it stays open after); ended; or open until its date.
 */
export function givenStatus(input: {
  given: Pick<GivenRecordingDoc, 'openUntil' | 'studentUid'>;
  closedBy: ClosedBy;
  enrolled: boolean;
  session: RegisterFacts;
  grant: Pick<AssignmentDoc, 'active' | 'dueDate'> | null;
  recordingStatus: string;
  today: string;
}): string {
  const { given, closedBy, enrolled, session, grant, recordingStatus, today } = input;
  if (closedBy) return `Closed (${closedBy})`;
  if (!enrolled) return 'Left the class';
  const required = requiredUntil(given.studentUid, { session, grant, enrolled, recordingStatus, today });
  if (required) {
    return given.openUntil > required ? `Required until ${required}, then open until ${given.openUntil}` : `Required until ${required}`;
  }
  if (isOverdue(given.openUntil, today)) return `Ended ${given.openUntil}`;
  return `Open until ${given.openUntil}`;
}

/** What a give, move or reopen says once it has worked. Never a claim that anything was delivered. */
export function giveResult(outcome: GiveOutcome, name: string, openUntil: string, today: string): string {
  const tonight = openUntil === today ? ' It closes at midnight tonight.' : '';
  switch (outcome) {
    case 'opened':
      return `Given to ${name} until ${openUntil}. It is on their To do under Optional, with a message if their notifications are on.${tonight}`;
    case 'moved':
      return `Now open until ${openUntil}.${tonight}`;
    case 'reopened':
      return `Open again until ${openUntil}. They get a message if their notifications are on.${tonight}`;
    case 'unchanged':
      return `Open until ${openUntil}.${tonight}`;
  }
}
