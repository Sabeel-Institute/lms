/**
 * The staff work queue's derivation — pure, and deliberately in its own module.
 *
 * NOTHING HERE IMPORTS REACT, FIREBASE OR REACT-NATIVE, and that is the point:
 * `app/vitest.config.ts` runs in a node environment with no react-native
 * transform, so logic that reaches the app's UI layer cannot be unit tested at
 * all. Everything interesting about this queue lives here — the bucketing, what
 * counts as blocking, the ordering, and the three different sentences an empty
 * result has to produce — and `today.ts` is the subscriptions that feed it.
 */
import {
  DUE_SOON_DAYS,
  INSTITUTE_TIMEZONE,
  daysUntilDue,
  isLate,
  type CourseworkDoc,
  type GradeDoc,
  type RecordingDoc,
  type SessionDoc,
  type SubmissionDoc,
} from '@sabeel/shared';

export type TodayKind = 'attendance' | 'recording' | 'publish' | 'closing' | 'grading';

export interface TodayItem {
  key: string;
  kind: TodayKind;
  /** The session a row is about; empty for an assignment's. */
  sessionId: string;
  /** The assignment a `grading` row is about; null otherwise. */
  courseworkId: string | null;
  /** The row's own action word, where its kind has two ("Grade", "Return"). */
  action?: string;
  courseId: string;
  courseName: string;
  title: string;
  /** The session's meeting date, `YYYY-MM-DD`. */
  date: string;
  /**
   * What is true of this row and no other, as a caption: "Met 4 days ago".
   * The section heading says what kind of work it is.
   */
  detail: string;
  recordingId: string | null;
  /** Days past due (negative = still to come). Drives the ordering. */
  age: number;
  /**
   * Students are locked out of something until this is cleared.
   *
   * Two things qualify and it is worth being exact about which. An un-taken
   * register grants nobody anything, and a recording TAKEN BACK — unpublished,
   * or archived before its listen-by date — removes access every excused
   * student already had. A draft has granted nothing yet and a missing recording
   * is not a lockout: those are work, not a closed door. This is what the tab's
   * badge counts.
   */
  blocking: boolean;
}

export interface TodayQueue {
  items: TodayItem[];
  /** How many rows are `blocking` — the number on the tab. */
  blocking: number;
  /** No snapshot has arrived yet. Distinct from an empty queue, which is news. */
  loading: boolean;
  /** A listener was refused. `loading` would otherwise be true for ever. */
  failed: boolean;
  /**
   * Whether there are any LIVE courses to have a queue about.
   *
   * An empty queue has three causes and they read as three different sentences:
   * nothing is waiting, you have no courses yet, and your courses are all
   * finished. Telling a manager at the end of term that an administrator will
   * assign them something is the second answer given to the third question.
   */
  scoped: boolean;
  /** Courses exist, but none of them is still running. */
  allFinished: boolean;
  /** More courses than one `in` clause can carry; the queue is a partial view. */
  truncated: boolean;
}

/**
 * Which courses the queue watches, and whether that is all of them.
 *
 * HERE RATHER THAN IN THE HOOK, for the reason at the top of this file: the
 * hook imports react and firebase, so nothing inside it is reachable from a
 * test, and this is the piece whose two rules are worth pinning.
 *
 * FINISHED COURSES ARE NOT WORK — and `effectiveActive` is the field that says
 * so, not `archived`. `archived` is a course's OWN flag. A term ends by
 * archiving the COHORT, and that cascade deliberately never touches it — it
 * sets `effectiveActive`. So reading `archived` meant every course of every
 * past term stayed in the queue for ever, producing rows nobody is waiting on
 * and spending the scope budget that live courses need.
 *
 * SORTED, THEN CUT, and the order matters: `in` takes at most `max` values, and
 * a cut applied to the arrival order would make the watched set depend on
 * snapshot order — the same reader would watch a different set of courses from
 * one load to the next, and the badge would move with no change to any
 * document. Sorting first makes the cut deterministic.
 *
 * Returns a comma-joined `key` — a stable primitive the hook can hand to
 * `useMemo`, since `courses` is a fresh array on every render of the live query
 * behind it.
 */
export function queueScope(
  courses: { id: string; effectiveActive: boolean }[] | null,
  max: number,
): { key: string; truncated: boolean } {
  const live = (courses ?? []).filter((c) => c.effectiveActive);
  return {
    key: live
      .map((c) => c.id)
      .sort()
      .slice(0, max)
      .join(','),
    truncated: live.length > max,
  };
}

/**
 * How urgent each kind is, before age is considered — and THE ONE STATEMENT OF
 * that order in the app. `TodayScreen` renders its sections in this sequence by
 * reading it, rather than by listing the kinds a second time; two lists would
 * be free to disagree, and the disagreement would be invisible because the
 * screen groups the rows anyway.
 *
 * ATTENDANCE IS FIRST AND IT IS NOT A CLOSE CALL. Under the excused-only policy
 * an un-taken sheet grants nobody anything, so a whole class is locked out of a
 * published recording with nothing on any screen saying why. Every other row
 * here is work that is visibly outstanding somewhere; this one is work whose
 * absence is invisible.
 */
export const KIND_ORDER = ['attendance', 'publish', 'recording', 'closing', 'grading'] as const;
const RANK: Record<TodayKind, number> = {
  attendance: KIND_ORDER.indexOf('attendance'),
  publish: KIND_ORDER.indexOf('publish'),
  recording: KIND_ORDER.indexOf('recording'),
  closing: KIND_ORDER.indexOf('closing'),
  grading: KIND_ORDER.indexOf('grading'),
};

/**
 * What a reader's assignments need of them, for the `grading` rows.
 *
 * ONLY COURSES THEY MANAGE BY NAME — an admin included. An admin's Today
 * covers every running course, and every other teacher's grading would bury
 * the registers that keep students from their recordings.
 */
export interface GradingInput {
  managed: ReadonlySet<string>;
  coursework: (CourseworkDoc & { id: string })[] | null;
  /** Work in `handedIn` state across the scope. */
  handedIn: SubmissionDoc[] | null;
  grades: GradeDoc[] | null;
}

/**
 * The whole derivation, as a pure function of what the listeners returned.
 *
 * SEPARATE FROM THE HOOK ON PURPOSE. Everything interesting about this queue is
 * in here — the bucketing, what counts as blocking, the ordering, and the three
 * different sentences an empty result has to produce — and none of it was
 * reachable from a test while it lived inside a `useMemo`. The hook below is now
 * only the subscriptions and this call.
 */
export function buildTodayQueue({
  courses,
  sessions,
  recordings,
  scope,
  today,
  failed,
  settled,
  truncated,
  grading,
}: {
  /** Every course the reader can see, or null before the first snapshot. */
  courses: { id: string; name: string }[] | null;
  /** Sessions across `scope`, or null before the first snapshot. */
  sessions: (SessionDoc & { id: string })[] | null;
  /** Recordings across `scope` by id, or null before the first snapshot. */
  recordings: Map<string, RecordingDoc & { id: string }> | null;
  /** The course ids actually subscribed — empty when there are none to watch. */
  scope: readonly string[];
  /** Today in the institute's timezone, as `YYYY-MM-DD`. */
  today: string;
  /** Whether any listener this queue depends on was refused. */
  failed: boolean;
  /**
   * Whether nothing will ever be subscribed, so a null `courses` is the final
   * answer rather than a cold load.
   *
   * True only for a reader who has no course query at all — a student, whose
   * queue is never rendered. It is NOT "the course listener has answered": that
   * listener reports by turning `courses` non-null, and until it does there is
   * nothing to say.
   */
  settled: boolean;
  /** Whether `scope` was cut to fit one `in` clause. */
  truncated: boolean;
  grading?: GradingInput;
}): TodayQueue {
  const names = new Map((courses ?? []).map((c) => [c.id, c.name]));

  // Nothing subscribed is not the same as nothing loaded. Until the COURSES
  // arrive there is no answer at all, and an empty list of them reads on
  // screen as "you have no courses" — a confident wrong answer shown to every
  // staff member for the length of a cold load.
  const pending = { items: [], blocking: 0, failed, scoped: true, allFinished: false, truncated };
  if (!settled && courses === null) {
    return { ...pending, loading: !failed };
  }

  const subscribed = scope.length > 0;
  if (subscribed && (sessions === null || recordings === null)) {
    return { ...pending, loading: !failed };
  }

  const out: TodayItem[] = [];

  for (const s of sessions ?? []) {
    // A class somebody has said was not recorded raises nothing here: no
    // register to chase, no recording to wait for. It is the only exit from the
    // "no recording yet" card, which otherwise stays for the life of the course.
    if (s.notRecorded) continue;
    const courseName = names.get(s.courseId) ?? '';
    // Days since the meeting: `daysUntilDue` counts whole calendar days
    // between two date-only strings, which is exactly this with the arguments
    // the other way round.
    const met = -daysUntilDue(s.date, today);
    const base = {
      sessionId: s.id,
      courseworkId: null,
      courseId: s.courseId,
      courseName,
      title: s.title,
      date: s.date,
    };

    if (s.attendanceSubmittedAt === null && met >= 0) {
      out.push({
        ...base,
        key: `att-${s.id}`,
        kind: 'attendance',
        recordingId: null,
        age: met,
        blocking: true,
        /*
         * ONLY WHAT IS TRUE OF THIS ROW. The section heading already carries the
         * rule ("Until this is submitted, nobody in the class has access"), and
         * repeating it on every card made the one thing that differs between
         * them — how long it has been waiting — two words at the head of a
         * sentence that was otherwise identical four times over.
         */
        detail: met === 0 ? 'Met today' : `Met ${met} ${met === 1 ? 'day' : 'days'} ago`,
      });
      continue;
    }

    const rec = s.recordingId ? (recordings?.get(s.recordingId) ?? null) : null;
    if (!rec) {
      if (met >= 0) {
        out.push({
          ...base,
          key: `rec-${s.id}`,
          kind: 'recording',
          recordingId: null,
          age: met,
          blocking: false,
          // The heading says the rest; this says when the class met.
          detail: met === 0 ? 'Met today' : `Met ${met} ${met === 1 ? 'day' : 'days'} ago`,
        });
      }
      continue;
    }

    /*
     * NOT OUT YET, AND ONLY WHILE THERE IS STILL TIME TO PUT IT OUT.
     *
     * The four not-published states differ in whether anyone is locked out — a
     * draft and a needs-attention import granted nobody anything, while
     * unpublishing and ARCHIVING both revoke what every excused student already
     * had (`assignmentsFanout.ts` keys on `status === 'published'` and nothing
     * else, so the two are identical to a student).
     *
     * But NONE of them is work once the listen-by date has gone. The server
     * refuses to publish past it — "Move it before publishing, or nobody will be
     * able to listen" — so the row's own action would fail, nobody is locked out
     * of anything they could still use, and a queue that kept them would carry a
     * permanent badge for lockouts that no longer exist. A badge that is never
     * zero is one people learn to ignore.
     */
    const stillOwed = daysUntilDue(s.dueDate, today) >= 0;
    const revoked = rec.status === 'unpublished' || rec.status === 'archived';
    if (rec.status !== 'published' && stillOwed) {
      out.push({
        ...base,
        key: `pub-${s.id}`,
        kind: 'publish',
        recordingId: rec.id,
        age: met,
        blocking: revoked,
        detail:
          rec.status === 'needsAttention'
            ? 'The import needs attention before it can be published'
            : rec.status === 'unpublished'
              ? 'Unpublished, so nobody excused can open it'
              : rec.status === 'archived'
                ? 'Archived before its due date, so nobody excused can open it'
                : 'A draft is waiting to be published',
      });
      continue;
    }

    if (rec.status === 'published') {
      const left = daysUntilDue(s.dueDate, today);
      if (left >= 0 && left <= DUE_SOON_DAYS) {
        out.push({
          ...base,
          key: `close-${s.id}`,
          kind: 'closing',
          recordingId: rec.id,
          blocking: false,
          // Negative, so a deadline further off sorts below a nearer one under
          // the same descending comparison the overdue rows use.
          age: -left,
          detail:
            left === 0 ? 'Access closes today' : `Access closes in ${left} ${left === 1 ? 'day' : 'days'}`,
        });
      }
    }
  }

  out.push(...gradingRows(grading, names, today));

  out.sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || b.age - a.age || a.title.localeCompare(b.title),
  );
  return {
    items: out,
    blocking: out.filter((i) => i.blocking).length,
    loading: false,
    failed,
    scoped: subscribed,
    allFinished: !subscribed && (courses ?? []).length > 0,
    truncated,
  };
}

/**
 * One row per assignment with work waiting on its teacher, last on the
 * screen and never counted in the badge: ungraded work keeps nobody from
 * anything, and a badge that is never zero gets ignored. Work handed in early
 * counts too. Once everything is graded the row turns into a reminder to
 * return it, and leaves when it is all back with the students.
 */
function gradingRows(grading: GradingInput | undefined, names: Map<string, string>, today: string): TodayItem[] {
  if (!grading?.coursework || !grading.handedIn || !grading.grades) return [];
  const graded = new Set(grading.grades.map((g) => `${g.studentUid}_${g.courseworkId}`));
  const rows: TodayItem[] = [];
  for (const cw of grading.coursework) {
    if (cw.status !== 'posted' || !grading.managed.has(cw.courseId)) continue;
    const work = grading.handedIn.filter((s) => s.courseworkId === cw.id);
    const toGrade = work.filter((s) => !graded.has(`${s.studentUid}_${cw.id}`));
    const late = toGrade.filter((s) => s.handedInAt !== null && isLate(s.handedInAt, s.dueDate, INSTITUTE_TIMEZONE)).length;
    const toReturn = work.length - toGrade.length;
    if (work.length === 0) continue;
    rows.push({
      key: `grade-${cw.id}`,
      kind: 'grading',
      sessionId: '',
      courseworkId: cw.id,
      courseId: cw.courseId,
      courseName: names.get(cw.courseId) ?? '',
      title: cw.title,
      date: cw.dueDate,
      detail:
        toGrade.length > 0
          ? `${toGrade.length} handed in and not graded yet${late ? `, ${late} of them late` : ''}`
          : `All graded, ${toReturn} not returned yet`,
      action: toGrade.length > 0 ? 'Grade' : 'Return',
      recordingId: null,
      age: -daysUntilDue(cw.dueDate, today),
      blocking: false,
    });
  }
  return rows;
}
