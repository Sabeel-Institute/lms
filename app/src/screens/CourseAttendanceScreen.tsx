import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { Card, Empty, Grid, Screen, Segmented } from '../components/ui';
import { useCourseAttendance } from '../ledger';
import { useStudents } from '../students';
import type { CourseRow } from '../structure';
import { getTheme, spacing } from '../theme';

const t = getTheme();

type Tab = 'sessions' | 'students';

/**
 * A course's attendance report: sessions rolled up (who was there) and students
 * rolled up (who keeps missing, and whether they've caught up). Staff-scoped —
 * the underlying reads are the same course-scoped session/roster/assignment
 * queries the rules already allow.
 */
export function CourseAttendanceScreen({
  cls,
  onOpenCourse,
  onOpenSession,
  onOpenStudent,
}: {
  cls: CourseRow;
  onOpenCourse: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenStudent: (studentUid: string) => void;
}) {
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const report = useCourseAttendance(cls.id, today);
  const students = useStudents(true);
  const [tab, setTab] = useState<Tab>('sessions');
  const nameOf = useMemo(() => {
    const m = new Map(students.map((s) => [s.uid, s.displayName]));
    return (uid: string) => m.get(uid) ?? uid;
  }, [students]);

  // Chronic-first: most absences (absent + excused) at the top.
  const studentRows = useMemo(
    () =>
      [...report.students].sort(
        (a, b) =>
          b.absent + b.excused - (a.absent + a.excused) ||
          nameOf(a.studentUid).localeCompare(nameOf(b.studentUid)),
      ),
    [report.students, nameOf],
  );

  return (
    <Screen
      parent={{ label: cls.name, testID: 'up-to-course-from-attendance', onPress: onOpenCourse }}
      subtitle={
        report.resolved
          ? `${report.sessionsWithAttendance} of ${report.totalSessions} sessions taken`
          : 'Attendance'
      }
      width="list"
    >

      <View style={styles.toggleRow}>
        {/* The shared control, not a local twin. This one predates `Segmented`
            and had drifted from it — `accessibilityRole="button"` where the
            shared one says `"tab"`, and its own colours. Same job, same widget. */}
        {/* Wrapped to carry the same top margin `styles.btn` gives the Export
            button beside it — a column affordance that, in a centred row, put
            the two controls out of true. */}
        <View style={styles.toolItem}>
          <Segmented
            value={tab}
            testIdPrefix="attendance-tab"
            options={[
              { value: 'sessions' as Tab, label: `By session (${report.sessions.length})` },
              { value: 'students' as Tab, label: `By student (${studentRows.length})` },
            ]}
            onChange={setTab}
          />
        </View>
      </View>

      {!report.resolved ? (
        <Empty>Checking the register…</Empty>
      ) : tab === 'sessions' ? (
        report.sessions.length === 0 ? (
          <Empty>No sessions in this course yet.</Empty>
        ) : (
          <Grid min={330}>
            {report.sessions.map((s) => (
              <Card key={s.sessionId}>
                <Pressable
                  testID={`attendance-session-${s.title}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${s.title}`}
                  onPress={() => onOpenSession(s.sessionId)}
                >
                  <Text style={styles.name}>{s.title}</Text>
                  <Text style={styles.hint}>{s.date}</Text>
                  {s.submitted ? (
                    <Text style={styles.counts}>
                      <Text style={styles.countValue}>{s.present}</Text> present
                      {'   '}
                      <Text style={styles.countValue}>{s.absent}</Text> absent
                      {'   '}
                      <Text style={styles.countValue}>{s.excused}</Text> excused
                    </Text>
                  ) : (
                    <View style={styles.notTakenChip}>
                      <Text style={styles.notTaken}>Attendance not taken</Text>
                    </View>
                  )}
                </Pressable>
              </Card>
            ))}
          </Grid>
        )
      ) : studentRows.length === 0 ? (
        <Empty>Nobody is enrolled in this course yet.</Empty>
      ) : (
        <Grid min={330}>
          {studentRows.map((s) => (
            <Card key={s.studentUid}>
              <Pressable
                testID={`attendance-student-${nameOf(s.studentUid)}`}
                accessibilityRole="button"
                accessibilityLabel={`Open listening progress for ${nameOf(s.studentUid)}`}
                onPress={() => onOpenStudent(s.studentUid)}
              >
                <Text style={styles.name}>{nameOf(s.studentUid)}</Text>
                {/* WHY A NAME THAT IS NOT ON THE ROSTER IS HERE. Their marks
                    still count in every session's totals above, so leaving them
                    out made the two halves of one report disagree — and left no
                    account at all of a student who withdrew mid-term. */}
                {s.departed ? (
                  <Text style={styles.departed}>No longer enrolled</Text>
                ) : null}
                <Text style={styles.counts}>
                  <Text style={styles.countValue}>{s.present}</Text> present
                  {'   '}
                  <Text style={styles.countValue}>{s.absent}</Text> absent
                  {'   '}
                  <Text style={styles.countValue}>{s.excused}</Text> excused
                  {s.notMarked > 0 ? <Text style={styles.hint}>{`   ${s.notMarked} not marked`}</Text> : null}
                </Text>
                {s.assigned > 0 ? (
                  <Text style={styles.catchup}>
                    Required recordings: {s.completed} of {s.assigned} completed
                    {/* The separator rides with the words AFTER it, or a wrap left
                        every row ending in a dangling "·". */}
                    {s.missed > 0 ? (
                      <Text style={styles.missed}>{`\u00A0·\u00A0${s.missed}\u00A0missed`}</Text>
                    ) : null}
                  </Text>
                ) : (
                  <Text style={styles.catchup}>No required recordings</Text>
                )}
              </Pressable>
            </Card>
          ))}
        </Grid>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolItem: { marginTop: spacing(2) },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing(2),
    marginBottom: spacing(4),
    flexWrap: 'wrap',
  },
  name: { fontSize: 15, fontWeight: '600', color: t.text.primary },
  hint: { fontSize: 13, color: t.text.secondary },
  departed: { fontSize: 12, color: t.text.secondary, fontStyle: 'italic', marginTop: spacing(1) },
  counts: { fontSize: 14, color: t.text.secondary, marginTop: spacing(1) },
  /*
   * ONE WEIGHT, NO TONE. A breakdown is three facts, not three verdicts, and
   * binding the colour to the WORD made the number lie: "0 present" came out
   * green because "present" is good, and "11 excused" came out in the attention
   * colour on every healthy session — excused is the normal, intended state
   * that opens a recording and is the whole of a student's entitlement.
   */
  countValue: { color: t.text.primary, fontWeight: '700' },
  // THE SAME CHIP THE SESSIONS LIST WEARS. This screen's only job is attendance
  // coverage, and the state that blocks every student's access was set in the
  // same italic grey as the neutral counts beside it — the quietest of three
  // treatments, on the screen where it matters most.
  notTakenChip: {
    alignSelf: 'flex-start',
    marginTop: spacing(2),
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(3),
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: t.bg.goldSoft,
    borderColor: t.accent.gold,
  },
  notTaken: { fontSize: 12, fontWeight: '600', color: t.accent.goldText },
  catchup: { fontSize: 14, color: t.text.secondary, marginTop: spacing(2) },
  missed: { color: t.feedback.danger, fontWeight: '700' },
});
