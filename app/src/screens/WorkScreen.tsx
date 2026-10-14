import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  MAX_ANSWER_CHARS,
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
import { PlainLines } from '../components/PlainLines';
import { forgetAnswer, journalAnswer, journaledAnswer, restorable } from '../answerJournal';
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

/*
 * OFFLINE, A SAVE NEVER ANSWERS: the write waits for the connection. These
 * are how long the page waits on one before saying so, rather than "Saving…"
 * and a spinning Hand in for as long as the connection is down.
 */
/** Hand in waits this long for the answer to be stored, then says it is not. */
const HAND_IN_WAIT_MS = 10_000;
/** Leaving waits this long for the answer, then asks. */
const LEAVE_WAIT_MS = 5_000;
/** A save on its way this long is said to be not sent yet. */
const SLOW_SAVE_MS = 5_000;

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
  // Something they handed in: work graded on paper and given back has a grade
  // and no hand-in, and a heading over an empty card said otherwise.
  const handedIn = (sub.state === 'handedIn' || sub.state === 'returned') && sub.handedInAt !== null;
  // "Hand in by" only while they can: beside "Your teacher has stopped taking
  // work" it told them to do what they could not.
  const dueWord = isOverdue(sub.dueDate, today) ? 'Was due' : open ? 'Hand in by' : 'Due';
  // Which action was refused, so its words appear beside its button: at the
  // top of a page with a long answer they were out of sight, and a refused
  // hand-in looked like one that had gone in.
  const [error, setError] = useState<{ key: 'handIn' | 'takeBack'; text: string } | null>(null);
  // One at a time, so a double tap cannot hand in and then show the second
  // call's refusal as an error over work that went in.
  const { active, run: once } = useOneAtATime();
  const run = (key: 'handIn' | 'takeBack', fn: () => Promise<unknown>) =>
    void once(key, async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError({ key, text: errorText(e) });
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
  // Beside the button when it is still drawn; at the top when the work has
  // moved on under it (closed at midnight, say), so it is said somewhere.
  const takeBackRefused = error?.key === 'takeBack' && handedIn ? error.text : null;
  const handInRefused = error?.key === 'handIn' && !handedIn && open ? error.text : null;
  const refusedElsewhere = error && !takeBackRefused && !handInRefused ? error.text : null;
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
      {refusedElsewhere ? <Notice tone="error">{refusedElsewhere}</Notice> : null}
      {cw.editedAt ? <Text style={styles.quiet}>Updated {dayOf(cw.editedAt)}</Text> : null}
      <StateNotice state={state} sub={sub} today={today} courseOpen={cls.effectiveActive} />

      {sub.state === 'returned' && sub.returned ? <Returned returned={sub.returned} grading={cw.grading} /> : null}

      {handedIn ? (
        <>
          {/* WHEN, AND THE WAY BACK, ON ITS HEADING: Take back belongs to the
              work under it, as a file's bin belongs to its row. */}
          <SectionTitle
            action={
              state === 'handedIn' && canTakeBack(sub, today, cls.effectiveActive) ? (
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
          {takeBackRefused ? <Notice tone="error">{takeBackRefused}</Notice> : null}
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
              refused={handInRefused}
              onHandIn={(saveAnswer) =>
                run('handIn', async () => {
                  // What is on the screen is what goes in: the answer is
                  // stored first, or nothing is handed in.
                  if (!(await saveAnswer())) throw new Error('Your answer is not saved yet. Check the connection, then hand in again.');
                  await handIn({ courseworkId: cw.id });
                })
              }
            />
          ) : (
            <UnsentWork uid={uid} courseworkId={cw.id} />
          )}
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
  courseOpen,
}: {
  state: ReturnType<typeof workState>;
  sub: SubmissionRow;
  today: string;
  courseOpen: boolean;
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
            {`Not returned yet.${canTakeBack(sub, today, courseOpen) ? ` You can take it back to change it until ${due}.` : ''}`}
          </Notice>
        </View>
      );
    case 'returned':
      return null;
  }
}

/**
 * WHAT THEY HAD WRITTEN, once the work closed under it: an answer and files
 * never handed in stay on the server, and the page went on as if there were
 * none. Shown as it stands, to read and keep.
 */
function UnsentWork({ uid, courseworkId }: { uid: string; courseworkId: string }) {
  const draft = useMyDraftState(uid, courseworkId).value;
  if (!draft || (!draft.note.trim() && Object.keys(draft.files).length === 0)) return null;
  return (
    <>
      <SectionTitle>Your work, not handed in</SectionTitle>
      <Card>
        <HandedIn note={draft.note} files={draft.files} courseworkId={courseworkId} uid={uid} />
      </Card>
    </>
  );
}

/** The grade and feedback, which exist for the student only once returned. */
function Returned({ returned, grading }: { returned: ReturnedGrade; grading: CourseworkGrading }) {
  return (
    <Card>
      <View testID="work-returned">
        <Text style={styles.quiet}>Returned {dayOf(returned.at)}</Text>
        {returned.grade ? <Text style={styles.grade}>{gradeText(returned.grade, grading)}</Text> : null}
        {returned.feedback ? <PlainLines text={returned.feedback} textStyle={styles.feedback} style={styles.feedbackBlock} /> : null}
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
      {attempt.returned.feedback ? (
        <PlainLines text={attempt.returned.feedback} textStyle={styles.feedback} style={styles.feedbackBlock} />
      ) : null}
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
  refused,
  onHandIn,
}: {
  uid: string;
  cw: CourseworkRow;
  courseId: string;
  busy: boolean;
  /** Why the last hand-in did not go in, said beside the button. */
  refused: string | null;
  /** Hand in, given the way to store the answer first. */
  onHandIn: (saveAnswer: () => Promise<boolean>) => void;
}) {
  const draftState = useMyDraftState(uid, cw.id);
  const draft = draftState.value;
  const [note, setNote] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<AutosaveState>({ kind: 'idle' });
  const pending = saveState.kind === 'waiting' || saveState.kind === 'saving' || saveState.kind === 'failed';
  /*
   * The editor seeds ONCE, so it waits for the draft and starts again if the
   * draft turns up after it — a taken-back answer can arrive a snapshot after
   * the form does. Never over typing that has not been stored: that would
   * throw their words away.
   *
   * AND IT FOLLOWS THE STUDENT'S OTHER DEVICE. A screen left open on a phone
   * kept the answer it opened with while the essay was written on the laptop,
   * and its next keystroke stored the old text over the essay. So when the
   * stored answer changes to one this screen did not type, and nothing typed
   * here is waiting, the editor starts again from the stored one.
   */
  const seedKey = useRef('none');
  if (note === null) seedKey.current = draft ? `draft-${draft.updatedAt}` : 'none';
  const [followed, setFollowed] = useState(false);
  /*
   * PUT BACK WHAT THIS DEVICE TYPED AND NEVER SAVED. On Android an answer
   * typed with no signal waited in memory, and an app killed before the
   * signal returned took it (answerJournal.ts). When the device's copy is
   * newer than the stored answer, the editor starts from it, and it is saved.
   */
  const [restored, setRestored] = useState<string | null>(null);
  const [restoredNotice, setRestoredNotice] = useState(false);
  const typed = useRef(false);
  useEffect(() => {
    if (!draft || note === null || pending || draft.note === note) return;
    setFollowed(true);
    setRestored(null);
    setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored answer changing
  }, [draft?.updatedAt]);
  const [uploading, setUploading] = useState(false);
  const draftExists = useRef(false);
  draftExists.current = draft !== null;
  const [saver] = useState(() =>
    createAutosave<string>({
      delayMs: 700,
      // Steady typing is still sent every couple of seconds (see autosave.ts).
      maxWaitMs: 2500,
      save: async (v) => {
        await saveDraftNote(uid, cw.id, courseId, v, draftExists.current);
        void forgetAnswer(uid, cw.id, v);
      },
      onState: setSaveState,
    }),
  );
  const checked = useRef(false);
  useEffect(() => {
    if (!draftState.resolved || checked.current) return;
    checked.current = true;
    const stored = draftState.value;
    void journaledAnswer(uid, cw.id).then((entry) => {
      if (typed.current || !restorable(entry, stored ? { note: stored.note, updatedAt: stored.updatedAt } : null)) return;
      setRestored(entry.note);
      setRestoredNotice(true);
      setNote(entry.note);
      if (entry.note.length <= MAX_ANSWER_CHARS) saver.queue(entry.note);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the stored answer is first known
  }, [draftState.resolved]);
  /*
   * LEAVING SENDS WHAT IS WAITING. The save goes when typing pauses, and a
   * student who types a sentence and taps Back inside that pause used to lose
   * it. The write is the SDK's to deliver from here, offline included, so the
   * screen does not have to stay for it.
   */
  useEffect(() => () => void saver.flush(), [saver]);
  // AND WHEN THE PAGE GOES AWAY OR OUT OF SIGHT: a tab closed, a reload, the
  // phone's browser put in the background. The write is queued in the SDK at
  // once; the guard below asks before a reload or close lets it be lost.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const flushNow = () => void saver.flush();
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [saver]);
  const shown = note ?? draft?.note ?? '';

  const change = (v: string) => {
    // The editor reports what it was seeded with; that is not an edit.
    if (v === shown) return;
    typed.current = true;
    setFollowed(false);
    setRestoredNotice(false);
    setNote(v);
    journalAnswer(uid, cw.id, v);
    // Too long to store: the rules would refuse it, so it is not sent, and the
    // line under the box says so rather than blaming the connection.
    if (v.length > MAX_ANSWER_CHARS) return;
    saver.queue(v);
  };
  const onBusyChange = useCallback((b: boolean) => setUploading(b), []);

  const failed = saveState.kind === 'failed';
  const over = shown.length - MAX_ANSWER_CHARS;
  // A save on its way too long to be the network being slow.
  const [unanswered, setUnanswered] = useState(false);
  useEffect(() => {
    setUnanswered(false);
    if (saveState.kind !== 'saving') return;
    const timer = setTimeout(() => setUnanswered(true), SLOW_SAVE_MS);
    return () => clearTimeout(timer);
  }, [saveState.kind]);
  const guard = useLeaveGuard({
    // Waiting or on its way counts too: a reload or a closed tab in that moment
    // lost the typing with no word (in-app ways out send it first, below).
    when: uploading || failed || over > 0 || pending,
    // A failed answer gets one more try before anyone is asked; a file on its
    // way cannot be hurried, nor an answer too long to store, so those are
    // asked at once.
    settle: uploading || over > 0 ? undefined : () => saver.flush(LEAVE_WAIT_MS),
    prompt: uploading
      ? {
          title: 'A file is still uploading',
          message: 'Leave now and it stops. Your answer and the files already up are kept.',
          stay: 'Stay',
          leave: 'Leave and stop it',
        }
      : {
          title: 'Your answer is not saved',
          message:
            over > 0
              ? 'It is too long to save. Leave now and the last part you wrote is lost.'
              : 'The last change did not reach the server. Leave now and it is lost.',
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
            key={restored !== null ? 'restored' : seedKey.current}
            testID="work-note"
            label="Your answer"
            placeholder="Your answer, or a note to go with your files"
            initialMarkdown={restored ?? draft?.note ?? ''}
            onChangeMarkdown={change}
          />
        ) : (
          <ActivityIndicator style={styles.loading} />
        )}
        <Attachments target="work" courseworkId={cw.id} files={files} editable studentUid={uid} onBusyChange={onBusyChange} />
        <Text testID="work-saved" aria-live="polite" style={[styles.quiet, failed || over > 0 ? styles.failed : null]}>
          {over > 0
            ? `Too long to save: ${over.toLocaleString('en')} characters over the ${MAX_ANSWER_CHARS.toLocaleString('en')} an answer can have. Shorten it, or put the long part in a document and attach that.`
            : unanswered
              ? 'Not sent yet. Check the connection: it goes as soon as you are back online. Your answer is still here.'
              : saveState.kind === 'waiting' || saveState.kind === 'saving'
                ? 'Saving…'
                : failed
                  ? (saveState.error as { code?: string } | null)?.code === 'permission-denied'
                    ? 'Not saved: this work is no longer open to changes. Your answer is still here.'
                    : 'Not saved. Check the connection; your answer is still here.'
                  : `${followed ? 'Brought up to date with what you wrote on another device. ' : ''}${restoredNotice ? 'Brought back what you typed here that had not been saved. ' : ''}${empty ? '' : 'Saved. '}Only you can see this until you hand it in.${
                      shown.length > MAX_ANSWER_CHARS * 0.9
                        ? ` ${shown.length.toLocaleString('en')} of ${MAX_ANSWER_CHARS.toLocaleString('en')} characters.`
                        : ''
                    }`}
        </Text>
        {refused ? <Notice tone="error">{refused}</Notice> : null}
        <Button
          testID="work-hand-in"
          label="Hand in"
          busy={busy}
          disabled={empty || uploading || over > 0}
          onPress={() => onHandIn(() => saver.flush(HAND_IN_WAIT_MS))}
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
  feedback: { fontSize: 15, lineHeight: 22, color: t.text.primary },
  feedbackBlock: { marginTop: spacing(2) },
  answer: { marginBottom: spacing(3) },
  loading: { minHeight: 184 },
});
