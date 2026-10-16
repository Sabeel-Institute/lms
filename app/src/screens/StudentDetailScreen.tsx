import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AUDIT_PAGE, INSTITUTE_TIMEZONE, QUEUE_SCOPE, stampInZone } from '@sabeel/shared';
import {
  Card,
  ConfirmDanger,
  EmailText,
  Empty,
  Grid,
  IconButton,
  ListRow,
  Notice,
  Screen,
  SectionTitle,
  StatusChip,
} from '../components/ui';
import { Sheet, SheetOption } from '../components/Sheet';
import { resendPasswordSetup, setStudentAccess, useStudentState, type StudentRow } from '../students';
import { deleteAccount } from '../accounts';
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
 * One student, everything about them in one place: the courses they are in and
 * their history, with what can be done about their account under the ⋮.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Whether a manager runs a course this student is in now: reported by the
  // course list below, which is the only place a manager may ask.
  const [managesThem, setManagesThem] = useState(false);

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
  const email = student?.email ?? null;

  // The sheet closes as the action starts; the ⋮ turns into a spinner until it
  // is done, and the result is the notice at the top of the page.
  const choose = (key: string, fn: () => Promise<void>) => {
    setMenuOpen(false);
    void run(key, fn);
  };

  return (
    <Screen
      title={who}
      subtitle={email !== null ? <EmailText email={email} lede /> : undefined}
      status={student ? student.status : undefined}
      width="list"
      actions={
        student ? (
          <IconButton
            testID="student-actions"
            icon="more-vert"
            bare
            busy={busy !== null}
            label={`Actions for ${who}`}
            onPress={() => setMenuOpen(true)}
          />
        ) : undefined
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {info ? <Notice tone="success">{info}</Notice> : null}
      {/* THE SECOND DECISION. Delete is offered only on a disabled account, and
          asks again here, in the danger colour this app keeps for what cannot
          be undone. */}
      <ConfirmDanger
        enabled={isAdmin && disabled}
        opened={{ open: confirmDelete, close: () => setConfirmDelete(false) }}
        label="Delete account"
        confirmLabel="Delete account"
        warning={`Delete ${who}’s account for good? They can no longer sign in, and their email address and notification settings are removed. They leave every class they are in. Their name stays on the record with their attendance, listening, work and grades. This cannot be undone.`}
        busy={busy === 'delete'}
        confirmTestID="student-delete-confirm"
        onConfirm={() =>
          void run('delete', async () => {
            await deleteAccount(studentUid);
            setConfirmDelete(false);
          })
        }
      />

      {!student ? (
        <Empty>
          {studentState.resolved
            ? 'That student is not available. They may have been removed.'
            : 'Loading…'}
        </Empty>
      ) : (
        <>
          <Sheet visible={menuOpen} title={who} onClose={() => setMenuOpen(false)} closeAt="corner">
            {/* WHO MAY SEND IT is who may manage the student, as the server
                decides (`sendPasswordLink`): an admin, whoever made the
                account, or a manager of a course they are in now. Offered to
                nobody else, rather than refused after a tap. */}
            {email !== null && (isAdmin || student.createdBy === uid || managesThem) ? (
              <SheetOption
                testID="student-resend"
                label="Resend password link"
                // "Them", not the address: it is under their name already, and
                // in a sentence a long one broke across lines at a dot.
                detail="Emails them a link to set their password."
                onPress={() =>
                  choose('resend', async () => {
                    await resendPasswordSetup(studentUid);
                    setInfo(`Password link sent to ${email}.`);
                  })
                }
              />
            ) : null}
            {/* Everything about this student, across the courses the reader
                may see, in one .xlsx — the student's counterpart of the course
                workbook. */}
            <SheetOption
              testID="student-export-workbook"
              label="Export workbook"
              detail="Their courses, attendance and listening, in one spreadsheet."
              onPress={() => choose('export', () => exportStudentWorkbook(student, uid, isAdmin))}
            />
            {/* Enable/disable is directory-level — it spans every course — so
                the server keeps it admin-only, and a manager's menu does not
                offer what would only fail. The normal tone in BOTH directions:
                disabling is the reversible, recommended action in this product,
                and dressing it as destructive is how people learn to ignore the
                colour that marks the genuinely irreversible ones. */}
            {isAdmin && student.status !== 'deleted' ? (
              <SheetOption
                testID="student-access"
                label={disabled ? 'Re-enable account' : 'Disable account'}
                detail={disabled ? 'They can sign in again.' : 'They can no longer sign in. You can re-enable them.'}
                onPress={() =>
                  choose('access', () =>
                    setStudentAccess({ uid: studentUid, status: disabled ? 'active' : 'disabled' }),
                  )
                }
              />
            ) : null}
            {isAdmin && disabled ? (
              <SheetOption
                testID="student-delete"
                label="Delete account"
                detail="For a request to delete their data. Their record stays."
                tone="danger"
                onPress={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              />
            ) : null}
          </Sheet>

          {isAdmin ? (
            <AdminCourses studentUid={studentUid} who={who} deleted={student.status === 'deleted'} onOpenCourse={onOpenCourse} />
          ) : (
            <ManagerCourses
              studentUid={studentUid}
              uid={uid}
              who={who}
              onOpenCourse={onOpenCourse}
              onManages={setManagesThem}
            />
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
        {/* SAYS SO WHEN IT IS CUT SHORT. The read stops at the most recent
            AUDIT_PAGE rows naming the student, so the earliest rows are the
            ones left out, which a list starting "Account created" hides. */}
        {(isAdmin ? adminRows : scoped.rows).length >= AUDIT_PAGE ? (
          <Notice tone="info">Earlier changes are kept, but only the most recent are listed here.</Notice>
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
  deleted,
  onOpenCourse,
}: {
  studentUid: string;
  who: string;
  /** No "yet" for an account that is gone. */
  deleted: boolean;
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
        <Empty>{deleted ? 'Never enrolled in a course.' : 'Not enrolled in any course yet.'}</Empty>
      ) : (
        <Grid min={330} rows>
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
  onManages,
}: {
  studentUid: string;
  uid: string;
  who: string;
  onOpenCourse: (cls: CourseRow) => void;
  /** Whether the student is in one of these courses now. */
  onManages: (manages: boolean) => void;
}) {
  const coursesState = useMyCoursesState(uid);
  const courses = coursesState ?? NO_COURSES;
  const cohortNameOf = useCohortName();
  // Only the rows know whether they matched — each owns its own enrollment
  // listener, because one read per managed course is the only shape a manager
  // may issue. So they report back; without it a student in none of these
  // courses left the heading standing over nothing.
  // `null`: asked, and not enrolled; absent: not answered yet.
  const [enrolledIn, setEnrolledIn] = useState<Record<string, { active: boolean } | null>>({});
  const report = useCallback((courseId: string, enrolment: { active: boolean } | null) => {
    setEnrolledIn((m) =>
      courseId in m && m[courseId]?.active === enrolment?.active ? m : { ...m, [courseId]: enrolment },
    );
  }, []);
  const allAnswered = courses.length > 0 && courses.every((c) => c.id in enrolledIn);
  const noneMatched = allAnswered && courses.every((c) => !enrolledIn[c.id]);
  // Only the courses that hold them are rows: a probe that found nothing must
  // not leave an empty row between two dividers.
  const matched = courses.filter((c) => enrolledIn[c.id]);
  const managesNow = courses.some((c) => enrolledIn[c.id]?.active === true);
  useEffect(() => onManages(managesNow), [managesNow, onManages]);

  return (
    <>
      <SectionTitle>Courses you manage</SectionTitle>
      {coursesState === null ? (
        <Empty>Checking your courses…</Empty>
      ) : courses.length === 0 ? (
        <Empty>You are not assigned to any courses.</Empty>
      ) : (
        <>
          {courses.map((c) => (
            <EnrollmentProbe key={c.id} course={c} studentUid={studentUid} onAnswered={report} />
          ))}
          {matched.length > 0 ? (
            <Grid min={330} rows>
              {matched.map((c) => (
                <CourseEnrollmentRow
                  key={c.id}
                  course={c}
                  cohortName={cohortNameOf(c.cohortId)}
                  active={enrolledIn[c.id]?.active ?? false}
                  who={who}
                  onOpenCourse={onOpenCourse}
                />
              ))}
            </Grid>
          ) : null}
          {noneMatched ? (
            <Empty>{who} is not in any of the courses you manage.</Empty>
          ) : null}
        </>
      )}
    </>
  );
}

/** Asks whether this student is in this manager's course, and says so; draws nothing. */
function EnrollmentProbe({
  course,
  studentUid,
  onAnswered,
}: {
  course: CourseRow;
  studentUid: string;
  onAnswered: (courseId: string, enrolment: { active: boolean } | null) => void;
}) {
  // Scoped to one course, so the rule resolves one class get() however big the
  // roster — and asked as a LIST, because the answer is usually "no such
  // enrollment" and the rule refuses that read outright when it is a get. See
  // useEnrollmentIn.
  const enrollment = useEnrollmentIn(studentUid, course.id);
  const { resolved } = enrollment;
  const active = enrollment.value ? enrollment.value.active : null;
  useEffect(() => {
    if (resolved) onAnswered(course.id, active === null ? null : { active });
  }, [resolved, active, course.id, onAnswered]);
  return null;
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
      // Only when it says something: "active" on every course they are in
      // said nothing.
      status={active ? undefined : <StatusChip status="inactive" />}
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
