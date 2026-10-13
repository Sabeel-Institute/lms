import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  canPlayFromCourse,
  canPlayNow,
  VERSION_LABELS,
  isPlayable,
  listenedFraction,
  mediaParts,
  startingItem,
  todayInZone,
} from '@sabeel/shared';
import { Chips, Notice } from '../components/ui';
import { VideoSurface } from '../components/VideoSurface';
import { Scrubber } from '../components/Scrubber';
import { Transport } from '../components/Transport';
import { IDLE, closePlayback, formatClock, openPlayback, playback, usePlayback } from '../playback';
import { useCompletion, useMyListening, setCompleted } from '../completion';
import { useListenerError } from '../liveQuery';
import { useCohortName, type CourseRow } from '../structure';
import type { RecordingRow } from '../recordings';
import { getTheme, spacing } from '../theme';

const t = getTheme();
const RATES = [1, 1.25, 1.5, 2];

/**
 * Listening to one recording.
 *
 * Laid out like a video page rather than a dashboard: the controls own the top
 * of the screen and everything else — notes, listening detail — sits BELOW the
 * fold, reached by scrolling. Notes are shared with everyone who can access the
 * recording and can run long, so putting them inline would push the transport
 * off a phone screen.
 */
export function PlayerScreen({
  recording,
  cls,
  studentUid,
  dueDate,
  itemId: askedItemId,
}: {
  recording: RecordingRow;
  cls: CourseRow;
  studentUid: string | null;
  /** The caller's due date: the session's for staff, the student's own
   *  assignment for students, or null when browsing something not assigned. */
  dueDate: string | null;
  /** One file to open — staff previewing it from the session page — or null
   *  for the recording's starting file. */
  itemId: string | null;
}) {
  const listenerError = useListenerError();
  // Two independent reasons the audio may be shut: the course was archived with
  // listening off, or this student's own deadline has passed. Either way the
  // server refuses to mint a URL, so the transport must not be drawn — a play
  // button that does nothing reads as a broken app rather than a closed door.
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const allowed = canPlayNow(cls, dueDate, studentUid, today);
  // WHICH of the two, derived by ELIMINATION rather than by re-testing the
  // deadline. Spelling `studentUid !== null && isOverdue(dueDate, today)` here
  // would put half of `canPlayNow` in a second place, free to disagree with the
  // half that actually shuts the transport — and the disagreement would surface
  // as the wrong sentence under a correct lockout, which no test would catch.
  const closed = !allowed && canPlayFromCourse(cls);
  // The file this recording starts on: its first part, in the version students
  // start on. Publishing requires one, so a recording anyone reaches here has it.
  // A file asked for by id is staff previewing it, hidden or not; the server
  // decides whether this caller may hear it. Otherwise the session resumes
  // where this listener left off.
  const requested = askedItemId && recording.media[askedItemId]?.status === 'ready' ? askedItemId : null;
  const playable = requested !== null || startingItem(recording.media, recording.defaultVersion) !== null;
  const session = usePlayback();
  // The session is app-wide, so on the first render after arriving it may still
  // describe the PREVIOUS recording. Read it only once it is about this one;
  // otherwise the scrubber shows another lecture's position for a frame.
  const state = session.now?.recordingId === recording.id ? session : IDLE;
  const { play, pause, seek, setRate } = playback;
  /*
   * THE GATE CLOSES ON A SESSION ALREADY PLAYING, not only on one about to
   * start.
   *
   * `allowed` goes false in two ways that have nothing to do with the recording
   * document: the course is archived with listening off, and the student's own
   * deadline rolls over at midnight. Both are live here — so without this the
   * screen swaps to "this recording closed" over audio that is still running,
   * with the transport gone and no control anywhere to stop it.
   */
  useEffect(() => {
    if (!allowed && session.now?.recordingId === recording.id) void closePlayback();
  }, [allowed, session.now?.recordingId, recording.id]);

  // Opening the session is an EFFECT, not a render-time call: this screen is one
  // view onto app-wide playback, and re-entering it for something already
  // playing must re-focus rather than restart. `openPlayback` is idempotent for
  // the loaded recording, so a re-render costs nothing.
  useEffect(() => {
    if (!allowed || !playable) return;
    openPlayback({
      recordingId: recording.id,
      itemId: requested,
      courseId: recording.courseId,
      title: recording.title,
      courseName: cls.name,
      media: recording.media,
      defaultVersion: recording.defaultVersion,
      studentUid,
      dueDate,
    });
  }, [
    allowed,
    playable,
    requested,
    recording.id,
    recording.title,
    recording.media,
    recording.defaultVersion,
    recording.courseId,
    cls.name,
    studentUid,
    dueDate,
  ]);
  // While the scrubber is being dragged it reports the previewed position; the
  // time readouts follow the thumb rather than the still-advancing playhead.
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  // Staff can reach this across cohorts, where a course name alone is ambiguous;
  // students can't read cohorts and arrive from their own single context, so the
  // lookup is disabled for them (returns '').
  const cohortName = useCohortName(studentUid === null)(recording.cohortId);

  if (!allowed) {
    return (
      <ScrollView style={styles.canvas} contentContainerStyle={styles.content}>
        {/* THE BANNER BELONGS ON THIS BRANCH TOO. It used to sit only on the
            playable return, which cost nothing while this branch subscribed to
            nothing. It now mounts three listeners for `ClosedRecord`, and a
            refused one resolves to an EMPTY value — so without this, a failed
            read of the student's own listening row renders as a confident
            account of what they did, on the screen they have no other way to
            check. */}
        {listenerError ? <Notice tone="error">{listenerError}</Notice> : null}
        <Hero recording={recording} courseName={cls.name} cohortName={cohortName} />
        {/* THREE REASONS, and each says something different to do about it.
            "Closed on <date>" needs a date; a student who holds no grant at all
            has none, and telling them a recording closed on `null` is worse
            than telling them it was never theirs. */}
        <Notice tone="info">
          {!closed
            ? 'This course has been archived and listening has been turned off. Your listening history is kept — ask your teacher if you need access again.'
            : dueDate === null
              ? 'This recording has not been assigned to you. Your teacher marks who needs to listen when they take the register.'
              : `This recording closed on ${dueDate}. Your listening record is kept — ask your teacher if you need it reopened.`}
        </Notice>
        {/* AND THE RECORD ITSELF, which "is kept" above promises and the screen
            used not to show. A student who finished a recording on time could
            not see that they had, from the day it closed — they had to ask.
            The transport is gone; the account of what they did is not. */}
        {studentUid !== null && dueDate !== null ? (
          <ClosedRecord studentUid={studentUid} recording={recording} />
        ) : null}
      </ScrollView>
    );
  }

  // The file being played: its length is the scrubber's, a part rather than
  // the whole recording.
  const current = state.now ? state.now.media[state.now.itemId] : undefined;
  const durationMs = state.now?.durationMs ?? 0;
  const shownPositionMs = scrubMs ?? state.positionMs;
  // What this listener can move between: the versions of the part being
  // played, and the recording's parts. Staff may play hidden files; students
  // see what students are given.
  const offered = Object.values(recording.media).filter((i) =>
    studentUid === null ? i.status === 'ready' : isPlayable(i),
  );
  const parts = mediaParts(offered);
  const versions = current ? offered.filter((i) => i.part === current.part) : [];
  const remainingMs = Math.max(0, durationMs - shownPositionMs);
  const listened = listenedFraction(state.listenedMs, recording.durationSec);

  return (
    <ScrollView style={styles.canvas} contentContainerStyle={styles.content}>
      {listenerError ? <Notice tone="error">{listenerError}</Notice> : null}
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}

      {/*
        ONE COLUMN, CAPPED — at every width.

        A two-column split was tried and is worse: a lecture's panel, transport
        and rate chips do not fill half a 1400px window, so the controls ended up
        trapped in a 480px gutter with the other half empty below the notes. The
        player is a single object read top to bottom, like a podcast episode
        page, and 560px is the width it wants. The room a desktop has to spare is
        margin, not a second column.
      */}
      {current?.kind === 'video' ? <VideoSurface /> : null}
      <Hero recording={recording} courseName={cls.name} cohortName={cohortName} />

      {/* THE VERSIONS OF THIS PART, which share its timeline: switching keeps
          the place and plays on. "Audio only" is also the way to save data
          on the move. */}
      {versions.length > 1 && current ? (
        <View style={styles.versions}>
          <Chips
            value={current.id}
            testIdPrefix="player-version"
            options={versions.map((i) => ({ value: i.id, label: VERSION_LABELS[i.version] }))}
            onChange={(id) => playback.selectItem(id)}
          />
        </View>
      ) : null}

      {!playable ? <Notice tone="info">Nothing in this recording can be played yet.</Notice> : null}

      <Scrubber
        testID="player-scrubber"
        positionMs={shownPositionMs}
        durationMs={durationMs}
        disabled={!state.ready}
        onSeek={seek}
        onScrub={setScrubMs}
      />
      <View style={styles.times}>
        <Text testID="player-elapsed" style={styles.time}>
          {formatClock(shownPositionMs)}
        </Text>
        {/* Remaining, not total: mid-lecture, "how much is left" is the question
            anyone actually has. */}
        <Text style={styles.time}>−{formatClock(remainingMs)}</Text>
      </View>

      <Transport
        playing={state.playing}
        disabled={!state.ready}
        onPlayPause={state.playing ? pause : play}
        onBack={playback.skipBack}
        onForward={playback.skipForward}
      />

      <View style={styles.speedRow}>
        {RATES.map((r) => {
          const on = state.rate === r;
          return (
            <Pressable
              key={r}
              testID={`player-rate-${r}`}
              accessibilityRole="button"
              aria-pressed={on}
              accessibilityLabel={`Playback speed ${r} times`}
              disabled={!state.ready}
              onPress={() => setRate(r)}
              style={[styles.speedChip, on ? styles.speedChipOn : null]}
            >
              <Text style={[styles.speedText, on ? styles.speedTextOn : null]}>{r}×</Text>
            </Pressable>
          );
        })}
      </View>

      {!state.ready && !state.error && playable ? <Text style={styles.preparing}>Preparing…</Text> : null}

      {/* THE PARTS, when the class was recorded in more than one stretch. At
          the end of one the next starts by itself; these are for jumping. */}
      {parts.length > 1 && current ? (
        <View style={styles.parts}>
          {parts.map(({ part, items }, index) => {
            const longest = Math.max(0, ...items.map((i) => i.durationSec ?? 0));
            const here = part === current.part;
            return (
              <Pressable
                key={part}
                testID={`player-part-${index + 1}`}
                accessibilityRole="button"
                aria-pressed={here}
                accessibilityLabel={`Part ${index + 1}${here ? ', playing' : ''}`}
                disabled={here || !state.ready}
                onPress={() => playback.selectPart(part)}
                style={[styles.part, here ? styles.partOn : null]}
              >
                <Text style={[styles.partText, here ? styles.partTextOn : null]}>
                  {`Part ${index + 1}`}
                  {longest > 0 ? ` · ${formatClock(longest * 1000)}` : ''}
                  {here ? ' · playing' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* AT THE END, the moment completion is for — said plainly, never as a
          demand: marking complete is the student's own statement. */}
      {state.ended && studentUid ? (
        <Notice tone="info">You have reached the end of this recording. If you have finished it, mark it complete below.</Notice>
      ) : null}

      {/* ---- below the fold ---- */}
      <View style={styles.divider} />

      {/* Staff reach this player to preview/reference audio; there is no student
          to track, so the listening bar and completion control are student-only.
          A short note says why, rather than leaving a bare gap. */}
      {studentUid ? (
        <>
          <Text style={styles.sectionHeading}>Your listening</Text>
          <View style={styles.listenedTrack}>
            <View style={[styles.listenedFill, { width: `${Math.round(listened * 100)}%` }]} />
          </View>
          <Text style={styles.body}>
            {Math.round(listened * 100)}% of this recording listened. Your place is saved
            automatically, so you can carry on from another device.
          </Text>
          {/*
            LISTENED TIME ALONE. `positionMs > 0` counted a SEEK as playing — so
            opening a recording and tapping +30s once, with no audio played at
            all, unlocked Mark complete. That is the product's only precondition
            on completion, and three documents state it as "you do have to press
            play first".

            `listenedMs` is the honest measure: `onProgress` only adds to it for
            forward movement at roughly real time, and refuses a jump, which is
            the same rule the ledger's evidence is built on. A resumed session is
            still covered — the stored total is restored when the session opens,
            so a student who listened yesterday is not asked to prove it again.
          */}
          <CompletionControl
            studentUid={studentUid}
            recordingId={recording.id}
            courseId={recording.courseId}
            everPlayed={state.listenedMs > 0}
          />
        </>
      ) : (
        <Text style={styles.staffNote}>
          Staff preview — your listening isn&apos;t recorded, and there&apos;s nothing to mark
          complete here.
        </Text>
      )}

      {recording.notes ? (
        <>
          <Text style={styles.sectionHeading}>About this recording</Text>
          <Text style={styles.body}>{recording.notes}</Text>
        </>
      ) : null}

      {/* For a student the due date is not a nag, it is the day this recording
          closes to them — so it is stated as an availability window rather than
          a deadline. Staff previewing see the session's date plainly. */}
      {dueDate ? (
        <Text style={styles.due}>
          {studentUid ? `Available to listen until ${dueDate}` : `Due ${dueDate}`}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/**
 * Stands where Spotify puts album art. A lecture has none, so the panel carries
 * the type instead — same visual anchor, nothing invented.
 */
function Hero({
  recording,
  courseName,
  cohortName,
}: {
  recording: RecordingRow;
  courseName: string;
  cohortName: string;
}) {
  return (
    <View style={styles.hero}>
      <Text style={styles.heroCourse}>
        {courseName.toUpperCase()}
        {cohortName ? ` · ${cohortName.toUpperCase()}` : ''}
      </Text>
      {/* Not clamped. Three lines cut the institute's longest title mid-word on
          a phone — "…the Hikam of Ib…" — on a screen that had room below the
          card for all six. The transport stays reachable because the screen
          scrolls; a truncated title is simply the wrong name. */}
      <Text style={styles.heroTitle}>{recording.title}</Text>
      {recording.date ? <Text style={styles.heroDate}>Recorded {recording.date}</Text> : null}
    </View>
  );
}

/**
 * Mark complete / completed, with the never-played gate.
 *
 * Completion is student-attested (brief): there is no listened-% threshold. The
 * ONE precondition is that the student has played at all — enforced here, in the
 * app, deliberately not in the rules, so an offline completion is never
 * false-rejected on sync. Writes go straight to Firestore and work offline; a
 * queued write shows as "Pending sync" until it lands.
 */
/**
 * What a student did with a recording that has since closed.
 *
 * Read-only by construction: the transport is gone, Mark complete is gone, and
 * an override is a teacher's to change. What remains is the account the brief
 * promises them — how much they listened, and whether it counted.
 */
function ClosedRecord({
  studentUid,
  recording,
}: {
  studentUid: string;
  recording: RecordingRow;
}) {
  const { value: stored, resolved } = useMyListening(studentUid, recording.id);
  const { completed, override } = useCompletion(studentUid, recording.id);
  // WAIT FOR THE ANSWER. `null` before the first snapshot and `null` for "never
  // played it" are the same value, and the completions listener regularly wins
  // the race — so rendering early tells a student who finished the recording on
  // time that they listened to none of it, then corrects itself.
  if (!resolved) return null;
  // Nothing was ever played and nothing was ever marked: there is no record to
  // show, and an empty panel saying "0%" is worse than no panel.
  if (!stored && !completed && !override) return null;
  return (
    <View style={styles.closedRecord}>
      <Text style={styles.closedRecordTitle}>Your record</Text>
      {/*
        ONLY WHEN THERE IS ONE TO STATE, and never as a percentage of a duration
        the recording does not have. `listenedFraction` returns 0 for a null
        `durationSec` — which a phone upload supplies — so a student who listened
        to the whole thing was told "0% listened", as the final word, on a
        recording they can no longer open. With no duration the honest figure is
        the time itself.
      */}
      {stored ? (
        <Text style={styles.closedRecordLine}>
          {recording.durationSec
            ? `${Math.round(listenedFraction(stored.listenedMs, recording.durationSec) * 100)}% listened`
            : `${formatClock(stored.listenedMs)} listened`}
        </Text>
      ) : null}
      <Text style={styles.closedRecordLine}>
        {completed ? '✓ Completed' : 'Not marked complete'}
        {override ? ' — marked by your teacher' : ''}
      </Text>
      {override ? <Text style={styles.closedRecordLine}>{override.reason}</Text> : null}
    </View>
  );
}

function CompletionControl({
  studentUid,
  recordingId,
  courseId,
  everPlayed,
}: {
  studentUid: string;
  recordingId: string;
  courseId: string;
  everPlayed: boolean;
}) {
  const { completed, pending, override } = useCompletion(studentUid, recordingId);

  /*
   * A TEACHER'S MARK IS THEIRS TO EXPLAIN, AND NOT THE STUDENT'S TO UNDO.
   *
   * The manual tells the student "if a teacher has overridden your status, their
   * mark takes precedence — that's by design", and until now no student screen
   * showed one at all: a student a teacher had marked complete still saw the
   * recording as outstanding. Offering Unmark here would also be a lie, because
   * the override wins whatever the student writes underneath it.
   */
  if (override) {
    return (
      <View>
        <Text style={override.completed ? styles.completedText : styles.gateHint}>
          {override.completed ? '✓ Completed — marked by your teacher' : 'Your teacher has marked this not complete'}
        </Text>
        <Text style={styles.gateHint}>{override.reason}</Text>
      </View>
    );
  }

  if (completed) {
    return (
      <View style={styles.completeRow}>
        <Text style={styles.completedText}>✓ Completed</Text>
        {pending ? <Text style={styles.pendingText}>Pending sync</Text> : null}
        <Pressable
          testID="mark-incomplete"
          accessibilityRole="button"
          accessibilityLabel="Mark not complete"
          onPress={() => void setCompleted(studentUid, recordingId, courseId, false)}
        >
          <Text style={styles.unmark}>Unmark</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <Pressable
        testID="mark-complete"
        accessibilityRole="button"
        accessibilityLabel="Mark complete"
        aria-disabled={!everPlayed}
        disabled={!everPlayed}
        onPress={() => void setCompleted(studentUid, recordingId, courseId, true)}
        style={({ pressed }) => [
          styles.completeButton,
          pressed ? styles.completePressed : null,
          !everPlayed ? styles.completeDisabled : null,
        ]}
      >
        <Text style={[styles.completeLabel, !everPlayed ? styles.completeLabelDisabled : null]}>
          Mark complete
        </Text>
      </Pressable>
      {!everPlayed ? (
        <Text style={styles.gateHint}>Play the recording before marking it complete.</Text>
      ) : null}
      {pending ? <Text style={styles.pendingText}>Pending sync</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: t.bg.canvas },
  closedRecord: {
    backgroundColor: t.bg.surface,
    borderRadius: 8,
    padding: spacing(4),
    marginTop: spacing(4),
    gap: spacing(1),
  },
  closedRecordTitle: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  closedRecordLine: { fontSize: 14, color: t.text.secondary },
  content: {
    padding: spacing(5),
    paddingBottom: spacing(12),
    // NARROWER THAN THE READING CAP, deliberately, and the one width in the app
    // that is not in `LAYOUT_WIDTHS`. A transport, a scrub bar and a row of rate
    // chips are a media column: at 720 the controls drift apart, and this screen
    // is the same object at every width rather than a layout that reflows.
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  hero: {
    backgroundColor: t.bg.sage,
    borderRadius: 16,
    paddingVertical: spacing(10),
    paddingHorizontal: spacing(5),
    marginBottom: spacing(5),
    minHeight: 200,
    justifyContent: 'center',
  },
  heroCourse: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: t.text.secondary,
    marginBottom: spacing(2),
  },
  heroTitle: { fontSize: 28, fontWeight: '700', color: t.text.primary },
  heroDate: { fontSize: 14, color: t.text.secondary, marginTop: spacing(2) },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -spacing(1) },
  time: { fontSize: 13, color: t.text.secondary, fontVariant: ['tabular-nums'] },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing(2),
    marginTop: spacing(5),
  },
  speedChip: {
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.border.strong,
    minWidth: 56,
    // 44pt. These sit on the screen students spend the most time on, and they
    // were 32px tall — under the minimum on the app's core control row.
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedChipOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
  speedText: { fontSize: 14, fontWeight: '600', color: t.text.secondary },
  speedTextOn: { color: t.accent.onAccent },
  preparing: { fontSize: 13, color: t.text.secondary, textAlign: 'center', marginTop: spacing(3) },
  versions: { marginTop: spacing(2), marginBottom: spacing(2) },
  parts: { marginTop: spacing(4), gap: spacing(2) },
  part: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing(3),
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  partOn: { backgroundColor: t.bg.accentSoft, borderColor: t.accent.base },
  partText: { fontSize: 14, color: t.text.primary },
  partTextOn: { fontWeight: '700', color: t.accent.base },
  divider: { height: 1, backgroundColor: t.accent.gold, marginVertical: spacing(7) },
  sectionHeading: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: t.text.secondary,
    marginBottom: spacing(2),
    marginTop: spacing(4),
  },
  listenedTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: t.bg.inset,
    overflow: 'hidden',
    marginBottom: spacing(2),
  },
  listenedFill: { height: 6, backgroundColor: t.feedback.success },
  body: { fontSize: 15, color: t.text.secondary, lineHeight: 22 },
  // secondary, not muted: this sentence is the only explanation of why there is
  // no Mark complete button, which makes it content rather than a caption.
  staffNote: { fontSize: 14, color: t.text.secondary, fontStyle: 'italic', lineHeight: 20 },
  due: { fontSize: 14, color: t.text.secondary, marginTop: spacing(5) },

  completeButton: {
    marginTop: spacing(4),
    backgroundColor: t.accent.base,
    borderRadius: 12,
    paddingVertical: spacing(3),
    alignItems: 'center',
  },
  completePressed: { opacity: 0.85 },
  completeDisabled: { backgroundColor: t.bg.inset },
  completeLabel: { fontSize: 16, fontWeight: '700', color: t.accent.onAccent },
  completeLabelDisabled: { color: t.text.muted },
  gateHint: { fontSize: 13, color: t.text.secondary, marginTop: spacing(2), textAlign: 'center' },
  completeRow: {
    marginTop: spacing(4),
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
  },
  completedText: { fontSize: 16, fontWeight: '700', color: t.feedback.success, flex: 1 },
  unmark: { fontSize: 14, color: t.text.secondary, fontWeight: '600' },
  pendingText: { fontSize: 13, color: t.feedback.warning, fontWeight: '600' },
});
