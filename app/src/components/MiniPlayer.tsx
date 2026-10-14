import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  closePlayback,
  formatClock,
  playback,
  usePlayback,
} from '../playback';
import { INSTITUTE_TIMEZONE, canPlayFromCourse, canPlayNow, todayInZone } from '@sabeel/shared';
import { liveDueDate, useMyAssignmentState } from '../completion';
import { useRecordingState } from '../recordings';
import { useCourseState } from '../structure';
import { PlayPauseGlyph, Skip } from './Transport';
import { LAYOUT_WIDTHS, getTheme, spacing } from '../theme';
import { useRoomy, useWide } from '../useWidth';

const t = getTheme();

/**
 * The docked now-playing bar.
 *
 * This is the piece that makes app-wide playback VISIBLE, and it only became
 * possible once the session moved out of `PlayerScreen` (see `playback.ts`).
 * A two-hour lecture is not listened to in one sitting on one screen: people
 * check their attendance record, open another class, put the phone down. With
 * playback held by the app and this bar always showing what is loaded, leaving
 * the player screen stops being a decision.
 *
 * Two shapes, and the difference is not decoration:
 *
 *  - NARROW it sits directly on top of the tab bar as a single compact row —
 *    artwork-less: the title, back 15, play/pause and a dismiss. Skipping BACK
 *    earns its place on a phone even where forward cannot fit: the phone is
 *    where someone listens hands-free, and "I missed that sentence" is the
 *    reason anyone reaches for a bar they are not looking at. Forward arrives
 *    with the room for it, at the reading width.
 *  - WIDE it spans the content area beneath the rail with the transport laid
 *    out inline: back 15 · play/pause · forward 30, elapsed and remaining, and
 *    a full-width progress line. There is room for the controls, so putting
 *    them behind a tap would be hiding them for no reason.
 *
 * A progress line runs along the TOP edge in both, so the bar reports position
 * without spending a row on it.
 */
export function MiniPlayer({
  onOpen,
}: {
  /** Carries the deadline as well as the id: the player screen gates the audio
   *  on it, and re-opening without it would draw a live transport for a student
   *  whose access closed while they were listening. */
  onOpen: (recordingId: string, dueDate: string | null) => void;
}) {
  const state = usePlayback();
  const wide = useWide();
  const roomy = useRoomy();
  const now = state.now;

  /*
   * STOP THE AUDIO IF THE RECORDING IS REVOKED WHILE THIS BAR IS SHOWING.
   *
   * The player screen already does this for the case where it is on screen, and
   * this covers the other half: playback outlives that screen now, so a student
   * listening from their class list would otherwise keep hearing a recording
   * that was unpublished — for as long as the signed URL lasts, with nothing on
   * screen saying anything changed.
   *
   * Two document listeners, and only while something is loaded. They do not
   * duplicate the player screen's: this bar is not rendered there, and that
   * screen is not mounted anywhere else.
   *
   * SCOPED, because this bar rides along with every screen. Listener errors are
   * keyed by label, so an unscoped success here clears the banner a screen's
   * own denied `course` or `recording` read had raised.
   */
  const loaded = useRecordingState(now?.recordingId ?? null, 'miniPlayer', !!now?.studentUid);
  const course = useCourseState(now?.courseId ?? null, 'miniPlayer');
  // The student's deadline, live: `now.dueDate` was captured when the recording
  // was opened, and a Listen-by date moved forward since is the documented way
  // a closed session reopens — the bar must not close it at midnight on a date
  // that no longer applies.
  const grant = useMyAssignmentState(now?.studentUid ?? null, now?.recordingId ?? null, 'miniPlayer');
  /*
   * THREE WAYS ACCESS ENDS, and the audio has to stop for all of them:
   *   - the recording is deleted or unpublished (its document goes);
   *   - the course is archived with listening off;
   *   - the STUDENT's own deadline passes, which happens at midnight while they
   *     are listening and nothing else would notice. Staff have no deadline —
   *     a session's date rides in `dueDate` for them too, and applying it here
   *     cut a manager off from anything more than a week old the moment they
   *     left the player.
   * Watching only the first left the other two running off a signed URL good
   * for another twelve hours, with nothing on screen saying anything changed.
   */
  const today = todayInZone(INSTITUTE_TIMEZONE);
  const due = now ? liveDueDate(now.studentUid, grant, now.dueDate) : null;
  const shut = !!course.value && !canPlayNow(course.value, due, now?.studentUid ?? null, today);
  const revoked = !!now && ((loaded.resolved && !loaded.value) || (course.resolved && shut));
  /*
   * A recording playing when the student's own deadline passes plays on to
   * the end and closes once it stops, as the player screen lets it (see
   * there). Anything else that shuts it stops it at once.
   */
  const finishing =
    !!now && loaded.value !== null && !!course.value && canPlayFromCourse(course.value) && due !== null && state.playing;
  useEffect(() => {
    if (revoked && !finishing) void closePlayback();
  }, [revoked, finishing]);

  if (!now) return null;

  const pct = now.durationMs > 0 ? Math.min(1, state.positionMs / now.durationMs) : 0;
  const remaining = Math.max(0, now.durationMs - state.positionMs);
  const times = `${formatClock(state.positionMs)} / −${formatClock(remaining)}`;

  return (
    <View testID="mini-player" style={[styles.bar, wide ? styles.barWide : null]}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
      </View>
      {/* CAPPED AND CENTRED to the widest content column. Left to span a 1400px
          window, the title and the transport ended up hundreds of pixels apart.
          It cannot match the column of the screen it happens to be docked under
          — it outlives every screen, and knowing which one is showing is not
          its business — so it takes the widest one there is. */}
      <View style={[styles.inner, wide ? styles.innerWide : null]}>
        <Pressable
          testID="mini-player-open"
          accessibilityRole="button"
          accessibilityLabel={`Open ${now.title}`}
          onPress={() => onOpen(now.recordingId, now.dueDate)}
          style={styles.text}
        >
          <Text style={styles.title} numberOfLines={1}>
            {now.title}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {now.courseName}
            {wide ? ` · ${times}` : ''}
          </Text>
        </Pressable>

        {/* THE SAME CONTROLS THE FULL PLAYER USES, not lookalikes. Bare "15" and
            "30" read as inert tags, and a typed "▶" renders as a colour emoji on
            some Android builds — which is exactly why `Transport` draws its
            glyphs. Sharing them is how the two views cannot drift.

            On a wide bar the title is capped, so a spacer takes the slack:
            without it the whole cluster packs left and leaves a hole where the
            dismiss should be. */}
        {/* ALWAYS. It is a zero-basis grower, so on a phone — where the title has
            already shrunk to fill the row — it takes nothing. Gated on `wide` it
            did nothing between 600 and 899 either, and there a short title left
            the transport and the dismiss packed against it with a third of the
            bar empty to their right. */}
        <View style={styles.spacer} />

        {/* BACK AT EVERY WIDTH. It is the one anyone reaches for on a bar they
            are not looking at, and forward is the one that gives way when the
            row runs out of room — see the gate below it. */}
        <Skip
          label={String(SKIP_BACK_MS / 1000)}
          direction="back"
          size={44}
          disabled={!state.ready}
          onPress={playback.skipBack}
          testID="mini-player-back"
        />

        <Pressable
          testID="mini-player-toggle"
          accessibilityRole="button"
          accessibilityLabel={state.playing ? 'Pause' : 'Play'}
          disabled={!state.ready}
          onPress={playback.toggle}
          style={[styles.play, !state.ready ? styles.playDisabled : null]}
        >
          {/* 0.62: this button is 44px against the player's 72px, and the glyph
              is built from borders rather than type. The skips beside it are 44
              too — see `Skip`'s `size`. */}
          <PlayPauseGlyph playing={state.playing} disabled={!state.ready} scale={0.62} />
        </Pressable>

        {/* ON ROOM, NOT ON THE NAV BREAKPOINT. Gated at 900 this was missing
            from a 720px window with 294px of empty bar beside the transport — an
            asymmetric transport for no reason a person could see. `useRoomy` is
            the reading width, which is where the title still has a sentence's
            worth of space left after a fourth target. */}
        {roomy ? (
          <Skip
            label={String(SKIP_FORWARD_MS / 1000)}
            direction="forward"
            size={44}
            disabled={!state.ready}
            onPress={playback.skipForward}
            testID="mini-player-forward"
          />
        ) : null}

        <Pressable
          testID="mini-player-close"
          accessibilityRole="button"
          accessibilityLabel="Stop playing"
          onPress={closePlayback}
          style={styles.close}
        >
          <Text style={styles.closeGlyph}>×</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    // Tight on a phone, because every pixel here is one the title does not get:
    // at 320 the transport is three 44px targets and the name of the lecture has
    // to live in what is left.
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    minHeight: 56,
    // Surface, like the bar it sits on — see `AppNav`.
    backgroundColor: t.bg.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border.strong,
  },
  barWide: { paddingHorizontal: spacing(6), minHeight: 64 },
  innerWide: { gap: spacing(3) },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    width: '100%',
    // MINUS THE PAGE'S PADDING, not the bar's. `Screen` caps its column INSIDE
    // `spacing(8)` of padding; this capped outside its own, so the bar's title
    // started 32px left of the cards above it at 1440. Both are centred in the
    // same stack, so matching the page's inner width is what lines them up —
    // subtracting the bar's own 24 left 8px of the same error.
    maxWidth: LAYOUT_WIDTHS.list - spacing(8) * 2,
    alignSelf: 'center',
  },
  progressTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: t.border.subtle,
  },
  progressFill: { height: 2, backgroundColor: t.accent.base },
  // NO CAP. The spacer below is what holds the transport at the end of the row,
  // so capping the title bought nothing and cost the name of the lecture: at
  // 1440 it ellipsised at 520px with 450px of bar empty beside it.
  text: { flexShrink: 1, justifyContent: 'center', minHeight: 40 },
  spacer: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', color: t.text.primary },
  sub: { fontSize: 12, color: t.text.secondary, marginTop: 1 },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.accent.base,
  },
  playDisabled: { backgroundColor: t.bg.inset },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  // Secondary, not muted: taupe on the bar is ~2.7:1, and this is the only way
  // to stop a lecture from a screen that is not the player.
  closeGlyph: { fontSize: 22, color: t.text.secondary },
});
