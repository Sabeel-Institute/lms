import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  canPlayFromCourse,
  grantOutcome,
  isOverdue,
  isVisibleToStudents,
  todayInZone,
  type GrantOutcome,
} from '@sabeel/shared';
import {
  Button,
  Chips,
  Collapsible,
  CountsLine,
  Empty,
  Field,
  Grid,
  IconButton,
  Notice,
  Row,
  Screen,
  useGridCell,
} from '../components/ui';
import { Sheet } from '../components/Sheet';
import {
  LEDGER_FILTERS,
  overrideCompletion,
  clearCompletionOverride,
  useRecordingLedger,
  type LedgerFilter,
  type LedgerRow,
  type RequiredRow,
} from '../ledger';
import { useCohortName, type CourseRow } from '../structure';
import type { SessionRow } from '../sessions';
import type { RecordingRow } from '../recordings';
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';

const t = getTheme();

/**
 * Recording ledger: the accountable roster for one recording, action-first.
 * Defaults to "Not complete" so staff land on who needs chasing, not a wall of
 * green. Effective status is override ?? student; the override is applied here.
 */
export function RecordingLedgerScreen({
  recording,
  session,
  cls,
}: {
  recording: RecordingRow;
  session: SessionRow;
  cls: CourseRow;
}) {
  const today = todayInZone(INSTITUTE_TIMEZONE);
  // A recording that is no longer published, or an archived class with
  // listening off, closes every open grant — the rows say which rather than
  // "Not complete", which reads as still doable.
  const closedBy = closedReason(recording, cls);
  // Reached from the cross-cohort library, where the course name alone is ambiguous.
  const cohortName = useCohortName()(cls.cohortId);
  const { loading, failed, accountable, attendees, absentees, lapsed, otherListeners, rollup } = useRecordingLedger(
    recording,
    session,
    today,
  );
  const [filter, setFilter] = useState<LedgerFilter>('notComplete');
  const { active: busy, run: once } = useOneAtATime();
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (filter === 'all') return accountable;
    if (filter === 'notComplete') return accountable.filter((r) => !r.completed);
    return accountable.filter((r) => !r.completed && isOverdue(r.dueDate, today));
  }, [accountable, filter, today]);

  // One write at a time on this screen: the three buttons on an open editor
  // each locked on their own key, so "Remove override" stayed live while
  // "Mark complete" was in flight, and two callables raced on one override.
  // The gate is a ref, not this render's `busy`, which a same-frame second
  // tap would still read as free.
  const run = (key: string, fn: () => Promise<unknown>) =>
    once(key, async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <Screen
      title={recording.title}
      // Not "· listening progress": the header above already says it.
      subtitle={cohortName ? `${cls.name} · ${cohortName}` : cls.name}
      width="list"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* NOT UNTIL THE GRANTS ARRIVE. `rollup` is derived from `accountable`,
          which is empty while the roster is unknown — so the first thing on the
          page read `Required 0 / Completed 0 / Not complete 0 / Missed 0` for
          the length of every cold load, on the screen staff consult to decide
          who to chase. Four confident zeros are a worse answer than four
          absent tiles. */}
      {loading || failed ? null : (
        /* The product's own words — required listening, completed, missed —
           on one line. THE TONE FOLLOWS THE VALUE, never the label: a missed
           count is in the danger colour only when someone missed it. */
        <CountsLine
          testID="ledger-counts"
          counts={[
            { value: rollup.total, label: 'required' },
            { value: rollup.complete, label: 'completed' },
            { value: rollup.incomplete, label: 'not complete' },
            { value: rollup.missed, label: 'missed', alarm: true },
          ]}
        />
      )}

      <View style={styles.toolbar}>
        <Chips value={filter} testIdPrefix="ledger-filter" options={LEDGER_FILTERS} onChange={setFilter} />
      </View>

      {rows.length === 0 ? (
        <Empty>
          {/* WHAT IT KNOWS, IN ORDER. Until the grants arrive nothing below is
              settled — and every sentence after this one is a conclusion about
              a roster that has not loaded. An empty accountable list is then
              answered before the filter is: with nobody granted the recording
              at all, "everyone has completed this" would be congratulating
              staff on nothing having happened. */}
          {loading
            ? 'Checking who holds this recording…'
            : failed
              ? 'The roster for this recording could not be read. The message above says why.'
              : accountable.length === 0
              ? lapsed.length > 0
                ? 'Nobody holds this recording now — every grant from this session has lapsed. See below.'
                : session.attendanceSubmittedAt === null
                  ? // A register never taken is not a register with nobody excused:
                    // the grants come from the submit, and Today counts this
                    // session as blocking for exactly that reason.
                    'Attendance has not been taken for this session, so nobody has been granted this recording yet. Take attendance on the session.'
                  : 'No one was excused from this session, so nobody has been granted this recording.'
              : filter === 'missed'
                ? 'Nobody missed the deadline — nice.'
                : 'Everyone required has completed this — nice.'}
        </Empty>
      ) : (
        <Grid min={330} rows>
          {rows.map((r) => (
            <LedgerRowCard
              key={r.studentUid}
              row={r}
              recordingId={recording.id}
              today={today}
              closedBy={closedBy}
              busy={busy}
              onRun={run}
            />
          ))}
        </Grid>
      )}

      {/* FOR REFERENCE, AND CLOSED: nothing in these is asked of anyone, so
          they wait below the list that is, each with its count and the reason
          it is not in that list. */}
      <View style={styles.reference}>
        {attendees.length > 0 ? (
          <Collapsible testID="ledger-present" title="Present" count={attendees.length}>
            <Notice tone="info">
              They were at the session, so this recording is neither required for them nor open to
              them.
            </Notice>
            <ListenerRows rows={attendees} />
          </Collapsible>
        ) : null}

        {absentees.length > 0 ? (
          <Collapsible testID="ledger-absent" title="Absent" count={absentees.length}>
            <Notice tone="info">
              Marked absent rather than excused, so the recording was not opened to them. To let
              someone catch up, mark them excused on the session and submit again.
            </Notice>
            <ListenerRows rows={absentees} />
          </Collapsible>
        ) : null}

        {lapsed.length > 0 ? (
          <Collapsible testID="ledger-lapsed" title="Excused, access closed" count={lapsed.length}>
            <Notice tone="info">
              Excused at the session, but they hold no active grant — they were unenrolled from the
              class, or corrected out of the register since. Nothing is required of them, and they
              can&apos;t open it. Re-enrolling them restores it — for anything still inside its
              listen-by date.
            </Notice>
            <ListenerRows rows={lapsed} />
          </Collapsible>
        ) : null}

        {otherListeners.length > 0 ? (
          <Collapsible testID="ledger-also" title="Also listened" count={otherListeners.length}>
            <Notice tone="info">
              Listening from someone who holds no current grant — for example, excused and listening,
              then corrected to present. Kept as history; does not count toward accountability.
            </Notice>
            <ListenerRows rows={otherListeners} />
          </Collapsible>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * A read-only row — present, absent, and other listeners; no accountability.
 *
 * SILENT WHERE THERE IS NOTHING TO REPORT. The section above these rows says
 * this recording is neither required for them nor open to them, and then every
 * name carried "0% listened · not started" — a shortfall printed against people
 * of whom nothing was asked. Someone who listened anyway is worth showing;
 * someone who did not is simply not in this story.
 */
function ListenerRows({ rows }: { rows: LedgerRow[] }) {
  return (
    <Grid min={300} rows>
      {rows.map((r) => (
        <ListenerRow key={r.studentUid} row={r} />
      ))}
    </Grid>
  );
}

function ListenerRow({ row: r }: { row: LedgerRow }) {
  const listened = r.listenedPct !== 0 || !!r.lastListened;
  return (
    <View style={[styles.row, useGridCell()]}>
      <View style={styles.rowHead}>
        <View style={styles.rowText}>
          <Text style={styles.name}>{r.name}</Text>
          {listened ? (
            <Text style={styles.sub}>
              {listenedText(r.listenedPct)}
              {r.lastListened ? ` · last ${fmtDate(r.lastListened)}` : ''}
            </Text>
          ) : null}
        </View>
        {r.completed ? <Text style={[styles.status, styles.ok]}>Completed</Text> : null}
      </View>
    </View>
  );
}

function LedgerRowCard({
  row: r,
  recordingId,
  today,
  closedBy,
  busy,
  onRun,
}: {
  row: RequiredRow;
  recordingId: string;
  today: string;
  closedBy: ClosedBy;
  busy: string | null;
  onRun: (key: string, fn: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  /*
   * EMPTY EVERY TIME IT OPENS, never prefilled from the existing override.
   *
   * The reason is required because it goes into the audit log as the
   * justification for THIS action. Seeded with the reason that justified the
   * original grant, `disabled={!reason.trim()}` was already satisfied the moment
   * the editor opened, so "Remove override" could be pressed without typing
   * anything — and the log recorded the removal as justified by the sentence
   * that had justified the grant. The existing reason is on the row above
   * either way ("Override: …"), so nothing is lost by asking again.
   *
   * `useState`'s initialiser runs once, so an abandoned draft also survived
   * Cancel and re-armed both buttons on the next open. `close` is what both
   * exits go through.
   */
  const [reason, setReason] = useState('');
  const close = () => {
    setReason('');
    setOpen(false);
  };
  const outcome = grantOutcome(r, today, closedBy === null);
  const inGrid = useGridCell();
  const writing = busy === `ov-${r.studentUid}` || busy === `rm-${r.studentUid}`;
  const caption = (
    <Text style={styles.sub}>
      {/* THE STATUS LEADS, in its colour: it is what the row is read for. */}
      <Text style={[styles.status, statusStyle(outcome)]}>{statusLabel(r, today, closedBy)}</Text>
      {` · ${listenedText(r.listenedPct)}`}
      {r.lastListened ? ` · last ${fmtDate(r.lastListened)}` : ''}
      {r.pending ? ' · pending sync' : ''}
    </Text>
  );

  return (
    // Named, so a check about ONE student can be bound to their row. A regex
    // over the page says only that somebody on it is overridden, which is the
    // one thing an override check must not settle for.
    <View testID={`ledger-row-${r.name}`} style={[styles.row, inGrid]}>
      <View style={styles.rowHead}>
        <View style={styles.rowText}>
          <Text style={styles.name}>{r.name}</Text>
          {caption}
          {r.source === 'override' ? (
            <Text style={styles.override}>Override: {r.overrideReason}</Text>
          ) : null}
        </View>
        <IconButton
          testID={`override-open-${r.name}`}
          icon="edit"
          bare
          label={r.source === 'override' ? `Change ${r.name}'s override` : `Override completion for ${r.name}`}
          onPress={() => setOpen(true)}
        />
      </View>

      <Sheet visible={open} title={`Override: ${r.name}`} onClose={close} closeLabel="Cancel">
        {caption}
        <Field
          testID={`override-reason-${r.name}`}
          label="Reason (required, recorded in the audit log)"
          value={reason}
          onChangeText={setReason}
          placeholder="e.g. attended in person"
        />
        <Row>
          <Button
            testID={`override-complete-${r.name}`}
            label="Mark complete"
            disabled={!reason.trim()}
            busy={writing}
            onPress={() =>
              onRun(`ov-${r.studentUid}`, async () => {
                await overrideCompletion({ studentUid: r.studentUid, recordingId, completed: true, reason: reason.trim() });
                close();
              })
            }
          />
          <Button
            testID={`override-incomplete-${r.name}`}
            label="Mark not complete"
            variant="secondary"
            disabled={!reason.trim()}
            busy={writing}
            onPress={() =>
              onRun(`ov-${r.studentUid}`, async () => {
                await overrideCompletion({ studentUid: r.studentUid, recordingId, completed: false, reason: reason.trim() });
                close();
              })
            }
          />
        </Row>
        {r.source === 'override' ? (
          <Button
            testID={`override-remove-${r.name}`}
            label="Remove override"
            variant="secondary"
            disabled={!reason.trim()}
            busy={writing}
            onPress={() =>
              onRun(`rm-${r.studentUid}`, async () => {
                await clearCompletionOverride({ studentUid: r.studentUid, recordingId, reason: reason.trim() });
                close();
              })
            }
          />
        ) : null}
      </Sheet>
    </View>
  );
}

/** "42% listened" — or, when the recording's length is unknown, no number at
 *  all: the row must not print a share nobody can compute as if it were 0. */
function listenedText(pct: number | null): string {
  return pct === null ? 'Listened' : `${Math.round(pct * 100)}% listened`;
}

/**
 * What, if anything, has closed this recording's open grants: the recording
 * itself leaving the published state, or its class being archived with
 * listening off. Null while a student could still open it.
 */
type ClosedBy = 'recording archived' | 'recording unpublished' | 'course archived' | null;

function closedReason(recording: RecordingRow, cls: CourseRow): ClosedBy {
  if (recording.status === 'archived') return 'recording archived';
  if (!isVisibleToStudents(recording.status)) return 'recording unpublished';
  if (!canPlayFromCourse(cls)) return 'course archived';
  return null;
}

function statusLabel(r: RequiredRow, today: string, closedBy: ClosedBy): string {
  switch (grantOutcome(r, today, closedBy === null)) {
    case 'complete':
      return r.source === 'override' ? 'Completed (override)' : 'Completed';
    case 'missed':
      return 'Missed';
    case 'closed':
      return `Closed (${closedBy})`;
    case 'open':
      return 'Not complete';
  }
}

// Typed as GrantOutcome, not string: this branched on a removed union member
// for a while and rendered every Missed row amber, which a `string` parameter
// cannot catch and this one would have. Closed draws like Missed: nothing
// further will happen to either row on its own.
function statusStyle(outcome: GrantOutcome) {
  if (outcome === 'complete') return styles.ok;
  if (outcome === 'open') return styles.warn;
  return styles.bad;
}

/**
 * When a student last played the recording, in the institute's timezone.
 *
 * NOT `toLocaleDateString()`. This sits in a row beside a listen-by date that
 * is a civil date in `INSTITUTE_TIMEZONE`, and the two have to be comparable:
 * a play at 23:30 the night before a deadline dated to the morning after it —
 * which is what the reader's own zone does further east — is the ledger giving
 * the wrong answer to the only question it is asked.
 */
function fmtDate(ms: number | null): string {
  if (!ms) return '';
  return todayInZone(INSTITUTE_TIMEZONE, ms);
}

const styles = StyleSheet.create({
  ok: { color: t.feedback.success },
  bad: { color: t.feedback.danger },
  warn: { color: t.feedback.warning },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    marginBottom: spacing(4),
    flexWrap: 'wrap',
  },
  reference: { marginTop: spacing(5) },
  row: {
    // Fills its grid cell, so cards side by side end level.
    flexGrow: 1,
    backgroundColor: t.bg.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: t.border.subtle,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing(2) },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  sub: { fontSize: 13, color: t.text.secondary, marginTop: spacing(1) },
  override: { fontSize: 13, color: t.text.accent, marginTop: spacing(1) },
  status: { fontSize: 13, fontWeight: '700' },
});
