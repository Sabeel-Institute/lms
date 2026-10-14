import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  courseworkCounts,
  todayInZone,
  unbreakableDate,
  type CourseworkCounts,
} from '@sabeel/shared';
import { Empty, Grid, IconButton, Screen, SectionTitle, useGridCell } from '../components/ui';
import {
  useCourseCourseworkState,
  useCourseGradesState,
  useCourseSubmissionsState,
  type CourseworkRow,
  type GradeRow,
  type SubmissionRow,
} from '../coursework';
import { useRosterState, type CourseRow } from '../structure';
import { gradingText } from './courseworkWords';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/** Each assignment's figures, from the one source the assignment page reads too. */
export function useCourseworkFigures(cls: CourseRow) {
  const subs = useCourseSubmissionsState(cls.id);
  const grades = useCourseGradesState(cls.id);
  return useMemo(() => {
    if (subs === null || grades === null) return null;
    const today = todayInZone(INSTITUTE_TIMEZONE);
    const byWork = new Map<string, { subs: SubmissionRow[]; grades: Map<string, GradeRow> }>();
    const slot = (id: string) => {
      let s = byWork.get(id);
      if (!s) byWork.set(id, (s = { subs: [], grades: new Map() }));
      return s;
    };
    for (const s of subs) slot(s.courseworkId).subs.push(s);
    for (const g of grades) slot(g.courseworkId).grades.set(g.studentUid, g);
    return (cw: CourseworkRow): CourseworkCounts => {
      const w = byWork.get(cw.id) ?? { subs: [], grades: new Map() };
      return courseworkCounts(cw.grading, w.subs, w.grades, today, cls.effectiveActive, INSTITUTE_TIMEZONE);
    };
  }, [subs, grades, cls.effectiveActive]);
}

/**
 * A course's assignments: drafts first, then the rest with the latest due
 * date first, as sessions are listed by meeting date. This list is the report
 * by assignment — each card says where the class stands, with what is
 * waiting on the teacher marked apart from what is waiting on students.
 */
export function CourseworkListScreen({
  cls,
  onOpenCourse,
  onNew,
  onOpen,
}: {
  cls: CourseRow;
  onOpenCourse: () => void;
  onNew: () => void;
  onOpen: (cw: CourseworkRow) => void;
}) {
  const state = useCourseCourseworkState(cls.id);
  const roster = useRosterState(cls.id);
  const figures = useCourseworkFigures(cls);
  const all = state ?? [];
  const drafts = all.filter((c) => c.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
  const posted = all
    .filter((c) => c.status === 'posted')
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate) || a.title.localeCompare(b.title));
  const enrolled = roster?.filter((e) => e.active).length;

  return (
    <Screen
      title="Assignments"
      subtitle={enrolled === undefined ? undefined : `${enrolled} ${enrolled === 1 ? 'student' : 'students'}`}
      parent={{ label: cls.name, testID: 'up-to-course-from-coursework', onPress: onOpenCourse }}
      width="list"
      // A plus, as every list adds; only while the course is running.
      actions={
        cls.effectiveActive ? <IconButton testID="coursework-new" icon="add" label="New assignment" onPress={onNew} /> : undefined
      }
    >
      {state === null ? (
        <Empty>Checking this course’s assignments…</Empty>
      ) : all.length === 0 ? (
        <Empty>No assignments yet. A new one goes to everyone in the class when you post it.</Empty>
      ) : (
        <>
          {drafts.length > 0 ? (
            <>
              <SectionTitle>Drafts ({drafts.length})</SectionTitle>
              <Grid min={330}>
                {drafts.map((cw) => (
                  <CourseworkCard key={cw.id} cw={cw} counts={null} onOpen={() => onOpen(cw)} />
                ))}
              </Grid>
            </>
          ) : null}
          {posted.length > 0 ? (
            <>
              <SectionTitle>Posted ({posted.length})</SectionTitle>
              <Grid min={330}>
                {posted.map((cw) => (
                  <CourseworkCard key={cw.id} cw={cw} counts={figures ? figures(cw) : null} onOpen={() => onOpen(cw)} />
                ))}
              </Grid>
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function CourseworkCard({ cw, counts, onOpen }: { cw: CourseworkRow; counts: CourseworkCounts | null; onOpen: () => void }) {
  const draft = cw.status === 'draft';
  const inGrid = useGridCell();
  return (
    <Pressable
      testID={`coursework-${cw.title}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${cw.title}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.card, inGrid, pressed ? styles.pressed : null]}
    >
      <Text style={styles.title}>{cw.title}</Text>
      <Text style={styles.meta}>
        {[
          `Due ${unbreakableDate(cw.dueDate)}`,
          draft ? 'not posted' : gradingText(cw.grading),
          counts?.average != null ? `average ${Math.round(counts.average * 100)}%` : null,
          cw.closedAt ? 'closed' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {counts ? (
        <View style={styles.tags}>
          <Text style={styles.tag}>
            {counts.handedIn} of {counts.expected} handed in
          </Text>
          {counts.toGrade ? <Text style={[styles.tag, styles.onTeacher]}>{counts.toGrade} to grade</Text> : null}
          {counts.toReturn ? <Text style={[styles.tag, styles.onTeacher]}>{counts.toReturn} to return</Text> : null}
          {counts.pastDue ? <Text style={[styles.tag, styles.onStudents]}>{counts.pastDue} past due</Text> : null}
          {counts.missed ? <Text style={[styles.tag, styles.onStudents]}>{counts.missed} missed</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  meta: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1), marginTop: spacing(2) },
  tag: {
    fontSize: 12,
    fontWeight: '600',
    color: t.text.primary,
    backgroundColor: t.bg.inset,
    borderRadius: 999,
    paddingHorizontal: spacing(2),
    paddingVertical: 2,
    overflow: 'hidden',
  },
  // Gold for work waiting on the teacher, raspberry tint for work waiting on students.
  onTeacher: { backgroundColor: t.bg.goldSoft },
  onStudents: { backgroundColor: t.bg.dangerSoft },
});
