import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
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
import { Button, Card, Notice, Screen, SectionTitle, inputLook } from '../components/ui';
import { LazyRichEditor } from '../components/LazyRichEditor';
import { useLeaveGuard } from '../components/LeaveGuard';
import { Attachments } from '../components/Attachments';
import { RichText } from '../components/RichText';
import { handIn, saveDraftNote, takeBack, useMyDraftState, type CourseworkRow, type SubmissionRow } from '../coursework';
import type { CourseRow } from '../structure';
import { errorText } from '../errors';
import { createAutosave, type AutosaveState } from '../autosave';
import { useOneAtATime } from '../oneAtATime';
import { gradingText } from './courseworkWords';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

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
  // One at a time, so a double tap cannot hand in and then show the second
  // call's refusal as an error over work that went in.
  const { active, run: once } = useOneAtATime();
  const run = (key: 'handIn' | 'takeBack', fn: () => Promise<unknown>) =>
    void once(key, async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      }
    });

  const hasFiles = Object.keys(cw.files).length > 0;
  // Left out when there is nothing to read: a heading over "No written
  // instructions" is a card that says there is no card.
  const instructions =
    cw.instructions || hasFiles ? (
      <>
        <SectionTitle>Instructions</SectionTitle>
        <Card>
          {cw.instructions ? <RichText markdown={cw.instructions} /> : null}
          {hasFiles ? (
            <View style={cw.instructions ? styles.files : null}>
              <Attachments target="coursework" courseworkId={cw.id} files={cw.files} editable={false} />
            </View>
          ) : null}
        </Card>
      </>
    ) : null;
  const late = sub.handedInAt !== null && isLate(sub.handedInAt, sub.dueDate, INSTITUTE_TIMEZONE);
  const takeBackNow = () => run('takeBack', () => takeBack({ courseworkId: cw.id }));

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
      <StateNotice state={state} sub={sub} today={today} />

      {sub.state === 'returned' && sub.returned ? <Returned returned={sub.returned} grading={cw.grading} /> : null}

      {handedIn ? (
        <>
          {/* WHEN, AND THE WAY BACK, ON ITS HEADING: Take back belongs to the
              work under it, as a file's bin belongs to its row. */}
          <SectionTitle
            action={
              state === 'handedIn' && canTakeBack(sub, today) ? (
                <Button testID="work-take-back" label="Take back" variant="quiet" hug busy={active === 'takeBack'} onPress={takeBackNow} />
              ) : undefined
            }
          >
            What you handed in{sub.handedInAt ? ` · ${dayOf(sub.handedInAt)}` : ''}
            {late ? ' · late' : ''}
          </SectionTitle>
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
              busy={active === 'handIn'}
              onHandIn={(saveAnswer) =>
                run('handIn', async () => {
                  // What is on the screen is what goes in: the answer is
                  // stored first, or nothing is handed in.
                  if (!(await saveAnswer())) throw new Error('Your answer is not saved yet. Check the connection, then hand in again.');
                  await handIn({ courseworkId: cw.id });
                })
              }
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
}: {
  state: ReturnType<typeof workState>;
  sub: SubmissionRow;
  today: string;
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
    // When it went in, and whether late, are on the heading of the work below.
    case 'handedIn':
      return (
        <View testID="work-handed-in">
          <Notice tone="success">
            {`Not returned yet.${canTakeBack(sub, today) ? ` You can take it back to change it until ${due}.` : ''}`}
          </Notice>
        </View>
      );
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
      {note ? (
        <View style={styles.answer}>
          <RichText markdown={note} />
        </View>
      ) : null}
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
 * The student's own work while it is open: an answer, formatted, saved as
 * they type; files uploaded the moment they are added; and Hand in once
 * something is there and every file is up. Either may be empty, not both —
 * a question to the class is answered in the box alone.
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
  /** Hand in, given the way to store the answer first. */
  onHandIn: (saveAnswer: () => Promise<boolean>) => void;
}) {
  const draftState = useMyDraftState(uid, cw.id);
  const draft = draftState.value;
  const [note, setNote] = useState<string | null>(null);
  /*
   * The editor seeds ONCE, so it waits for the draft and starts again if the
   * draft turns up after it — a taken-back answer can arrive a snapshot after
   * the form does. Never once the student has typed: that would throw their
   * words away.
   */
  const seedKey = useRef('none');
  if (note === null) seedKey.current = draft ? 'draft' : 'none';
  const [saveState, setSaveState] = useState<AutosaveState>({ kind: 'idle' });
  const [uploading, setUploading] = useState(false);
  const draftExists = useRef(false);
  draftExists.current = draft !== null;
  const [saver] = useState(() =>
    createAutosave<string>({
      delayMs: 700,
      save: (v) => saveDraftNote(uid, cw.id, courseId, v, draftExists.current),
      onState: setSaveState,
    }),
  );
  /*
   * LEAVING SENDS WHAT IS WAITING. The save goes when typing pauses, and a
   * student who types a sentence and taps Back inside that pause used to lose
   * it. The write is the SDK's to deliver from here, offline included, so the
   * screen does not have to stay for it.
   */
  useEffect(() => () => void saver.flush(), [saver]);
  const shown = note ?? draft?.note ?? '';

  const change = (v: string) => {
    // The editor reports what it was seeded with; that is not an edit.
    if (v === shown) return;
    setNote(v);
    saver.queue(v);
  };
  const onBusyChange = useCallback((b: boolean) => setUploading(b), []);

  const failed = saveState.kind === 'failed';
  const guard = useLeaveGuard({
    when: uploading || failed,
    // A failed answer gets one more try before anyone is asked; a file on its
    // way cannot be hurried, so that is asked at once.
    settle: uploading ? undefined : () => saver.flush(),
    prompt: uploading
      ? {
          title: 'A file is still uploading',
          message: 'Leave now and it stops. Your answer and the files already up are kept.',
          stay: 'Stay',
          leave: 'Leave and stop it',
        }
      : {
          title: 'Your answer is not saved',
          message: 'The last change did not reach the server. Leave now and it is lost.',
          stay: 'Stay',
          leave: 'Leave without it',
        },
  });

  const files = draft?.files ?? {};
  const empty = !shown.trim() && Object.keys(files).length === 0;
  return (
    <>
      {guard.element}
      <SectionTitle>Your work</SectionTitle>
      <Card>
        <Text style={inputLook.label}>Your answer</Text>
        {draftState.resolved ? (
          <LazyRichEditor
            key={seedKey.current}
            testID="work-note"
            label="Your answer"
            placeholder="Your answer, or a note to go with your files"
            initialMarkdown={draft?.note ?? ''}
            onChangeMarkdown={change}
          />
        ) : (
          <ActivityIndicator style={styles.loading} />
        )}
        <Attachments target="work" courseworkId={cw.id} files={files} editable studentUid={uid} onBusyChange={onBusyChange} />
        <Text testID="work-saved" style={[styles.quiet, failed ? styles.failed : null]}>
          {saveState.kind === 'waiting' || saveState.kind === 'saving'
            ? 'Saving…'
            : failed
              ? 'Not saved. Check the connection; your answer is still here.'
              : 'Saved. Only you can see this until you hand it in.'}
        </Text>
        <Button
          testID="work-hand-in"
          label="Hand in"
          busy={busy}
          disabled={empty || uploading}
          onPress={() => onHandIn(() => saver.flush())}
        />
        {uploading ? <Text style={styles.quiet}>Ready once every file is up.</Text> : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  quiet: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(2) },
  failed: { color: t.feedback.danger },
  files: { marginTop: spacing(3) },
  grade: { fontSize: 32, fontWeight: '700', color: t.text.primary },
  feedback: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginTop: spacing(2) },
  answer: { marginBottom: spacing(3) },
  loading: { minHeight: 184 },
});
