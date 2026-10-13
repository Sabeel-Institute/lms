import { describe, expect, it } from 'vitest';
import { KIND_ORDER, buildTodayQueue, queueScope } from './todayQueue';
import { DUE_SOON_DAYS, type CourseworkDoc, type GradeDoc, type RecordingDoc, type SessionDoc, type SubmissionDoc } from '@sabeel/shared';

/**
 * The staff work queue's derivation.
 *
 * Everything this screen is lives in one pure function: which sessions become
 * work, which of that work is BLOCKING (the number on the tab badge), what order
 * it comes in, and which of three sentences an empty result produces. None of it
 * had a test — the sweep photographs whatever the seeded world happens to
 * contain, which is a handful of the cases below and none of the edges.
 *
 * `today` is fixed at 2026-09-06 throughout; every date is written relative to
 * it in the helpers.
 */
const TODAY = '2026-09-06';
const COURSE = 'c1';

const day = (offset: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

function session(
  id: string,
  opts: Partial<SessionDoc> & { metDaysAgo?: number; dueInDays?: number } = {},
): SessionDoc & { id: string } {
  const { metDaysAgo = 3, dueInDays = 14, ...rest } = opts;
  return {
    id,
    courseId: COURSE,
    cohortId: 'co1',
    date: day(-metDaysAgo),
    title: id,
    dueDate: day(dueInDays),
    notes: '',
    recordingId: null,
    attendance: {},
    attendanceSubmittedAt: 1,
    notRecorded: false,
    createdAt: 1,
    createdBy: 'admin',
    updatedAt: 1,
    ...rest,
  } as SessionDoc & { id: string };
}

function recording(
  id: string,
  status: RecordingDoc['status'],
): RecordingDoc & { id: string } {
  return {
    id,
    sessionId: 's',
    courseId: COURSE,
    cohortId: 'co1',
    title: id,
    notes: '',
    date: TODAY,
    status,
    source: 'manual',
    media: {},
    defaultVersion: 'audio',
    durationSec: null,
    createdAt: 1,
    createdBy: 'admin',
    updatedAt: 1,
  } as RecordingDoc & { id: string };
}

function coursework(id: string, over: Partial<CourseworkDoc> = {}): CourseworkDoc & { id: string } {
  return {
    id,
    courseId: COURSE,
    cohortId: 'co1',
    title: id,
    instructions: '',
    files: {},
    dueDate: day(-1),
    lateUntil: day(6),
    grading: { kind: 'points', outOf: 10 },
    status: 'posted',
    closedAt: null,
    postedAt: 1,
    postedBy: 'admin',
    createdAt: 1,
    createdBy: 'admin',
    updatedAt: 1,
    editedAt: null,
    ...over,
  };
}

/** Work handed in on `onDay`, by student `uid`. */
const handedIn = (uid: string, cwId: string, onDay: string): SubmissionDoc =>
  ({ studentUid: uid, courseworkId: cwId, courseId: COURSE, state: 'handedIn', dueDate: day(-1), handedInAt: Date.parse(`${onDay}T17:00:00Z`) }) as SubmissionDoc;
const graded = (uid: string, cwId: string): GradeDoc =>
  ({ studentUid: uid, courseworkId: cwId, courseId: COURSE, grade: { points: 8 }, feedback: '', gradedBy: 't', gradedAt: 1, withoutHandIn: false });

const build = (
  sessions: (SessionDoc & { id: string })[],
  recordings: (RecordingDoc & { id: string })[] = [],
  over: Partial<Parameters<typeof buildTodayQueue>[0]> = {},
) =>
  buildTodayQueue({
    courses: [{ id: COURSE, name: 'Hikam Foundations' }],
    sessions,
    recordings: new Map(recordings.map((r) => [r.id, r])),
    scope: [COURSE],
    today: TODAY,
    failed: false,
    settled: true,
    truncated: false,
    ...over,
  });

describe('what becomes work', () => {
  it('a met session with no attendance is the top of the queue', () => {
    const q = build([session('s1', { attendanceSubmittedAt: null, metDaysAgo: 3 })]);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].kind).toBe('attendance');
    expect(q.items[0].detail).toBe('Met 3 days ago.');
  });

  it('says "today" rather than "0 days ago"', () => {
    const q = build([session('s1', { attendanceSubmittedAt: null, metDaysAgo: 0 })]);
    expect(q.items[0].detail).toBe('Met today.');
  });

  it('a session that has NOT met yet is not work', () => {
    const q = build([session('s1', { attendanceSubmittedAt: null, metDaysAgo: -2 })]);
    expect(q.items).toHaveLength(0);
  });

  it('attendance in and no recording asks for the audio', () => {
    const q = build([session('s1')]);
    expect(q.items[0].kind).toBe('recording');
    expect(q.items[0].recordingId).toBeNull();
    // The row says when the class met; its heading says what is missing.
    expect(q.items[0].detail).toBe('Met 3 days ago.');
  });

  /*
   * A SESSION STILL TO COME does not need its audio yet, and the guard saying so
   * had no test that reached it: the only future-dated fixture also had no
   * attendance, so it returned two branches earlier and the missing-recording
   * branch was never entered with a future date at all.
   */
  it('a session still to come is not asked for its audio', () => {
    const q = build([session('s1', { metDaysAgo: -2 })]);
    expect(q.items).toHaveLength(0);
  });

  /*
   * THE ONE EXIT FROM A CARD THAT OTHERWISE NEVER LEAVES.
   *
   * A class that met and was never recorded raises "no recording yet", and that
   * card has no expiry — unlike the publish row, which retires at the listen-by
   * date. Marking the session as not recorded is what clears it, and the same
   * flag stops the morning reminder. The control belongs to whoever runs the
   * class; this is the whole of its effect here.
   *
   * ASSERTED AGAINST ITS OWN CONTROL: the identical session without the flag
   * DOES raise work, so an empty queue cannot pass because the fixture was
   * uninteresting.
   */
  it('a session marked as not recorded is not work at all', () => {
    const fields = { attendanceSubmittedAt: null };
    expect(build([session('s1', { ...fields, notRecorded: true })]).items).toHaveLength(0);
    expect(build([session('s1', fields)]).items.length).toBeGreaterThan(0);
  });

  it('a published recording well inside its deadline is not work', () => {
    const q = build(
      [session('s1', { recordingId: 'r1', dueInDays: 30 })],
      [recording('r1', 'published')],
    );
    expect(q.items).toHaveLength(0);
  });

  it('a published recording closing this week is work', () => {
    const q = build(
      [session('s1', { recordingId: 'r1', dueInDays: 2 })],
      [recording('r1', 'published')],
    );
    expect(q.items[0].kind).toBe('closing');
    expect(q.items[0].detail).toBe('Access closes in 2 days.');
  });

  /*
   * THE WINDOW ITSELF, at both edges — the one thing the fixtures around it
   * could not pin.
   *
   * Every other "closing soon" case here uses a day comfortably inside or
   * outside the week, so `left <= DUE_SOON_DAYS` could become `left <` — or the
   * constant could become anything from 6 to 29 — with all of them still green.
   * The shared copy of the same seven days IS pinned exactly
   * (`packages/shared/test/assignments.test.ts`), which left this the free one.
   */
  it('includes the last day of the window and excludes the first day outside it', () => {
    const inside = build(
      [session('s1', { recordingId: 'r1', dueInDays: DUE_SOON_DAYS })],
      [recording('r1', 'published')],
    );
    expect(inside.items.map((i) => i.kind)).toEqual(['closing']);

    const outside = build(
      [session('s1', { recordingId: 'r1', dueInDays: DUE_SOON_DAYS + 1 })],
      [recording('r1', 'published')],
    );
    expect(outside.items).toHaveLength(0);
  });

  it('a deadline already past is not work — nothing can be done about it', () => {
    const q = build(
      [session('s1', { recordingId: 'r1', dueInDays: -1 })],
      [recording('r1', 'published')],
    );
    expect(q.items).toHaveLength(0);
  });

  it('a recording id with no recording behind it asks for the audio', () => {
    const q = build([session('s1', { recordingId: 'gone' })], []);
    expect(q.items[0].kind).toBe('recording');
  });
});

/*
 * THE BADGE COUNTS WHAT IS BLOCKING ACCESS, WHICH IS NOT THE SAME AS WHAT IS
 * WAITING. A draft is work; nobody was promised it, so nobody is locked out of
 * it. An unpublished recording is the opposite — every excused student HAD it
 * and now does not.
 */
describe('what the badge counts', () => {
  it('counts an un-taken register', () => {
    const q = build([session('s1', { attendanceSubmittedAt: null })]);
    expect(q.blocking).toBe(1);
  });

  it('counts an unpublished recording, because it revoked access', () => {
    const q = build(
      [session('s1', { recordingId: 'r1' })],
      [recording('r1', 'unpublished')],
    );
    expect(q.items[0].kind).toBe('publish');
    expect(q.items[0].detail).toBe('Unpublished, so nobody excused can open it.');
    expect(q.blocking).toBe(1);
  });

  it('does NOT count a draft, which has granted nothing yet', () => {
    const q = build([session('s1', { recordingId: 'r1' })], [recording('r1', 'draft')]);
    expect(q.items[0].kind).toBe('publish');
    expect(q.blocking).toBe(0);
  });

  /*
   * ARCHIVING REVOKES EXACTLY AS UNPUBLISHING DOES — the fan-out reads
   * `status === 'published'` and nothing else — so while students are still
   * accountable it is a lockout, and after the deadline it is filing.
   */
  it('counts a recording archived while its listen-by date is still open', () => {
    const q = build(
      [session('s1', { recordingId: 'r1', dueInDays: 5 })],
      [recording('r1', 'archived')],
    );
    expect(q.items[0].kind).toBe('publish');
    expect(q.items[0].detail).toBe(
      'Archived before its due date, so nobody excused can open it.',
    );
    expect(q.blocking).toBe(1);
  });

  /*
   * AND NOTHING ABOUT ANY OF THEM ONCE THE DATE HAS GONE. The server refuses to
   * publish past the listen-by date, so the row's own action would fail; nobody
   * is locked out of anything they could still use; and a badge that never
   * reaches zero is one people learn to ignore.
   */
  it.each(['archived', 'unpublished', 'draft', 'needsAttention'] as const)(
    'says nothing about a %s recording once the deadline has passed',
    (status) => {
      const q = build(
        [session('s1', { recordingId: 'r1', dueInDays: -1 })],
        [recording('r1', status)],
      );
      expect(q.items).toHaveLength(0);
      expect(q.blocking).toBe(0);
    },
  );

  it('does not count an import that needs attention', () => {
    const q = build(
      [session('s1', { recordingId: 'r1' })],
      [recording('r1', 'needsAttention')],
    );
    expect(q.items[0].detail).toBe('The import needs attention before it can be published.');
    expect(q.blocking).toBe(0);
  });

  /*
   * A MISSING RECORDING IS WORK, NOT A CLOSED DOOR — and it is the most common
   * row on the screen, so the badge turns on its exclusion.
   */
  it('does not count a session whose recording has not been added', () => {
    const q = build([session('s1')]);
    expect(q.items[0].kind).toBe('recording');
    expect(q.blocking).toBe(0);
  });

  it('does not count a deadline that is merely near', () => {
    const q = build(
      [session('s1', { recordingId: 'r1', dueInDays: 1 })],
      [recording('r1', 'published')],
    );
    expect(q.blocking).toBe(0);
  });
});

describe('the order', () => {
  /*
   * TITLED SO THAT ALPHABETICAL ORDER DISAGREES WITH `KIND_ORDER`.
   *
   * With names that happened to sort the same way, the comparator's fallback —
   * age, then title — produced the right sequence on its own, and deleting the
   * cross-kind term left this green. The fixtures now spell the opposite order,
   * so only `RANK` can put them right.
   */
  it('sorts by kind first, in KIND_ORDER', () => {
    const q = build(
      [
        session('alpha-closing', { recordingId: 'r1', dueInDays: 3 }),
        session('bravo-norec'),
        session('charlie-draft', { recordingId: 'r2' }),
        session('delta-attendance', { attendanceSubmittedAt: null }),
      ],
      [recording('r1', 'published'), recording('r2', 'draft')],
      {
        grading: {
          managed: new Set([COURSE]),
          coursework: [coursework('echo-grading')],
          handedIn: [handedIn('u1', 'echo-grading', day(-2))],
          grades: [],
        },
      },
    );
    // All four, in KIND_ORDER — the length matters as much as the sequence, or
    // an expectation derived from the actual passes when a kind is dropped.
    expect(q.items.map((i) => i.kind)).toEqual([...KIND_ORDER]);
    expect(q.items.map((i) => i.title)).toEqual([
      'delta-attendance',
      'charlie-draft',
      'bravo-norec',
      'alpha-closing',
      'echo-grading',
    ]);
  });

  it('within a kind, the longest outstanding comes first', () => {
    const q = build([
      session('recent', { attendanceSubmittedAt: null, metDaysAgo: 1 }),
      session('old', { attendanceSubmittedAt: null, metDaysAgo: 9 }),
    ]);
    expect(q.items.map((i) => i.title)).toEqual(['old', 'recent']);
  });

  /*
   * `age: -left` IS THE SIGN TRICK THAT MAKES ONE COMPARATOR DO BOTH.
   *
   * Overdue rows sort oldest-first on a descending age; a closing row's urgency
   * runs the other way — sooner is more urgent — so it stores the negated days
   * remaining and falls out in the right order under the same comparison.
   */
  it('among closing rows, the nearest deadline comes first', () => {
    const q = build(
      [
        session('later', { recordingId: 'r1', dueInDays: 6 }),
        session('sooner', { recordingId: 'r2', dueInDays: 1 }),
      ],
      [recording('r1', 'published'), recording('r2', 'published')],
    );
    expect(q.items.map((i) => i.title)).toEqual(['sooner', 'later']);
  });

  it('ties break on the title, so the order never wobbles between renders', () => {
    const q = build([
      session('Bravo', { attendanceSubmittedAt: null, metDaysAgo: 4 }),
      session('Alpha', { attendanceSubmittedAt: null, metDaysAgo: 4 }),
    ]);
    expect(q.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo']);
  });
});

/*
 * AN EMPTY QUEUE HAS THREE CAUSES AND THEY ARE THREE DIFFERENT SENTENCES.
 * `scoped` and `allFinished` are what the screen picks between; getting them
 * wrong tells a manager at the end of term that nobody has assigned them a
 * course.
 */
describe('an empty queue', () => {
  it('with courses running: nothing is waiting', () => {
    const q = build([]);
    expect(q).toMatchObject({ loading: false, scoped: true, allFinished: false });
  });

  it('with no courses at all: nothing has been assigned', () => {
    const q = build([], [], { courses: [], scope: [] });
    expect(q).toMatchObject({ scoped: false, allFinished: false });
  });

  it('with courses that have all finished: the term is over', () => {
    const q = build([], [], { scope: [] });
    expect(q).toMatchObject({ scoped: false, allFinished: true });
  });

  it('waits for the courses rather than claiming there are none', () => {
    const q = build([], [], { courses: null, settled: false, scope: [] });
    expect(q).toMatchObject({ loading: true, scoped: true });
  });

  it('stops waiting for a reader who will never subscribe to anything', () => {
    const q = build([], [], { courses: null, settled: true, scope: [] });
    expect(q.loading).toBe(false);
  });

  it('waits for the sessions once there is something to subscribe to', () => {
    const q = build([], [], { sessions: null });
    expect(q).toMatchObject({ loading: true, scoped: true });
  });

  /*
   * AND FOR THE RECORDINGS, which arrive on their own listener. In the window
   * where the sessions have landed and the recordings have not, every session
   * that HAS a recording looks like one that does not — so the landing screen
   * would fill with "Attendance is in. The recording has not been added yet."
   * for a page of recordings that exist.
   */
  it('waits for the recordings too, rather than reporting them missing', () => {
    const q = build([session('s1', { recordingId: 'r1' })], [], { recordings: null });
    expect(q).toMatchObject({ loading: true, scoped: true });
    expect(q.items).toHaveLength(0);
  });

  it('a refused listener reports failure rather than loading for ever', () => {
    const q = build([], [], { courses: null, settled: false, scope: [], failed: true });
    expect(q).toMatchObject({ loading: false, failed: true });
  });

  it('carries the truncation flag through a loaded queue', () => {
    const q = build([session('s1', { attendanceSubmittedAt: null })], [], { truncated: true });
    // The notice this drives — "Some are not counted here" — belongs to the
    // NORMAL case: a manager with more live courses than one `in` clause holds,
    // everything loaded, a queue on screen that is only part of the answer.
    expect(q).toMatchObject({ loading: false, truncated: true });
    expect(q.items).toHaveLength(1);
  });

  it('carries the truncation flag through every early return', () => {
    const q = build([], [], { courses: null, settled: false, scope: [], truncated: true });
    expect(q.truncated).toBe(true);
  });
});

/**
 * Which courses the queue watches.
 *
 * Both rules here have a bug behind them and neither is visible on screen: a
 * queue scoped to the wrong courses looks exactly like a queue with nothing in
 * it, and the badge is simply a different number.
 */
describe('queueScope', () => {
  const course = (id: string, effectiveActive = true) => ({ id, effectiveActive });

  it('watches the live courses and no others', () => {
    expect(queueScope([course('b'), course('a', false), course('c')], 10)).toEqual({
      key: 'b,c',
      truncated: false,
    });
  });

  /*
   * A COHORT ARCHIVED AT THE END OF TERM LEAVES `archived` FALSE on every course
   * under it — the cascade sets `effectiveActive` instead. Filtering on the
   * course's own flag kept every past term in the queue for ever and spent the
   * scope budget the live courses needed.
   */
  it('drops a course whose cohort was archived, not just a self-archived one', () => {
    const cascaded = { id: 'c1', effectiveActive: false, archived: false };
    expect(queueScope([cascaded], 10).key).toBe('');
  });

  /*
   * `in` takes at most `max` values. Cutting the ARRIVAL order would make the
   * watched set depend on snapshot order — the same reader watching a different
   * set of courses from one load to the next, and a badge that moves with no
   * document changing.
   */
  it('cuts the sorted ids, so the watched set does not move between loads', () => {
    const arrived = [course('m'), course('a'), course('z')];
    const reordered = [course('z'), course('m'), course('a')];
    expect(queueScope(arrived, 2)).toEqual({ key: 'a,m', truncated: true });
    expect(queueScope(reordered, 2)).toEqual(queueScope(arrived, 2));
  });

  it('counts only the LIVE courses against the cap', () => {
    const three = [course('a'), course('b', false), course('c', false)];
    expect(queueScope(three, 2)).toEqual({ key: 'a', truncated: false });
  });

  it('has an answer before the first snapshot', () => {
    expect(queueScope(null, 10)).toEqual({ key: '', truncated: false });
  });
});

describe('work to grade', () => {
  const grading = (over: Partial<Parameters<typeof buildTodayQueue>[0]['grading'] & object> = {}) => ({
    managed: new Set([COURSE]),
    coursework: [coursework('reflection')],
    handedIn: [handedIn('u1', 'reflection', day(-2)), handedIn('u2', 'reflection', day(0)), handedIn('u3', 'reflection', day(-3))],
    grades: [graded('u3', 'reflection')],
    ...over,
  });

  it('says how much is waiting, how much of it late, and never counts it in the badge', () => {
    const q = build([], [], { grading: grading() });
    expect(q.items).toEqual([
      expect.objectContaining({ kind: 'grading', courseworkId: 'reflection', detail: '2 handed in and not graded yet, 1 of them late.', action: 'Grade', blocking: false }),
    ]);
    expect(q.blocking).toBe(0);
  });

  it('turns into a reminder to return once everything is graded', () => {
    const q = build([], [], { grading: grading({ handedIn: [handedIn('u3', 'reflection', day(-3))] }) });
    expect(q.items[0]).toMatchObject({ detail: 'All graded. 1 not returned yet.', action: 'Return' });
  });

  it('only for courses the reader manages by name, and never for a draft', () => {
    expect(build([], [], { grading: grading({ managed: new Set() }) }).items).toEqual([]);
    expect(build([], [], { grading: grading({ coursework: [coursework('reflection', { status: 'draft' })] }) }).items).toEqual([]);
  });
});
