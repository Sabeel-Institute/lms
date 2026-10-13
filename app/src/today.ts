import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  QUEUE_SCOPE,
  todayInZone,
  type CourseworkDoc,
  type GradeDoc,
  type RecordingDoc,
  type SessionDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
// The queue's vocabulary, re-exported so a screen has one import for the hook
// and the shapes it returns. `buildTodayQueue` itself is not: its callers are
// this file and its own test, and both name the module it lives in.
export { KIND_ORDER, type TodayItem, type TodayKind, type TodayQueue } from './todayQueue';
import { buildTodayQueue, queueScope, type TodayQueue } from './todayQueue';
import { db } from './firebase';
import { useListenerFailed, useLiveQuery } from './liveQuery';
import { useAllCoursesSource, useMyCoursesSource, type CourseRow } from './structure';
import { recordingRow } from './recordingRow';

/**
 * The staff work queue, derived — never stored.
 *
 * Every row is computed from sessions and recordings the reader can already
 * see. There is no queue collection, nothing to keep in step with the documents
 * it describes, and no way for it to claim work that is already done: close the
 * gap and the row is gone.
 *
 * LIVE, not a one-shot read, and the badge is why. A count on the tab that is
 * refreshed only on arrival tells you two sessions are blocking access for as
 * long as you stay on the screen where you just fixed both — and a badge that
 * lies about work you have finished is worse than no badge. Two listeners hold
 * the whole thing honest: submit attendance and the row and the count go at the
 * same moment, from whichever screen you are on.
 */
function useTodayQueue(
  uid: string,
  courses: CourseRow[] | null,
  max: number,
  /** See `buildTodayQueue`: "nothing will ever be subscribed", not "loaded". */
  settled: boolean,
  /** Whether `courses` has come from the server, or is still the cache. */
  confirmed: boolean,
): TodayQueue {
  /*
   * A STRING FIRST, THE ARRAY FROM IT — not the other way round.
   *
   * `courses` is a new array on every render of the live query that produced
   * it, so it cannot be a subscription input. Sorting the ids into one string
   * gives a stable primitive, and rebuilding the array FROM that string gives a
   * stable array too — which is what lets `exhaustive-deps` check this hook
   * honestly instead of being told to look away. That rule is what mechanically
   * proves every live query resubscribes when its inputs change; silencing it
   * here would cost more than the two lines it saves.
   */
  const { key, truncated } = queueScope(courses, max);

  /*
   * A REFUSAL OF A SCOPE THE SERVER HAS NOT CONFIRMED IS NOT NEWS.
   *
   * On a cold load `courses` is the cache, and one course the manager no
   * longer runs — deleted, or they were taken off it while the browser was
   * closed — makes the rules refuse the whole `in` query (every value is
   * judged against live data). The server's course list then replaces the
   * scope and the re-issued queries are served: a banner flash and two Sentry
   * events per stale cache, for nothing anyone could act on (WEB-4). So while
   * the scope is provisional a denial is expected; once the server has
   * confirmed it, a denial is a fault again.
   *
   * The queries are still issued on the provisional scope — withholding them
   * until the server answers would cost offline staff their cached queue.
   *
   * AND A SWALLOWED REFUSAL IS RETRIED ONCE CONFIRMED. A refused listener is
   * dead, and if the server's list turns out identical to the cache the scope
   * does not change and nothing would re-subscribe: the queue would sit on
   * "Checking your courses…" with the fault unreported. `retry` flips exactly
   * then — a refusal was swallowed and the scope has since been confirmed —
   * and the second attempt reports if it is refused again.
   */
  const [swallowed, setSwallowed] = useState(false);
  const expectDenial = () => {
    if (confirmed) return false;
    setSwallowed(true);
    return true;
  };
  const retry = confirmed && swallowed;
  // `retry` is folded into the scope's identity rather than listed as a
  // second dependency on the queries: they read the scope and nothing else,
  // and a fresh array is what makes them subscribe again.
  const scope = useMemo(() => {
    void retry;
    return key ? key.split(',') : [];
  }, [key, retry]);

  /*
   * `null` UNTIL THE FIRST SNAPSHOT, deliberately — not an empty array.
   *
   * `useLiveQuery` renders `empty` before anything arrives and again after an
   * error, so an empty array cannot tell "nothing is waiting" from "nothing has
   * come back yet". On this screen those are opposite messages: the first is the
   * most useful thing it can say, and showing it for a beat before the rows
   * appear is a flash of the wrong answer on the app's landing screen.
   */
  const sessions = useLiveQuery<(SessionDoc & { id: string })[] | null>(
    () =>
      scope.length > 0
        ? query(collection(db, COLLECTIONS.sessions), where('courseId', 'in', scope))
        : null,
    [scope],
    {
      label: 'todaySessions',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as SessionDoc) })),
      empty: null,
      expectDenial,
      extra: { scope: key },
    },
  );

  const recordings = useLiveQuery<Map<string, RecordingDoc & { id: string }> | null>(
    () =>
      scope.length > 0
        ? query(collection(db, COLLECTIONS.recordings), where('courseId', 'in', scope))
        : null,
    [scope],
    {
      label: 'todayRecordings',
      map: (snap) =>
        new Map(snap.docs.map((d) => [d.id, recordingRow(d.id, d.data() as RecordingDoc)])),
      empty: null,
      expectDenial,
      extra: { scope: key },
    },
  );

  /*
   * ALL FOUR QUERIES THIS SCREEN DEPENDS ON, not just the two it subscribes
   * itself.
   *
   * A refused listener leaves its query on the `empty` value for ever, and
   * `empty` is the same `null` that means "nothing has arrived yet" — so without
   * this the landing screen sits on "Checking your courses…" with no way out.
   * The first guard in `buildTodayQueue` waits on `courses`, which comes from
   * `allCourses`/`myCourses`, so leaving those two out left exactly that.
   *
   * `useListenerFailed` matches on the label and ignores the scope, so an
   * unscoped denial of the same query from another screen counts here too. That
   * is the right answer — it is the same query against the same rules, and it
   * fails for both or neither — but it is not a claim about isolation: the
   * SCOPING exists so that a screen's success cannot clear the shell's failure,
   * which is the opposite direction.
   *
   * Spelled out rather than derived from the calls above, because
   * `firestoreIndexes.test.ts` parses `label:` out of every `useLiveQuery` call
   * site and a computed one is a call site it cannot read — a guard that stops
   * seeing a query is worse than the duplication.
   */
  /*
   * WORK TO GRADE, across the same scope: the assignments, the work handed in
   * and not yet returned, and the grades being written. Rows are shown only
   * for the courses the reader manages by name — see `gradingRows`.
   */
  const coursework = useLiveQuery<(CourseworkDoc & { id: string })[] | null>(
    () =>
      scope.length > 0
        ? query(collection(db, COLLECTIONS.coursework), where('courseId', 'in', scope))
        : null,
    [scope],
    {
      label: 'todayCoursework',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as CourseworkDoc) })),
      empty: null,
      expectDenial,
      extra: { scope: key },
    },
  );
  const handedIn = useLiveQuery<SubmissionDoc[] | null>(
    () =>
      scope.length > 0
        ? query(
            collection(db, COLLECTIONS.submissions),
            where('courseId', 'in', scope),
            where('state', '==', 'handedIn'),
          )
        : null,
    [scope],
    {
      label: 'todayHandedIn',
      map: (snap) => snap.docs.map((d) => d.data() as SubmissionDoc),
      empty: null,
      expectDenial,
      extra: { scope: key },
    },
  );
  const grades = useLiveQuery<GradeDoc[] | null>(
    () =>
      scope.length > 0 ? query(collection(db, COLLECTIONS.grades), where('courseId', 'in', scope)) : null,
    [scope],
    {
      label: 'todayGrades',
      map: (snap) => snap.docs.map((d) => d.data() as GradeDoc),
      empty: null,
      expectDenial,
      extra: { scope: key },
    },
  );

  const failed = useListenerFailed([
    'todaySessions',
    'todayRecordings',
    'allCourses',
    'myCourses',
  ]);
  const managed = useMemo(
    () => new Set((courses ?? []).filter((c) => (c.managerUids ?? []).includes(uid)).map((c) => c.id)),
    [courses, uid],
  );

  // OUTSIDE the memo: a browser left open past midnight would otherwise keep
  // saying "Met today" until the next snapshot happened to arrive.
  const today = todayInZone(INSTITUTE_TIMEZONE);

  return useMemo(
    () =>
      buildTodayQueue({
        courses,
        sessions,
        recordings,
        scope,
        today,
        failed,
        settled,
        truncated,
        grading: { managed, coursework, handedIn, grades },
      }),
    [courses, sessions, recordings, scope, today, failed, settled, truncated, managed, coursework, handedIn, grades],
  );
}

/**
 * The queue for whoever is signed in — subscribed ONCE, at the app shell.
 *
 * The tab's badge and the screen itself must never disagree, and the cheapest
 * way to guarantee that is for there to be one subscription rather than two
 * that happen to run the same query. The shell holds it and hands it down; the
 * Today screen renders it and does no fetching of its own.
 *
 * A STUDENT SUBSCRIBES TO NOTHING. Sessions are staff-only in the rules, so a
 * student running this would raise a permission denial per listener from their
 * own home screen — the exact shape of the bug the shared-device route tables
 * exist to prevent. Both course queries are gated, so their scope is empty and
 * no listener is ever opened.
 */
export function useStaffQueue(isStaff: boolean, isAdmin: boolean, uid: string): TodayQueue {
  // SCOPED, for the same reason the docked bar's listeners are: this one is
  // mounted by the SHELL and outlives every screen, while five screens mount the
  // same query under the same label. Unscoped, navigating away from one of them
  // deletes the shell's error entry — and `useListenerFailed` above then goes
  // false with `courses` still null, so the landing screen falls back from
  // "Could not read your courses" to "Checking your courses…" for good.
  const all = useAllCoursesSource(isStaff && isAdmin, 'todayQueue');
  const mine = useMyCoursesSource(isStaff && !isAdmin ? uid : null, 'todayQueue');
  const courses = isAdmin ? all : mine;
  return useTodayQueue(
    uid,
    courses.rows,
    isAdmin ? QUEUE_SCOPE.admin : QUEUE_SCOPE.manager,
    // A student subscribes to nothing, so "no courses" is their settled answer
    // rather than one still arriving.
    !isStaff,
    !courses.fromCache,
  );
}
