import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  closesOn,
  gradeText,
  isOverdue,
  todayInZone,
  unbreakableDate,
  workState,
  type CourseworkDoc,
  type WorkState,
} from '@sabeel/shared';
import { Card, Empty } from '../components/ui';
import { useResolvedDocs } from '../resolveDocs';
import type { SubmissionRow } from '../coursework';
import type { CourseRow } from '../structure';
import { getTheme, spacing } from '../theme';

const t = getTheme();

const STATE_WORD: Record<WorkState, string> = {
  toDo: 'To do',
  pastDue: 'Past due',
  handedIn: 'Handed in',
  returned: 'Returned',
  missed: 'Missed',
  closed: 'Closed',
  notRequired: 'Not required',
};

/** The three numbers a student checks: what is left, what is in, what was missed. */
export function workTally(work: SubmissionRow[], cls: CourseRow, today: string) {
  const tally = { toDo: 0, handedIn: 0, missed: 0 };
  for (const s of work) {
    const st = workState(s, today, cls.effectiveActive);
    if (st === 'toDo' || st === 'pastDue') tally.toDo++;
    else if (st === 'handedIn' || st === 'returned') tally.handedIn++;
    else if (st === 'missed') tally.missed++;
  }
  return tally;
}

/**
 * A class's assignments on the student's class page: every one they were
 * given, the whole term's record, each opening the assignment. To do keeps
 * only two weeks of finished work; this keeps it all.
 */
export function ClassAssignments({
  cls,
  work,
  onOpenWork,
}: {
  cls: CourseRow;
  /** This class's work, already loaded by the page. */
  work: SubmissionRow[];
  onOpenWork: (courseworkId: string) => void;
}) {
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const ids = useMemo(() => work.map((s) => s.courseworkId), [work]);
  const { resolved, resolving } = useResolvedDocs<CourseworkDoc>(COLLECTIONS.coursework, ids);
  const tally = workTally(work, cls, today);
  const rows = work
    .map((s) => ({ s, cw: resolved.get(s.courseworkId)?.doc }))
    .filter((r): r is { s: SubmissionRow; cw: NonNullable<typeof r.cw> } => r.cw !== undefined)
    .sort((a, b) => b.s.dueDate.localeCompare(a.s.dueDate) || a.cw.title.localeCompare(b.cw.title));

  if (work.length === 0) return <Empty>No assignments in this class yet.</Empty>;
  if (resolving && rows.length === 0) return <Empty>Checking your assignments…</Empty>;
  return (
    <>
      <Card>
        <View style={styles.tally}>
          <Tally label="To do" value={tally.toDo} />
          <Tally label="Handed in" value={tally.handedIn} />
          <Tally label="Missed" value={tally.missed} />
        </View>
      </Card>
      {rows.map(({ s, cw }) => {
        const st = workState(s, today, cls.effectiveActive);
        const when =
          st === 'toDo'
            ? `Hand in by ${unbreakableDate(s.dueDate)}`
            : st === 'pastDue'
              ? `Was due ${unbreakableDate(s.dueDate)} · accepted until ${unbreakableDate(closesOn(s))}`
              : `${isOverdue(s.dueDate, today) ? 'Was due' : 'Due'} ${unbreakableDate(s.dueDate)}`;
        return (
          <Pressable
            key={s.id}
            testID={`class-work-${cw.title}`}
            accessibilityRole="button"
            accessibilityLabel={`Open ${cw.title}`}
            onPress={() => onOpenWork(s.courseworkId)}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
          >
            <View style={styles.rowMain}>
              <Text style={styles.title}>{cw.title}</Text>
              <Text style={styles.date}>{when}</Text>
            </View>
            <Text style={styles.status}>
              {st === 'returned' && s.returned?.grade ? gradeText(s.returned.grade, cw.grading) : STATE_WORD[st]}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.tallyItem}>
      <Text style={styles.tallyValue}>{value}</Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tally: { flexDirection: 'row', justifyContent: 'space-around' },
  tallyItem: { alignItems: 'center' },
  tallyValue: { fontSize: 24, fontWeight: '700', color: t.text.primary },
  tallyLabel: { fontSize: 12, color: t.text.secondary, letterSpacing: 0.6, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    rowGap: spacing(1),
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginTop: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  rowMain: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 200, paddingRight: spacing(3) },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  date: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  status: { fontSize: 13, fontWeight: '600', color: t.text.primary },
});
