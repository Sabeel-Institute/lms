import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  gradeText,
  isLate,
  staffWorkState,
  tallyCounts,
  todayInZone,
  unbreakableDate,
  workTally,
  type StaffWorkState,
} from '@sabeel/shared';
import { Empty, RowList, useGridCell } from '../components/ui';
import { useCourseCourseworkState, useCourseGradesState, useCourseSubmissionsState } from '../coursework';
import type { CourseRow } from '../structure';
import { getTheme, spacing } from '../theme';

const t = getTheme();

const WORD: Record<StaffWorkState, string> = {
  toDo: 'Not due yet',
  pastDue: 'Past due',
  toGrade: 'To grade',
  graded: 'Graded, not returned',
  returned: 'Returned',
  missed: 'Missed',
  closed: 'Closed',
  notRequired: 'Not required',
};

/**
 * One student's assignments in one course, for their teachers: what they see
 * on their class page, with the staff figures beside it — grades still in
 * draft, and the average of the returned ones. Each row opens their work.
 */
export function StaffStudentWork({
  studentUid,
  cls,
  onOpenWork,
}: {
  studentUid: string;
  cls: CourseRow;
  onOpenWork: (courseworkId: string) => void;
}) {
  const coursework = useCourseCourseworkState(cls.id);
  const subs = useCourseSubmissionsState(cls.id);
  const grades = useCourseGradesState(cls.id);
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const rows = useMemo(() => {
    const titles = new Map((coursework ?? []).map((c) => [c.id, c]));
    const gradeOf = new Map((grades ?? []).filter((g) => g.studentUid === studentUid).map((g) => [g.courseworkId, g]));
    return (subs ?? [])
      .filter((s) => s.studentUid === studentUid && titles.has(s.courseworkId))
      .map((s) => ({ s, cw: titles.get(s.courseworkId)!, g: gradeOf.get(s.courseworkId) }))
      .map((r) => ({ ...r, st: staffWorkState(r.s, r.g, today, cls.effectiveActive) }))
      .sort((a, b) => b.s.dueDate.localeCompare(a.s.dueDate));
  }, [coursework, subs, grades, studentUid, today, cls.effectiveActive]);

  if (coursework === null || subs === null || grades === null) return <Empty>Checking their assignments…</Empty>;
  if (rows.length === 0) return <Empty>No assignments here.</Empty>;
  // The figures every other count of assignments adds up: the assignment's
  // page and both workbooks (`workTally`), so this page cannot disagree with them.
  const counts = tallyCounts(rows.map((r) => workTally(r.cw.grading, r.s, r.g, today, cls.effectiveActive, INSTITUTE_TIMEZONE)));
  return (
    <>
      <Text style={styles.summary}>
        {[
          `${counts.handedIn} handed in`,
          `${counts.pastDue} past due`,
          `${counts.missed} missed`,
          counts.average === null ? null : `average ${Math.round(counts.average * 100)}%`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <RowList>
        {rows.map(({ s, cw, g, st }) => {
          const late = s.handedInAt !== null && isLate(s.handedInAt, s.dueDate, INSTITUTE_TIMEZONE);
          const grade = st === 'returned' ? s.returned?.grade : g?.grade;
          return (
            <WorkRow
              key={s.id}
              title={cw.title}
              when={
                s.handedInAt
                  ? `Handed in ${unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, s.handedInAt))}${late ? ' · late' : ''}`
                  : `Hand in by ${unbreakableDate(s.dueDate)}`
              }
              grade={grade ? gradeText(grade, cw.grading) : null}
              word={WORD[st]}
              onPress={() => onOpenWork(cw.id)}
            />
          );
        })}
      </RowList>
    </>
  );
}

/** One assignment: when it went in, its grade, and where it stands. Opens their work. */
function WorkRow({
  title,
  when,
  grade,
  word,
  onPress,
}: {
  title: string;
  when: string;
  grade: string | null;
  word: string;
  onPress: () => void;
}) {
  const inGrid = useGridCell();
  return (
    <Pressable
      testID={`student-work-${title}`}
      accessibilityRole="button"
      accessibilityLabel={`Open their work on ${title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, inGrid, pressed ? styles.pressed : null]}
    >
      <View style={styles.main}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.quiet}>{when}</Text>
      </View>
      <View style={styles.meta}>
        {grade ? <Text style={styles.grade}>{grade}</Text> : null}
        <Text style={styles.quiet}>{word}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 15, color: t.text.secondary, marginBottom: spacing(3) },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing(1),
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  main: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 200, paddingRight: spacing(3) },
  // One line, grade then word: stacked and right-aligned, the pair came
  // apart when the row wrapped under the title at phone width.
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing(2), flexShrink: 1, maxWidth: '100%' },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  quiet: { fontSize: 13, color: t.text.secondary },
  grade: { fontSize: 15, fontWeight: '700', color: t.text.primary },
});
