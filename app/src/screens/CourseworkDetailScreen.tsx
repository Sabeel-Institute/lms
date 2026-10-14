import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  courseworkCounts,
  gradeText,
  isOverdue,
  todayInZone,
  unbreakableDate,
} from '@sabeel/shared';
import {
  Button,
  Card,
  Chips,
  CountsLine,
  Empty,
  IconButton,
  Notice,
  Row,
  RowList,
  Screen,
  Segmented,
  useGridCell,
} from '../components/ui';
import { RichText } from '../components/RichText';
import { Attachments } from '../components/Attachments';
import {
  returnWork,
  useAssignmentGradesState,
  useAssignmentSubmissionsState,
  type CourseworkRow,
  type GradeRow,
} from '../coursework';
import { useStudentsState, type StudentRow } from '../students';
import type { CourseRow } from '../structure';
import { gradingText } from './courseworkWords';
import { inFilter, rowLine, staffRows, type WorkFilter } from '../courseworkRows';
import { useWorkFilter } from '../courseworkFilter';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const NO_STUDENTS: StudentRow[] = [];

/**
 * One assignment's page: where is everyone? Laid out like the listening
 * progress page, so a teacher who knows one can read the other: a line of
 * counts, filters, then the class by name, each row opening that student's
 * work.
 */
export function CourseworkDetailScreen({
  cls,
  coursework: cw,
  onOpenCourse,
  onEdit,
  onGrade,
}: {
  cls: CourseRow;
  coursework: CourseworkRow;
  onOpenCourse: () => void;
  onEdit: () => void;
  /** Open one student's work; with no student, the first still to grade. */
  onGrade: (studentUid: string, order: string[]) => void;
}) {
  // This assignment's work and grades only, not the course's every one: a
  // term's worth was read and re-sorted to show one assignment's page.
  const subsAll = useAssignmentSubmissionsState(cls.id, cw.id);
  const gradesAll = useAssignmentGradesState(cls.id, cw.id);
  // Waited for, as on the grading screen: rows sorted by names not yet known
  // reorder themselves under the reader when the directory answers.
  const studentsState = useStudentsState(true);
  const students = studentsState ?? NO_STUDENTS;
  const [tab, setTab] = useState<'students' | 'instructions'>('students');
  const [filter, setFilter] = useWorkFilter(cw.id);
  // The students named when Return was first tapped: the confirmation sends
  // exactly those, even if another grade is saved while it is open.
  const [confirmReturn, setConfirmReturn] = useState<string[] | null>(null);
  const { active, run } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);
  const today = todayInZone(INSTITUTE_TIMEZONE);

  const nameOf = useMemo(() => {
    const names = new Map(students.map((s) => [s.uid, s.displayName]));
    return (uid: string) => names.get(uid) ?? 'Unknown student';
  }, [students]);
  const subs = useMemo(() => (subsAll ?? []).filter((s) => s.courseworkId === cw.id), [subsAll, cw.id]);
  const grades = useMemo(
    () => new Map((gradesAll ?? []).filter((g) => g.courseworkId === cw.id).map((g) => [g.studentUid, g] as [string, GradeRow])),
    [gradesAll, cw.id],
  );
  const counts = courseworkCounts(cw.grading, subs, grades, today, cls.effectiveActive, INSTITUTE_TIMEZONE);
  const rows = useMemo(
    () => staffRows(subs, grades, today, cls.effectiveActive, nameOf),
    [subs, grades, today, cls.effectiveActive, nameOf],
  );
  const shown = rows.filter(({ st }) => inFilter(st, filter));
  const toGrade = rows.filter((r) => r.st === 'toGrade').map((r) => r.s.studentUid);
  const toReturn = rows.filter((r) => r.st === 'graded' && r.g?.grade).map((r) => r.s.studentUid);
  const beforeDue = !isOverdue(cw.dueDate, today);

  const returnGraded = (uids: string[]) =>
    void run('return', async () => {
      setError(null);
      try {
        const res = await returnWork({ courseworkId: cw.id, studentUids: uids });
        setConfirmReturn(null);
        // The rest went back: say who did not, and why, beside the ones that did.
        if (res.refused.length > 0) {
          setError(
            `Returned ${res.returned}. Not returned: ${res.refused.map((r) => `${nameOf(r.studentUid)} (${r.reason})`).join('; ')}`,
          );
        }
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <Screen
      title={cw.title}
      parent={{ label: cls.name, testID: 'up-to-course-from-assignment', onPress: onOpenCourse }}
      subtitle={[
        `Due ${unbreakableDate(cw.dueDate)}`,
        gradingText(cw.grading),
        cw.lateUntil ? `late work until ${unbreakableDate(cw.lateUntil)}` : 'no late work',
        cw.closedAt ? 'closed' : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      width="list"
      actions={<IconButton testID="coursework-edit" icon="edit" bare label="Edit assignment" onPress={onEdit} />}
    >
      {/* No status chip: a draft says so in the notice below, and "posted" on
          every posted assignment said nothing. */}
      {toGrade.length > 0 ? (
        <View style={styles.head}>
          <Button testID="coursework-grade" label="Grade" hug onPress={() => onGrade(toGrade[0], toGrade)} />
        </View>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {cw.status === 'draft' ? (
        <Notice tone="info">Not posted. No student can see it until you post it from Edit.</Notice>
      ) : null}

      <View style={styles.tabs}>
        <Segmented
          value={tab}
          testIdPrefix="coursework-tab"
          options={[
            { value: 'students', label: `Students (${rows.length})` },
            { value: 'instructions', label: 'Instructions' },
          ]}
          onChange={setTab}
        />
      </View>

      {tab === 'instructions' ? (
        <Card>
          {cw.instructions ? <RichText markdown={cw.instructions} /> : <Text style={styles.quiet}>No written instructions.</Text>}
          {Object.keys(cw.files).length ? (
            <View style={styles.files}>
              <Attachments target="coursework" courseworkId={cw.id} files={cw.files} editable={false} />
            </View>
          ) : null}
        </Card>
      ) : subsAll === null || gradesAll === null || studentsState === null ? (
        <Empty>Checking the class’s work…</Empty>
      ) : rows.length === 0 ? (
        <Empty>{cw.status === 'draft' ? 'Nobody has it yet: it goes to the class when it is posted.' : 'Nobody in the class has this assignment.'}</Empty>
      ) : (
        <>
          <CountsLine
            testID="coursework-counts"
            counts={[
              { value: counts.handedIn, label: `of ${counts.expected} handed in`, testID: 'coursework-count-handed-in' },
              beforeDue
                ? { value: counts.notInYet, label: 'not in yet' }
                : { value: counts.pastDue, label: 'past due' },
              { value: counts.missed, label: 'missed', alarm: true },
            ]}
          />
          <View style={styles.filters}>
            <Chips<WorkFilter>
              value={filter}
              testIdPrefix="coursework-filter"
              options={[
                { value: 'all', label: 'All' },
                { value: 'toGrade', label: `To grade (${counts.toGrade})` },
                { value: 'pastDue', label: `Past due (${counts.pastDue})` },
                { value: 'returned', label: `Returned (${counts.returned})` },
              ]}
              onChange={setFilter}
            />
          </View>
          {shown.length > 0 ? (
            <RowList>
              {shown.map(({ s, st, g }) => (
                <StudentRow key={s.id} name={nameOf(s.studentUid)} onPress={() => onGrade(s.studentUid, toGrade)}>
                  <View style={styles.rowMain}>
                    <Text style={styles.name}>{nameOf(s.studentUid)}</Text>
                    <Text style={styles.quiet}>{rowLine(s, st)}</Text>
                  </View>
                  <View style={styles.rowMeta}>
                    {st === 'returned' && s.returned?.grade ? <Text style={styles.grade}>{gradeText(s.returned.grade, cw.grading)}</Text> : null}
                    {st === 'graded' && g?.grade ? <Text style={styles.grade}>{gradeText(g.grade, cw.grading)}</Text> : null}
                    {st === 'graded' ? <Text style={styles.quiet}>not returned</Text> : null}
                    {st === 'toGrade' ? <Text style={[styles.tag, styles.onTeacher]}>To grade</Text> : null}
                    {st === 'pastDue' ? <Text style={[styles.tag, styles.onStudents]}>Past due</Text> : null}
                  </View>
                </StudentRow>
              ))}
            </RowList>
          ) : null}
          {toReturn.length > 0 ? (
            <View style={styles.returnAll}>
              {/*
                ASKED ONCE MORE. A return cannot be taken back — each student
                sees their grade and is told — and this one goes to everyone
                graded, so a stray tap here is the costliest in the app.
              */}
              {confirmReturn ? (
                <Card>
                  <Text style={styles.confirm}>
                    Return {confirmReturn.length === 1 ? 'the 1 graded piece of work' : `all ${confirmReturn.length} graded`} now?
                    Each student sees their grade and feedback and is told.
                  </Text>
                  <Row>
                    <Button
                      testID="coursework-return-graded-confirm"
                      label={`Return ${confirmReturn.length}`}
                      busy={active === 'return'}
                      onPress={() => returnGraded(confirmReturn)}
                    />
                    <Button label="Cancel" variant="quiet" onPress={() => setConfirmReturn(null)} />
                  </Row>
                </Card>
              ) : (
                <>
                  <Button testID="coursework-return-graded" label={`Return ${toReturn.length} graded`} onPress={() => setConfirmReturn(toReturn)} />
                  <Text style={styles.quiet}>Sends back every grade not yet returned. Each student is told.</Text>
                </>
              )}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** One student's row: their work on this assignment, opening it to grade. */
function StudentRow({ name, onPress, children }: { name: string; onPress: () => void; children: ReactNode }) {
  const inGrid = useGridCell();
  return (
    <Pressable
      testID={`work-row-${name}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}’s work`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, inGrid, pressed ? styles.pressed : null]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', marginBottom: spacing(3) },
  tabs: { marginBottom: spacing(3) },
  files: { marginTop: spacing(3) },
  filters: { marginBottom: spacing(3) },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    rowGap: spacing(1),
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  rowMain: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 200, paddingRight: spacing(3) },
  // One line, grade then word: stacked and right-aligned, the pair came
  // apart when the row wrapped under the title at phone width.
  rowMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing(2), flexShrink: 1, maxWidth: '100%' },
  name: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  quiet: { fontSize: 13, color: t.text.secondary },
  grade: { fontSize: 15, fontWeight: '700', color: t.text.primary },
  tag: { fontSize: 12, fontWeight: '600', color: t.text.primary, borderRadius: 999, paddingHorizontal: spacing(2), paddingVertical: 2, overflow: 'hidden' },
  onTeacher: { backgroundColor: t.bg.goldSoft },
  onStudents: { backgroundColor: t.bg.dangerSoft },
  returnAll: { marginTop: spacing(3) },
  confirm: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginBottom: spacing(3) },
});
