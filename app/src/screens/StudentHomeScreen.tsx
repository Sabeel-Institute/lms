import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { doc, getDoc } from 'firebase/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  bucketRank,
  canPlayFromCourse,
  dueBucket,
  playVerb,
  todayInZone,
  unbreakableDate,
  type CourseDoc,
  type DueBucket,
  type RecordingDoc,
} from '@sabeel/shared';
import { Empty, Grid, Screen } from '../components/ui';
import { PushNudge } from '../components/PushNudge';
import { db } from '../firebase';
import { captureError } from '../sentry';
import { useMyAssignments, useMyCompletions } from '../completion';
import { useListenerFailed } from '../liveQuery';
import { drainCompletionOutbox } from '../completionOutbox';
import { drainProgressJournal } from '../playback';
import type { CourseRow } from '../structure';
import type { RecordingRow } from '../recordings';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The student's task-ordered home.
 *
 * Every recording a student can reach is here, because a recording is granted by
 * being excused and that grant is exactly what makes it required. So this is at
 * once the to-do list and the whole of what they may listen to — there is no
 * separate browsable archive, and nothing to show that is "available but not
 * required".
 *
 * Grouped Missed → Due soon → Upcoming → Completed. A missed row is kept rather
 * than hidden: access closed, and a student is owed the record of what closed
 * and when. The grant's OWN due date is authoritative, so bucketing reads the
 * assignment, not the recording.
 */
export function StudentHomeScreen({
  uid,
  onOpen,
}: {
  uid: string;
  onOpen: (recording: RecordingRow, cls: CourseRow, dueDate: string) => void;
}) {
  const granted = useMyAssignments(uid);
  // Memoised, not a bare `?? []`: a fresh array literal every render would make
  // every `useMemo` below it recompute on every render, which is what
  // `exhaustive-deps` objects to — and the objection is right.
  const assignments = useMemo(() => granted ?? [], [granted]);
  // A REFUSAL IS NOT A LOAD: `useLiveQuery` resets to `empty` on a listener
  // error too, so without this a denial would sit on "Checking…" for ever.
  // `Screen` renders the error banner itself; this only stops the screen
  // claiming to still be looking.
  const failed = useListenerFailed(['myAssignments']);
  const completions = useMyCompletions(uid);
  const { resolved, resolving } = useResolvedRecordings(assignments.map((a) => a.recordingId));
  // BOTH LEGS. The grants arriving is not the same as the screen having
  // something to show: every row is looked up one at a time afterwards, and
  // until those land the list is empty for a reason that is not "nothing to
  // listen to".
  //
  // On launch, replay what this device saved and then lost to an app kill
  // before it synced: a completion marked offline, and listening done with the
  // screen locked (native only; both are no-ops on web). Runs once the student
  // is signed in, so the replayed writes carry their auth.
  useEffect(() => {
    void drainCompletionOutbox(uid);
    void drainProgressJournal(uid);
  }, [uid]);

  const today = todayInZone(INSTITUTE_TIMEZONE);

  const rows = useMemo(() => {
    return assignments
      .map((a) => {
        const r = resolved.get(a.recordingId);
        if (!r) return null;
        const state = completions.get(a.recordingId);
        const bucket = dueBucket({ dueDate: a.dueDate, completed: state?.completed ?? false }, today);
        return {
          key: a.id,
          recording: r.recording,
          cls: r.cls,
          dueDate: a.dueDate,
          bucket,
          /*
           * THE COURSE IS CLOSED. Archived with listening off, the server
           * refuses the audio (`class-listening-off`), so a row like this is
           * not required listening any more, whatever its date says: it is
           * neither the hero nor a thing still to do, and the brief has
           * archived courses out of the default student views. A row already
           * completed stays Completed — the record is the student's.
           */
          archived: !canPlayFromCourse(r.cls) && bucket !== 'done',
          pending: state?.pending ?? false,
          override: state?.override ?? null,
        };
      })
      .filter((x): x is TaskRow => x !== null)
      .sort(
        (a, b) =>
          bucketRank(a.bucket) - bucketRank(b.bucket) ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.recording.title.localeCompare(b.recording.title),
      );
  }, [assignments, resolved, completions, today]);

  /**
   * The hero: the most urgent recording that can actually be OPENED.
   *
   * Not simply the first incomplete row. A missed recording sorts above
   * everything and is deliberately not a play target — the server refuses to
   * mint a URL past the deadline, so a big tappable card for one would look
   * like the app's most important action and then fail. It stays in the Missed
   * group, where the student is owed the record of what closed and when, and
   * the hero falls through to the first thing still open.
   */
  /*
   * BOTH LEGS, AND ONLY WHEN THERE IS NOTHING TO SHOW.
   *
   * The grants arriving is not the same as the screen having something to show:
   * every row is looked up one at a time afterwards, and until those land the
   * list is empty for a reason that is not "nothing to listen to".
   *
   * `resolving` also turns true again on every change to the assignment set —
   * being excused from one more session re-resolves the lot — so without the
   * `rows.length` leg a fully rendered screen was replaced by "Checking…" for
   * ten round trips each time a grant arrived, with the hero card still sitting
   * above it. A warm update replaces the rows in place; only a cold one has
   * nothing to replace.
   */
  const checking = ((granted === null && !failed) || resolving) && rows.length === 0;

  const next =
    rows.find((r) => !r.archived && (r.bucket === 'dueSoon' || r.bucket === 'upcoming')) ?? null;
  const listed = next ? rows.filter((r) => r.key !== next.key) : rows;

  const groups: { bucket: DueBucket | 'archived'; label: string; rows: TaskRow[] }[] = [
    { bucket: 'missed', label: 'Missed', rows: [] },
    // Quiet, like Missed, and right below it: closed, not owed, not tappable.
    { bucket: 'archived', label: 'Archived', rows: [] },
    { bucket: 'dueSoon', label: 'Due soon', rows: [] },
    { bucket: 'upcoming', label: 'Upcoming', rows: [] },
    { bucket: 'done', label: 'Completed', rows: [] },
  ];
  for (const row of listed) {
    groups.find((g) => g.bucket === (row.archived ? 'archived' : row.bucket))?.rows.push(row);
  }

  return (
    <Screen
      /*
       * LIST, AND A GRID INSIDE IT, like every other collection in the app.
       *
       * The reading width was tried first, on the argument that a short ordered
       * task list is read top to bottom. It is — but at 1440 it put a student's
       * whole app in a 656px ribbon down the middle of a 1364px pane while every
       * staff list beside it used the room, and the full-width rows it left
       * behind set the title and the date 700px apart. Grouped card lists are
       * what `Grid` is for; the grouping is what keeps the order legible.
       */
      width="list"
      title="Your recordings"
      /*
       * NOT "recordings you were excused from". Being excused is what grants
       * these — but read plainly it says "recordings you do not have to listen
       * to", which is the opposite of what this list is, and it borrows a
       * staff-side attendance word into the student's vocabulary.
       *
       * AND NOT "classes to catch up on", which was wrong twice over. Every row
       * is one session's recording, not a class — the class name is the line
       * under it. And "catch up" is what STAFF do about a latecomer (re-take the
       * register, mark them excused, move the listen-by date), so the student's
       * own standing list of required listening was borrowing the word for the
       * exception. It also does not describe the Upcoming or Completed groups,
       * which are two of the four this list has.
       *
       * AND NOT "listening": a recording may be video, and its card says
       * "Watch by". The list's own words name neither.
       */
      subtitle="Required, soonest first"
    >

      {/* Top of the content, below the listener error only. Same place in all
          three apps: first thing after anything that needs acting on today. */}
      <PushNudge uid={uid} />

      {/*
        The one recording to listen to next, at full size, above the grouped
        list of everything else.

        This list is usually one item long — a student is excused from a class
        now and then, not every week — so the common case is a single card under
        a heading with three empty groups implied around it, and the tap that
        matters is always the first one. The grouping below still carries the
        week somebody returns from a fortnight away with five to catch up on.
      */}
      {next ? (
        <Pressable
          testID={`next-up-${next.recording.title}`}
          accessibilityRole="button"
          accessibilityLabel={`Play ${next.recording.title}`}
          onPress={() => onOpen(next.recording, next.cls, next.dueDate)}
          style={({ pressed }) => [styles.hero, pressed ? styles.heroPressed : null]}
        >
          <Text style={styles.heroLabel}>NEXT TO {playVerb(next.recording.media).toUpperCase()}</Text>
          <Text style={styles.heroTitle}>{next.recording.title}</Text>
          <Text style={styles.heroCourse}>{next.cls.name}</Text>
          <Text style={styles.heroDue}>
            {playVerb(next.recording.media)} by {unbreakableDate(next.dueDate)}
          </Text>
          {/* THE CARD IS THE BUTTON, so it has to say so. Without this line the
              app's single most important action was a date in bold ivory — it
              looked like a button label and was not one, and nothing on the
              student's landing screen named the thing to do. */}
          <Text style={styles.heroAction}>Play ›</Text>
        </Pressable>
      ) : null}

      {/* "Nothing required" is an ANSWER, and the wrong one shown to a
          student with three recordings due — on the screen that is the whole of
          this app for them. So it waits for the grants to arrive. */}
      {checking ? (
        <Empty>Checking your recordings…</Empty>
      ) : granted === null ? (
        // Refused, not empty — and the banner above already says why. Saying
        // "nothing required" underneath it would contradict it.
        <Empty>Your recordings could not be loaded. The message above says why.</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing required right now. New recordings will appear here.</Empty>
      ) : (
        groups
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <View key={g.bucket} testID={`group-${g.bucket}`} style={styles.group}>
              {/* No special treatment. Alarm red on the one group a student
                  can do nothing about — sitting over cards deliberately quieted
                  for the same reason — made one of four peer headings read as an
                  error state. "Missed" is already the word. */}
              <Text style={styles.groupLabel}>{g.label}</Text>
              {/* A grid per group, like every other collection. The rows are
                  cards, and stacking them full-width at the list cap left the
                  title and the date 700px apart. */}
              <Grid min={330}>
                {g.rows.map((row) => (
                  <TaskCard
                    key={row.key}
                    row={row}
                    onOpen={() => onOpen(row.recording, row.cls, row.dueDate)}
                  />
                ))}
              </Grid>
            </View>
          ))
      )}

    </Screen>
  );
}

interface TaskRow {
  key: string;
  recording: RecordingRow;
  cls: CourseRow;
  dueDate: string;
  bucket: DueBucket;
  /** The course is archived with listening off — see the note where it is set. */
  archived: boolean;
  pending: boolean;
  /** Set by a teacher, and not the student's to change — see the note on the card. */
  override: { completed: boolean; reason: string } | null;
}

/**
 * A missed card is deliberately not a button. The server refuses to mint a URL
 * past the due date, so opening it could only produce an error — and a card that
 * looks tappable and then refuses reads as a fault in the app rather than a
 * deadline the student missed.
 */
function TaskCard({ row, onOpen }: { row: TaskRow; onOpen: () => void }) {
  const done = row.bucket === 'done';
  // An archived course's row is closed the way a missed one is: not a button,
  // since the server refuses the audio, and quiet.
  const missed = row.bucket === 'missed' || row.archived;
  const body = (
    <>
      <View style={styles.cardMain}>
        <Text style={[styles.title, done || missed ? styles.titleDone : null]}>
          {row.recording.title}
        </Text>
        <Text style={styles.course}>{row.cls.name}</Text>
        {/*
          WHY THIS ROW IS WHERE IT IS, when a teacher put it there.

          An override of `completed: false` sends a recording the student had
          already finished back to the top of this list, and the player offers
          them no Mark complete underneath it — correctly, since the override
          wins whatever they write. Without this line the card is
          indistinguishable from an ordinary outstanding task, so the student
          sees an obligation reappear, taps it, and finds nothing they can do.
          The reason is the teacher's own words and belongs on the card that
          raised the question.
        */}
        {row.override ? (
          <Text style={styles.overrideNote}>
            {row.override.completed
              ? `Marked complete by your teacher — ${row.override.reason}`
              : `Your teacher marked this not complete — ${row.override.reason}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.cardMeta}>
        {row.pending ? <Text style={styles.pending}>Pending sync</Text> : null}
        {done ? (
          <Text style={styles.doneChip}>Completed</Text>
        ) : (
          <Text style={[styles.due, missed ? styles.missed : null]}>
            {row.archived
              ? 'Course archived'
              : missed
                ? `Closed ${unbreakableDate(row.dueDate)}`
                : `${playVerb(row.recording.media)} by ${unbreakableDate(row.dueDate)}`}
          </Text>
        )}
      </View>
    </>
  );

  if (missed) {
    return (
      <View testID={`task-${row.recording.title}`} style={[styles.card, styles.cardMissed]}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={`task-${row.recording.title}`}
      accessibilityRole="button"
      accessibilityLabel={`Play ${row.recording.title}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      {body}
    </Pressable>
  );
}

/**
 * Read one document, treating a refusal as an answer.
 *
 * `permission-denied` is not a failure here: a student may read a recording only
 * while it is PUBLISHED, so an assignment pointing at one staff have just
 * unpublished comes back refused rather than absent. That is the same "it is not
 * available to you" the missing-document branch already handles, so it skips the
 * row the same way.
 *
 * Anything else rethrows on purpose. An offline or failed read must never be
 * mistaken for an empty syllabus — the caller keeps its last good list instead
 * of publishing a short one.
 */
async function readIfPermitted(collectionPath: string, id: string) {
  try {
    const snap = await getDoc(doc(db, collectionPath, id));
    return snap.exists() ? snap : null;
  } catch (e) {
    if ((e as { code?: string }).code === 'permission-denied') return null;
    throw e;
  }
}

/**
 * Resolve each assignment's recording and course for display and navigation.
 *
 * A plain get per id (not a live subscription): titles and course names change
 * rarely, and the accountability state that DOES change — assignment and
 * completion — is already live. Deduplicated and cached across renders.
 *
 * Every read is individually survivable. When one throw could abandon the loop,
 * a single unpublished recording emptied the ENTIRE screen: the rejection escaped
 * before setResolved ran, so no assignment resolved and the student read
 * "Nothing required right now". The fan-out deactivates those assignments a few
 * seconds later, which cleared the screen up again and made the whole thing look
 * like nothing had happened.
 */
function useResolvedRecordings(recordingIds: string[]): {
  resolved: Map<string, { recording: RecordingRow; cls: CourseRow }>;
  /**
   * Whether the reads for the CURRENT set of ids are still in flight.
   *
   * The map is empty until the whole loop finishes, and the loop is sequential —
   * one get per recording plus one per uncached course. For a student with eight
   * assignments across two courses that is ten serial round trips, and for all
   * of them every row mapped to null and the screen said "Nothing to listen to
   * right now. New recordings will appear here." The grants having arrived is
   * not the same as the screen having something to show.
   */
  resolving: boolean;
} {
  // KEYED BY THE IDS IT ANSWERS FOR. A bare map cannot say whether it describes
  // the current request or the previous one.
  const [state, setState] = useState<{
    key: string;
    map: Map<string, { recording: RecordingRow; cls: CourseRow }>;
  }>({ key: '', map: new Map() });
  const key = useMemo(() => [...new Set(recordingIds)].sort().join(','), [recordingIds]);

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(',') : [];
    void (async () => {
      const courseCache = new Map<string, CourseRow | null>();
      const out = new Map<string, { recording: RecordingRow; cls: CourseRow }>();
      try {
        for (const id of ids) {
          const recSnap = await readIfPermitted(COLLECTIONS.recordings, id);
          if (!recSnap) continue;
          const recording = { id: recSnap.id, ...(recSnap.data() as RecordingDoc) };
          if (!courseCache.has(recording.courseId)) {
            const cSnap = await readIfPermitted(COLLECTIONS.courses, recording.courseId);
            courseCache.set(
              recording.courseId,
              cSnap ? { id: cSnap.id, ...(cSnap.data() as CourseDoc) } : null,
            );
          }
          const cls = courseCache.get(recording.courseId);
          if (cls) out.set(id, { recording, cls });
        }
      } catch (e) {
        // Keep the last good list rather than showing a short one, and say so
        // off-device — this used to be an unhandled rejection nobody could see.
        // STILL SETTLED, though: leaving `key` behind would leave the screen on
        // "Checking…" for ever, which is the other half of the same mistake.
        captureError(e, { source: 'resolveAssignedRecordings' });
        if (!cancelled) setState((prev) => ({ key, map: prev.map }));
        return;
      }
      if (!cancelled) setState({ key, map: out });
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { resolved: state.map, resolving: state.key !== key };
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: t.accent.base,
    borderRadius: 12,
    padding: spacing(5),
    marginBottom: spacing(5),
  },
  heroPressed: { opacity: 0.9 },
  heroLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: t.accent.onAccentMuted,
  },
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
    // WRAPS AT 320. Side by side, a title of any length gets 117px beside a
    // one-line date — this app's real titles then break into seven lines
    // against 140px of empty card. Wrapping drops the date under the title,
    // where it has the whole width.
    flexWrap: 'wrap',
    rowGap: spacing(2),
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  pressed: { opacity: 0.85 },
  cardMissed: { backgroundColor: t.bg.inset },
  // `minWidth` is what makes the wrap happen: below it the two blocks cannot
  // share a line, so the date moves to its own.
  cardMain: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 220, paddingRight: spacing(3) },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  titleDone: { color: t.text.secondary },
  course: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  // `flexGrow: 0`. Growing BOTH halves split the spare width evenly, so a
  // one-line date was handed 490px it could not use while the title wrapped —
  // the row's slack belongs to the only part of it that can spend slack.
  cardMeta: { alignItems: 'flex-end' },
  /*
   * THE LIVE DATE IS THE LOUD ONE.
   *
   * It was the other way round: "Closed 2026-08-28" came out danger-red and
   * bold while "Listen by 2026-09-11" was quiet secondary — the app shouting
   * about the one thing the student can no longer do anything about, and
   * whispering the three they can. A closed grant is information; the tone the
   * brief asks for is "missed", not a reprimand.
   */
  due: { fontSize: 13, fontWeight: '600', color: t.text.primary, fontVariant: ['tabular-nums'] },
  missed: { color: t.text.secondary, fontWeight: '400' },
  doneChip: { fontSize: 13, color: t.feedback.success, fontWeight: '600' },
  pending: { fontSize: 12, color: t.feedback.warning, fontWeight: '600', marginBottom: spacing(1) },
  overrideNote: { fontSize: 12, color: t.text.secondary, marginTop: spacing(1), fontStyle: 'italic' },
});
