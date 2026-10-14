import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  VERSION_LABELS,
  addDays,
  todayInZone,
  unbreakableDate,
  zoomRecordingDate,
  zoomRecordingHours,
  type ZoomFileRow,
  type ZoomMeetingRow,
} from '@sabeel/shared';
import { Button, Card, Chips, Empty, Field, IconButton, Notice, Row, Screen } from '../components/ui';
import { Sheet, SheetSection } from '../components/Sheet';
import { DateField } from '../components/DateField';
import { importZoomFiles, listZoomRecordings } from '../zoom';
import {
  choosable,
  chosenFiles,
  formatShown,
  isShortSegment,
  quickPickFiles,
  selectionSummary,
  storageCostText,
  zoomMeetingsShown,
  type QuickPick,
  type ZoomFormatFilter,
  type ZoomStatusFilter,
} from '../zoomFilters';
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

const FORMAT_FILTERS: { value: ZoomFormatFilter; label: string }[] = [
  { value: 'all', label: 'all formats' },
  { value: 'video', label: 'video' },
  { value: 'audio', label: 'audio only' },
];

const QUICK_PICKS: { value: QuickPick; label: string }[] = [
  { value: 'audio', label: 'Audio only' },
  { value: 'videoAndAudio', label: 'Video and audio' },
  { value: 'everything', label: 'Everything' },
];

// A no-break space, so a narrow row never strands "MB" on a line of its own.
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}\u00a0MB`;
const length = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : sec < 60 ? `${sec} s` : `${m} min`;
};

/**
 * The Zoom import picker, scoped to ONE session.
 *
 * Lists the central account's meetings for a date range, each with its
 * segments and the formats Zoom kept of each. Staff tick the files they want —
 * one meeting or several, video or audio — and import them into this session's
 * recording in one go: each segment becomes a part, each format a version of
 * it. The copies run in the background, so the import returns at once and the
 * session page shows each file as it arrives.
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
  /** Open a recording this institute already imported — see the file row below. */
  onOpenImported: (recordingId: string) => void;
}) {
  // Never set: the range the picker arrives with, read once by the first load.
  const [initial] = useState(() => defaultRange(session.date));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rows, setRows] = useState<ZoomMeetingRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ZoomStatusFilter>('available');
  const [formats, setFormats] = useState<ZoomFormatFilter>('all');
  const [hideShort, setHideShort] = useState(true);
  const [sessionDayOnly, setSessionDayOnly] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Takes the range as an argument rather than closing over `from`/`to`, so it
  // has no dependencies and cannot serve a stale range.
  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listZoomRecordings(range));
      // What was chosen belongs to the list it was chosen from.
      setChosen(new Set());
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

  const filtered = zoomMeetingsShown(rows ?? [], {
    status,
    search,
    hideShort,
    onDate: sessionDayOnly ? session.date : null,
  });
  // Only what is on screen counts: a file chosen and then filtered away would
  // otherwise be imported without anyone seeing it ticked.
  const visibleChosen = new Set(
    filtered.flatMap((m) =>
      m.segments.flatMap((s) => s.files.filter((f) => formatShown(f.format, formats) && chosen.has(f.fileId))),
    ).map((f) => f.fileId),
  );
  const summary = selectionSummary(filtered, visibleChosen);

  const toggle = (fileId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  const quickPick = (m: ZoomMeetingRow, pick: QuickPick) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const f of m.segments.flatMap((s) => s.files)) next.delete(f.fileId);
      for (const id of quickPickFiles(m, pick)) next.add(id);
      return next;
    });

  const doImport = () =>
    void (async () => {
      setImporting(true);
      setImportError(null);
      try {
        await importZoomFiles({ sessionId: session.id, files: chosenFiles(filtered, visibleChosen) });
        onImported();
      } catch (e) {
        setImportError(errorText(e));
      } finally {
        setImporting(false);
      }
    })();

  // What the filters have changed from how the picker opened, in words, so a
  // list narrowed behind the ⚙ never reads as everything there is.
  const narrowedBy = [
    status === 'available' ? null : status === 'imported' ? 'imported only' : 'imported too',
    formats === 'all' ? null : formats === 'video' ? 'video only' : 'audio only',
    hideShort ? null : 'short recordings too',
  ].filter(Boolean);

  return (
    // No title of its own: the header says "Import from Zoom", and this line
    // says which session the files go into.
    <Screen subtitle={`${session.title} · ${cls.name}`}>
      {/* THE SESSION'S DAY FIRST, AND MOSTLY ALL THAT IS NEEDED: the range is
          asked for only once the picker is looking beyond that day. A tick
          and a square say "on/off"; a filled pill says "chosen". */}
      <Check
        testID="zoom-session-day"
        on={sessionDayOnly}
        onToggle={() => setSessionDayOnly((v) => !v)}
        label={`Only recordings from this session's date (${unbreakableDate(session.date)})`}
      />
      {sessionDayOnly ? null : (
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
      )}

      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Field label="Search by title" value={search} onChangeText={setSearch} placeholder="topic…" />
        </View>
        <IconButton testID="zoom-filters" icon="tune" label="Filters" onPress={() => setFiltersOpen(true)} />
      </View>
      {narrowedBy.length > 0 ? <Text style={styles.narrowed}>{`Showing ${narrowedBy.join(', ')}.`}</Text> : null}
      <Sheet visible={filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)} closeAt="corner">
        <SheetSection label="Recordings" />
        <Chips value={status} testIdPrefix="zoom-filter" options={STATUS_FILTERS} onChange={setStatus} />
        <SheetSection label="Formats" />
        <Chips value={formats} testIdPrefix="zoom-format" options={FORMAT_FILTERS} onChange={setFormats} />
        <Check
          testID="zoom-hide-short"
          on={hideShort}
          onToggle={() => setHideShort((v) => !v)}
          label="Hide recordings under 2 minutes"
          accessibilityLabel="Hide recordings under two minutes"
        />
      </Sheet>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {/* NOT BOTH. `rows` stays null when the request fails, so the empty state
          fired alongside the error and told staff to widen a date range for a
          request that never completed. */}
      {error ? null : loading && rows === null ? (
        <Empty>Loading recordings…</Empty>
      ) : filtered.length === 0 ? (
        // A wider range cannot help while the list is pinned to one date, so
        // that case names the toggle that can — beside the filters, which may
        // be what is hiding that day's recording.
        <Empty>
          {sessionDayOnly
            ? `No recordings match on ${unbreakableDate(session.date)}. Change the filters, or untick "Only recordings from this session's date" to see the whole range.`
            : 'No recordings match. Widen the date range or the filters, then Load.'}
        </Empty>
      ) : (
        <>
          {filtered.map((m) => (
            <MeetingCard
              key={m.meetingUuid}
              meeting={m}
              formats={formats}
              chosen={chosen}
              onToggle={toggle}
              onQuickPick={(pick) => quickPick(m, pick)}
              onOpenImported={onOpenImported}
            />
          ))}
          <Card>
            {/* WHAT IT ADDS UP TO, before anything is copied: video is where the
                storage goes, and the figure is the one decision this screen
                asks staff to make with money attached. */}
            <Text testID="zoom-selected" style={styles.total}>
              {summary.files === 0
                ? 'Nothing chosen yet. Tick files, or use a quick pick on a recording.'
                : `Selected: ${summary.files} ${summary.files === 1 ? 'file' : 'files'} · ${mb(summary.bytes)} · ${length(summary.durationSec)} of class · ${storageCostText(summary.usdPerMonth)}`}
            </Text>
            <Button
              testID="zoom-import"
              label={summary.files === 0 ? 'Import' : `Import ${summary.files} ${summary.files === 1 ? 'file' : 'files'}`}
              disabled={summary.files === 0}
              busy={importing}
              onPress={doImport}
            />
            {importError ? <Notice tone="error">{importError}</Notice> : null}
          </Card>
        </>
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
  disabled,
}: {
  testID: string;
  on: boolean;
  onToggle: () => void;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      aria-checked={on}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      style={styles.toggle}
    >
      <View style={[styles.box, on ? styles.boxOn : null, disabled ? styles.boxOff : null]}>
        {on ? <Text style={styles.tick}>✓</Text> : null}
      </View>
      <Text style={[styles.toggleText, disabled ? styles.muted : null]}>{label}</Text>
    </Pressable>
  );
}

function MeetingCard({
  meeting,
  formats,
  chosen,
  onToggle,
  onQuickPick,
  onOpenImported,
}: {
  meeting: ZoomMeetingRow;
  formats: ZoomFormatFilter;
  chosen: ReadonlySet<string>;
  onToggle: (fileId: string) => void;
  onQuickPick: (pick: QuickPick) => void;
  onOpenImported: (recordingId: string) => void;
}) {
  const several = meeting.segments.length > 1;
  // FROM THE FIRST START TO THE LAST END: the gaps between stretches are part
  // of when the class ran, though not of what was recorded.
  const last = meeting.segments[meeting.segments.length - 1];
  const span = {
    startTime: meeting.startTime,
    durationSec: (Date.parse(last.startTime) - Date.parse(meeting.startTime)) / 1000 + last.durationSec,
  };
  return (
    <Card>
      <Text style={styles.title}>{meeting.topic.trim() || 'Zoom recording'}</Text>
      {/* THE HOURS ARE WHAT IDENTIFY IT. One recurring meeting carries every
          class in a cohort, so the topic is the same on every card and two
          classes can share a date; when the recording ran is what differs. */}
      <Text testID={`zoom-when-${meeting.meetingUuid}`} style={styles.when}>
        {unbreakableDate(zoomRecordingDate(meeting))} · {zoomRecordingHours(span)}
      </Text>
      <Text style={styles.sub}>
        {length(meeting.durationSec)}
        {several ? ` · recorded in ${meeting.segments.length} stretches` : ''}
      </Text>
      {meeting.segments.some((s) => s.files.some(choosable)) ? (
        <Row>
          {QUICK_PICKS.map((q) => (
            <Button
              key={q.value}
              testID={`zoom-pick-${q.value}-${meeting.meetingUuid}`}
              label={q.label}
              variant="secondary"
              onPress={() => onQuickPick(q.value)}
            />
          ))}
        </Row>
      ) : null}
      {meeting.segments.map((s, i) => (
        <View key={s.startTime} style={several ? styles.segment : null}>
          {several ? (
            <Text style={styles.segmentHead}>
              {`Stretch ${i + 1} · ${zoomRecordingHours(s)} · ${length(s.durationSec)}`}
              {isShortSegment(s) ? ' · short' : ''}
            </Text>
          ) : null}
          {s.files
            .filter((f) => formatShown(f.format, formats))
            .map((f) => (
              <FileRow key={f.fileId} file={f} on={chosen.has(f.fileId)} onToggle={onToggle} onOpenImported={onOpenImported} />
            ))}
        </View>
      ))}
    </Card>
  );
}

function FileRow({
  file,
  on,
  onToggle,
  onOpenImported,
}: {
  file: ZoomFileRow;
  on: boolean;
  onToggle: (fileId: string) => void;
  onOpenImported: (recordingId: string) => void;
}) {
  const label = `${VERSION_LABELS[file.format]} · ${mb(file.sizeBytes)}`;
  if (file.imported) {
    const imp = file.imported;
    /*
      TAPPABLE, because the sentence alone leaves staff stuck: the picker lists
      the whole Zoom account, so most of what a manager sees part-way through a
      term is already imported, and the row knows exactly where it went. It is
      not a Button: this is a link out of a list, not the action the card offers.
    */
    return (
      <Pressable
        testID={`zoom-open-${file.fileId}`}
        accessibilityRole="link"
        onPress={() => onOpenImported(imp.recordingId)}
        style={styles.importedRow}
      >
        <Text style={styles.imported}>
          {`✓ ${label} — already imported${imp.courseName ? ` into ${imp.courseName}` : ''}, open it`}
        </Text>
      </Pressable>
    );
  }
  return (
    <Check
      testID={`zoom-file-${file.fileId}`}
      on={on}
      disabled={!file.ready}
      onToggle={() => onToggle(file.fileId)}
      label={file.ready ? label : `${label} · still processing in Zoom`}
    />
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing(2) },
  search: { flex: 1, minWidth: 0 },
  narrowed: { fontSize: 13, color: t.text.secondary, marginTop: spacing(2) },
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
  boxOff: { opacity: 0.4 },
  tick: { fontSize: 14, fontWeight: '700', color: t.accent.onAccent, lineHeight: 16 },
  toggleText: { flexShrink: 1, fontSize: 14, color: t.text.primary },
  muted: { color: t.text.secondary },
  title: { fontSize: 16, fontWeight: '600', color: t.text.primary },
  when: { fontSize: 14, fontWeight: '600', color: t.text.primary, marginTop: 2 },
  sub: { fontSize: 13, color: t.text.secondary, marginTop: 2, marginBottom: spacing(2) },
  segment: { marginTop: spacing(3) },
  segmentHead: { fontSize: 13, fontWeight: '600', color: t.text.secondary },
  imported: { fontSize: 14, color: t.feedback.success, fontWeight: '600' },
  total: { fontSize: 14, color: t.text.primary, marginBottom: spacing(2) },
});
