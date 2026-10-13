import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DEFAULT_DUE_DAYS, INSTITUTE_TIMEZONE, addDays, todayInZone } from '@sabeel/shared';
import {
  AddAction,
  Button,
  Card,
  Empty,
  Field,
  Grid,
  Notice,
  Screen,
  SectionTitle,
  useAddAction,
} from '../components/ui';
import { DateField } from '../components/DateField';
import { createSession, useCourseSessionsState, type SessionRow } from '../sessions';

const NO_SESSIONS: SessionRow[] = [];
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';

const t = getTheme();

/**
 * The deadline to prefill for a meeting on `date`, floored at today.
 *
 * Back-entering a meeting from a fortnight ago is a normal flow, and
 * `date + DEFAULT_DUE_DAYS` alone would silently prefill a deadline the server
 * refuses — leaving the Create button enabled and the error unexplained. Today is
 * the earliest date that can be written, and it is still the last on-time day.
 */
function dueFor(date: string): string {
  const proposed = addDays(date, DEFAULT_DUE_DAYS);
  const today = todayInZone(INSTITUTE_TIMEZONE);
  return proposed < today ? today : proposed;
}

/**
 * The create form, in the sheet the header action opens.
 *
 * ITS OWN COMPONENT so it can close the sheet on success, which is the contract
 * every "Add a …" sheet in the app keeps: the new row appearing in the list
 * behind it is the confirmation. Leaving it open blocks the list underneath —
 * the e2e caught it as a modal backdrop swallowing the tap on the session that
 * had just been created.
 */
function AddSession({ courseId }: { courseId: string }) {
  const close = useAddAction();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayInZone(INSTITUTE_TIMEZONE));
  // Prefilled from the meeting date and kept in step with it until staff edit it
  // themselves. It cannot be blank: the due date is the day access closes, so an
  // empty one would mean a recording that never closes.
  const [dueDate, setDueDate] = useState(() => dueFor(todayInZone(INSTITUTE_TIMEZONE)));
  const [dueEdited, setDueEdited] = useState(false);
  const { active, run } = useOneAtATime();
  const busy = active !== null;
  const [error, setError] = useState<string | null>(null);

  const changeDate = (next: string) => {
    setDate(next);
    if (!dueEdited && next) setDueDate(dueFor(next));
  };

  const add = () =>
    void run('add', async () => {
      setError(null);
      try {
        await createSession({
          courseId,
          date,
          title: title.trim(),
          dueDate: dueDate.trim(),
          notes: '',
        });
        setTitle('');
        setDueEdited(false);
        setDueDate(dueFor(date));
        close();
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <>
      <Field
        testID="session-title"
        label="Title"
        value={title}
        onChangeText={setTitle}
        autoCapitalize="words"
        placeholder="Session 1 — Introduction"
      />
      <DateField label="Date of the meeting" value={date} onChange={changeDate} />
      <DateField
        label="Due by"
        value={dueDate}
        onChange={(v) => {
          setDueEdited(true);
          setDueDate(v);
        }}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        testID="session-create"
        label="Create session"
        busy={busy}
        disabled={!title.trim() || !date || !dueDate}
        block
        onPress={add}
      />
    </>
  );
}

/**
 * Staff: the sessions (dated meetings) of one course.
 *
 * A session is the organizing unit — attendance lives on it, and its recording
 * (0..1) hangs off it. Create a session for a meeting, take attendance, and add
 * the recording; whoever was excused is then granted it automatically.
 */
export function SessionsScreen({
  courseId,
  courseName,
  onOpenCourse,
  onOpenSession,
}: {
  courseId: string;
  courseName: string;
  onOpenCourse: () => void;
  onOpenSession: (session: SessionRow) => void;
}) {
  const sessionsState = useCourseSessionsState(courseId);
  const sessions = sessionsState ?? NO_SESSIONS;

  return (
    <Screen
      /* No title: the header above already says "Sessions", and the parent link
         carries the course. A pushed screen repeating its own header is a line
         of chrome that tells the reader nothing. */
      parent={{ label: courseName, testID: 'up-to-course-from-sessions', onPress: onOpenCourse }}
      width="list"
      actions={
        <AddAction testID="sessions-add" label="Add a session" title="Add a session">
          <AddSession courseId={courseId} />
        </AddAction>
      }
    >
      <SectionTitle>Sessions{sessionsState === null ? '' : ` (${sessions.length})`}</SectionTitle>
      {sessions.length === 0 ? (
        <Empty>
          {sessionsState === null ? 'Checking the sessions…' : 'No sessions yet. Add one for each class meeting.'}
        </Empty>
      ) : (
        <Grid min={330}>
          {sessions.map((s) => (
            <Pressable
              key={s.id}
              testID={`session-open-${s.title}`}
              // A row without a ROLE is not a control: a screen reader announces
              // nothing tappable, and every check in the layout sweep that looks
              // for controls looks straight past it.
              accessibilityRole="button"
              accessibilityLabel={`Open ${s.title}`}
              onPress={() => onOpenSession(s)}
              // The grid child is this wrapper, not the Card inside it, so the
              // fill has to be here or the row ends ragged.
              style={styles.cell}
            >
              <Card>
                <Text style={styles.title}>{s.title}</Text>
                <Text style={styles.date}>{s.date}</Text>
                <View style={styles.tags}>
                  <Tag
                    on={!!s.attendanceSubmittedAt}
                    onLabel="Attendance taken"
                    offLabel="Attendance not taken"
                  />
                  <Tag on={!!s.recordingId} onLabel="Recording added" offLabel="No recording" />
                </View>
              </Card>
            </Pressable>
          ))}
        </Grid>
      )}
    </Screen>
  );
}

/**
 * One step of a session's progress: done, or still to do.
 *
 * THE OUTSTANDING STATE IS THE LOUD ONE. It was the other way round — done wore
 * the brand accent and outstanding was grey-on-grey — so a screen of finished
 * sessions was a wall of pink and today's class, with attendance not taken and
 * no recording, was the palest card on the page. Staff read this list to find
 * work; a list that highlights the finished rows points them away from it.
 */
function Tag({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <View style={[styles.tag, on ? styles.tagDone : styles.tagTodo]}>
      <Text style={[styles.tagText, on ? styles.tagTextDone : styles.tagTextTodo]}>
        {on ? onLabel : offLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { flexGrow: 1 },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  date: { fontSize: 13, color: t.text.secondary, marginTop: 2 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginTop: spacing(3) },
  tag: { paddingVertical: spacing(1), paddingHorizontal: spacing(3), borderRadius: 999, borderWidth: 1 },
  // Gold, the app's "waiting on you" register — the same one the work queue's
  // blocking card wears.
  tagTodo: { backgroundColor: t.bg.goldSoft, borderColor: t.accent.gold },
  tagDone: { backgroundColor: 'transparent', borderColor: t.border.subtle },
  tagText: { fontSize: 12, fontWeight: '600' },
  tagTextTodo: { color: t.accent.goldText },
  tagTextDone: { color: t.text.secondary },
});
