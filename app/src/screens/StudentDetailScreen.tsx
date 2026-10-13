import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { INSTITUTE_TIMEZONE, QUEUE_SCOPE, stampInZone } from '@sabeel/shared';
import {
  Button,
  Card,
  Empty,
  Grid,
  ListRow,
  Notice,
  Row,
  Screen,
  SectionTitle,
  StatusChip,
} from '../components/ui';
import { resendPasswordSetup, setStudentAccess, useStudentState, type StudentRow } from '../students';
import { useDecidedStaff } from '../staff';
import { useStudentAudit, useStudentAuditIn } from '../ledger';
import { studentHistory } from '../studentHistory';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import { exportStudentWorkbook } from '../workbookData';
import {
  useAllCoursesState,
  useCohortName,
  useEnrollmentIn,
  useMyCoursesState,
  useStudentEnrollmentsState,
  type CourseRow,
  type EnrollmentRow,
} from '../structure';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const NO_COURSES: CourseRow[] = [];
const NO_ENROLLMENTS: EnrollmentRow[] = [];

/**
 * One student, everything about them in one place: their access, and the courses
 * they are in.
 *
 * WHAT A MANAGER SEES IS DIFFERENT, and deliberately so. There is no query for
 * "this student's courses" that a manager may run: the enrollments rule resolves
 * a course get() per row, so a cross-course studentUid query denies as soon as
 * the student is in a class they do not run. Inverting the loop — start from the
 * courses they manage, then ask about one course at a time — is both the only
 * legal shape AND the right product answer, since a manager is scoped class by
 * class and a partial list that read as complete would be worse than an honest
 * one. The heading says which they are looking at.
 */
export function StudentDetailScreen({
  studentUid,
  isAdmin,
  uid,
  onOpenCourse,
}: {
  studentUid: string;
  isAdmin: boolean;
  /** The signed-in staff member, for the manager's course list. */
  uid: string;
  onOpenCourse: (cls: CourseRow) => void;
}) {
  const studentState = useStudentState(studentUid);
  const student = studentState.value;
  const { active: busy, run: once } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const run = (key: string, fn: () => Promise<void>) =>
    once(key, async () => {
      setError(null);
      setInfo(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      }
    });

  const who = student?.displayName ?? '';
  const disabled = student?.status === 'disabled';

  return (
    <Screen
      title={who}
      subtitle={student?.email}
      status={student ? student.status : undefined}
      width="list"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {info ? <Notice tone="success">{info}</Notice> : null}

      {!student ? (
        <Empty>
          {studentState.resolved
            ? 'That student is not available. They may have been removed.'
            : 'Loading…'}
        </Empty>
      ) : (
        <>
          <SectionTitle>Access</SectionTitle>
          <Card>
            {/* A Row, like every other action pair in the app. Straight into the
                Card they stacked at the left of an 1114px card, two different
                widths, while the equivalent pair on a course sits side by side. */}
            <Row>
              {/* Everything about this student, across the courses the reader
                  may see, in one .xlsx — the student's counterpart of the
                  course workbook. */}
              <Button
                testID="student-export-workbook"
                label="Export workbook"
                variant="secondary"
                busy={busy === 'export'}
                onPress={() => void run('export', () => exportStudentWorkbook(student, uid, isAdmin))}
              />
              <Button
                testID="student-resend"
                label="Resend password link"
                variant="secondary"
                busy={busy === 'resend'}
                onPress={() =>
                  void run('resend', async () => {
                    await resendPasswordSetup(student.email);
                    setInfo(`Password link sent to ${student.email}.`);
                  })
                }
              />
              {/* Enable/disable is directory-level — it spans every course — so
                  the server keeps it admin-only. A manager sees the state, not a
                  control that would only fail. */}
              {isAdmin ? (
                <Button
                  testID="student-access"
                  // Secondary in BOTH directions, like archiving a course.
                  // Disabling is the reversible, recommended action in this
                  // product; dressing it as destructive is how people learn to
                  // ignore the colour that marks the genuinely irreversible ones.
                  label={disabled ? 'Re-enable account' : 'Disable account'}
                  variant="secondary"
                  busy={busy === 'access'}
                  onPress={() =>
                    void run('access', () =>
                      setStudentAccess({
                        uid: studentUid,
                        status: disabled ? 'active' : 'disabled',
                      }),
                    )
                  }
                />
              ) : null}
            </Row>
            {/* BELOW the row, not inside it. A Row cell is 150px of action; a
                sentence dropped into one is a paragraph squeezed into half a
                card beside a button. */}
            {isAdmin ? null : (
              <Empty>
                {disabled
                  ? 'This account is disabled. An admin can re-enable it.'
                  : 'Only an admin can disable an account.'}
              </Empty>
            )}
          </Card>

          {isAdmin ? (
            <AdminCourses studentUid={studentUid} who={who} onOpenCourse={onOpenCourse} />
          ) : (
            <ManagerCourses studentUid={studentUid} uid={uid} who={who} onOpenCourse={onOpenCourse} />
          )}

          <History student={student} isAdmin={isAdmin} uid={uid} />
        </>
      )}
    </Screen>
  );
}

/**
 * When the account was made, and everything that has happened to the student's
 * standing since — enrolled, removed, brought back, disabled, re-enabled — each
 * with who did it and when.
 *
 * The first row is the student document's own `createdAt`, which every student
 * has. The rest is the audit log, which is the record of these changes and is
 * not copied anywhere else (see `studentHistory`). An admin reads it by the
 * student; a manager reads it pinned to the courses they run, and is told so —
 * an access change is admin-only, and an enrolment in someone else's course is
 * not theirs, so a manager's list is a true account of their own courses rather
 * than a partial one that reads as whole.
 */
function History({ student, isAdmin, uid }: { student: StudentRow; isAdmin: boolean; uid: string }) {
  const staff = useDecidedStaff(true);
  // The `State` variants, whose "not subscribed" value is a stable `null`
  // rather than a fresh `[]` per render — these feed memos below.
  const allCourses = useAllCoursesState(isAdmin) ?? NO_COURSES;
  const myCourses = useMyCoursesState(isAdmin ? null : uid) ?? NO_COURSES;
  const courses = isAdmin ? allCourses : myCourses;
  const cohortNameOf = useCohortName();
  const adminRows = useStudentAudit(isAdmin ? student.uid : null);
  const myCourseIds = useMemo(() => myCourses.map((c) => c.id), [myCourses]);
  const scoped = useStudentAuditIn(isAdmin ? null : student.uid, myCourseIds);

  // Names, not uids, for the same reason the audit screen resolves them: an id
  // answers "who" with a string nobody can match to a person. One that no
  // longer resolves — a staff account since removed — is still printed.
  const nameOf = useMemo(() => {
    const byUid = new Map(staff.map((r) => [r.uid, r.displayName]));
    return (actorUid: string) => byUid.get(actorUid) ?? actorUid;
  }, [staff]);
  const courseLabel = useMemo(() => {
    const byId = new Map(courses.map((c) => [c.id, c]));
    return (courseId: string) => {
      const c = byId.get(courseId);
      if (!c) return courseId;
      const cohort = cohortNameOf(c.cohortId);
      return cohort ? `${c.name} · ${cohort}` : c.name;
    };
  }, [courses, cohortNameOf]);
  const rows = useMemo(
    () => studentHistory(isAdmin ? adminRows : scoped.rows, courseLabel),
    [isAdmin, adminRows, scoped.rows, courseLabel],
  );

  return (
    <>
      <SectionTitle>History</SectionTitle>
      <Card>
        {isAdmin ? null : (
          <Text style={styles.historyLede}>Enrolment changes in the courses you manage.</Text>
        )}
        {scoped.truncated ? (
          <Notice tone="info">
            Changes in {QUEUE_SCOPE.manager} of the {myCourseIds.length} courses you manage are
            listed; the rest are not.
          </Notice>
        ) : null}
        <View testID="student-history">
          <HistoryRow
            testID="student-created"
            what="Account created"
            at={student.createdAt}
            by={nameOf(student.createdBy)}
            first
          />
          {rows.map((r) => (
            <HistoryRow
              key={r.id}
              testID={`student-history-${r.id}`}
              what={r.what}
              at={r.at}
              by={nameOf(r.actorUid)}
            />
          ))}
        </View>
      </Card>
    </>
  );
}

function HistoryRow({
  what,
  at,
  by,
  first,
  testID,
}: {
  what: string;
  at: number;
  by: string;
  first?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.historyRow, first ? null : styles.historyRowRule]}>
      <Text style={styles.historyWhat}>{what}</Text>
      {/* The institute's clock, like every date in the app — see `stampInZone`. */}
      <Text style={styles.historyWhen}>
        {stampInZone(INSTITUTE_TIMEZONE, at)} · by {by}
      </Text>
    </View>
  );
}

/** Admin: one query for the student's enrollments, joined to the course list. */
function AdminCourses({
  studentUid,
  who,
  onOpenCourse,
}: {
  studentUid: string;
  who: string;
  onOpenCourse: (cls: CourseRow) => void;
}) {
  // Both `State` variants: a row needs its enrolment AND its course, and
  // "Not enrolled in any course yet" is a claim about the student that the
  // page made for the length of every cold load.
  const enrollmentsState = useStudentEnrollmentsState(studentUid);
  const coursesState = useAllCoursesState(true);
  const enrollments = enrollmentsState ?? NO_ENROLLMENTS;
  const courses = coursesState ?? NO_COURSES;
  const checking = enrollmentsState === null || coursesState === null;
  const cohortNameOf = useCohortName();
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const rows = useMemo(
    () =>
      enrollments
        .map((e) => ({ enrollment: e, course: byId.get(e.courseId) }))
        .filter((r): r is { enrollment: typeof r.enrollment; course: CourseRow } => !!r.course),
    [enrollments, byId],
  );

  return (
    <>
      <SectionTitle>Courses{checking ? '' : ` (${rows.length})`}</SectionTitle>
      {/* IN A GRID, like every other collection. Mapped straight into the screen
          these were the only list rows in the app that never flowed into
          columns — two 1114px bars each holding a course name and a status
          lamp, on a `list`-width page whose whole point is the columns. */}
      {checking ? (
        <Empty>Checking their courses…</Empty>
      ) : rows.length === 0 ? (
        <Empty>Not enrolled in any course yet.</Empty>
      ) : (
        <Grid min={330}>
          {rows.map((r) => (
            <CourseEnrollmentRow
              key={r.enrollment.id}
              course={r.course}
              cohortName={cohortNameOf(r.course.cohortId)}
              active={r.enrollment.active}
              who={who}
              onOpenCourse={onOpenCourse}
            />
          ))}
        </Grid>
      )}
    </>
  );
}

/**
 * Manager: start from the courses they run and read one enrollment document per
 * course. One subscription per course, held by a child component — the only way
 * to have a variable number of live reads without breaking the rules of hooks.
 */
function ManagerCourses({
  studentUid,
  uid,
  who,
  onOpenCourse,
}: {
  studentUid: string;
  uid: string;
  who: string;
  onOpenCourse: (cls: CourseRow) => void;
}) {
  const coursesState = useMyCoursesState(uid);
  const courses = coursesState ?? NO_COURSES;
  const cohortNameOf = useCohortName();
  // Only the rows know whether they matched — each owns its own enrollment
  // listener, because one read per managed course is the only shape a manager
  // may issue. So they report back; without it a student in none of these
  // courses left the heading standing over nothing.
  const [enrolledIn, setEnrolledIn] = useState<Record<string, boolean>>({});
  const report = useCallback((courseId: string, enrolled: boolean) => {
    setEnrolledIn((m) => (m[courseId] === enrolled ? m : { ...m, [courseId]: enrolled }));
  }, []);
  const allAnswered = courses.length > 0 && courses.every((c) => c.id in enrolledIn);
  const noneMatched = allAnswered && courses.every((c) => !enrolledIn[c.id]);

  return (
    <>
      <SectionTitle>Courses you manage</SectionTitle>
      {coursesState === null ? (
        <Empty>Checking your courses…</Empty>
      ) : courses.length === 0 ? (
        <Empty>You are not assigned to any courses.</Empty>
      ) : (
        <>
          <Grid min={330}>
            {courses.map((c) => (
              <ManagedCourseRow
                key={c.id}
                course={c}
                cohortName={cohortNameOf(c.cohortId)}
                studentUid={studentUid}
                who={who}
                onOpenCourse={onOpenCourse}
                onAnswered={report}
              />
            ))}
          </Grid>
          {noneMatched ? (
            <Empty>{who} is not in any of the courses you manage.</Empty>
          ) : null}
        </>
      )}
    </>
  );
}

/** Renders nothing unless this student is in this manager's course. */
function ManagedCourseRow({
  course,
  cohortName,
  studentUid,
  who,
  onOpenCourse,
  onAnswered,
}: {
  course: CourseRow;
  cohortName: string;
  studentUid: string;
  who: string;
  onOpenCourse: (cls: CourseRow) => void;
  onAnswered: (courseId: string, enrolled: boolean) => void;
}) {
  // Scoped to one course, so the rule resolves one class get() however big the
  // roster — and asked as a LIST, because the answer is usually "no such
  // enrollment" and the rule refuses that read outright when it is a get. See
  // useEnrollmentIn.
  const enrollment = useEnrollmentIn(studentUid, course.id);
  const { resolved } = enrollment;
  const enrolled = !!enrollment.value;
  useEffect(() => {
    if (resolved) onAnswered(course.id, enrolled);
  }, [resolved, enrolled, course.id, onAnswered]);
  if (!enrollment.value) return null;
  return (
    <CourseEnrollmentRow
      course={course}
      cohortName={cohortName}
      active={enrollment.value.active}
      who={who}
      onOpenCourse={onOpenCourse}
    />
  );
}

function CourseEnrollmentRow({
  course,
  cohortName,
  active,
  who,
  onOpenCourse,
}: {
  course: CourseRow;
  cohortName: string;
  active: boolean;
  who: string;
  onOpenCourse: (cls: CourseRow) => void;
}) {
  return (
    <ListRow
      testID={`student-course-open-${course.name}`}
      name={course.name}
      // The same course name recurs across cohorts, so the term disambiguates it.
      detail={cohortName || undefined}
      status={<StatusChip status={active ? 'active' : 'inactive'} />}
      openLabel={`Open ${who}'s progress in ${course.name}`}
      onPress={() => onOpenCourse(course)}
    />
  );
}

const styles = StyleSheet.create({
  historyLede: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2) },
  historyRow: { paddingVertical: spacing(2) },
  historyRowRule: { borderTopWidth: 1, borderTopColor: t.border.subtle },
  historyWhat: { fontSize: 15, color: t.text.primary },
  // secondary, not muted: when and by whom is the point of the row.
  historyWhen: { fontSize: 13, color: t.text.secondary, marginTop: 2 },
});
