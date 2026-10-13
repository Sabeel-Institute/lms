import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  canHandIn,
  canTakeBack,
  closesOn,
  gradeText,
  isLate,
  isOverdue,
  todayInZone,
  unbreakableDate,
  workState,
  type CourseworkGrading,
  type PastAttempt,
  type ReturnedGrade,
} from '@sabeel/shared';
import { Button, Card, Field, Notice, Screen, SectionTitle } from '../components/ui';
import { Attachments } from '../components/Attachments';
import { RichText } from '../components/RichText';
import { handIn, saveDraftNote, takeBack, useMyDraft, type CourseworkRow, type SubmissionRow } from '../coursework';
import type { CourseRow } from '../structure';
import { errorText } from '../errors';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

/** "out of 10", "satisfactory / needs work". */
function gradingText(grading: CourseworkGrading): string {
  return grading.kind === 'points' ? `graded out of ${grading.outOf}` : 'satisfactory / needs work';
}

/**
 * One assignment, as the student sees it: the teacher's instructions and
 * files, and their own work (docs/proposals/lms-assignments-proposal.html,
 * section 2, "An assignment").
 *
 * Everything the student does is saved as they go, on the server, so they can
 * start on a phone and finish on the website; the teacher sees nothing until
 * Hand in. Once handed in, their work moves to the top and the instructions
 * below it.
 */
export function WorkScreen({
  uid,
  coursework: cw,
  submission: sub,
  cls,
}: {
  uid: string;
  coursework: CourseworkRow;
  submission: SubmissionRow;
  cls: CourseRow;
}) {
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const state = workState(sub, today, cls.effectiveActive);
  const open = canHandIn(state);
  const handedIn = sub.state === 'handedIn' || sub.state === 'returned';
  const dueWord = isOverdue(sub.dueDate, today) ? 'Was due' : state === 'notRequired' ? 'Due' : 'Hand in by';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'handIn' | 'takeBack' | null>(null);

  const run = (key: 'handIn' | 'takeBack', fn: () => Promise<unknown>) =>
    void (async () => {
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    })();

  const instructions = (
    <>
      <SectionTitle>Instructions</SectionTitle>
      <Card>
        {cw.instructions ? <RichText markdown={cw.instructions} /> : <Text style={styles.quiet}>No written instructions.</Text>}
        {Object.keys(cw.files).length > 0 ? (
          <View style={styles.files}>
            <Attachments target="coursework" courseworkId={cw.id} files={cw.files} editable={false} />
          </View>
        ) : null}
      </Card>
    </>
  );

  return (
    <Screen
      title={cw.title}
      subtitle={[
        cls.name,
        `${dueWord} ${unbreakableDate(sub.dueDate)}`,
        gradingText(cw.grading),
      ].join(' · ')}
      width="read"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {cw.editedAt ? <Text style={styles.quiet}>Updated {dayOf(cw.editedAt)}</Text> : null}
      <StateNotice state={state} sub={sub} today={today} onTakeBack={() => run('takeBack', () => takeBack({ courseworkId: cw.id }))} busy={busy === 'takeBack'} />

      {sub.state === 'returned' && sub.returned ? <Returned returned={sub.returned} grading={cw.grading} /> : null}

      {handedIn ? (
        <>
          <SectionTitle>What you handed in{sub.handedInAt ? ` · ${dayOf(sub.handedInAt)}` : ''}</SectionTitle>
          <Card>
            <HandedIn note={sub.note} files={sub.files} courseworkId={cw.id} uid={uid} />
          </Card>
          {instructions}
        </>
      ) : (
        <>
          {instructions}
          {open ? (
            <YourWork
              uid={uid}
              cw={cw}
              courseId={sub.courseId}
              busy={busy === 'handIn'}
              onHandIn={() => run('handIn', () => handIn({ courseworkId: cw.id }))}
            />
          ) : null}
        </>
      )}

      {sub.attempts.length > 0 ? (
        <>
          <SectionTitle>Earlier attempts</SectionTitle>
          {[...sub.attempts].reverse().map((a) => (
            <Attempt key={a.attempt} attempt={a} grading={cw.grading} courseworkId={cw.id} uid={uid} />
          ))}
        </>
      ) : null}
    </Screen>
  );
}

/** One sentence on where the work stands, in the words the proposal settled. */
function StateNotice({
  state,
  sub,
  today,
  onTakeBack,
  busy,
}: {
  state: ReturnType<typeof workState>;
  sub: SubmissionRow;
  today: string;
  onTakeBack: () => void;
  busy: boolean;
}) {
  const due = unbreakableDate(sub.dueDate);
  switch (state) {
    case 'notRequired':
      return (
        <Notice tone="info">
          Not required for you. Your teacher’s note: “{sub.notRequired?.reason}”. You can still read the instructions.
        </Notice>
      );
    case 'closed':
      return <Notice tone="info">This course has been archived, so nothing more can be handed in.</Notice>;
    case 'missed':
      return (
        <Notice tone="info">
          {sub.closedEarly
            ? 'Your teacher stopped taking work on this assignment. Nothing was handed in.'
            : `This closed on ${unbreakableDate(closesOn(sub))}. Nothing was handed in. Ask your teacher if you need more time.`}
        </Notice>
      );
    case 'pastDue':
      return (
        <Notice tone="info">
          This was due {due}. Your teacher accepts it until {unbreakableDate(closesOn(sub))}, and it will show as late.
        </Notice>
      );
    case 'toDo':
      if (sub.returned?.retry) return <Notice tone="info">Your teacher asked for another try. Hand it in by {due}.</Notice>;
      if (sub.moreTime) return <Notice tone="info">Your teacher gave you until {due}: “{sub.moreTime.reason}”.</Notice>;
      return null;
    case 'handedIn': {
      const late = sub.handedInAt !== null && isLate(sub.handedInAt, sub.dueDate, INSTITUTE_TIMEZONE);
      const back = canTakeBack(sub, today);
      return (
        <View testID="work-handed-in">
          <Notice tone="success">
            {`Handed in ${sub.handedInAt ? dayOf(sub.handedInAt) : ''}${late ? ', late' : ''}. Your teacher has not returned it yet.`}
            {back ? ` You can take it back to change it until ${due}.` : ''}
          </Notice>
          {back ? <Button testID="work-take-back" label="Take back" variant="secondary" hug busy={busy} onPress={onTakeBack} /> : null}
        </View>
      );
    }
    case 'returned':
      return null;
  }
}

/** The grade and feedback, which exist for the student only once returned. */
function Returned({ returned, grading }: { returned: ReturnedGrade; grading: CourseworkGrading }) {
  return (
    <Card>
      <View testID="work-returned">
        <Text style={styles.quiet}>Returned {dayOf(returned.at)}</Text>
        {returned.grade ? <Text style={styles.grade}>{gradeText(returned.grade, grading)}</Text> : null}
        {returned.feedback ? <Text style={styles.feedback}>{returned.feedback}</Text> : null}
      </View>
    </Card>
  );
}

function HandedIn({ note, files, courseworkId, uid }: { note: string; files: SubmissionRow['files']; courseworkId: string; uid: string }) {
  return (
    <>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <Attachments target="work" courseworkId={courseworkId} files={files} editable={false} studentUid={uid} />
    </>
  );
}

function Attempt({ attempt, grading, courseworkId, uid }: { attempt: PastAttempt; grading: CourseworkGrading; courseworkId: string; uid: string }) {
  return (
    <Card>
      <Text style={styles.quiet}>
        Attempt {attempt.attempt}
        {attempt.handedInAt ? ` · handed in ${dayOf(attempt.handedInAt)}` : ''}
        {attempt.returned.grade ? ` · ${gradeText(attempt.returned.grade, grading)}` : ''}
      </Text>
      {attempt.returned.feedback ? <Text style={styles.feedback}>{attempt.returned.feedback}</Text> : null}
      <HandedIn note={attempt.note} files={attempt.files} courseworkId={courseworkId} uid={uid} />
    </Card>
  );
}

/**
 * The student's own work while it is open: a note saved as they type, files
 * uploaded the moment they are added, and Hand in once something is there
 * and every file is up.
 */
function YourWork({
  uid,
  cw,
  courseId,
  busy,
  onHandIn,
}: {
  uid: string;
  cw: CourseworkRow;
  courseId: string;
  busy: boolean;
  onHandIn: () => void;
}) {
  const draft = useMyDraft(uid, cw.id);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [uploading, setUploading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = note ?? draft?.note ?? '';

  const change = (v: string) => {
    setNote(v);
    setSaving('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveDraftNote(uid, cw.id, courseId, v).then(
        () => setSaving('saved'),
        () => setSaving('failed'),
      );
    }, 700);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onBusyChange = useCallback((b: boolean) => setUploading(b), []);

  const files = draft?.files ?? {};
  const empty = !shown.trim() && Object.keys(files).length === 0;
  return (
    <>
      <SectionTitle>Your work</SectionTitle>
      <Card>
        <Field testID="work-note" label="Note to your teacher" value={shown} onChangeText={change} multiline />
        <Attachments target="work" courseworkId={cw.id} files={files} editable studentUid={uid} onBusyChange={onBusyChange} />
        <Text testID="work-saved" style={styles.quiet}>
          {saving === 'saving'
            ? 'Saving…'
            : saving === 'failed'
              ? 'Not saved. Check the connection; your note is still here.'
              : 'Saved. Only you can see this until you hand it in.'}
        </Text>
        <Button
          testID="work-hand-in"
          label="Hand in"
          busy={busy}
          disabled={empty || uploading || saving === 'saving'}
          onPress={onHandIn}
        />
        {uploading ? <Text style={styles.quiet}>Ready once every file is up.</Text> : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  quiet: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2) },
  files: { marginTop: spacing(3) },
  grade: { fontSize: 32, fontWeight: '700', color: t.text.primary },
  feedback: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginTop: spacing(2) },
  note: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginBottom: spacing(3) },
});
