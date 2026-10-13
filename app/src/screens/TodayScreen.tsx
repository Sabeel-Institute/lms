import { Pressable, StyleSheet, Text, View } from 'react-native';
import { INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';
import { Empty, Grid, Notice, Screen } from '../components/ui';
import { PushNudge } from '../components/PushNudge';
import { KIND_ORDER, type TodayItem, type TodayKind, type TodayQueue } from '../today';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/** What each kind is called here; the ORDER comes from `KIND_ORDER`. */
const HEADING: Record<TodayKind, { label: string; blurb: string }> = {
  attendance: {
    label: 'Attendance not taken',
    blurb: 'Until this is submitted, nobody in the class has access.',
  },
  publish: { label: 'Waiting to publish', blurb: 'Recorded, not yet released.' },
  recording: {
    label: 'No recording yet',
    blurb: 'Attendance is in; the recording is not. Nobody is waiting on anything else.',
  },
  closing: { label: 'Closing soon', blurb: 'Access ends within the week.' },
  grading: { label: 'To grade', blurb: 'Handed in, not yet returned.' },
};

/**
 * The staff landing screen: what is waiting, most urgent first.
 *
 * The argument for leading with this rather than with the cohort hierarchy is
 * the shape of the job. Everything a teacher does here runs on a fixed cycle: a
 * class meets, attendance is taken, the recording is added and published, and a
 * week later access closes. Every one of those steps is dated, every one has an
 * owner, and every one is invisible until somebody goes looking for it course by
 * course. A hierarchy answers "where is X"; this
 * answers "what is waiting", which is the question actually being asked on a
 * Tuesday evening.
 *
 * Nothing here is stored — see `today.ts`. Each row is derived, live, from
 * documents the reader can already see, so it cannot go stale and there is no
 * second copy of the truth to reconcile. The count on the tab comes from the
 * same subscription, so the badge and this screen cannot disagree.
 *
 * An empty queue is a RESULT, not a blank screen: "nothing is waiting" is the
 * single most useful thing this screen can say, and it has to say it in those
 * words rather than showing an empty list.
 */
export function TodayScreen({
  uid,
  isAdmin,
  queue,
  onOpenSession,
  onOpenLedger,
  onOpenCoursework,
}: {
  uid: string;
  /** Only to say the right thing when there is nothing here yet. */
  isAdmin: boolean;
  /** Subscribed by the app shell, so the tab's badge cannot disagree with it. */
  queue: TodayQueue;
  onOpenSession: (sessionId: string, courseId: string) => void;
  onOpenLedger: (recordingId: string) => void;
  onOpenCoursework: (courseId: string, courseworkId: string) => void;
}) {
  const { items, blocking, loading, failed, scoped, allFinished, truncated } = queue;
  const today = todayInZone(INSTITUTE_TIMEZONE);

  return (
    <Screen
      title="Today"
      subtitle={
        failed
          ? 'Could not read your courses'
          : loading
            ? 'Checking your courses…'
            : allFinished
              ? 'No courses running'
              : !scoped
                ? 'No courses yet'
                : items.length === 0
                  ? `Nothing is waiting · ${today}`
                  : blocking > 0
                    ? `${items.length} waiting · ${blocking} blocking access`
                    : `${items.length} waiting`
      }
      width="list"
    >
      {/* Top of the content. Same place in all three apps: first thing after
          anything that needs acting on today. */}
      <PushNudge uid={uid} />

      {/* Not "the first N" in any order a reader could predict — the scope is
          cut by document id, which is arbitrary. Say what is true. */}
      {truncated ? (
        <Text style={styles.note}>
          More courses than this queue can span. Some are not counted here — open them
          under Courses to see the rest.
        </Text>
      ) : null}

      {/* An empty queue has three causes and only one of them is good news.
          Saying "attendance is in" to someone who has not been given a course
          yet is a sentence about courses they do not have, and saying it at the
          end of term to a manager whose courses have all finished is an answer
          to a question they did not ask. See `TodayQueue.scoped`. */}
      {!loading && !failed && items.length === 0 ? (
        scoped ? (
          <Empty>
            Attendance is in, every recording is published, nothing closes this week, and no work is waiting to be graded.
          </Empty>
        ) : (
          <Notice tone="info">
            {allFinished
              ? 'Every course you can see has finished. Nothing is waiting; open Courses for the record of a past term.'
              : isAdmin
                ? 'No courses yet. Add a cohort under Courses, then a course inside it — this is where the work waiting on you will appear.'
                : 'You are not assigned to any courses yet. An administrator assigns them; once they do, this is where the work waiting on you appears.'}
          </Notice>
        )
      ) : null}

      {KIND_ORDER.map((kind) => {
        const h = HEADING[kind];
        const rows = items.filter((i) => i.kind === kind);
        if (rows.length === 0) return null;
        return (
          <View key={kind} style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={[styles.groupLabel, kind === 'attendance' ? styles.urgent : null]}>
                {h.label} ({rows.length})
              </Text>
              <Text style={styles.groupBlurb}>{h.blurb}</Text>
            </View>
            <Grid min={330}>
              {rows.map((item) => (
                <QueueCard
                  key={item.key}
                  item={item}
                  onPress={() =>
                    item.kind === 'grading' && item.courseworkId
                      ? onOpenCoursework(item.courseId, item.courseworkId)
                      : item.kind === 'closing' && item.recordingId
                        ? onOpenLedger(item.recordingId)
                        : onOpenSession(item.sessionId, item.courseId)
                  }
                />
              ))}
            </Grid>
          </View>
        );
      })}
    </Screen>
  );
}

/** What pressing this card does, in the words the card shows. */
const ACTION: Record<TodayKind, string> = {
  attendance: 'Take attendance',
  closing: 'See who has listened',
  publish: 'Review and publish',
  recording: 'Add the recording',
  grading: 'Grade',
};

function QueueCard({ item, onPress }: { item: TodayItem; onPress: () => void }) {
  const urgent = item.kind === 'attendance';
  return (
    <Pressable
      testID={`today-${item.key}`}
      accessibilityRole="button"
      /*
       * THE WHOLE CARD, because the label REPLACES it. `accessibilityLabel` is
       * the button's entire accessible name — the course, the section heading
       * and the action line inside it are announced by nobody — so it has to
       * carry what the eye gets from the group it sits in. Shortening the
       * details so two cards in different sections stopped repeating their own
       * heading left those two cards announcing the identical sentence.
       */
      accessibilityLabel={`${HEADING[item.kind].label}: ${item.title}, ${item.courseName}. ${item.detail} ${item.action ?? ACTION[item.kind]}.`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        urgent ? styles.cardUrgent : null,
        pressed ? styles.cardPressed : null,
      ]}
    >
      <Text style={styles.course} numberOfLines={1}>
        {item.courseName}
      </Text>
      <Text style={styles.title} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={styles.detail}>{item.detail}</Text>
      <Text style={styles.action}>{item.action ?? ACTION[item.kind]} ›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { marginBottom: spacing(5) },
  groupHead: { marginBottom: spacing(2) },
  groupLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.8, color: t.text.secondary, textTransform: 'uppercase' },
  // Gold, not danger. Attendance not yet taken is where every class meeting
  // begins — it is the work, not an emergency — and spending the destructive
  // register on the routine daily task leaves nothing to say "you are about to
  // remove a person from this course".
  urgent: { color: t.accent.goldText },
  // `secondary`, not `muted`. These two sentences carry the reason the section
  // exists ("Until this is submitted, nobody in the class has access"), and
  // BRAND.md puts anything that conveys content in secondary — taupe is for
  // captions, borders and dividers.
  groupBlurb: { fontSize: 13, color: t.text.secondary, marginTop: 2 },
  note: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(3) },
  card: {
    // Fills the grid cell it is given, so a row of these ends level instead
    // of ragged with its actions at three different heights.
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.border.subtle,
    padding: spacing(4),
    marginBottom: spacing(3),
    minHeight: 132,
  },
  // The tint behind an ATTENDANCE row — not behind every blocking one. An
  // unpublished recording is blocking too and gets no tint, because it is a
  // thing that was done and can be undone, while an un-taken register is the
  // step nothing else on any screen mentions. `goldSoft` is the app's "waiting
  // on you" fill; `dangerSoft` is the tint of "remove this person", and wearing
  // it on the card a teacher sees at the start of every class both overstated
  // the problem and spent the colour that has to mean something worse.
  cardUrgent: { borderColor: t.accent.gold, backgroundColor: t.bg.goldSoft },
  cardPressed: { opacity: 0.8 },
  course: { fontSize: 12, fontWeight: '700', color: t.text.secondary, letterSpacing: 0.4 },
  title: { fontSize: 16, fontWeight: '700', color: t.text.primary, marginTop: 2 },
  detail: { fontSize: 13, color: t.text.secondary, marginTop: spacing(2), flex: 1 },
  action: { fontSize: 13, fontWeight: '700', color: t.text.accent, marginTop: spacing(3) },
});
