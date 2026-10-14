import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import {
  INSTITUTE_TIMEZONE,
  addDays,
  daysUntilDue,
  gradeFits,
  gradeText,
  isLate,
  staffWorkState,
  stampInZone,
  todayInZone,
  unbreakableDate,
  type Grade,
  type ScaleMark,
  type SubmissionState,
} from '@sabeel/shared';
import { Button, Card, Chips, Field, InlineNumber, Notice, Row, Screen, SectionTitle } from '../components/ui';
import { useLeaveGuard } from '../components/LeaveGuard';
import { DateField } from '../components/DateField';
import { Attachments } from '../components/Attachments';
import { PlainLines } from '../components/PlainLines';
import { RichText } from '../components/RichText';
import {
  giveMoreTime,
  returnWork,
  saveGrade,
  setNotRequired,
  useAssignmentGradesState,
  useAssignmentSubmissionsState,
  useSubmissionEventsState,
  type CourseworkRow,
  type GradeRow,
} from '../coursework';
import { inFilter, rowLine, staffRows, stepFrom, type WorkFilter } from '../courseworkRows';
import { useWorkFilter } from '../courseworkFilter';
import { useStudentsState, type StudentRow } from '../students';
import type { CourseRow } from '../structure';
import { errorText } from '../errors';
import { createAutosave, type AutosaveState } from '../autosave';
import { useOneAtATime } from '../oneAtATime';
import { WIDE_BREAKPOINT, getTheme, spacing } from '../theme';

const t = getTheme();
const dayOf = (ms: number) => unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, ms));

/** Grading at a desk: the class list beside the work and the grade from this width up. */
const DESK_THREE_COLUMNS = 1200;

/** Ctrl on most keyboards, ⌘ on a Mac — both work; this is only what the hint says. */
const RETURN_KEY =
  Platform.OS === 'web' && typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ + Enter' : 'Ctrl + Enter';

/**
 * Grading one student's work (proposal section 3, "Grading"): the work — the
 * answer, pictures large enough to read handwriting, audio that plays in place
 * — and the grade and feedback. Everything saves as it is typed, as a draft
 * only staff see. Next moves on through the work still to grade, in name
 * order; Return now sends this one back at once.
 *
 * At a desk (proposal section 3, "Teacher · laptop") the work and the grade
 * sit side by side, with the class list beside them from 1200px; J and K step
 * through that list and Ctrl + Enter returns — never a bare key, so a stray
 * one sends nothing. Nothing moves on, and nothing is returned, until what is
 * typed is stored.
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
  const subs = useAssignmentSubmissionsState(cls.id, cw.id);
  const grades = useAssignmentGradesState(cls.id, cw.id);
  const events = useSubmissionEventsState(cls.id, cw.id, studentUid);
  // The directory's own state, not an empty list while it loads: until it
  // answers every student is "Unknown student", the title says so, and J and K
  // step through a list sorted by nothing.
  const studentsState = useStudentsState(true);
  const students = studentsState ?? NO_STUDENTS;
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const { width } = useWindowDimensions();
  const layout: 'stack' | 'two' | 'three' = width >= DESK_THREE_COLUMNS ? 'three' : width >= WIDE_BREAKPOINT ? 'two' : 'stack';
  const focused = useIsFocused();
  const nameOf = useMemo(() => {
    const names = new Map(students.map((s) => [s.uid, s.displayName]));
    return (uid: string) => names.get(uid) ?? 'Unknown student';
  }, [students]);
  // One action at a time across the screen: Next, J, K, Return and the
  // student's options each wait for the one before, and none runs twice.
  const { active, run } = useOneAtATime();
  const form = useRef<GradeFormApi | null>(null);
  const [formStatus, setFormStatus] = useState<GradeFormStatus>(NOTHING_TYPED);
  const [filter, setFilter] = useWorkFilter(cw.id);
  const [returnError, setReturnError] = useState<string | null>(null);
  // The screen stays as the teacher steps from one student to the next (the
  // form below is the per-student part), so an error is the last student's.
  useEffect(() => setReturnError(null), [studentUid]);
  // Store the grade on the screen before anything that moves on or sends it.
  const settle = () => form.current?.flush() ?? Promise.resolve(true);

  const guard = useLeaveGuard({
    when: formStatus.unsaved || formStatus.invalid !== null || formStatus.staged,
    settle,
    prompt: {
      title: formStatus.staged ? 'This change is not sent' : 'This grade is not saved',
      message: formStatus.invalid
        ? `${formStatus.invalid} Leave now and it is not saved.`
        : formStatus.staged
          ? 'The change to the returned grade has not been sent to the student. Leave now and it is lost.'
          : 'The last change did not reach the server. Leave now and it is lost.',
      stay: 'Stay',
      leave: 'Leave without it',
    },
  });

  const mine = useMemo(() => (subs ?? []).filter((s) => s.courseworkId === cw.id), [subs, cw.id]);
  const gradeOf = useMemo(
    () => new Map((grades ?? []).filter((g) => g.courseworkId === cw.id).map((g) => [g.studentUid, g] as [string, GradeRow])),
    [grades, cw.id],
  );
  const rows = useMemo(() => staffRows(mine, gradeOf, today, cls.effectiveActive, nameOf), [mine, gradeOf, today, cls.effectiveActive, nameOf]);
  const listed = rows.filter((r) => inFilter(r.st, filter));
  const sub = mine.find((s) => s.studentUid === studentUid);
  const saved = gradeOf.get(studentUid);
  const toGrade = rows.filter((r) => r.st === 'toGrade').map((r) => r.s.studentUid);
  const next = toGrade.find((uid) => uid !== studentUid && nameOf(uid).localeCompare(nameOf(studentUid)) > 0) ?? toGrade.find((uid) => uid !== studentUid);
  const st = sub ? staffWorkState(sub, saved, today, cls.effectiveActive) : null;
  // Return is offered once there is a grade on the screen, stored or not:
  // the return stores it first. Waiting for the save to come back round
  // before showing the button made a quick "type, return" a dead key.
  const canReturn = st !== null && st !== 'returned' && st !== 'notRequired' && st !== 'closed' && (formStatus.hasGrade || st === 'graded');

  const open = (uid: string) =>
    void run('next', async () => {
      if (uid === studentUid) return;
      if (await settle()) onOpenStudent(uid);
      else if (formStatus.staged) setReturnError('Send the change to the returned grade, or undo it, before moving on.');
    });
  const sendBack = (retryBy: string | null) =>
    void run(retryBy ? 'retry' : 'return', async () => {
      setReturnError(null);
      try {
        // The server returns the STORED grade, so what is on the screen goes
        // first: returning straight after a change used to send the one before.
        if (!(await settle())) return;
        await returnWork({
          courseworkId: cw.id,
          studentUids: [studentUid],
          ...(retryBy ? { retry: { dueDate: retryBy, lateUntil: null } } : {}),
        });
      } catch (e) {
        setReturnError(errorText(e));
      }
    });

  // The keys, held in a ref so the listener is added once per screen and
  // always sees the current list and the current form.
  const keys = useRef({ step: (_dir: 1 | -1) => {}, ret: () => {} });
  keys.current = {
    step: (dir) => {
      const to = stepFrom(listed, studentUid, dir, nameOf);
      if (to) open(to);
    },
    ret: () => {
      if (canReturn) sendBack(null);
    },
  };
  useEffect(() => {
    if (Platform.OS !== 'web' || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        keys.current.ret();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      // Typing a J into the feedback is typing, not moving on.
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === 'j' || e.key === 'J') keys.current.step(1);
      else if (e.key === 'k' || e.key === 'K') keys.current.step(-1);
    };
    // CAPTURE, not bubble: the feedback box is a react-native-web text input,
    // which keeps its key events to itself, so Ctrl + Enter typed in it — the
    // one place a teacher is when they finish — never reached a bubbling
    // listener on the window.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focused]);

  if (subs === null || grades === null || studentsState === null) {
    return <Screen title="Grade"><Text style={styles.quiet}>Loading…</Text></Screen>;
  }
  if (!sub || st === null) return <Screen title="Grade"><Notice tone="info">This student does not have this assignment.</Notice></Screen>;

  const late = sub.handedInAt !== null && isLate(sub.handedInAt, sub.dueDate, INSTITUTE_TIMEZONE);
  const position = toGrade.indexOf(studentUid);

  const work = (
    <>
      {/* THE MINUTE IT WENT IN, on the heading: with one hand-in there is no
          history to read it from. */}
      <SectionTitle>
        {sub.handedInAt
          ? `Handed in ${stampInZone(INSTITUTE_TIMEZONE, sub.handedInAt)}${late ? ' · late' : ''}`
          : 'Nothing handed in'}
      </SectionTitle>
      <Card>
        {sub.note ? (
          <View style={styles.answer}>
            <RichText markdown={sub.note} />
          </View>
        ) : null}
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
      {/* A history from two events on: one hand-in is the heading above. */}
      {events && events.length > 1 ? (
        <View testID="grade-history" style={styles.history}>
          <Text style={styles.historyTitle}>Hand-in history</Text>
          {events.map((e) => (
            <Text key={e.id} style={styles.quiet}>
              {e.kind === 'handIn' ? `Handed in${e.late ? ', late' : ''}` : 'Taken back'} · {stampInZone(INSTITUTE_TIMEZONE, e.at)}
              {e.attempt > 1 ? ` · attempt ${e.attempt}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
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
              {a.returned.feedback ? (
                <PlainLines text={a.returned.feedback} textStyle={styles.noteLine} style={styles.noteBlock} />
              ) : null}
              {a.note ? (
                <View style={styles.answer}>
                  <RichText markdown={a.note} />
                </View>
              ) : null}
              <Attachments target="work" courseworkId={cw.id} files={a.files} editable={false} studentUid={studentUid} />
            </Card>
          ))}
        </>
      ) : null}
    </>
  );

  const grade = (
    <>
      {st !== 'notRequired' && st !== 'closed' ? (
        <GradeForm
          key={`${studentUid}-${sub.attempt}`}
          cw={cw}
          studentUid={studentUid}
          saved={saved}
          state={sub.state}
          returned={sub.state === 'returned' ? sub.returned : null}
          onApi={(api) => {
            form.current = api;
          }}
          onStatus={setFormStatus}
        />
      ) : null}
      {returnError ? <Notice tone="error">{returnError}</Notice> : null}
      <Row>
        {next ? (
          <Button
            testID="grade-next"
            label="Next to grade ›"
            variant="secondary"
            busy={active === 'next'}
            disabled={formStatus.invalid !== null || formStatus.staged}
            onPress={() => open(next)}
          />
        ) : null}
        {canReturn ? <Button testID="grade-return" label="Return now" busy={active === 'return'} onPress={() => sendBack(null)} /> : null}
      </Row>
      {canReturn ? <RetryOption active={active} onRetry={(by) => sendBack(by)} /> : null}
      {!next && toGrade.length === 0 ? (
        <Text style={styles.quiet}>Everything handed in is graded. Return it from the assignment’s page, together.</Text>
      ) : null}
      {sub.state !== 'returned' ? (
        <StudentOptions cw={cw} studentUid={studentUid} notRequired={sub.notRequired !== null} active={active} run={run} />
      ) : null}
      {layout !== 'stack' && Platform.OS === 'web' ? (
        <Text style={styles.keysHint}>J K next and previous · {RETURN_KEY} return</Text>
      ) : null}
    </>
  );

  const list = (
    <View style={styles.list}>
      <Chips<WorkFilter>
        value={filter}
        testIdPrefix="grade-filter"
        options={[
          { value: 'all', label: 'All' },
          { value: 'toGrade', label: 'To grade' },
          { value: 'pastDue', label: 'Past due' },
          { value: 'returned', label: 'Returned' },
        ]}
        onChange={setFilter}
      />
      {listed.length === 0 ? <Text style={styles.quiet}>Nobody here under this filter.</Text> : null}
      {listed.map(({ s, st: rowSt }) => {
        const here = s.studentUid === studentUid;
        return (
          <Pressable
            key={s.id}
            testID={`grade-list-${nameOf(s.studentUid)}`}
            accessibilityRole="button"
            accessibilityLabel={`Open ${nameOf(s.studentUid)}’s work`}
            accessibilityState={{ selected: here }}
            onPress={() => open(s.studentUid)}
            style={({ pressed }) => [styles.listRow, here ? styles.listRowHere : null, pressed ? styles.pressed : null]}
          >
            <Text style={styles.listName}>{nameOf(s.studentUid)}</Text>
            <Text style={styles.listLine}>{rowLine(s, rowSt)}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <Screen
      title={nameOf(studentUid)}
      subtitle={position >= 0 ? `${position + 1} of ${toGrade.length} to grade` : undefined}
      parent={{ label: cw.title, testID: 'up-to-assignment-from-grade', onPress: onBackToList }}
      width={layout === 'stack' ? 'read' : 'list'}
    >
      {guard.element}
      {layout === 'stack' ? (
        <>
          {work}
          {grade}
        </>
      ) : (
        <View style={styles.columns}>
          {layout === 'three' ? <View style={styles.listCol}>{list}</View> : null}
          <View style={styles.workCol}>{work}</View>
          <View style={styles.gradeCol}>{grade}</View>
        </View>
      )}
    </Screen>
  );
}

const NO_STUDENTS: StudentRow[] = [];

type Gate = ReturnType<typeof useOneAtATime>;

/** What the screen needs from the form: a way to store what is typed, now. */
interface GradeFormApi {
  flush: () => Promise<boolean>;
}

interface GradeFormStatus {
  /** Typed and not yet stored: waiting, on its way, or failed. */
  unsaved: boolean;
  /** Why what is typed cannot be a grade; null when it can. */
  invalid: string | null;
  /** A grade is on the form — stored or about to be. */
  hasGrade: boolean;
  /** A change to RETURNED work, held on the form until it is sent. */
  staged: boolean;
}

const NOTHING_TYPED: GradeFormStatus = { unsaved: false, invalid: null, hasGrade: false, staged: false };

type Draft = { points: string; scale: ScaleMark | ''; feedback: string };

const draftOf = (g: { grade: Grade | null; feedback: string } | null | undefined): Draft => ({
  points: g?.grade && 'points' in g.grade ? String(g.grade.points) : '',
  scale: g?.grade && 'scale' in g.grade ? g.grade.scale : '',
  feedback: g?.feedback ?? '',
});

/**
 * The grade and feedback, saved as they are typed: a draft only staff see
 * until it is returned.
 *
 * RETURNED WORK IS NOT SAVED AS IT IS TYPED. What is saved there reaches the
 * student, so every pause in typing was a new return: emptying a 9 to type 10
 * took the grade away, then sent a 1, then the 10, each told and recorded. The
 * change is held on the form and sent once, with Send the change.
 *
 * Saves go one at a time, in order, and leaving waits for them (see
 * `autosave.ts`). A grade that does not fit is never sent — not even the
 * last good one that was still waiting when it was typed — and says why.
 */
function GradeForm({
  cw,
  studentUid,
  saved,
  state,
  returned,
  onApi,
  onStatus,
}: {
  cw: CourseworkRow;
  studentUid: string;
  saved: { grade: Grade | null; feedback: string } | undefined;
  /** Where the work stands on screen: each change says so, and is refused if it has moved. */
  state: SubmissionState;
  returned: { grade: Grade | null; feedback: string } | null;
  onApi: (api: GradeFormApi | null) => void;
  onStatus: (status: GradeFormStatus) => void;
}) {
  const start = returned ?? saved;
  const [draft, setDraft] = useState<Draft>(() => draftOf(start));
  const touched = useRef(false);
  /*
   * ANOTHER TEACHER'S CHANGE, while this form has none of its own, is shown.
   * Once anything is typed here the form keeps what was typed, and the last
   * save wins, as everywhere else in the app.
   */
  const startKey = start ? `${JSON.stringify(start.grade)}|${start.feedback}` : '';
  useEffect(() => {
    if (!touched.current) setDraft(draftOf(start));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored grade's content
  }, [startKey]);

  const [saveState, setSaveState] = useState<AutosaveState>({ kind: 'idle' });
  const [invalid, setInvalid] = useState<string | null>(null);
  const invalidNow = useRef<string | null>(null);
  const isReturned = returned !== null;
  const stagedNow = useRef(false);
  const { active: sending, run: runSend } = useOneAtATime();
  const [sendError, setSendError] = useState<string | null>(null);
  const stateNow = useRef(state);
  stateNow.current = state;
  const [saver] = useState(() =>
    createAutosave<{ grade: Grade | null; feedback: string; onState: SubmissionState }>({
      delayMs: 600,
      save: (v) => saveGrade({ courseworkId: cw.id, studentUid, ...v }),
      onState: setSaveState,
    }),
  );
  // Through a ref: the screen passes a fresh arrow each render, and an effect
  // keyed on it would run its cleanup — a flush — on every keystroke.
  const api = useRef(onApi);
  api.current = onApi;
  useEffect(() => {
    api.current({ flush: () => (invalidNow.current || stagedNow.current ? Promise.resolve(false) : saver.flush()) });
    // The last resort for a way out the guard does not see, such as signing
    // out: what is waiting is still sent.
    return () => {
      api.current(null);
      void saver.flush();
    };
  }, [saver]);

  const gradeOf = (d: Draft): Grade | null | 'invalid' => {
    if (cw.grading.kind === 'points') {
      if (!d.points.trim()) return null;
      const g = { points: Number(d.points.replace(',', '.')) };
      return gradeFits(g, cw.grading) ? g : 'invalid';
    }
    return d.scale ? { scale: d.scale } : null;
  };

  // Held on returned work: what the form says differs from what the student has.
  const staged =
    isReturned &&
    (JSON.stringify(gradeOf(draft)) !== JSON.stringify(start?.grade ?? null) || draft.feedback !== (start?.feedback ?? ''));
  stagedNow.current = staged;
  const unsaved = saveState.kind === 'waiting' || saveState.kind === 'saving' || saveState.kind === 'failed';
  const hasGrade = invalid === null && gradeOf(draft) !== null;
  useEffect(() => onStatus({ unsaved, invalid, hasGrade, staged }), [onStatus, unsaved, invalid, hasGrade, staged]);

  // The latest draft, for two changes that land before a re-render.
  const latest = useRef(draft);
  latest.current = draft;
  const change = (patch: Partial<Draft>) => {
    touched.current = true;
    const d = { ...latest.current, ...patch };
    latest.current = d;
    setDraft(d);
    const grade = gradeOf(d);
    if (grade === 'invalid') {
      const why = `A grade is a number from 0 to ${cw.grading.kind === 'points' ? cw.grading.outOf : ''}, in halves at most.`;
      invalidNow.current = why;
      setInvalid(why);
      saver.discard();
      return;
    }
    if (isReturned) {
      const why = grade === null ? 'A returned grade can be changed, but it cannot be removed.' : null;
      invalidNow.current = why;
      setInvalid(why);
      return;
    }
    invalidNow.current = null;
    setInvalid(null);
    // The state as the teacher typed, not as it is when the save goes out.
    saver.queue({ grade, feedback: d.feedback, onState: stateNow.current });
  };
  const send = () =>
    void runSend('send', async () => {
      setSendError(null);
      const d = latest.current;
      const grade = gradeOf(d);
      if (grade === 'invalid' || grade === null) return;
      try {
        await saveGrade({ courseworkId: cw.id, studentUid, grade, feedback: d.feedback, onState: 'returned' });
        // The stored grade comes back round as `returned`, and replaces the form.
        touched.current = false;
      } catch (e) {
        setSendError(errorText(e));
      }
    });
  const undo = () => {
    touched.current = false;
    invalidNow.current = null;
    setInvalid(null);
    setSendError(null);
    latest.current = draftOf(start);
    setDraft(draftOf(start));
  };

  const failed = saveState.kind === 'failed';
  return (
    <>
      <SectionTitle>Grade</SectionTitle>
      <Card>
        {cw.grading.kind === 'points' ? (
          <InlineNumber
            testID="grade-points"
            label={`Grade out of ${cw.grading.outOf}`}
            after={`/ ${cw.grading.outOf}`}
            value={draft.points}
            onChangeText={(v) => change({ points: v })}
          />
        ) : (
          <Chips<ScaleMark>
            value={draft.scale as ScaleMark}
            testIdPrefix="grade-scale"
            options={[
              { value: 'satisfactory', label: 'Satisfactory' },
              { value: 'needsWork', label: 'Needs work' },
            ]}
            onChange={(v) => change({ scale: v })}
          />
        )}
        <Field testID="grade-feedback" label="Feedback" value={draft.feedback} onChangeText={(v) => change({ feedback: v })} multiline />
        <Text testID="grade-status" style={[styles.quiet, invalid || failed ? styles.failed : null]}>
          {invalid
            ? invalid
            : failed
              ? `Not saved: ${errorText((saveState as { error: unknown }).error)}`
              : saveState.kind === 'waiting' || saveState.kind === 'saving'
                ? 'Saving…'
                : returned
                  ? staged
                    ? 'Not sent yet. The student sees the change when you send it; a changed grade is a new return, and is recorded.'
                    : 'Returned. To change the grade or the feedback, edit it here, then send the change to the student.'
                  : `${saveState.kind === 'saved' || saved ? 'Saved · only' : 'Only'} staff see this until you return it. Feedback is optional.`}
        </Text>
        {isReturned ? (
          <>
            {sendError ? <Notice tone="error">{sendError}</Notice> : null}
            <Row>
              <Button
                testID="grade-send-change"
                label="Send the change"
                busy={sending === 'send'}
                disabled={!staged || invalid !== null}
                onPress={send}
              />
              {staged ? <Button testID="grade-undo-change" label="Undo" variant="quiet" onPress={undo} /> : null}
            </Row>
          </>
        ) : null}
      </Card>
    </>
  );
}

/** Return with a request for another try, by a new date. */
function RetryOption({ active, onRetry }: { active: string | null; onRetry: (dueDate: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(todayInZone(INSTITUTE_TIMEZONE), 7));
  return (
    <View style={styles.returnNow}>
      <Button testID="grade-retry" label="Ask for another try…" variant="secondary" hug onPress={() => setOpen((o) => !o)} />
      {open ? (
        <Card>
          <Text style={styles.quiet}>
            The work goes back with your grade and feedback, and opens again for another try. This attempt stays with the next.
          </Text>
          <DateField label="Hand in again by" value={date} onChange={setDate} />
          <Button testID="grade-retry-confirm" label="Return and ask for another try" busy={active === 'retry'} onPress={() => onRetry(date)} />
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
function StudentOptions({
  cw,
  studentUid,
  notRequired,
  active,
  run,
}: {
  cw: CourseworkRow;
  studentUid: string;
  notRequired: boolean;
  active: Gate['active'];
  run: Gate['run'];
}) {
  const [open, setOpen] = useState(false);
  // A week past the later of today and the class's own date: more time is
  // more, and the server refuses a date earlier than the class's. Late work
  // keeps the gap the class has, so a student given more time does not lose it.
  const [date, setDate] = useState(() => {
    const today = todayInZone(INSTITUTE_TIMEZONE);
    return addDays(today > cw.dueDate ? today : cw.dueDate, 7);
  });
  const lateUntil = cw.lateUntil === null ? null : addDays(date, daysUntilDue(cw.lateUntil, cw.dueDate));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = (key: string, fn: () => Promise<unknown>) =>
    void run(key, async () => {
      setError(null);
      try {
        await fn();
        setOpen(false);
        setReason('');
      } catch (e) {
        setError(errorText(e));
      }
    });
  if (notRequired) {
    return (
      <>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button
          testID="grade-required-again"
          label="Make it required again"
          variant="secondary"
          busy={active === 'undo'}
          onPress={() => act('undo', () => setNotRequired({ courseworkId: cw.id, studentUid, reason: null }))}
        />
      </>
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
          {lateUntil ? (
            <Text style={styles.quiet}>Late work then until {unbreakableDate(lateUntil)}, the same gap the class has.</Text>
          ) : null}
          <Row>
            <Button
              testID="grade-more-time"
              label="Give more time"
              busy={active === 'time'}
              disabled={!reason.trim()}
              onPress={() => act('time', () => giveMoreTime({ courseworkId: cw.id, studentUid, dueDate: date, lateUntil, reason: reason.trim() }))}
            />
            <Button
              testID="grade-not-required"
              label="Mark not required"
              variant="secondary"
              busy={active === 'notRequired'}
              disabled={!reason.trim()}
              onPress={() => act('notRequired', () => setNotRequired({ courseworkId: cw.id, studentUid, reason: reason.trim() }))}
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
  noteLine: { fontSize: 15, lineHeight: 22, color: t.text.primary },
  noteBlock: { marginBottom: spacing(3) },
  answer: { marginBottom: spacing(3) },
  returnNow: { marginTop: spacing(2) },
  options: { marginTop: spacing(4) },
  history: { marginTop: spacing(3) },
  historyTitle: { fontSize: 13, fontWeight: '600', color: t.text.secondary, marginBottom: spacing(1) },
  keysHint: { fontSize: 12, color: t.text.secondary, marginTop: spacing(4) },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing(5) },
  listCol: { width: 240, flexShrink: 0 },
  workCol: { flex: 1, minWidth: 0 },
  gradeCol: { width: 360, flexShrink: 0 },
  list: { gap: spacing(1) },
  listRow: { borderRadius: 10, paddingVertical: spacing(2), paddingHorizontal: spacing(3) },
  listRowHere: { backgroundColor: t.bg.accentSoft },
  pressed: { opacity: 0.85 },
  listName: { fontSize: 14, fontWeight: '600', color: t.text.primary },
  listLine: { fontSize: 12, color: t.text.secondary },
});
