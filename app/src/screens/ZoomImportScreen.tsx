import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  addDays,
  todayInZone,
  unbreakableDate,
  zoomRecordingDate,
  zoomRecordingHours,
  type ZoomImportRow,
} from '@sabeel/shared';
import { Button, Card, Chips, Empty, Field, Notice, Screen } from '../components/ui';
import { DateField } from '../components/DateField';
import { listZoomRecordings, importZoomRecording } from '../zoom';
import { zoomRowsShown, type ZoomStatusFilter } from '../zoomFilters';
import type { SessionRow } from '../sessions';
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';

const t = getTheme();

/**
 * The last sixty days, in the institute's calendar — and reaching back to the
 * session's own date if that is older, because the picker opens filtered to
 * that date and would otherwise open empty on a session from last term.
 */
function defaultRange(sessionDate: string): { from: string; to: string } {
  const to = todayInZone(INSTITUTE_TIMEZONE);
  const sixtyDays = addDays(to, -60);
  return { from: sessionDate < sixtyDays ? sessionDate : sixtyDays, to };
}

// Lower case, like the library's status filter — the other screen that narrows
// a list by a state rather than by a phrase.
const STATUS_FILTERS: { value: ZoomStatusFilter; label: string }[] = [
  { value: 'available', label: 'available' },
  { value: 'imported', label: 'imported' },
  { value: 'all', label: 'all' },
];

/**
 * The Zoom import picker, scoped to ONE session.
 *
 * Lists the central account's audio-only recordings for a date range; importing
 * one downloads it as this session's draft recording (the session already owns
 * the title/date/due). A session holds a single recording, so after a successful
 * import we return to it.
 */
export function ZoomImportScreen({
  session,
  cls,
  onImported,
  onOpenImported,
}: {
  session: SessionRow;
  cls: { id: string; name: string };
  onImported: () => void;
  /** Open a recording this institute already imported — see the row below. */
  onOpenImported: (recordingId: string) => void;
}) {
  // Never set: the range the picker arrives with, read once by the first load.
  const [initial] = useState(() => defaultRange(session.date));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rows, setRows] = useState<ZoomImportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ZoomStatusFilter>('available');
  const [hideShort, setHideShort] = useState(true);
  const [sessionDayOnly, setSessionDayOnly] = useState(true);

  // Takes the range as an argument rather than closing over `from`/`to`, so it
  // has no dependencies and cannot serve a stale range.
  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listZoomRecordings(range));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Arrive with the default range already fetched; after that the Load button
  // applies whatever the user picked. `load` and `initial` are stable, so this
  // runs once — and it must: every call is a Zoom API request, and the date
  // fields change on each keystroke.
  useEffect(() => {
    void load(initial);
  }, [load, initial]);

  const filtered = zoomRowsShown(rows ?? [], {
    status,
    search,
    hideShort,
    onDate: sessionDayOnly ? session.date : null,
  });

  return (
    <Screen title="Import from Zoom" subtitle={`${session.title} · ${cls.name}`}>
      <Card>
        <DateField label="From" value={from} onChange={setFrom} />
        <DateField label="To" value={to} onChange={setTo} />
        <Button
          testID="zoom-load"
          label="Load recordings"
          busy={loading}
          onPress={() => void load({ from, to })}
        />
      </Card>

      <Field label="Search by title" value={search} onChangeText={setSearch} placeholder="topic…" />
      <View style={styles.filter}>
        <Chips value={status} testIdPrefix="zoom-filter" options={STATUS_FILTERS} onChange={setStatus} />
      </View>

      {/* ROWS OF THEIR OWN, AND A SHAPE OF THEIR OWN. These are independent
          toggles, not further members of the one-of-three filter above them —
          drawn as the same raspberry pill, "available" and "hide <2 min" read as
          two selections in one group. A tick and a square say "on/off"; a
          filled pill says "chosen". */}
      <Check
        testID="zoom-session-day"
        on={sessionDayOnly}
        onToggle={() => setSessionDayOnly((v) => !v)}
        label={`Only recordings from this session's date (${unbreakableDate(session.date)})`}
      />
      <Check
        testID="zoom-hide-short"
        on={hideShort}
        onToggle={() => setHideShort((v) => !v)}
        label="Hide recordings under 2 minutes"
        accessibilityLabel="Hide recordings under two minutes"
      />

      {error ? <Notice tone="error">{error}</Notice> : null}
      {/* NOT BOTH. `rows` stays null when the request fails, so the empty state
          fired alongside the error and told staff to widen a date range for a
          request that never completed. */}
      {error ? null : loading && rows === null ? (
        <Empty>Loading recordings…</Empty>
      ) : filtered.length === 0 ? (
        // A wider range cannot help while the list is pinned to one date, so
        // that case names the toggle that can.
        <Empty>
          {sessionDayOnly
            ? `No recordings match on ${unbreakableDate(session.date)}. Untick "Only recordings from this session's date" to see the whole range.`
            : 'No recordings match. Widen the date range or the filters, then Load.'}
        </Empty>
      ) : (
        filtered.map((r) => (
          <ZoomRow
            key={r.meetingUuid}
            row={r}
            sessionId={session.id}
            onImported={onImported}
            onOpenImported={onOpenImported}
          />
        ))
      )}
    </Screen>
  );
}

function Check({
  testID,
  on,
  onToggle,
  label,
  accessibilityLabel,
}: {
  testID: string;
  on: boolean;
  onToggle: () => void;
  label: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      aria-checked={on}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      style={styles.toggle}
    >
      <View style={[styles.box, on ? styles.boxOn : null]}>
        {on ? <Text style={styles.tick}>✓</Text> : null}
      </View>
      <Text style={styles.toggleText}>{label}</Text>
    </Pressable>
  );
}

function ZoomRow({
  row,
  sessionId,
  onImported,
  onOpenImported,
}: {
  row: ZoomImportRow;
  sessionId: string;
  onOpenImported: (recordingId: string) => void;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doImport = () =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await importZoomRecording({ meetingUuid: row.meetingUuid, fileId: row.fileId, sessionId });
        onImported();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Card>
      <Text style={styles.title}>{row.topic.trim() || 'Zoom recording'}</Text>
      {/* THE HOURS ARE WHAT IDENTIFY IT. One recurring meeting carries every
          class in a cohort, so the topic is the same on every card and two
          classes can share a date; when the audio ran is what differs. */}
      <Text testID={`zoom-when-${row.meetingUuid}`} style={styles.when}>
        {unbreakableDate(zoomRecordingDate(row))} · {zoomRecordingHours(row)}
      </Text>
      <Text style={styles.sub}>
        {Math.round(row.durationSec / 60)} min · {(row.sizeBytes / 1048576).toFixed(1)} MB
      </Text>
      {row.alreadyImported ? (
        /*
          TAPPABLE, because the sentence alone leaves staff stuck.
          The picker lists the whole Zoom account, so most of what a manager sees
          part-way through a term is already imported — and "already imported
          into Hikam Foundations" as flat text sends them off to find it by hand,
          in a library that lists every recording in the institute. The row knows
          exactly which one it is. It is not a Button: this is a link out of a
          list, not the action the card is offering.
        */
        <Pressable
          testID={`zoom-open-${row.meetingUuid}`}
          accessibilityRole="link"
          onPress={() => onOpenImported(row.alreadyImported as string)}
          style={styles.importedRow}
        >
          <Text style={styles.imported}>
            ✓ Already imported{row.importedCourseName ? ` into ${row.importedCourseName}` : ''} —
            open it
          </Text>
        </Pressable>
      ) : (
        <Button
          testID={`zoom-import-${row.meetingUuid}`}
          label="Import into this session"
          busy={busy}
          onPress={doImport}
        />
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  filter: { marginTop: spacing(2), marginBottom: spacing(2) },
  importedRow: { minHeight: 44, justifyContent: 'center' },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    minHeight: 44,
    marginTop: spacing(2),
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: t.border.strong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: t.accent.base, borderColor: t.accent.base },
  tick: { fontSize: 14, fontWeight: '700', color: t.accent.onAccent, lineHeight: 16 },
  toggleText: { flexShrink: 1, fontSize: 14, color: t.text.primary },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  when: { fontSize: 14, fontWeight: '600', color: t.text.primary, marginTop: 2 },
  sub: { fontSize: 13, color: t.text.secondary, marginTop: 2, marginBottom: spacing(2) },
  imported: { fontSize: 14, color: t.feedback.success, fontWeight: '600', marginTop: spacing(2) },
});
