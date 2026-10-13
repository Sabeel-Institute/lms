import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Empty, Grid, Screen } from '../components/ui';
import { useMyAttendanceState, type AttendanceRecordRow } from '../attendance';

const NO_MARKS: AttendanceRecordRow[] = [];
import { useCourse, useStudentEnrollmentsState } from '../structure';
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

  return (
    <Screen
      // LIST, like every other collection — see `StudentHomeScreen`.
      width="list"
      title="Your classes"
      subtitle="Your attendance and required recordings, class by class"
    >
      {/* IN A GRID, like every other collection. Asking for the list width and
          then stacking full-width rows is the worst of both: a card holding a
          class name and one caption line ran to 1114px with 640px of it empty,
          beside staff cards of identical shape flowing two across. */}
      {enrollments === null ? (
        <Empty>Checking your classes…</Empty>
      ) : courseIds.length === 0 ? (
        <Empty>You are not enrolled in any classes yet.</Empty>
      ) : (
        <Grid min={330}>
          {courseIds.map((courseId) => (
            <CourseCard key={courseId} uid={uid} courseId={courseId} onOpen={onOpen} />
          ))}
        </Grid>
      )}
    </Screen>
  );
}

function CourseCard({
  uid,
  courseId,
  onOpen,
}: {
  uid: string;
  courseId: string;
  onOpen: (courseId: string) => void;
}) {
  const cls = useCourse(courseId);
  // The card answers the question the screen is for, so most visits need no tap
  // at all: how many meetings am I marked in, and how many did I miss. Read from
  // the student's OWN projected records — a student cannot read a session.
  const marksState = useMyAttendanceState(uid, courseId);
  const marks = marksState ?? NO_MARKS;
  if (!cls) return null;
  const present = marks.filter((m) => m.status === 'present').length;
  const excused = marks.filter((m) => m.status === 'excused').length;
  const absent = marks.filter((m) => m.status === 'absent').length;
  return (
    <Pressable
      testID={`myclass-${cls.name}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${cls.name}`}
      onPress={() => onOpen(courseId)}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
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
        {!cls.effectiveActive ? <Text style={styles.sub}>Finished</Text> : null}
      </View>
    </Pressable>
  );
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
