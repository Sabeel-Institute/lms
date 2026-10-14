import { useMemo } from 'react';
import { collection, doc, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  COLLECTIONS,
  type CourseDoc,
  type CohortDoc,
  type EnrollmentDoc,
} from '@sabeel/shared';
import { db, functions } from './firebase';
import { useLiveDocState, useLiveQuery } from './liveQuery';
import { read } from './documents';

export interface CohortRow extends CohortDoc {
  id: string;
}
export interface CourseRow extends CourseDoc {
  id: string;
}

export interface EnrollmentRow extends EnrollmentDoc {
  id: string;
}

/**
 * Staff-only: a `cohortId -> name` resolver, for disambiguating a class name in
 * cross-cohort views (the same class name recurs across cohorts). Cohorts are
 * not student-readable, so this only works on staff screens.
 */
export function useCohortName(enabled = true): (cohortId: string) => string {
  const cohorts = useCohorts(enabled);
  return useMemo(() => {
    const byId = new Map(cohorts.map((c) => [c.id, c.name]));
    return (cohortId: string) => byId.get(cohortId) ?? '';
  }, [cohorts]);
}

/**
 * One cohort, live — a DOCUMENT listener, so it is a `get` rather than a list.
 *
 * The cohort screen edits the cohort it displays (archive/reactivate), so it
 * must not render from the navigation param it arrived with: that is a copy
 * frozen at the tap, and a control that both renders and computes its next
 * value from a frozen copy never appears to work. See useCourse.
 *
 * Returns `resolved` too: the cohort screen is reachable by URL, so it has to be
 * able to tell "still loading" from "no such cohort".
 */
export function useCohortState(cohortId: string | null) {
  return useLiveDocState<CohortRow | null>(
    () => (cohortId ? doc(db, COLLECTIONS.cohorts, cohortId) : null),
    [cohortId],
    {
      label: 'cohort',
      map: (snap) => ({ id: snap.id, ...read('cohorts', snap) }),
      empty: null,
    },
  );
}

export function useCohorts(enabled: boolean): CohortRow[] {
  return useCohortsState(enabled) ?? NO_COHORTS;
}

const NO_COHORTS: CohortRow[] = [];

/** The `State` variant: `null` until the listener answers, so an empty sentence is
 *  never printed for a question not yet answered. */
export function useCohortsState(enabled: boolean): CohortRow[] | null {
  return useLiveQuery<CohortRow[] | null>(
    () =>
      enabled
        ? query(collection(db, COLLECTIONS.cohorts), orderBy('createdAt', 'desc'))
        : null,
    [enabled],
    {
      label: 'cohorts',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('cohorts', d) })),
      empty: null,
    },
  );
}

/** Every class in a cohort. Admin-only: the rule has no scoped arm for this shape.
 *  `null` until the listener answers, so an empty sentence is never printed for
 *  a question not yet answered. */
export function useCoursesInCohortState(cohortId: string | null): CourseRow[] | null {
  return useLiveQuery<CourseRow[] | null>(
    () =>
      cohortId
        ? query(
            collection(db, COLLECTIONS.courses),
            where('cohortId', '==', cohortId),
            orderBy('createdAt', 'asc'),
          )
        : null,
    [cohortId],
    {
      label: 'coursesInCohort',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('courses', d) })),
      empty: null,
    },
  );
}

/**
 * One course, live — a DOCUMENT listener, which is what makes it usable by
 * everyone who needs it.
 *
 * It must not be a `where('__name__','==',id)` query: that is a LIST, and the
 * courses rule grants students `get` without `list`. The player and the course
 * screens are reached by staff AND students, so a list here fails closed on a
 * student — an empty screen and a console warning, not an error anyone notices.
 * The e2e caught exactly that.
 *
 * The screens that EDIT a course also read it through this, so none of them
 * renders from the navigation param it arrived with — a copy frozen at the tap,
 * which is how the manager toggles came to do nothing.
 */
export function useCourse(courseId: string | null): CourseRow | null {
  return useCourseState(courseId).value;
}

/**
 * As useCourse, plus whether the listener has answered — for a screen resolving
 * a course from a URL, which must be able to say "no such course".
 *
 * A refusal is an answer: a manager taken off the class, or a student
 * unenrolled, while on its page is refused it by design, and the page says it
 * is not available rather than "Live data error" above that.
 *
 * `scope` for a second reader of the same document; see `useRecordingState`.
 */
export function useCourseState(courseId: string | null, scope?: string) {
  return useLiveDocState<CourseRow | null>(
    () => (courseId ? doc(db, COLLECTIONS.courses, courseId) : null),
    [courseId],
    {
      label: 'course',
      context: scope ? { scope } : undefined,
      map: (snap) => ({ id: snap.id, ...read('courses', snap) }),
      empty: null,
      denialIsAnswer: true,
    },
  );
}

/**
 * Every class in every cohort, oldest first — ADMIN ONLY.
 *
 * The rules' admin arm lists the whole `courses` collection without a per-row
 * read (a manager must go cohort by cohort). Used where the admin needs courses
 * across cohorts at once: the cohort class-counts and the student-enrolment
 * picker. Single-field `createdAt` order needs no composite index.
 */
export function useAllCourses(enabled: boolean): CourseRow[] {
  return useAllCoursesState(enabled) ?? [];
}

/**
 * The same query, `null` until the first snapshot.
 *
 * An empty array cannot tell "there are none" from "none have arrived yet", and
 * one caller has to: the staff landing screen says "You are not assigned to any
 * courses yet" when the list is empty, and said it to everybody for the length
 * of a cold load. `useAllCourses` keeps the simpler shape for the callers that
 * only render rows.
 */
export function useAllCoursesState(enabled: boolean, scope?: string): CourseRow[] | null {
  return useLiveQuery<CourseRow[] | null>(
    () =>
      enabled
        ? query(collection(db, COLLECTIONS.courses), orderBy('createdAt', 'asc'))
        : null,
    [enabled],
    {
      label: 'allCourses',
      context: scope ? { scope } : undefined,
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('courses', d) })),
      empty: null,
    },
  );
}

/**
 * A course list AND where it came from — the cache, or the server.
 *
 * With IndexedDB persistence the first snapshot of a cold load is the cache,
 * and the work queue builds its `courseId in [...]` scope from it. The rules
 * judge every value of that scope against live data, so a course the reader
 * no longer runs — deleted, or they were taken off it while the browser was
 * closed — refuses the whole query until the server's snapshot corrects the
 * list. The queue needs to know which of those two it is holding, so this
 * variant asks for metadata changes and says so; the plain `State` hooks do
 * not, because every other screen only renders rows and the metadata
 * doubles the callbacks. `fromCache` starts true: before the first snapshot
 * nothing has been confirmed.
 */
export interface CourseSource {
  rows: CourseRow[] | null;
  fromCache: boolean;
}
const UNCONFIRMED: CourseSource = { rows: null, fromCache: true };

export function useAllCoursesSource(enabled: boolean, scope?: string): CourseSource {
  return useLiveQuery<CourseSource>(
    () =>
      enabled
        ? query(collection(db, COLLECTIONS.courses), orderBy('createdAt', 'asc'))
        : null,
    [enabled],
    {
      label: 'allCourses',
      context: scope ? { scope } : undefined,
      includeMetadataChanges: true,
      map: (snap) => ({
        rows: snap.docs.map((d) => ({ id: d.id, ...read('courses', d) })),
        fromCache: snap.metadata.fromCache,
      }),
      empty: UNCONFIRMED,
    },
  );
}

export function useMyCoursesSource(uid: string | null, scope?: string): CourseSource {
  return useLiveQuery<CourseSource>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.courses), where('managerUids', 'array-contains', uid))
        : null,
    [uid],
    {
      label: 'myCourses',
      context: scope ? { scope } : undefined,
      includeMetadataChanges: true,
      map: (snap) => ({
        rows: snap.docs.map((d) => ({ id: d.id, ...read('courses', d) })),
        fromCache: snap.metadata.fromCache,
      }),
      empty: UNCONFIRMED,
    },
  );
}

/**
 * The courses a manager is scoped to.
 *
 * The `array-contains` constraint is not a convenience — the security rule's
 * manager arm reads `resource.data.managerUids`, so Firestore rejects this
 * query without it. Dropping the constraint does not widen the results; it
 * fails the query outright.
 */
export function useMyCourses(uid: string | null): CourseRow[] {
  return useMyCoursesState(uid) ?? [];
}

/** The same query, `null` until the first snapshot — see `useAllCoursesState`. */
export function useMyCoursesState(uid: string | null, scope?: string): CourseRow[] | null {
  return useLiveQuery<CourseRow[] | null>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.courses), where('managerUids', 'array-contains', uid))
        : null,
    [uid],
    {
      label: 'myCourses',
      context: scope ? { scope } : undefined,
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('courses', d) })),
      empty: null,
    },
  );
}

/**
 * A roster comes back in DOCUMENT ID ORDER, which is arbitrary.
 *
 * Firestore cannot order these: the name lives on `students`, not on the
 * enrolment. So every consumer sorts once it has resolved the names — and every
 * one of them must, because the two screens this feeds are the attendance
 * register (marked once per student, per session, by hand) and the roster with
 * a remove button on each row. An arbitrary order there is a real chance of
 * marking or removing the wrong person.
 */
export function sortByName<T>(rows: T[], nameOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

/**
 * A class roster.
 *
 * Constrained to one courseId, which is also what makes the rule affordable:
 * its staff arm resolves a class lookup per row, and only a single-class query
 * lets that resolve one cached path.
 *
 *  `null` until the listener answers, so an empty sentence is never printed for
 *  a question not yet answered.
 */
export function useRosterState(courseId: string | null): EnrollmentRow[] | null {
  return useLiveQuery<EnrollmentRow[] | null>(
    () =>
      courseId
        ? query(collection(db, COLLECTIONS.enrollments), where('courseId', '==', courseId))
        : null,
    [courseId],
    {
      label: 'roster',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('enrollments', d) })),
      empty: null,
    },
  );
}

/**
 * Every enrollment of one student, across courses. Must carry the studentUid
 * constraint — the rule depends on resource.data, so Firestore rejects an
 * unconstrained list.
 *
 * Legal for the STUDENT THEMSELVES and for an ADMIN, and for nobody else. Both
 * satisfy the enrollments rule with zero document reads. A manager does not:
 * their arm resolves a course get() per row, so this query denies the moment the
 * student is in a course they do not run, and blows the per-query
 * document-access cap even when they run them all. A manager who needs this
 * inverts the loop — see useEnrollmentIn and StudentDetailScreen.
 */

/**
 * The `State` variant: `null` until the first snapshot. "You are not enrolled
 * in any classes yet" is the answer to a question the listener has not yet
 * answered, and a student's Classes tab said it on every cold load.
 */
export function useStudentEnrollmentsState(uid: string | null): EnrollmentRow[] | null {
  return useLiveQuery<EnrollmentRow[] | null>(
    () =>
      uid
        ? query(collection(db, COLLECTIONS.enrollments), where('studentUid', '==', uid))
        : null,
    [uid],
    {
      label: 'studentEnrollments',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('enrollments', d) })),
      empty: null,
    },
  );
}

/**
 * Is this one student in this one course? The manager's only legal way to ask.
 *
 * A QUERY, not a document get, and the difference is the whole point. The
 * enrollments rule's manager arm reads `resource.data.courseId`, and `resource`
 * is NULL for a document that does not exist — dereferencing it is a rules
 * evaluation error, so an absent enrollment comes back REFUSED rather than
 * "no such document". "Not enrolled" is the answer this asks for most of the
 * time, so a get here means a permission denial on nearly every row: a live-data
 * error banner and a Sentry event each time a manager opens a student's page.
 * The same trap is already spelled out on listeningProgress and completions in
 * firestore.rules; enrollments has no such get-the-missing-doc allowance because
 * whether a document exists there is itself the private fact.
 *
 * A list never evaluates against a null resource — absent rows simply do not come
 * back. Both equality filters are load-bearing: `courseId` is what constrains the
 * rule (every returned row resolves the SAME course get(), one access call
 * whatever the roster size), and `studentUid` is what keeps the answer to a
 * single row. Equality-only filters need no composite index.
 */
export function useEnrollmentIn(
  studentUid: string,
  courseId: string,
): { value: EnrollmentRow | null; resolved: boolean } {
  return useLiveQuery<{ value: EnrollmentRow | null; resolved: boolean }>(
    () =>
      query(
        collection(db, COLLECTIONS.enrollments),
        where('courseId', '==', courseId),
        where('studentUid', '==', studentUid),
      ),
    [courseId, studentUid],
    {
      label: 'studentEnrollment',
      map: (snap) => {
        const d = snap.docs[0];
        return { value: d ? { id: d.id, ...read('enrollments', d) } : null, resolved: true };
      },
      // A listener error leaves this unresolved, deliberately: "we could not find
      // out" is not "they are not enrolled", and the app-wide live-data banner is
      // already saying the truer thing.
      empty: { value: null, resolved: false },
    },
  );
}

const call = <T,>(name: string) => (input: T) => httpsCallable(functions, name)(input).then(() => undefined);

export const createCohort = call<{ name: string }>('createCohort');
export const setCohortArchived = call<{ cohortId: string; archived: boolean }>('setCohortArchived');
export const renameCohort = call<{ cohortId: string; name: string }>('renameCohort');
export const createCourse = call<{ cohortId: string; name: string }>('createCourse');
export const updateCourse =
  call<{ courseId: string; name?: string; archived?: boolean; archivedAccess?: boolean }>('updateCourse');
export const setCourseManagers = call<{ courseId: string; managerUids: string[] }>('setCourseManagers');
export const createEnrollment = call<{ studentUid: string; courseId: string }>('createEnrollment');
export const setEnrollmentActive =
  call<{ studentUid: string; courseId: string; active: boolean }>('setEnrollmentActive');
