import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Icon } from '../icons';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  canPlayFromCourse,
  closesOn,
  dueBucket,
  gradeText,
  isOverdue,
  listenWindow,
  nextDeadline,
  playVerb,
  todayInZone,
  unbreakableDate,
  workBucket,
  workState,
  type TodoBucket,
  type WorkState,
} from '@sabeel/shared';
import { Empty, Grid, Screen, useGridCell } from '../components/ui';
import { PushNudge } from '../components/PushNudge';
import { useMyAssignments, useMyCompletions, useMyGivenRecordings } from '../completion';
import { useMyDraftIds, useMySubmissions, type CourseworkRow, type SubmissionRow } from '../coursework';
import { useListenerFailed } from '../liveQuery';
import { drainCompletionOutbox } from '../completionOutbox';
import { drainProgressJournal } from '../playback';
import { useResolvedDocs } from '../resolveDocs';
import { arrangeTodo, type TodoEntry } from '../todo';
import { useStudentEnrollmentsState, type CourseRow } from '../structure';
import type { RecordingRow } from '../recordings';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/** A required recording on the list. */
interface RecordingItem extends TodoEntry {
  kind: 'recording';
  recording: RecordingRow;
  cls: CourseRow;
  dueDate: string;
  pending: boolean;
  /** Set by a teacher, and not the student's to change — see the note on the card. */
  override: { completed: boolean; reason: string } | null;
}

/**
 * A recording staff gave the student: open until a date, optional, counted
 * nowhere. `again` when it reopens one whose listen-by date they missed or
 * met: the record row for it stays where it is.
 */
interface GivenItem extends TodoEntry {
  kind: 'given';
  recording: RecordingRow;
  cls: CourseRow;
  openUntil: string;
  again: boolean;
}

/** An assignment on the list. */
interface WorkItem extends TodoEntry {
  kind: 'work';
  coursework: CourseworkRow;
  submission: SubmissionRow;
  cls: CourseRow;
  state: WorkState;
  draftSaved: boolean;
}

type Item = RecordingItem | GivenItem | WorkItem;

/**
 * The student's To do: everything they owe, in one list
 * (docs/proposals/lms-assignments-proposal.html, section 2).
 *
 * Two kinds of work, each by its own rules. A recording is required because
 * the student was marked excused — the grant is both the access and the
 * obligation. An assignment is here because the student is in the class; the
 * register plays no part. And under Optional, a recording a teacher gave
 * them: open until a date, required by nothing, never Next up.
 *
 * Open work first, the record after: the nearest deadline drawn large, then
 * Past due, Due soon, Upcoming; then Missed and Archived, quiet and
 * unopenable, as a student is owed the record of what closed and when; then
 * two weeks of Done. The order is `arrangeTodo`'s, tested on its own.
 */
export function StudentHomeScreen({
  uid,
  onOpenRecording,
  onOpenWork,
}: {
  uid: string;
  onOpenRecording: (recording: RecordingRow, cls: CourseRow) => void;
  onOpenWork: (courseworkId: string) => void;
}) {
  const granted = useMyAssignments(uid);
  const submissions = useMySubmissions(uid);
  // Memoised, not a bare `?? []`: a fresh array literal every render would make
  // every `useMemo` below it recompute on every render.
  const grants = useMemo(() => granted ?? [], [granted]);
  const work = useMemo(() => submissions ?? [], [submissions]);
  // A REFUSAL IS NOT A LOAD: `useLiveQuery` resets to `empty` on a listener
  // error too, so without this a denial would sit on "Checking…" for ever.
  const failed = useListenerFailed(['myAssignments', 'mySubmissions']);
  const completions = useMyCompletions(uid);
  const drafts = useMyDraftIds(uid);
  const recordings = useResolvedDocs(COLLECTIONS.recordings, useMemo(() => grants.map((a) => a.recordingId), [grants]));
  const coursework = useResolvedDocs(COLLECTIONS.coursework, useMemo(() => work.map((s) => s.courseworkId), [work]));

  const today = todayInZone(INSTITUTE_TIMEZONE);

  /*
   * GIVEN RECORDINGS, and the classes the student is still in. The list is
   * live; the recordings and classes behind it are read once, like the
   * required ones. But nothing about a given recording changes when its
   * recording is unpublished or its class archived, so those are read again
   * on coming back to To do, on coming back to the app, and when the
   * student's classes change: until then a tap reaches "not available", which
   * is the truth.
   */
  const givenList = useMyGivenRecordings(uid);
  const enrolments = useStudentEnrollmentsState(uid);
  const givenFailed = useListenerFailed(['myGivenRecordings', 'studentEnrollments']);
  const inClass = useMemo(
    () => new Set((enrolments ?? []).filter((e) => e.active).map((e) => e.courseId)),
    [enrolments],
  );
  const classKey = [...inClass].sort().join(',');
  const openGiven = useMemo(
    () => (givenList ?? []).filter((g) => !isOverdue(g.openUntil, today) && inClass.has(g.courseId)),
    [givenList, inClass, today],
  );
  const [refresh, setRefresh] = useState(0);
  const again = useCallback(() => setRefresh((n) => n + 1), []);
  useFocusEffect(again);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') again();
    });
    return () => sub.remove();
  }, [again]);
  useEffect(again, [classKey, again]);
  const givenRecordings = useResolvedDocs(
    COLLECTIONS.recordings,
    useMemo(() => openGiven.map((g) => g.recordingId), [openGiven]),
    refresh,
  );

  // On launch, replay what this device saved and then lost before it synced:
  // a completion marked offline (native only), and listening done with the
  // screen locked or the tab closed offline (progressJournal.ts).
  useEffect(() => {
    void drainCompletionOutbox(uid);
    void drainProgressJournal(uid);
  }, [uid]);

  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    for (const a of grants) {
      const r = recordings.resolved.get(a.recordingId);
      if (!r) continue;
      const state = completions.get(a.recordingId);
      const bucket = dueBucket({ dueDate: a.dueDate, completed: state?.completed ?? false }, today);
      /*
       * THE COURSE IS CLOSED. Archived with its recordings closed, the server
       * refuses the audio (`class-listening-off`), so a row like this is not
       * required any more, whatever its date says. A row already completed
       * stays done — the record is the student's.
       */
      const archived = !canPlayFromCourse(r.cls) && bucket !== 'done';
      const todo: TodoBucket = archived ? 'archived' : bucket;
      out.push({
        kind: 'recording',
        key: `rec-${a.id}`,
        title: r.doc.title,
        bucket: todo,
        deadline: todo === 'dueSoon' || todo === 'upcoming' ? a.dueDate : null,
        doneAt: state?.completedAt ?? null,
        recording: r.doc,
        cls: r.cls,
        dueDate: a.dueDate,
        pending: state?.pending ?? false,
        override: state?.override ?? null,
      });
    }
    for (const g of openGiven) {
      const r = givenRecordings.resolved.get(g.recordingId);
      // Closed with its class: the audio is refused, so it is not on offer.
      if (!r || !canPlayFromCourse(r.cls)) continue;
      const grant = grants.find((a) => a.recordingId === g.recordingId) ?? null;
      const window = listenWindow(grant, g, true, today);
      // Required right now: the required row says everything, and a second
      // row for the same recording would only confuse it.
      if (window.state !== 'open' || window.required) continue;
      out.push({
        kind: 'given',
        key: `given-${g.id}`,
        title: r.doc.title,
        bucket: 'optional',
        deadline: g.openUntil,
        doneAt: null,
        recording: r.doc,
        cls: r.cls,
        openUntil: g.openUntil,
        again: window.listenByWas !== null,
      });
    }
    for (const s of work) {
      const c = coursework.resolved.get(s.courseworkId);
      if (!c) continue;
      const state = workState(s, today, c.cls.effectiveActive);
      const bucket = workBucket(state, s.dueDate, today);
      if (!bucket) continue;
      out.push({
        kind: 'work',
        key: `work-${s.id}`,
        title: c.doc.title,
        bucket,
        deadline: nextDeadline(state, s),
        doneAt: s.returned && s.state === 'returned' ? s.returned.at : s.handedInAt,
        coursework: c.doc,
        submission: s,
        cls: c.cls,
        state,
        draftSaved: drafts.has(s.courseworkId),
      });
    }
    return out;
  }, [grants, work, openGiven, recordings.resolved, givenRecordings.resolved, coursework.resolved, completions, drafts, today]);

  const { next, groups } = useMemo(() => arrangeTodo(items, Date.now()), [items]);

  /*
   * BOTH LEGS, AND ONLY WHEN THERE IS NOTHING TO SHOW. The lists arriving is
   * not the same as the screen having something to show: every row is looked
   * up one at a time afterwards. And a warm update replaces the rows in place;
   * only a cold one has nothing to replace.
   */
  const loading = ((granted === null || submissions === null) && !failed) || ((givenList === null || enrolments === null) && !givenFailed);
  const checking = (loading || recordings.resolving || coursework.resolving || givenRecordings.resolving) && items.length === 0;

  const open = (item: Item) => (item.kind === 'work' ? onOpenWork(item.coursework.id) : onOpenRecording(item.recording, item.cls));

  return (
    <Screen
      /*
       * LIST, AND A GRID INSIDE IT, like every other collection in the app:
       * grouped card lists are what `Grid` is for, and the grouping is what
       * keeps the order legible at 1440.
       */
      width="list"
      title="To do"
    >
      <PushNudge uid={uid} />

      {next ? <Hero item={next} onOpen={() => open(next)} /> : null}

      {/* "Nothing to do" is an ANSWER, and the wrong one shown to a student
          with three things due — so it waits for everything to arrive. */}
      {checking ? (
        <Empty>Checking what you have to do…</Empty>
      ) : granted === null || submissions === null || (items.length === 0 && (givenList === null || enrolments === null)) ? (
        // Refused, not empty — and the banner above already says why.
        <Empty>Your list could not be loaded. The message above says why.</Empty>
      ) : items.length === 0 ? (
        <Empty>Nothing to do right now. New recordings and assignments will appear here.</Empty>
      ) : (
        groups.map((g) => (
          <View key={g.bucket} testID={`group-${g.bucket}`} style={styles.group}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            <Grid min={330}>
              {g.items.map((item) => (
                <Card key={item.key} item={item} onOpen={() => open(item)} />
              ))}
            </Grid>
          </View>
        ))
      )}
    </Screen>
  );
}

/**
 * What the next thing is, and when, in the words of its kind. Late work has
 * two dates, one per line: drawn as one, it ran off a 320px card.
 */
function dueLines(item: Item): string[] {
  return [dueLine(item), ...(item.kind === 'work' && item.state === 'pastDue' ? [`Accepted until ${unbreakableDate(closesOn(item.submission))}`] : [])];
}

function dueLine(item: Item): string {
  if (item.kind === 'given') return `${item.again ? 'Open again' : 'Open'} until ${unbreakableDate(item.openUntil)}`;
  if (item.kind === 'recording') {
    if (item.bucket === 'archived') return 'Course archived';
    if (item.bucket === 'missed') return `Closed ${unbreakableDate(item.dueDate)}`;
    if (item.bucket === 'done') return 'Completed';
    return `${playVerb(item.recording.media)} by ${unbreakableDate(item.dueDate)}`;
  }
  const s = item.submission;
  switch (item.state) {
    case 'toDo':
      return `Hand in by ${unbreakableDate(s.dueDate)}${item.draftSaved ? ' · draft saved' : ''}`;
    case 'pastDue':
      return `Was due ${unbreakableDate(s.dueDate)}`;
    case 'missed':
      return s.closedEarly ? 'Closed' : `Closed ${unbreakableDate(closesOn(s))}`;
    case 'closed':
      return 'Course archived';
    case 'handedIn':
      return s.handedInAt ? `Handed in ${unbreakableDate(todayInZone(INSTITUTE_TIMEZONE, s.handedInAt))}` : 'Handed in';
    case 'returned':
      return s.returned?.grade ? `Returned · ${gradeText(s.returned.grade, item.coursework.grading)}` : 'Returned';
    case 'notRequired':
      return 'Not required';
  }
}

const action = (item: Item) =>
  item.kind !== 'work' ? 'Play ›' : item.draftSaved || item.submission.attempt > 1 ? 'Continue ›' : 'Start ›';

/**
 * The one thing to do next, at full size. THE CARD IS THE BUTTON, so it says
 * so: its last line names the action, or the most important thing on the
 * screen is a date in bold that looks like a button label and is not one.
 */
function Hero({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <Pressable
      testID={`next-up-${item.title}`}
      accessibilityRole="button"
      accessibilityLabel={`${item.kind === 'work' ? 'Open' : 'Play'} ${item.title}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.hero, pressed ? styles.heroPressed : null]}
    >
      <Text style={styles.heroLabel}>NEXT UP</Text>
      <Text style={styles.heroTitle}>{item.title}</Text>
      <Text style={styles.heroCourse}>{item.cls.name}</Text>
      <Text style={styles.heroDue}>{dueLines(item).join(' · ')}</Text>
      <Text style={styles.heroAction}>{action(item)}</Text>
    </Pressable>
  );
}

/**
 * One row. Missed and archived rows are deliberately not buttons: the server
 * refuses a closed recording's audio and a closed assignment's hand-in, and a
 * card that looks tappable and then refuses reads as a fault in the app
 * rather than a deadline. An assignment that has closed still opens, though —
 * its instructions and the student's record stay readable.
 */
function Card({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const done = item.bucket === 'done';
  const closed = item.bucket === 'missed' || item.bucket === 'archived';
  const tappable = item.kind === 'work' || !closed;
  const inGrid = useGridCell();
  const body = (
    <>
      <Icon
        name={item.kind === 'work' ? 'assignment' : 'play-circle-outline'}
        size={22}
        color={t.text.secondary}
        style={styles.icon}
        accessibilityLabel={item.kind === 'work' ? 'Assignment' : 'Recording'}
      />
      {/* THE ICON STAYS OUT OF THE WRAP. Inside it, a phone's wrapped due
          lines went to the start of the card's own line, under the icon. */}
      <View style={styles.cardBody}>
      <View style={styles.cardMain}>
        <Text style={[styles.title, done || closed ? styles.titleDone : null]}>{item.title}</Text>
        <Text style={styles.course}>{item.cls.name}</Text>
        {/*
          WHY THIS ROW IS WHERE IT IS, when a teacher put it there: an
          override of `completed: false` sends a finished recording back to
          the top with no Mark complete under it, and without the teacher's
          own words the student taps it and finds nothing they can do.
        */}
        {item.kind === 'recording' && item.override ? (
          <Text style={styles.overrideNote}>
            {item.override.completed
              ? `Marked complete by your teacher — ${item.override.reason}`
              : `Your teacher marked this not complete — ${item.override.reason}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.cardMeta}>
        {item.kind === 'recording' && item.pending ? <Text style={styles.pending}>Pending sync</Text> : null}
        {dueLines(item).map((line) => (
          <Text key={line} style={[styles.due, done ? styles.doneText : closed ? styles.closed : null]}>
            {line}
          </Text>
        ))}
      </View>
      </View>
    </>
  );

  if (!tappable) {
    return (
      <View testID={`task-${item.title}`} style={[styles.card, inGrid, styles.cardClosed]}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={item.kind === 'given' ? `optional-${item.title}` : `task-${item.title}`}
      accessibilityRole="button"
      accessibilityLabel={
        item.kind === 'given'
          ? `Play ${item.title}, optional, open until ${item.openUntil}`
          : `${item.kind === 'recording' ? 'Play' : 'Open'} ${item.title}`
      }
      onPress={onOpen}
      style={({ pressed }) => [styles.card, inGrid, closed ? styles.cardClosed : null, pressed ? styles.pressed : null]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: t.accent.base,
    borderRadius: 12,
    padding: spacing(5),
    marginBottom: spacing(5),
  },
  heroPressed: { opacity: 0.9 },
  heroLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: t.accent.onAccentMuted },
  heroTitle: { fontSize: 22, fontWeight: '700', color: t.accent.onAccent, marginTop: spacing(2) },
  heroCourse: { fontSize: 14, color: t.accent.onAccentMuted, marginTop: 2 },
  heroDue: { fontSize: 14, color: t.accent.onAccentMuted, marginTop: spacing(3) },
  heroAction: { fontSize: 15, fontWeight: '700', color: t.accent.onAccent, marginTop: spacing(2) },
  group: { marginBottom: spacing(5) },
  groupLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.text.secondary,
    marginBottom: spacing(2),
  },
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
  cardClosed: { backgroundColor: t.bg.inset },
  icon: { marginRight: spacing(3) },
  // WRAPS AT 320: side by side, a title of any length got 117px beside a
  // one-line date. Wrapping drops the date under the title.
  cardBody: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: spacing(2) },
  // `minWidth` is what makes the wrap happen: below it the two blocks cannot
  // share a line, so the date moves to its own.
  cardMain: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 180, paddingRight: spacing(3) },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  titleDone: { color: t.text.secondary },
  course: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  // Lines left-aligned to each other. The block sits at the right end of a
  // wide card because the title beside it grows, and at the start of its own
  // line, under the title, when it wraps.
  cardMeta: { alignItems: 'flex-start', flexShrink: 1, maxWidth: '100%' },
  /*
   * THE LIVE DATE IS THE LOUD ONE: the app whispering the three things a
   * student can do and shouting the one they no longer can was the tone the
   * brief rules out. A closed date is information.
   */
  due: { fontSize: 13, fontWeight: '600', color: t.text.primary, fontVariant: ['tabular-nums'] },
  closed: { color: t.text.secondary, fontWeight: '400' },
  doneText: { color: t.feedback.success },
  pending: { fontSize: 12, color: t.feedback.warning, fontWeight: '600', marginBottom: spacing(1) },
  overrideNote: { fontSize: 12, color: t.text.secondary, marginTop: spacing(1), fontStyle: 'italic' },
});
