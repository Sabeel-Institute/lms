import { describe, expect, it, vi } from 'vitest';

/**
 * THE MORNING SWEEPS KEEP GOING PAST ONE STUDENT'S FAILURE.
 *
 * A reminder on the last day has no second chance: tomorrow the date has gone
 * and the query no longer matches. Each sweep isolated the SEND per student,
 * but the reads before it sat outside that guard, so one transient read error
 * for one student ended the sweep for everyone after them. These drive the
 * sweeps against a store whose one read throws, with the send stubbed, and ask
 * that the next student is still reminded.
 */

const sent: Array<{ uid: string; kind: string }> = [];
vi.mock('../../src/notify', () => ({
  notifyOnce: vi.fn(async (_db: unknown, uid: string, kind: string) => {
    sent.push({ uid, kind });
    return true;
  }),
}));
// The functions' secrets, which the trigger module binds when it loads.
vi.mock('../../src/messaging', () => ({ PUSH_SECRETS: [] }));

const { notifyLastDay, notifyAttendanceMissing } = await import('../../src/notifyJobs');
const { notifyHandInLastDay } = await import('../../src/notifyCoursework');
const { opensIt } = await import('../../src/notifyTrigger');

type Data = Record<string, unknown> | undefined;
/** A store of documents by path, and the paths whose read throws. */
function fakeDb(docs: Record<string, Data>, queries: Record<string, Array<{ id: string; data: Data }>>, failing: string[]) {
  const query = (name: string) => {
    const q = {
      where: () => q,
      get: async () => ({ docs: (queries[name] ?? []).map((d) => ({ id: d.id, data: () => d.data })) }),
    };
    return q;
  };
  return {
    collection: (name: string) => ({
      ...query(name),
      doc: (id: string) => ({
        get: async () => {
          const path = `${name}/${id}`;
          if (failing.includes(path)) throw new Error(`unavailable: ${path}`);
          const data = docs[path];
          return { exists: data !== undefined, data: () => data };
        },
      }),
    }),
  };
}

const TODAY = '2026-11-12';
const grant = (uid: string) => ({
  id: `${uid}_r1`,
  data: { studentUid: uid, recordingId: 'r1', sessionId: 's1', courseId: 'c1', cohortId: 'h', dueDate: TODAY, active: true, assignedAt: 1, assignedBy: 'system' },
});
const course = { name: 'Hikam', effectiveActive: true, archivedAccess: false, managerUids: ['m1', 'm2'] };

describe('the last-day sweep', () => {
  it('reminds the next student when one student’s read fails', async () => {
    sent.length = 0;
    const db = fakeDb(
      { 'courses/c1': course, 'recordings/r1': { status: 'published', title: 'Session 3' } },
      { assignments: [grant('s1'), grant('s2')] },
      ['completions/s1_r1'],
    );
    const count = await notifyLastDay(db as never, TODAY);
    expect(sent).toEqual([{ uid: 's2', kind: 'lastDay' }]);
    expect(count).toBe(1);
  });

  it('still reminds a student whose given record cannot be read: it only chooses the wording', async () => {
    sent.length = 0;
    const db = fakeDb(
      { 'courses/c1': course, 'recordings/r1': { status: 'published', title: 'Session 3' } },
      { assignments: [grant('s1')] },
      ['givenRecordings/s1_r1'],
    );
    expect(await notifyLastDay(db as never, TODAY)).toBe(1);
    expect(sent).toEqual([{ uid: 's1', kind: 'lastDay' }]);
  });
});

describe('the hand-in sweep', () => {
  it('reminds the next student when one assignment’s read fails', async () => {
    sent.length = 0;
    const sub = (uid: string, courseworkId: string) => ({
      id: `${uid}_${courseworkId}`,
      data: { studentUid: uid, courseworkId, courseId: 'c1', dueDate: TODAY, state: 'open', active: true, notRequired: null, closedEarly: false },
    });
    const db = fakeDb(
      { 'coursework/cwB': { courseId: 'c1', status: 'posted', title: 'Memorize' }, 'courses/c1': course },
      { submissions: [sub('s1', 'cwA'), sub('s2', 'cwB')] },
      ['coursework/cwA'],
    );
    expect(await notifyHandInLastDay(db as never, TODAY)).toBe(1);
    expect(sent).toEqual([{ uid: 's2', kind: 'handInLastDay' }]);
  });
});

describe('the attendance sweep', () => {
  it('reminds about the next session when one session’s read fails', async () => {
    sent.length = 0;
    const session = (courseId: string) => ({ courseId, title: 'Session 5', date: '2026-11-01', notRecorded: false });
    const db = fakeDb(
      { 'courses/c2': course },
      { sessions: [{ id: 'x1', data: session('c1') }, { id: 'x2', data: session('c2') }] },
      ['courses/c1'],
    );
    expect(await notifyAttendanceMissing(db as never, TODAY)).toBe(2);
    expect(sent.map((s) => s.uid)).toEqual(['m1', 'm2']);
  });
});

describe('the given-recording trigger', () => {
  it('acts on an opening only: a give or a reopen, never a move or a take back', () => {
    expect(opensIt(undefined, { givenAt: 1 })).toBe(true);
    expect(opensIt({ givenAt: 1 }, { givenAt: 2 })).toBe(true);
    expect(opensIt({ givenAt: 1 }, { givenAt: 1 })).toBe(false);
    expect(opensIt({ givenAt: 1 }, undefined)).toBe(false);
  });
});
