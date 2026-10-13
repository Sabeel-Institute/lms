import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  courseworkCounts,
  gradeText,
  isLate,
  isOverdue,
  staffWorkState,
  todayInZone,
  unbreakableDate,
  type StaffWorkState,
} from '@sabeel/shared';
import { Button, Card, Chips, Empty, Notice, Row, Screen, Segmented, StatusChip } from '../components/ui';
import { RichText } from '../components/RichText';
import { Attachments } from '../components/Attachments';
import {
  returnWork,
  useCourseGradesState,
  useCourseSubmissionsState,
  type CourseworkRow,
  type GradeRow,
  type SubmissionRow,
} from '../coursework';
import { useStudents } from '../students';
import type { CourseRow } from '../structure';
import { gradingText } from './courseworkWords';
import { errorText } from '../errors';
import { getTheme, spacing } from '../theme';

const t = getTheme();

type Filter = 'all' | 'toGrade' | 'pastDue' | 'returned';

const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

/** One student's row, in the words the proposal settled. */
function rowLine(s: SubmissionRow, st: StaffWorkState): string {
  const late = s.handedInAt !== null && isLate(s.handedInAt, s.dueDate, INSTITUTE_TIMEZONE);
  switch (st) {
    case 'notRequired':
      return `Not required · ${s.notRequired?.reason ?? ''}`;
    case 'returned':
      return `Returned ${s.returned ? dayOf(s.returned.at) : ''}`;
    case 'toGrade':
    case 'graded':
      return s.handedInAt ? `Handed in ${dayOf(s.handedInAt)}${late ? ' · late' : ''}` : 'Graded without a hand-in';
    case 'toDo':
      return s.moreTime ? `More time, until ${unbreakableDate(s.dueDate)}` : 'Nothing handed in yet';
    case 'pastDue':
      return 'Nothing handed in';
    case 'missed':
      return 'Missed';
    case 'closed':
      return 'Closed, course archived';
  }
}

/**
 * One assignment's page: where is everyone? Laid out like the listening
 * progress page, so a teacher who knows one can read the other: four counts,
 * filters, then the class by name, each row opening that student's work.
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
  const subsAll = useCourseSubmissionsState(cls.id);
  const gradesAll = useCourseGradesState(cls.id);
  const students = useStudents(true);
  const [tab, setTab] = useState<'students' | 'instructions'>('students');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
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
    () =>
      subs
        .filter((s) => s.active || s.state !== 'open')
        .map((s) => ({ s, st: staffWorkState(s, grades.get(s.studentUid), today, cls.effectiveActive), g: grades.get(s.studentUid) }))
        .sort((a, b) => nameOf(a.s.studentUid).localeCompare(nameOf(b.s.studentUid))),
    [subs, grades, today, cls.effectiveActive, nameOf],
  );
  const shown = rows.filter(({ st }) =>
    filter === 'all' ? true : filter === 'toGrade' ? st === 'toGrade' : filter === 'pastDue' ? st === 'pastDue' : st === 'returned',
  );
  const toGrade = rows.filter((r) => r.st === 'toGrade').map((r) => r.s.studentUid);
  const toReturn = rows.filter((r) => r.st === 'graded' && r.g?.grade).map((r) => r.s.studentUid);
  const beforeDue = !isOverdue(cw.dueDate, today);

  const returnGraded = () =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await returnWork({ courseworkId: cw.id, studentUids: toReturn });
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    })();

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
    >
      <View style={styles.head}>
        <StatusChip status={cw.status} />
        <Row>
          {toGrade.length > 0 ? (
            <Button testID="coursework-grade" label="Grade" hug onPress={() => onGrade(toGrade[0], toGrade)} />
          ) : null}
          <Button testID="coursework-edit" label="Edit" variant="secondary" hug onPress={onEdit} />
        </Row>
      </View>
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
      ) : subsAll === null || gradesAll === null ? (
        <Empty>Checking the class’s work…</Empty>
      ) : rows.length === 0 ? (
        <Empty>{cw.status === 'draft' ? 'Nobody has it yet: it goes to the class when it is posted.' : 'Nobody in the class has this assignment.'}</Empty>
      ) : (
        <>
          <View style={styles.tiles}>
            <Tile label="Expected" value={counts.expected} />
            <Tile label="Handed in" value={counts.handedIn} />
            <Tile label={beforeDue ? 'Not in yet' : 'Past due'} value={beforeDue ? counts.notInYet : counts.pastDue} />
            <Tile label="Missed" value={counts.missed} />
          </View>
          <View style={styles.filters}>
            <Chips<Filter>
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
          {shown.map(({ s, st, g }) => (
            <Pressable
              key={s.id}
              testID={`work-row-${nameOf(s.studentUid)}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${nameOf(s.studentUid)}’s work`}
              onPress={() => onGrade(s.studentUid, toGrade)}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
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
            </Pressable>
          ))}
          {toReturn.length > 0 ? (
            <View style={styles.returnAll}>
              <Button
                testID="coursework-return-graded"
                label={`Return ${toReturn.length} graded`}
                busy={busy}
                onPress={returnGraded}
              />
              <Text style={styles.quiet}>Sends back every grade not yet returned. Each student is told.</Text>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The status, then the actions under it: side by side they ran past a
  // 320px screen.
  head: { gap: spacing(2), marginBottom: spacing(3) },
  tabs: { marginBottom: spacing(3) },
  files: { marginTop: spacing(3) },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginBottom: spacing(3) },
  tile: {
    flexGrow: 1,
    flexBasis: 120,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(3),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  tileValue: { fontSize: 22, fontWeight: '700', color: t.text.primary },
  tileLabel: { fontSize: 12, color: t.text.secondary, letterSpacing: 0.6, textTransform: 'uppercase' },
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
});
