import { describe, it, expect } from 'vitest';
import {
  assignmentId,
  bucketRank,
  completionId,
  addDays,
  daysUntilDue,
  dueBucket,
  hasRecordingAccess,
  canPlayNow,
  clockRangeInZone,
  isOverdue,
  stampInZone,
  unbreakableDate,
  todayInZone,
  type DueBucket,
} from '../src';

describe('composite ids', () => {
  it('key assignments and completions by student+recording', () => {
    expect(assignmentId('stu', 'rec')).toBe('stu_rec');
    expect(completionId('stu', 'rec')).toBe('stu_rec');
  });
});

describe('todayInZone', () => {
  // 2026-07-25 05:30 UTC is still 2026-07-25 00:30 in Chicago (UTC-5, CDT).
  it('returns the local calendar date', () => {
    expect(todayInZone('America/Chicago', Date.parse('2026-07-25T05:30:00Z'))).toBe('2026-07-25');
  });

  it('rolls over at LOCAL midnight, not UTC', () => {
    // 04:30 UTC on the 25th is 23:30 on the 24th in Chicago — still the 24th.
    expect(todayInZone('America/Chicago', Date.parse('2026-07-25T04:30:00Z'))).toBe('2026-07-24');
    // One hour later it has ticked over.
    expect(todayInZone('America/Chicago', Date.parse('2026-07-25T05:30:00Z'))).toBe('2026-07-25');
  });
});

describe('stampInZone', () => {
  it('reads as an ISO date and a 24-hour clock', () => {
    expect(stampInZone('America/Chicago', Date.parse('2026-09-04T18:05:00Z'))).toBe(
      '2026-09-04 13:05',
    );
  });

  /*
   * THE POINT OF THE FUNCTION. A play at 23:30 the night before a deadline is
   * inside it; rendered in a reader's own zone further east it dates to the
   * morning after, and the ledger says a student missed something they did not.
   */
  it('is the institute clock, not the reader’s', () => {
    const lateNight = Date.parse('2026-09-05T04:30:00Z');
    expect(stampInZone('America/Chicago', lateNight)).toBe('2026-09-04 23:30');
    expect(stampInZone('Asia/Karachi', lateNight)).toBe('2026-09-05 09:30');
  });

  it('pads a single-digit hour rather than dropping to a 12-hour clock', () => {
    expect(stampInZone('America/Chicago', Date.parse('2026-09-04T13:05:00Z'))).toBe(
      '2026-09-04 08:05',
    );
    // Midnight is 00, not 24 — `hourCycle: 'h23'` rather than 'h24'.
    expect(stampInZone('America/Chicago', Date.parse('2026-09-04T05:00:00Z'))).toBe(
      '2026-09-04 00:00',
    );
  });
});

describe('clockRangeInZone', () => {
  const at = (iso: string) => Date.parse(iso);

  it('writes the meridiem once when both ends share it', () => {
    // 18:02–20:18 CDT.
    expect(clockRangeInZone('America/Chicago', at('2026-10-08T23:02:00Z'), at('2026-10-09T01:18:00Z'))).toBe(
      '6:02–8:18 PM',
    );
  });

  it('writes both when the span crosses noon', () => {
    expect(clockRangeInZone('America/Chicago', at('2026-10-08T16:30:00Z'), at('2026-10-08T18:05:00Z'))).toBe(
      '11:30 AM–1:05 PM',
    );
  });

  it('calls noon 12 PM and midnight 12 AM, never 0', () => {
    expect(clockRangeInZone('America/Chicago', at('2026-10-08T17:00:00Z'), at('2026-10-08T17:45:00Z'))).toBe(
      '12:00–12:45 PM',
    );
    expect(clockRangeInZone('America/Chicago', at('2026-10-09T04:30:00Z'), at('2026-10-09T05:15:00Z'))).toBe(
      '11:30 PM–12:15 AM',
    );
  });

  it('follows the clocks going back — the same 6 pm class is an hour later in UTC', () => {
    expect(clockRangeInZone('America/Chicago', at('2026-11-12T00:00:00Z'), at('2026-11-12T01:00:00Z'))).toBe(
      '6:00–7:00 PM',
    );
  });
});

describe('daysUntilDue', () => {
  it('counts whole calendar days, signed', () => {
    expect(daysUntilDue('2026-07-25', '2026-07-24')).toBe(1);
    expect(daysUntilDue('2026-07-25', '2026-07-25')).toBe(0);
    expect(daysUntilDue('2026-07-25', '2026-07-26')).toBe(-1);
    expect(daysUntilDue('2026-08-01', '2026-07-25')).toBe(7);
  });

  it('is exact across a DST boundary (US DST ends 2026-11-01)', () => {
    expect(daysUntilDue('2026-11-02', '2026-10-31')).toBe(2);
  });
});

describe('addDays', () => {
  it('shifts a civil date forward', () => {
    expect(addDays('2026-07-25', 7)).toBe('2026-08-01');
  });
  it('crosses a month and a year end', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });
  it('is exact across a DST boundary (US DST ends 2026-11-01)', () => {
    expect(addDays('2026-10-29', 7)).toBe('2026-11-05');
  });
  it('round-trips with daysUntilDue', () => {
    expect(daysUntilDue(addDays('2026-07-25', 7), '2026-07-25')).toBe(7);
  });
});

describe('isOverdue — the due date is the LAST on-time day', () => {
  it('is not overdue on the due date itself', () => {
    expect(isOverdue('2026-07-25', '2026-07-25')).toBe(false);
  });
  it('becomes overdue the next day', () => {
    expect(isOverdue('2026-07-25', '2026-07-26')).toBe(true);
  });
  it('is not overdue before the due date', () => {
    expect(isOverdue('2026-07-25', '2026-07-20')).toBe(false);
  });
});

describe('hasRecordingAccess — the whole of a student access decision', () => {
  const OPEN = { active: true, dueDate: '2026-07-25' };

  it('opens up to and including the due date', () => {
    expect(hasRecordingAccess(OPEN, '2026-07-01')).toBe(true);
    expect(hasRecordingAccess(OPEN, '2026-07-25')).toBe(true);
  });

  it('closes the day after the due date', () => {
    expect(hasRecordingAccess(OPEN, '2026-07-26')).toBe(false);
  });

  it('an inactive grant is closed however far ahead of the due date', () => {
    expect(hasRecordingAccess({ active: false, dueDate: '2999-01-01' }, '2026-07-25')).toBe(false);
  });
});

describe('dueBucket', () => {
  const TODAY = '2026-07-25';

  it('completed wins over any due state', () => {
    expect(dueBucket({ dueDate: '2026-01-01', completed: true }, TODAY)).toBe('done');
  });

  it('past due, incomplete → missed', () => {
    expect(dueBucket({ dueDate: '2026-07-24', completed: false }, TODAY)).toBe('missed');
  });

  it('due today counts as dueSoon, not missed', () => {
    expect(dueBucket({ dueDate: '2026-07-25', completed: false }, TODAY)).toBe('dueSoon');
  });

  it('within the 7-day window → dueSoon; the 7th day is still soon', () => {
    expect(dueBucket({ dueDate: '2026-08-01', completed: false }, TODAY)).toBe('dueSoon');
  });

  it('further out than the window → upcoming', () => {
    expect(dueBucket({ dueDate: '2026-08-02', completed: false }, TODAY)).toBe('upcoming');
  });
});

describe('bucketRank orders the home', () => {
  it('missed first, done last', () => {
    const order: DueBucket[] = ['missed', 'dueSoon', 'upcoming', 'done'];
    const ranks = order.map(bucketRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(order.length);
  });
});

/*
 * THE ONE GATE BOTH VIEWS OF A SESSION ASK. The player screen and the docked
 * bar read this; the copies they used to hold had already drifted, and the drift
 * cut a manager off from anything more than a week old the moment they left the
 * player.
 */
describe('canPlayNow', () => {
  const live = { effectiveActive: true, archivedAccess: false };
  const archived = { effectiveActive: false, archivedAccess: false };
  const archivedButOpen = { effectiveActive: false, archivedAccess: true };
  const TODAY = '2026-07-25';

  it('a student may play an open recording in a live course', () => {
    expect(canPlayNow(live, '2026-07-25', 'stu-1', TODAY)).toBe(true);
  });

  it('the deadline closes it the day after the due date', () => {
    expect(canPlayNow(live, '2026-07-24', 'stu-1', TODAY)).toBe(false);
  });

  it('an archived course closes it whatever the date', () => {
    expect(canPlayNow(archived, '2026-12-31', 'stu-1', TODAY)).toBe(false);
  });

  it('an archived course that kept listening open stays open', () => {
    expect(canPlayNow(archivedButOpen, '2026-12-31', 'stu-1', TODAY)).toBe(true);
  });

  /*
   * STAFF HAVE NO DEADLINE. A session's date rides in `dueDate` for them too,
   * so a gate that read the date without checking WHOSE it is stopped a manager
   * reviewing last term's lecture — which is the bug two copies of this rule
   * produced.
   */
  it('a past due date does not close it for staff', () => {
    expect(canPlayNow(live, '2020-01-01', null, TODAY)).toBe(true);
  });

  /*
   * AND NEITHER CLOSES A CLASS TO STAFF.
   *
   * Both of a student's two closures — the deadline, and archiving with
   * listening off — are a student's. The server has always read them that way:
   * `playbackDenial` returns from its staff branch before reaching either, so a
   * class manager is served the audio for an archived course. This said the
   * opposite, and the disagreement showed up as a player with no transport and
   * the STUDENT's message on it — "ask your teacher if you need access again" —
   * shown to the teacher being asked.
   *
   * Staff keeping access is what makes that sentence answerable: somebody has to
   * hear the recording to decide whether to turn listening back on. Settled
   * 2026-09-07; see `docs/PHASE_STATUS.md`.
   */
  it('nor does an archived course with listening off', () => {
    expect(canPlayNow(archived, '2020-01-01', null, TODAY)).toBe(true);
    expect(canPlayNow(archivedButOpen, '2020-01-01', null, TODAY)).toBe(true);
  });

  /*
   * THE PROMISE: a student may play what they were granted, and nothing else.
   *
   * A student's deadline comes from their assignment, so no deadline means no
   * assignment — the absence of permission, not the absence of an expiry. This
   * case used to assert the opposite ("not closed out"), which made a green test
   * out of the one outcome `CLAUDE.md` rules out by name: "a blank one would
   * mean permanent access". A test asserting that is worse than no test, because
   * the next reader stops looking.
   *
   * Staff are the other half of the same null, and must keep playing: theirs
   * means "no deadline applies to me", which is why the two cannot share a
   * branch.
   */
  it('does not let a student play a recording they hold no grant for', () => {
    expect(canPlayNow(live, null, 'stu-1', TODAY)).toBe(false);
  });

  it('still lets staff play, whose null means no deadline of their own', () => {
    expect(canPlayNow(live, null, null, TODAY)).toBe(true);
  });
});

describe('unbreakableDate', () => {
  it('replaces every hyphen with a non-breaking one', () => {
    expect(unbreakableDate('2026-09-26')).toBe('2026\u201109\u201126');
  });

  it('renders the same characters a reader sees', () => {
    // Same length, same digits — only the break opportunities are gone.
    const out = unbreakableDate('2026-09-26');
    expect(out).toHaveLength(10);
    expect(out.replace(/\u2011/g, '-')).toBe('2026-09-26');
  });
});
