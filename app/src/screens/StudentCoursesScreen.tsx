import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Collapsible, Empty, Grid, Screen, useGridCell } from '../components/ui';
import { useMyAttendanceState, type AttendanceRecordRow } from '../attendance';

const NO_MARKS: AttendanceRecordRow[] = [];
import { useCourseState, useStudentEnrollmentsState, type CourseRow } from '../structure';
import { useMySubmissions, type SubmissionRow } from '../coursework';
import { workTally } from './ClassAssignments';
import { INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The classes a student is enrolled in — the way in to their attendance record.
 *
 * The query shape is dictated by the rules, not by preference: a student lists
 * their own enrollments (constrained by studentUid) and then reads each course
 * BY ID. There is no student arm for listing courses at all, so a course must be
 * resolved one document listener at a time.
 */
export function StudentCoursesScreen({
  uid,
  onOpen,
}: {
  uid: string;
  onOpen: (courseId: string) => void;
}) {
  // `null` until the listener answers: the empty sentence below is a claim
  // about the student's standing, not a placeholder.
  const enrollments = useStudentEnrollmentsState(uid);
  const courseIds = useMemo(
    () => (enrollments ?? []).filter((e) => e.active).map((e) => e.courseId),
    [enrollments],
  );
  // One listener for every class's work, split per card.
  const work = useMySubmissions(uid);
  /*
   * Each course, as its own listener answers (see the note above). The list is
   * shown once EVERY course has answered, because which section a class goes
   * in depends on its course: shown sooner, a finished class appeared among
   * the running ones and then jumped into the closed section under the reader.
   */
  const [courses, setCourses] = useState<ReadonlyMap<string, CourseRow | null>>(new Map());
  const onCourse = useCallback((courseId: string, cls: CourseRow | null) => {
    setCourses((m) => {
      if (m.has(courseId) && m.get(courseId) === cls) return m;
      const next = new Map(m);
      next.set(courseId, cls);
      return next;
    });
  }, []);
  const answered = courseIds.every((id) => courses.has(id));
  const known = courseIds.map((id) => courses.get(id)).filter((c): c is CourseRow => !!c);
  // Running classes first; finished ones closed at the bottom, as archived
  // courses are on the staff side.
  const current = known.filter((c) => c.effectiveActive);
  const finished = known.filter((c) => !c.effectiveActive);
  const card = (cls: CourseRow) => (
    <CourseCard key={cls.id} uid={uid} cls={cls} work={(work ?? []).filter((s) => s.courseId === cls.id)} onOpen={onOpen} />
  );

  return (
    <Screen
      // LIST, like every other collection — see `StudentHomeScreen`.
      width="list"
      title="Your classes"
    >
      {courseIds.map((id) => (
        <CourseProbe key={id} courseId={id} onCourse={onCourse} />
      ))}
      {/* IN A GRID, like every other collection. Asking for the list width and
          then stacking full-width rows is the worst of both: a card holding a
          class name and one caption line ran to 1114px with 640px of it empty,
          beside staff cards of identical shape flowing two across. */}
      {enrollments === null || !answered ? (
        <Empty>Checking your classes…</Empty>
      ) : courseIds.length === 0 ? (
        <Empty>You are not enrolled in any classes yet.</Empty>
      ) : (
        <>
          {current.length > 0 ? <Grid min={330}>{current.map(card)}</Grid> : <Empty>All your classes have finished.</Empty>}
          {finished.length > 0 ? (
            <Collapsible testID="classes-finished" title="Finished" count={finished.length}>
              <Grid min={330}>{finished.map(card)}</Grid>
            </Collapsible>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** One course's listener, reporting what it says. Renders nothing. */
function CourseProbe({ courseId, onCourse }: { courseId: string; onCourse: (courseId: string, cls: CourseRow | null) => void }) {
  const state = useCourseState(courseId);
  useEffect(() => {
    if (state.resolved) onCourse(courseId, state.value);
  }, [courseId, onCourse, state.resolved, state.value]);
  return null;
}

function CourseCard({
  uid,
  cls,
  work,
  onOpen,
}: {
  uid: string;
  cls: CourseRow;
  work: SubmissionRow[];
  onOpen: (courseId: string) => void;
}) {
  // The card answers the question the screen is for, so most visits need no tap
  // at all: how many meetings am I marked in, and how many did I miss. Read from
  // the student's OWN projected records — a student cannot read a session.
  const marksState = useMyAttendanceState(uid, cls.id);
  const marks = marksState ?? NO_MARKS;
  const present = marks.filter((m) => m.status === 'present').length;
  const excused = marks.filter((m) => m.status === 'excused').length;
  const absent = marks.filter((m) => m.status === 'absent').length;
  const inGrid = useGridCell();
  return (
    <Pressable
      testID={`myclass-${cls.name}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${cls.name}`}
      onPress={() => onOpen(cls.id)}
      style={({ pressed }) => [styles.card, inGrid, pressed ? styles.pressed : null]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{cls.name}</Text>
        {marksState === null ? null : marks.length === 0 ? (
          <Text style={styles.sub}>No attendance taken yet</Text>
        ) : (
          <Text style={styles.sub}>
            {present} present · {excused} excused{absent > 0 ? ` · ${absent} absent` : ''}
          </Text>
        )}
        {work.length > 0 ? <AssignmentsLine work={work} cls={cls} /> : null}
      </View>
    </Pressable>
  );
}

/** "Assignments: 2 handed in · 1 to hand in · 1 missed", leaving out what is zero. */
function AssignmentsLine({ work, cls }: { work: SubmissionRow[]; cls: Parameters<typeof workTally>[1] }) {
  const tally = workTally(work, cls, todayInZone(INSTITUTE_TIMEZONE));
  const parts = [
    tally.handedIn ? `${tally.handedIn} handed in` : null,
    tally.toDo ? `${tally.toDo} to hand in` : null,
    tally.missed ? `${tally.missed} missed` : null,
  ].filter(Boolean);
  return parts.length ? <Text style={styles.sub}>Assignments: {parts.join(' · ')}</Text> : null;
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  name: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  sub: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
});
