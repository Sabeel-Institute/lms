import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  addDays,
  gradeFits,
  gradeText,
  isLate,
  staffWorkState,
  todayInZone,
  unbreakableDate,
  type Grade,
  type ScaleMark,
} from '@sabeel/shared';
import { Button, Card, Chips, Field, Notice, Row, Screen, SectionTitle } from '../components/ui';
import { DateField } from '../components/DateField';
import { Attachments } from '../components/Attachments';
import {
  giveMoreTime,
  returnWork,
  saveGrade,
  setNotRequired,
  useCourseGradesState,
  useCourseSubmissionsState,
  type CourseworkRow,
} from '../coursework';
import { useStudents } from '../students';
import type { CourseRow } from '../structure';
import { errorText } from '../errors';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

/**
 * Grading one student's work (proposal section 3, "Grading"): the work on top
 * — the note, pictures large enough to read handwriting, audio that plays in
 * place — and the grade and feedback underneath. Everything saves as it is
 * typed, as a draft only staff see. Next moves on through the work still to
 * grade, in name order; Return now sends this one back at once.
 */
export function GradeScreen({
  cls,
  coursework: cw,
  studentUid,
  onOpenStudent,
  onBackToList,
}: {
  cls: CourseRow;
  coursework: CourseworkRow;
  studentUid: string;
  onOpenStudent: (studentUid: string) => void;
  onBackToList: () => void;
}) {
  const subs = useCourseSubmissionsState(cls.id);
  const grades = useCourseGradesState(cls.id);
  const students = useStudents(true);
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const nameOf = useMemo(() => {
    const names = new Map(students.map((s) => [s.uid, s.displayName]));
    return (uid: string) => names.get(uid) ?? 'Unknown student';
  }, [students]);
  const mine = (subs ?? []).filter((s) => s.courseworkId === cw.id);
  const gradeOf = new Map((grades ?? []).filter((g) => g.courseworkId === cw.id).map((g) => [g.studentUid, g]));
  const sub = mine.find((s) => s.studentUid === studentUid);
  const saved = gradeOf.get(studentUid);
  const toGrade = mine
    .filter((s) => staffWorkState(s, gradeOf.get(s.studentUid), today, cls.effectiveActive) === 'toGrade')
    .map((s) => s.studentUid)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const next = toGrade.find((uid) => uid !== studentUid && nameOf(uid).localeCompare(nameOf(studentUid)) > 0) ?? toGrade.find((uid) => uid !== studentUid);

  if (subs === null || grades === null) return <Screen title="Grade"><Text style={styles.quiet}>Loading…</Text></Screen>;
  if (!sub) return <Screen title="Grade"><Notice tone="info">This student does not have this assignment.</Notice></Screen>;

  const st = staffWorkState(sub, saved, today, cls.effectiveActive);
  const late = sub.handedInAt !== null && isLate(sub.handedInAt, sub.dueDate, INSTITUTE_TIMEZONE);
  const position = toGrade.indexOf(studentUid);

  return (
    <Screen
      title={nameOf(studentUid)}
      subtitle={position >= 0 ? `${position + 1} of ${toGrade.length} to grade` : undefined}
      parent={{ label: cw.title, testID: 'up-to-assignment-from-grade', onPress: onBackToList }}
      width="read"
    >
      <SectionTitle>
        {sub.handedInAt ? `Handed in ${dayOf(sub.handedInAt)}${late ? ' · late' : ''}` : 'Nothing handed in'}
      </SectionTitle>
      <Card>
        {sub.note ? <Text style={styles.note}>{sub.note}</Text> : null}
        {Object.keys(sub.files).length ? (
          <Attachments target="work" courseworkId={cw.id} files={sub.files} editable={false} studentUid={studentUid} />
        ) : null}
        {!sub.note && !Object.keys(sub.files).length ? (
          <Text style={styles.quiet}>
            {st === 'notRequired'
              ? `Not required: ${sub.notRequired?.reason ?? ''}`
              : 'Work done on paper or recited in class can still be graded here. The record shows it was graded without a hand-in.'}
          </Text>
        ) : null}
      </Card>

      {st !== 'notRequired' && st !== 'closed' ? (
        <GradeForm key={`${studentUid}-${sub.attempt}`} cw={cw} studentUid={studentUid} saved={saved} returned={sub.state === 'returned' ? sub.returned : null} />
      ) : null}

      <Row>
        {next ? <Button testID="grade-next" label="Next to grade ›" variant="secondary" onPress={() => onOpenStudent(next)} /> : null}
        {st === 'graded' ? <ReturnNow cw={cw} studentUid={studentUid} /> : null}
      </Row>
      {!next && toGrade.length === 0 ? (
        <Text style={styles.quiet}>Everything handed in is graded. Return it from the assignment’s page, together.</Text>
      ) : null}

      {sub.state !== 'returned' ? <StudentOptions cw={cw} studentUid={studentUid} notRequired={sub.notRequired !== null} /> : null}

      {sub.attempts.length > 0 ? (
        <>
          <SectionTitle>Earlier attempts</SectionTitle>
          {sub.attempts.map((a) => (
            <Card key={a.attempt}>
              <Text style={styles.quiet}>
                Attempt {a.attempt}
                {a.handedInAt ? ` · handed in ${dayOf(a.handedInAt)}` : ''}
                {a.returned.grade ? ` · ${gradeText(a.returned.grade, cw.grading)}` : ''}
              </Text>
              {a.returned.feedback ? <Text style={styles.note}>{a.returned.feedback}</Text> : null}
              {a.note ? <Text style={styles.note}>{a.note}</Text> : null}
              <Attachments target="work" courseworkId={cw.id} files={a.files} editable={false} studentUid={studentUid} />
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * The grade and feedback, saved as they are typed. A draft only staff see
 * until it is returned; on returned work, a change reaches the student at once
 * and is recorded.
 */
function GradeForm({
  cw,
  studentUid,
  saved,
  returned,
}: {
  cw: CourseworkRow;
  studentUid: string;
  saved: { grade: Grade | null; feedback: string } | undefined;
  returned: { grade: Grade | null; feedback: string } | null;
}) {
  const start = returned ?? saved;
  const [points, setPoints] = useState(start?.grade && 'points' in start.grade ? String(start.grade.points) : '');
  const [scale, setScale] = useState<ScaleMark | ''>(start?.grade && 'scale' in start.grade ? start.grade.scale : '');
  const [feedback, setFeedback] = useState(start?.feedback ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | string>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const gradeOf = (p: string, sc: ScaleMark | ''): Grade | null | 'invalid' => {
    if (cw.grading.kind === 'points') {
      if (!p.trim()) return null;
      const g = { points: Number(p.replace(',', '.')) };
      return gradeFits(g, cw.grading) ? g : 'invalid';
    }
    return sc ? { scale: sc } : null;
  };

  const queue = (p: string, sc: ScaleMark | '', f: string) => {
    const grade = gradeOf(p, sc);
    if (grade === 'invalid') {
      setStatus(`A grade is a number from 0 to ${cw.grading.kind === 'points' ? cw.grading.outOf : ''}, in halves at most.`);
      return;
    }
    setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveGrade({ courseworkId: cw.id, studentUid, grade, feedback: f }).then(
        () => setStatus('saved'),
        (e) => setStatus(errorText(e)),
      );
    }, 600);
  };

  return (
    <>
      <SectionTitle>Grade</SectionTitle>
      <Card>
        {cw.grading.kind === 'points' ? (
          <View style={styles.points}>
            <View style={styles.pointsField}>
              <Field
                testID="grade-points"
                label={`Out of ${cw.grading.outOf}`}
                value={points}
                onChangeText={(v) => {
                  setPoints(v);
                  queue(v, scale, feedback);
                }}
              />
            </View>
          </View>
        ) : (
          <Chips<ScaleMark>
            value={scale as ScaleMark}
            testIdPrefix="grade-scale"
            options={[
              { value: 'satisfactory', label: 'Satisfactory' },
              { value: 'needsWork', label: 'Needs work' },
            ]}
            onChange={(v) => {
              setScale(v);
              queue(points, v, feedback);
            }}
          />
        )}
        <Field
          testID="grade-feedback"
          label="Feedback"
          value={feedback}
          onChangeText={(v) => {
            setFeedback(v);
            queue(points, scale, v);
          }}
          multiline
        />
        <Text testID="grade-status" style={[styles.quiet, status !== 'idle' && status !== 'saving' && status !== 'saved' ? styles.failed : null]}>
          {status === 'saving'
            ? 'Saving…'
            : status === 'saved' || status === 'idle'
              ? returned
                ? 'Returned. A change to the grade reaches the student, and is recorded.'
                : `${status === 'saved' || saved ? 'Saved · only' : 'Only'} staff see this until you return it. Feedback is optional.`
              : status}
        </Text>
      </Card>
    </>
  );
}

function ReturnNow({ cw, studentUid }: { cw: CourseworkRow; studentUid: string }) {
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const [date, setDate] = useState(addDays(todayInZone(INSTITUTE_TIMEZONE), 7));
  const [error, setError] = useState<string | null>(null);
  const send = (withRetry: boolean) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await returnWork({
          courseworkId: cw.id,
          studentUids: [studentUid],
          ...(withRetry ? { retry: { dueDate: date, lateUntil: null } } : {}),
        });
        setRetry(false);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    })();
  return (
    <View style={styles.returnNow}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Row>
        <Button testID="grade-return" label="Return now" busy={busy && !retry} onPress={() => send(false)} />
        <Button testID="grade-retry" label="Ask for another try…" variant="secondary" onPress={() => setRetry((r) => !r)} />
      </Row>
      {retry ? (
        <Card>
          <Text style={styles.quiet}>
            The work goes back with your grade and feedback, and opens again for another try. This attempt stays with the next.
          </Text>
          <DateField label="Hand in again by" value={date} onChange={setDate} />
          <Button testID="grade-retry-confirm" label="Return and ask for another try" busy={busy} onPress={() => send(true)} />
        </Card>
      ) : null}
    </View>
  );
}

/**
 * One student at a time: more time, with a reason they see, or not required,
 * with a reason they see. Never called "excused", which in this app is the
 * register's word.
 */
function StudentOptions({ cw, studentUid, notRequired }: { cw: CourseworkRow; studentUid: string; notRequired: boolean }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(todayInZone(INSTITUTE_TIMEZONE), 7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, fn: () => Promise<unknown>) =>
    void (async () => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        setOpen(false);
        setReason('');
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    })();
  if (notRequired) {
    return (
      <Button
        testID="grade-required-again"
        label="Make it required again"
        variant="secondary"
        busy={busy === 'undo'}
        onPress={() => run('undo', () => setNotRequired({ courseworkId: cw.id, studentUid, reason: null }))}
      />
    );
  }
  return (
    <View style={styles.options}>
      <Button testID="grade-options" label="More time, or not required…" variant="quiet" onPress={() => setOpen((o) => !o)} />
      {open ? (
        <Card>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field testID="grade-reason" label="Reason (the student sees it)" value={reason} onChangeText={setReason} />
          <DateField label="New date" value={date} onChange={setDate} />
          <Row>
            <Button
              testID="grade-more-time"
              label="Give more time"
              busy={busy === 'time'}
              disabled={!reason.trim()}
              onPress={() => run('time', () => giveMoreTime({ courseworkId: cw.id, studentUid, dueDate: date, lateUntil: null, reason: reason.trim() }))}
            />
            <Button
              testID="grade-not-required"
              label="Mark not required"
              variant="secondary"
              busy={busy === 'notRequired'}
              disabled={!reason.trim()}
              onPress={() => run('notRequired', () => setNotRequired({ courseworkId: cw.id, studentUid, reason: reason.trim() }))}
            />
          </Row>
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  quiet: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2) },
  failed: { color: t.feedback.danger },
  note: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginBottom: spacing(3) },
  points: { flexDirection: 'row', alignItems: 'flex-end' },
  pointsField: { width: 160 },
  returnNow: { marginTop: spacing(2) },
  options: { marginTop: spacing(4) },
});
