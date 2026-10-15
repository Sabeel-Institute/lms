import { useMemo } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  AUDIT_PAGE,
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  QUEUE_SCOPE,
  attendanceGroups,
  attendanceReport,
  effectiveCompletion,
  isVisibleToStudents,
  listenedShare,
  rollup,
  type AssignmentDoc,
  type AttendanceReport,
  type AttendanceStatus,
  type AuditEntryDoc,
  type CourseAccess,
  type LedgerRollup,
  type StoredCollection,
  type StoredDocs,
} from '@sabeel/shared';
import { db, functions } from './firebase';
import { useListenerFailed, useLiveQuery } from './liveQuery';
import { useStudentsState } from './students';
import { useCourseSessionsState } from './sessions';
import { useRosterState, type CourseRow, type EnrollmentRow } from './structure';
import type { RecordingRow } from './recordings';
import type { SessionRow } from './sessions';
import { read } from './documents';

// --------------------------------------------------------------- callables --

const call = <I,>(name: string) => (input: I) =>
  httpsCallable(functions, name)(input).then(() => undefined);

export const overrideCompletion = call<{
  studentUid: string;
  recordingId: string;
  completed: boolean;
  reason: string;
}>('overrideCompletion');

export const clearCompletionOverride = call<{
  studentUid: string;
  recordingId: string;
  reason: string;
}>('clearCompletionOverride');

// ------------------------------------------------------- per-recording reads --
//
// EVERY staff read here MUST pin `courseId`, and being "class-scoped by nature"
// is not the same thing. The staff arm of these collections resolves
// `get(/courses/$(resource.data.courseId))`, and Firestore evaluates a `list`
// rule against the QUERY's constraints, not only against the documents it would
// return: unless the query pins `courseId`, that path is unresolvable and the
// listen is refused outright — even when it would have returned nothing.
//
// A `recordingId ==` filter does not pin it. One recording does belong to one
// class, but Firestore cannot know that, so it cannot collapse the lookup. That
// mistake shipped: the recording ledger read `recordingId ==` alone, and every
// one of its four listeners was denied for every MANAGER on every recording,
// while admins saw nothing wrong (their arm reads no documents and depends on no
// `resource.data`). See the shape assertions in rules.ledger.test.ts.

function useScopedMap<C extends StoredCollection, V>(
  label: string,
  coll: C,
  /** The course scope the rules require. Null until it is known. */
  courseId: string | null,
  /** Narrows the course scope to one recording; null reads the whole course. */
  recordingId: string | null,
  pick: (data: StoredDocs[C], pending: boolean) => V,
  keyOf: (data: StoredDocs[C]) => string,
  metadata = false,
) {
  return useLiveQuery<Map<string, V>>(
    () =>
      courseId
        ? query(
            collection(db, coll),
            where('courseId', '==', courseId),
            ...(recordingId ? [where('recordingId', '==', recordingId)] : []),
          )
        : null,
    // coll is a constant at every call site today, so listing it changes nothing
    // at runtime — but the query reads it, and a wrapper whose dep list quietly
    // under-reports its inputs is how a subscription ends up serving another
    // collection's data after a refactor.
    [courseId, recordingId, coll],
    {
      label: label,
      map: (snap) => {
        const m = new Map<string, V>();
        for (const d of snap.docs) {
          const data = read(coll, d);
          m.set(keyOf(data), pick(data, d.metadata.hasPendingWrites));
        }
        return m;
      },
      empty: new Map(),
      includeMetadataChanges: metadata,
    },
  );
}

/**
 * The one-of-three filter both ledgers offer, and its words.
 *
 * ONE DECLARATION, because the two screens are the same question asked of a
 * recording and of a student, and the pair had drifted before: a label spelled
 * in a ternary on each screen, with the note "the same order as the recording
 * ledger's" standing in for anything that would notice if it stopped being.
 *
 * "Missed", never "overdue": once the deadline passes access has closed, so the
 * work is not still outstanding. The word matches the course detail, the
 * student's own home and the workbooks.
 */
export type LedgerFilter = 'all' | 'notComplete' | 'missed';

export const LEDGER_FILTERS: { value: LedgerFilter; label: string }[] = [
  { value: 'notComplete', label: 'Not complete' },
  { value: 'missed', label: 'Missed' },
  { value: 'all', label: 'All' },
];

export interface LedgerRow {
  studentUid: string;
  name: string;
  /** Null for everyone without a grant — attendees, absentees, other listeners. */
  dueDate: string | null;
  completed: boolean;
  source: 'override' | 'student' | 'none';
  overrideReason?: string;
  /** Null when they have listened but the recording's length is unknown. */
  listenedPct: number | null;
  lastListened: number | null;
  completedAt: number | null;
  pending: boolean;
  /** How the session recorded this student: 'excused' for the accountable set,
   *  'present'/'absent' for the rest of the roster, null for someone outside the
   *  snapshot. */
  attendance: AttendanceStatus | null;
}

/** An accountable row always came from a grant, so it always has a deadline. */
export type RequiredRow = LedgerRow & { dueDate: string };

export interface RecordingLedger {
  /**
   * No grant snapshot has arrived yet — so every group below is provisional.
   *
   * Distinct from "nobody holds this recording", which is news and is what the
   * screen says when this is false and `accountable` is empty.
   */
  loading: boolean;
  /** A listener was refused, so the roster will never arrive. Not `loading`. */
  failed: boolean;
  /** Excused, so granted the recording and required to listen — the only people
   *  who can open it at all. On a recording that is no longer published these
   *  are the grants as they stood when it closed: the term's record. */
  accountable: RequiredRow[];
  /** Present at the session: nothing required, and no access either. */
  attendees: LedgerRow[];
  /** Absent without being excused: nothing required, and no access. Listed so a
   *  ledger still accounts for the whole submitted roster. */
  absentees: LedgerRow[];
  /** Excused at the session but holding no active grant — unenrolled from the
   *  class, or corrected out of the roster. Deactivating keeps the attendance
   *  marks, so without this group they would appear in no section at all. */
  lapsed: LedgerRow[];
  /** Listened without holding a current grant — e.g. excused, listened, then
   *  corrected to present. Evidence, not accountability. */
  otherListeners: LedgerRow[];
  rollup: LedgerRollup;
}

/**
 * The recording ledger: the granted roster joined with completion, override, and
 * listening progress, split against the session's attendance into the excused
 * (who owe it), the present and the absent (who do not, and cannot open it), and
 * the excused whose grant has since lapsed. Every uid the session recorded lands
 * in exactly one group, which is what lets the screen claim to account for the
 * whole submitted roster. Every read is `courseId == && recordingId ==` — the
 * course scope is what the staff rules require, not an optimisation (see the
 * note on useScopedMap); the join and the counts are pure.
 */
export function useRecordingLedger(
  recording: RecordingRow,
  session: SessionRow,
  /** Its class: a date that ran out while the class's recordings were closed is not missed. */
  cls: CourseAccess,
  today: string,
): RecordingLedger {
  const rid = recording.id;
  // The course scope every read below carries — see the note on useScopedMap.
  const cid = recording.courseId;
  /*
   * `null` UNTIL THE FIRST SNAPSHOT — not an empty Map.
   *
   * THE GRANTS ARE WHAT THIS SCREEN IS. `accountable` is built from them and
   * `lapsed` is everyone excused who is NOT in them, so an empty Map standing in
   * for "nothing has arrived yet" does not read as a blank screen: it reads as
   * `Required 0 / Completed 0 / Missed 0`, "Nobody holds this recording now —
   * every grant from this session has lapsed", and an "Excused, access closed"
   * section naming the whole class and explaining they were unenrolled or the
   * recording was pulled. A confident, fully-formed, wrong answer, shown for the
   * length of every cold load on the one screen staff consult to decide who to
   * chase.
   */
  /*
   * EVERY GRANT THE RECORDING EVER MADE, active or not. While the recording is
   * published the active ones are the accountable roster and the rest are
   * lapsed; once it is archived or unpublished the fan-out has switched them
   * ALL off, and a read of active grants alone rendered the term's record as
   * `Required 0 / Missed 0` over a sentence about every grant having lapsed —
   * on the one screen that exists to say who listened and who missed, at the
   * one moment (the term's end) it is consulted for that. The rows are still
   * course-pinned, which is what the staff rules require.
   */
  const assignments = useLiveQuery<Map<string, AssignmentDoc> | null>(
    () =>
      query(
        collection(db, COLLECTIONS.assignments),
        where('courseId', '==', cid),
        where('recordingId', '==', rid),
      ),
    [cid, rid],
    {
      label: 'ledgerAssignments',
      map: (snap) => new Map(snap.docs.map((d) => [read('assignments', d).studentUid, read('assignments', d)])),
      empty: null,
    },
  );
  const completions = useScopedMap(
    'ledgerCompletions',
    COLLECTIONS.completions,
    cid,
    rid,
    (d, pending) => ({ completed: d.completed, completedAt: d.completedAt, pending }),
    (d) => d.studentUid,
    true,
  );
  const overrides = useScopedMap(
    'ledgerOverrides',
    COLLECTIONS.completionOverrides,
    cid,
    rid,
    (d) => d,
    (d) => d.studentUid,
  );
  const progress = useScopedMap(
    'ledgerProgress',
    COLLECTIONS.listeningProgress,
    cid,
    rid,
    (d) => ({ listenedMs: d.listenedMs, updatedAt: d.updatedAt }),
    (d) => d.studentUid,
  );
  // NAMES BEFORE ROWS: drawn first, the rows were 28-character account ids
  // in id order, re-sorted by name a moment later under a teacher's finger.
  const students = useStudentsState(true);
  const nameByUid = useMemo(() => new Map((students ?? []).map((s) => [s.uid, s.displayName])), [students]);
  // The four listeners this join reads. Matched on the LABEL, so a refusal on
  // any of them ends the loading state rather than leaving it for ever.
  const failed = useListenerFailed([
    'ledgerAssignments',
    'ledgerCompletions',
    'ledgerOverrides',
    'ledgerProgress',
    'students',
  ]);

  return useMemo(() => {
    const row = (
      studentUid: string,
      dueDate: string | null,
      attendance: AttendanceStatus | null,
    ): LedgerRow => {
      const c = completions.get(studentUid);
      const o = overrides.get(studentUid);
      const eff = effectiveCompletion(c, o);
      const p = progress.get(studentUid);
      return {
        studentUid,
        name: nameByUid.get(studentUid) ?? studentUid,
        dueDate,
        completed: eff.completed,
        source: eff.source,
        overrideReason: eff.reason,
        listenedPct: p ? listenedShare(p.listenedMs, recording.durationSec) : 0,
        lastListened: p?.updatedAt ?? null,
        completedAt: c?.completedAt ?? null,
        pending: c?.pending ?? false,
        attendance,
      };
    };

    /*
     * THREE STATES, NOT TWO — and conflating any pair of them puts a confident
     * wrong answer on the screen staff use to decide who to chase.
     *
     *   unknown  the grants have not arrived. Nothing below is settled.
     *   failed   a listener was refused. Also unknown, and it will stay that way.
     *   neither  the roster is what it says.
     *
     * `useLiveQuery` resets to `empty` on a listener error as well as before the
     * first snapshot, so `null` alone cannot tell the first two apart: reading it
     * as "still loading" leaves a refused manager on "Checking…" for ever, and
     * reading it as "loaded, and empty" renders `Required 0 / Completed 0 /
     * Missed 0` over an "Excused, access closed" section naming the whole class.
     * Both have shipped here. The groups derived by ABSENCE stay empty for
     * either, and the screen says which one it is.
     */
    const unknown = assignments === null || students === null;
    const loading = unknown && !failed;
    /*
     * WHICH GRANTS COUNT. Published: the active ones — a grant switched off
     * while the recording is live was withdrawn (unenrolled, corrected out),
     * and its holder belongs under "access closed". Not published: every one,
     * because the recording's closing is what switched them off, and the
     * record of who had finished and who had missed by then is the point.
     */
    const closed = !isVisibleToStudents(recording.status);
    const granted = new Map<string, AssignmentDoc>();
    for (const [uid, a] of assignments ?? []) if (closed || a.active) granted.set(uid, a);
    const status = session.attendance;
    // Re-stating dueDate after the spread is what narrows the row to a
    // RequiredRow: the grant it came from always carries one.
    const accountable: RequiredRow[] = [...granted.values()]
      .map((a) => ({ ...row(a.studentUid, a.dueDate, status[a.studentUid] ?? 'excused'), dueDate: a.dueDate }))
      // Not-yet-complete first, then by name. Every row here is excused, so
      // there is no longer a second attendance status to order within.
      .sort((x, y) => Number(x.completed) - Number(y.completed) || x.name.localeCompare(y.name));

    const { present, absent, excused } = attendanceGroups(status);
    const byName = (x: LedgerRow, y: LedgerRow) => x.name.localeCompare(y.name);
    const attendees = present.map((uid) => row(uid, null, 'present')).sort(byName);
    const absentees = absent.map((uid) => row(uid, null, 'absent')).sort(byName);
    // Excused, but the grant that came with it is no longer active — or was
    // never made. `accountable` holds the grants that count (above), so
    // unenrolling a student or correcting them out drops them out of it while
    // the session still says they were excused — and they belong to neither
    // present nor absent.
    // EMPTY WHILE THE GRANTS ARE UNKNOWN. Both this group and `otherListeners`
    // are defined by ABSENCE from `granted`, so without them they are
    // "everyone" — and each carries a notice stating a cause ("unenrolled, or
    // this recording was unpublished") that has not happened. A section that is
    // briefly missing is a loading screen; a section that accuses the whole
    // class of having lost access is not.
    const lapsed = unknown
      ? []
      : excused
          .filter((uid) => !granted.has(uid))
          .map((uid) => row(uid, null, 'excused'))
          .sort(byName);

    // Anyone with real listening/completion who holds no current grant and is
    // not in the snapshot — e.g. excused and listening, then corrected out.
    const known = new Set<string>([...granted.keys(), ...present, ...absent, ...excused]);
    const otherUids = new Set<string>();
    for (const [uid, c] of completions.entries()) if (c.completed && !known.has(uid)) otherUids.add(uid);
    for (const uid of progress.keys()) if (!known.has(uid)) otherUids.add(uid);
    const otherListeners = unknown ? [] : [...otherUids].map((uid) => row(uid, null, null));

    return {
      loading,
      failed: unknown && failed,
      accountable,
      attendees,
      absentees,
      lapsed,
      otherListeners,
      rollup: rollup(
        accountable.map((r) => ({ completed: r.completed, dueDate: r.dueDate })),
        today,
        cls,
        INSTITUTE_TIMEZONE,
      ),
    };
  }, [
    cls,
    assignments,
    students,
    failed,
    completions,
    overrides,
    progress,
    nameByUid,
    recording.durationSec,
    recording.status,
    session.attendance,
    today,
  ]);
}

// ------------------------------------------------------------ class-level ---

export interface CourseAssignmentItem {
  studentUid: string;
  recordingId: string;
  completed: boolean;
  dueDate: string;
}

export interface CourseLedger {
  /** Whether the grants have arrived. Until they have, `rollup` is three zeros
   *  — the exact wrong answer the course page used to state as fact. */
  resolved: boolean;
  /** rollup across every active assignment in the class. */
  rollup: LedgerRollup;
  /** per-recording { complete, total } for the recordings list. */
  byRecording: Map<string, { complete: number; total: number }>;
  /** every active assignment reduced to its effective completion (for the report). */
  items: CourseAssignmentItem[];
}

/**
 * Course-level counts: every active assignment in the class, its effective
 * completion, rolled up whole-class and per-recording. `courseId ==` reads.
 */
export function useCourseLedger(cls: CourseRow, today: string): CourseLedger {
  const courseId = cls.id;
  const granted = useLiveQuery<AssignmentDoc[] | null>(
    () =>
      courseId
        ? query(
            collection(db, COLLECTIONS.assignments),
            where('courseId', '==', courseId),
            where('active', '==', true),
          )
        : null,
    [courseId],
    {
      label: 'courseLedgerAssignments',
      map: (snap) => snap.docs.map((d) => read('assignments', d)),
      empty: null,
    },
  );
  const assignments = granted ?? NO_ASSIGNMENTS;
  const completions = useScopedMap(
    'courseLedgerCompletions',
    COLLECTIONS.completions,
    courseId,
    null,
    (d) => d.completed,
    (d) => `${d.studentUid}_${d.recordingId}`,
  );
  const overrides = useScopedMap(
    'courseLedgerOverrides',
    COLLECTIONS.completionOverrides,
    courseId,
    null,
    (d) => d,
    (d) => `${d.studentUid}_${d.recordingId}`,
  );

  return useMemo(() => {
    const items: CourseAssignmentItem[] = assignments.map((a) => {
      const key = `${a.studentUid}_${a.recordingId}`;
      const c = completions.get(key);
      const eff = effectiveCompletion(c === undefined ? undefined : { completed: c }, overrides.get(key));
      return { studentUid: a.studentUid, recordingId: a.recordingId, completed: eff.completed, dueDate: a.dueDate };
    });
    const byRecording = new Map<string, { complete: number; total: number }>();
    for (const it of items) {
      const cur = byRecording.get(it.recordingId) ?? { complete: 0, total: 0 };
      cur.total++;
      if (it.completed) cur.complete++;
      byRecording.set(it.recordingId, cur);
    }
    return { resolved: granted !== null, rollup: rollup(items, today, cls, INSTITUTE_TIMEZONE), byRecording, items };
  }, [granted, assignments, completions, overrides, today, cls]);
}

const NO_ASSIGNMENTS: AssignmentDoc[] = [];

// --------------------------------------------------------- attendance report --

/**
 * A course's attendance report: sessions + roster + the active catch-up
 * assignments, aggregated by the pure `attendanceReport`. Composes existing
 * live reads (no new listener shapes), so the security rules already cover it.
 */
export function useCourseAttendance(
  cls: CourseRow,
  today: string,
): AttendanceReport & { resolved: boolean } {
  const courseId = cls.id;
  // The `State` variants: "0 of 0 sessions taken" and "Nobody is enrolled"
  // are answers, and the report gave them for the length of every cold load.
  const sessionsState = useCourseSessionsState(courseId);
  const rosterState = useRosterState(courseId);
  const sessions = sessionsState ?? NO_SESSIONS;
  const roster = rosterState ?? NO_ROSTER;
  const { items, resolved: grantsResolved } = useCourseLedger(cls, today);
  const resolved = sessionsState !== null && rosterState !== null && grantsResolved;

  return useMemo(
    () => ({
      ...attendanceReport({
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          date: s.date,
          attendance: s.attendance,
          attendanceSubmittedAt: s.attendanceSubmittedAt,
        })),
        // Every enrolment, past ones included: a register counts as not
        // marked for someone only inside their time in the class.
        enrollments: roster,
        assignments: items.map((i) => ({ studentUid: i.studentUid, completed: i.completed, dueDate: i.dueDate })),
        course: cls,
        today,
        timeZone: INSTITUTE_TIMEZONE,
      }),
      resolved,
    }),
    [sessions, roster, items, cls, today, resolved],
  );
}

const NO_SESSIONS: SessionRow[] = [];
const NO_ROSTER: EnrollmentRow[] = [];

// -------------------------------------------------------------- student ledger --

export interface StudentLedgerItem {
  recordingId: string;
  dueDate: string;
  completed: boolean;
  source: 'override' | 'student' | 'none';
  overrideReason?: string;
}

/**
 * One student's obligations in one class. Reads are `studentUid == uid &&
 * courseId == X` — two equalities, class-scoped, so the staff rules accept them.
 * The screen supplies recording titles from `useCourseRecordings`.
 */
export function useStudentLedger(studentUid: string | null, courseId: string): StudentLedgerItem[] | null {
  // `null` until the grants have arrived: "No required recordings here" is a
  // claim about the student, and the page said it on every cold load.
  const assignments = useLiveQuery<AssignmentDoc[] | null>(
    () =>
      studentUid
        ? query(
            collection(db, COLLECTIONS.assignments),
            where('studentUid', '==', studentUid),
            where('courseId', '==', courseId),
          )
        : null,
    [studentUid, courseId],
    {
      label: 'studentLedgerAssignments',
      map: (snap) => snap.docs.map((d) => read('assignments', d)).filter((a) => a.active),
      empty: null,
    },
  );
  const completions = useStudentCourseMap(
    'studentLedgerCompletions',
    COLLECTIONS.completions,
    studentUid,
    courseId,
    (d) => d.completed,
  );
  const overrides = useStudentCourseMap(
    'studentLedgerOverrides',
    COLLECTIONS.completionOverrides,
    studentUid,
    courseId,
    (d) => d,
  );

  return useMemo(
    () =>
      assignments === null
        ? null
        : assignments.map((a) => {
            const c = completions.get(a.recordingId);
            const eff = effectiveCompletion(c === undefined ? undefined : { completed: c }, overrides.get(a.recordingId));
            return {
              recordingId: a.recordingId,
              dueDate: a.dueDate,
              completed: eff.completed,
              source: eff.source,
              overrideReason: eff.reason,
            };
          }),
    [assignments, completions, overrides],
  );
}

function useStudentCourseMap<C extends 'completions' | 'completionOverrides', V>(
  label: string,
  coll: C,
  studentUid: string | null,
  courseId: string,
  pick: (data: StoredDocs[C]) => V,
) {
  return useLiveQuery<Map<string, V>>(
    () =>
      studentUid
        ? query(
            collection(db, coll),
            where('studentUid', '==', studentUid),
            where('courseId', '==', courseId),
          )
        : null,
    // `coll` for the same reason as useScopedMap: the query reads it.
    [studentUid, courseId, coll],
    {
      label: label,
      map: (snap) =>
        new Map(
          snap.docs.map((d) => {
            const data = read(coll, d);
            return [data.recordingId, pick(data)];
          }),
        ),
      empty: new Map(),
    },
  );
}

// --------------------------------------------------------------- audit read --

export interface AuditRow extends AuditEntryDoc {
  id: string;
}

/**
 * What this staff member has done, wherever they did it.
 *
 * A manager's class-scoped view cannot show a course-less entry, and creating a
 * student account without naming a course produces exactly one — so the most
 * privilege-adjacent thing a manager can do was invisible to the manager who did
 * it. This is the other half: their own actions, by `actorUid`, needing no class
 * lookup and disclosing nothing they did not perform.
 */
export function useMyAudit(uid: string | null): AuditRow[] {
  return useLiveQuery<AuditRow[]>(
    () =>
      uid
        ? query(
            collection(db, COLLECTIONS.auditLog),
            where('actorUid', '==', uid),
            orderBy('at', 'desc'),
            limit(AUDIT_PAGE),
          )
        : null,
    [uid],
    {
      label: 'myAudit',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('auditLog', d) })),
      empty: [],
    },
  );
}

/**
 * The audit log, newest first. A manager passes their courseId (scoped read); an
 * admin passes null for the unconstrained global view.
 *
 *  `null` until the listener answers, so an empty sentence is never printed for
 *  a question not yet answered.
 */
export function useAuditState(courseId: string | null, enabled = true): AuditRow[] | null {
  return useLiveQuery<AuditRow[] | null>(
    () =>
      !enabled
        ? null
        : courseId === null
          ? query(collection(db, COLLECTIONS.auditLog), orderBy('at', 'desc'), limit(AUDIT_PAGE))
          : query(
              collection(db, COLLECTIONS.auditLog),
              where('courseId', '==', courseId),
              orderBy('at', 'desc'),
              limit(AUDIT_PAGE),
            ),
    [courseId, enabled],
    {
      label: 'audit',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('auditLog', d) })),
      empty: null,
    },
  );
}

/**
 * Everything the log holds about one student, newest first — an ADMIN's read.
 *
 * One query, on the key every action on a student carries: `createStudent`,
 * `setStudentAccess` and both enrolment callables all name the student under
 * `targets.studentUid`. The admin arm of the audit rule reads no documents, so
 * the query needs no other constraint. `studentHistory` turns the rows into the
 * page's sentences.
 */
export function useStudentAudit(studentUid: string | null): AuditRow[] {
  return useLiveQuery<AuditRow[]>(
    () =>
      studentUid
        ? query(
            collection(db, COLLECTIONS.auditLog),
            where('targets.studentUid', '==', studentUid),
            orderBy('at', 'desc'),
            limit(AUDIT_PAGE),
          )
        : null,
    [studentUid],
    {
      label: 'studentAudit',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('auditLog', d) })),
      empty: [],
    },
  );
}

/**
 * The same history, as a MANAGER may read it: pinned to the courses they run.
 *
 * The manager arm of the audit rule resolves a course lookup from each row, so
 * the query has to say which courses — an `in` over their ids, the shape the
 * work queue sends, and bounded the same way (`QUEUE_SCOPE.manager`, the
 * per-query document-access ceiling). What it cannot reach is deliberate: a
 * class-less row such as an access change is admin-only, and an enrolment in a
 * course they do not run is not theirs to see. `truncated` says when the bound
 * bit, so the page can say the history is partial rather than let it read as
 * whole.
 */
export function useStudentAuditIn(
  studentUid: string | null,
  courseIds: readonly string[],
): { rows: AuditRow[]; truncated: boolean } {
  // A string first, the array from it — a stable subscription input from a
  // course list that is a new array on every snapshot (see `useTodayQueue`).
  const key = [...courseIds].sort().slice(0, QUEUE_SCOPE.manager).join(',');
  const scope = useMemo(() => (key ? key.split(',') : []), [key]);
  const rows = useLiveQuery<AuditRow[]>(
    () =>
      studentUid && scope.length > 0
        ? query(
            collection(db, COLLECTIONS.auditLog),
            where('courseId', 'in', scope),
            where('targets.studentUid', '==', studentUid),
            orderBy('at', 'desc'),
            limit(AUDIT_PAGE),
          )
        : null,
    [studentUid, scope],
    {
      label: 'studentAuditScoped',
      map: (snap) => snap.docs.map((d) => ({ id: d.id, ...read('auditLog', d) })),
      empty: [],
    },
  );
  return { rows, truncated: courseIds.length > QUEUE_SCOPE.manager };
}
