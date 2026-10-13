import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  INSTITUTE_TIMEZONE,
  allowedTransitions,
  hasLedger,
  isDiscardable,
  isOverdue,
  itemLabel,
  publishBlockers,
  startingItem,
  todayInZone,
  unbreakableDate,
  type AttendanceStatus,
  type MediaItem,
  type RecordingStatus,
} from '@sabeel/shared';
import {
  Button,
  Card,
  ConfirmDanger,
  Empty,
  Field,
  Notice,
  Row,
  Screen,
  SectionTitle,
  StatusChip,
} from '../components/ui';
import { DateField } from '../components/DateField';
import {
  deleteSession,
  submitAttendance,
  updateSession,
  useSessionState,
  type SessionRow,
} from '../sessions';
import {
  deleteRecording,
  editRecordingMedia,
  removeRecordingMedia,
  setRecordingStatus,
  useRecording,
  type RecordingRow,
} from '../recordings';
import { UploadPanel, useUploads } from '../components/UploadPanel';
import { MediaList } from '../components/MediaList';
import { retryZoomImport } from '../zoom';
import { sortByName, useRosterState, type EnrollmentRow } from '../structure';
import { useStudents } from '../students';
import { useWide } from '../useWidth';
import { getTheme, spacing } from '../theme';
import { errorText } from '../errors';
import { attendancePayload, registerMark } from '../attendanceRegister';

const t = getTheme();
const NO_ROSTER: EnrollmentRow[] = [];
const STATUSES: AttendanceStatus[] = ['present', 'absent', 'excused'];
const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  excused: 'Excused',
};

/**
 * Staff: one session — attendance and its recording.
 *
 * Attendance is the point: mark who was there, submit, and the EXCUSED are
 * assigned the recording. That one document is both the access grant and the
 * requirement, so present and absent students are granted nothing and cannot
 * open it. "Everyone must listen" is said by excusing everyone.
 */
export function SessionDetailScreen({
  sessionId,
  cls,
  isAdmin,
  onOpenCourse,
  onOpenLedger,
  onPlay,
  onImportZoom,
}: {
  sessionId: string;
  cls: { id: string; name: string };
  isAdmin: boolean;
  onOpenCourse: () => void;
  onOpenLedger: (recording: RecordingRow) => void;
  onPlay: (recording: RecordingRow, session: SessionRow, itemId?: string) => void;
  onImportZoom: (session: SessionRow) => void;
}) {
  const sessionState = useSessionState(sessionId);
  const session = sessionState.value;
  const recording = useRecording(session?.recordingId ?? null);

  // Deleting a session leaves you standing on it, and a URL can point at one
  // that is already gone — so say which of the two this is rather than showing
  // a spinner that never resolves.
  if (!session) {
    return (
      <Screen parent={{ label: cls.name, testID: 'up-to-course-from-session', onPress: onOpenCourse }}>
        <Empty>
          {sessionState.resolved
            ? 'That session is not available. It may have been removed.'
            : 'Loading…'}
        </Empty>
      </Screen>
    );
  }

  return (
    <Screen
      title={session.title}
      parent={{ label: cls.name, testID: 'up-to-course-from-session', onPress: onOpenCourse }}
      subtitle={`${session.date} · excused students have until\u00A0${unbreakableDate(session.dueDate)}`}
      // READ, not `list`. This screen is a register and a set of notes, both of
      // which are read one line at a time; the list width put every name and its
      // control 470px apart. The roster's three-way control is 330px wide, which
      // fits the reading column with room for the longest name in the institute.
      width="read"
    >
      <SessionHeader session={session} isAdmin={isAdmin} />
      <AttendanceSection session={session} />
      <RecordingSection
        session={session}
        recording={recording}
        isAdmin={isAdmin}
        onOpenLedger={onOpenLedger}
        onPlay={onPlay}
        onImportZoom={onImportZoom}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------- header --

function SessionHeader({ session, isAdmin }: { session: SessionRow; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [date, setDate] = useState(session.date);
  const [dueDate, setDueDate] = useState(session.dueDate);
  const [notes, setNotes] = useState(session.notes);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the form when the editor OPENS, not when the header mounts. Save writes
  // all four fields back at once, so a form still holding what the session said
  // when the screen loaded would silently revert every change made since —
  // including another staff member's.
  const openEditor = () => {
    setTitle(session.title);
    setDate(session.date);
    setDueDate(session.dueDate);
    setNotes(session.notes);
    setEditing(true);
  };

  const run = (key: string, fn: () => Promise<unknown>) =>
    void (async () => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        setEditing(false);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    })();

  if (editing) {
    return (
      <Card>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field label="Title" value={title} onChangeText={setTitle} autoCapitalize="words" />
        <DateField label="Date" value={date} onChange={setDate} />
        <DateField label="Due by" value={dueDate} onChange={setDueDate} />
        <Field
          label="Notes (everyone with access sees these)"
          value={notes}
          onChangeText={setNotes}
          multiline
        />
        <Row>
          <Button
            // The editor's own handle. It replaces the settings card rather than
            // opening beside it, so nothing else on this screen identifies the
            // editing state to a test.
            testID="session-save"
            label="Save"
            busy={busy === 'save'}
            onPress={() =>
              run('save', () =>
                updateSession({
                  sessionId: session.id,
                  title: title.trim(),
                  date,
                  dueDate: dueDate.trim(),
                  notes,
                }),
              )
            }
          />
          {/* Quiet, like a sheet's dismiss. Filled, it was the loudest control
              in an editor whose Save is the reason the editor is open. */}
          <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} />
        </Row>
      </Card>
    );
  }

  return (
    <Card>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {/* The listen-by date rides the heading line now — stating it again here
          was the same sentence twice on one screen. */}
      {session.notes ? (
        <Text style={styles.notes}>{session.notes}</Text>
      ) : (
        <Text style={styles.meta}>No notes for this session.</Text>
      )}
      <ConfirmDanger
        // A session with a recording is deleted by removing the recording first,
        // which is the deliberate order — otherwise attendance would vanish out
        // from under a recording students may already be accountable for.
        enabled={isAdmin && !session.recordingId}
        label="Delete session"
        confirmLabel="Delete permanently"
        warning="Permanently delete this session and its attendance? This can't be undone."
        busy={busy === 'del'}
        testID="session-delete"
        confirmTestID="session-delete-confirm"
        onConfirm={() => run('del', () => deleteSession({ sessionId: session.id }))}
      >
        <Row>
          <Button label="Edit session" variant="secondary" onPress={openEditor} />
        </Row>
      </ConfirmDanger>
    </Card>
  );
}

// ------------------------------------------------------------ attendance --

function AttendanceSection({ session }: { session: SessionRow }) {
  const wide = useWide();
  // `null` until the roster listener answers: "Enrol students first" is a
  // claim about the class, and the register said it on every cold load.
  const rosterState = useRosterState(session.courseId);
  const roster = rosterState ?? NO_ROSTER;
  const students = useStudents(true);
  const nameByUid = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of students) m.set(s.uid, s.displayName);
    return m;
  }, [students]);
  // Sorted by name: this is a register, marked by hand, once per student.
  const activeUids = useMemo(
    () =>
      sortByName(
        roster.filter((e) => e.active),
        (e) => nameByUid.get(e.studentUid) ?? e.studentUid,
      ).map((e) => e.studentUid),
    [roster, nameByUid],
  );

  // Local marks: default present, seeded from a prior submit. Cleared whenever
  // the submitted attendance changes underneath us (a second staff member
  // submitting, or our own submit landing) so the screen shows what was actually
  // recorded rather than silently keeping stale local edits on top of it.
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  useEffect(() => {
    setMarks({});
  }, [session.attendanceSubmittedAt]);
  // A submitted register leaves a student who joined since UNMARKED — see
  // `attendanceRegister`; a new one starts everyone as Present.
  const statusOf = (uid: string) => registerMark(session, marks, uid);
  const setStatus = (uid: string, s: AttendanceStatus) =>
    setMarks((m) => ({ ...m, [uid]: s }));
  // "Everyone must listen" is now said by EXCUSING everyone: excused is the only
  // mark that opens a recording, so marking the room absent would grant nobody
  // anything. The old "Mark all absent" did the opposite of what it promised
  // once the policy changed.
  const markAllExcused = () =>
    setMarks(Object.fromEntries(activeUids.map((uid) => [uid, 'excused' as AttendanceStatus])));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = () =>
    void (async () => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const attendance = attendancePayload(session, activeUids, marks);
        const res = await submitAttendance({ sessionId: session.id, attendance });
        setMarks({});
        setInfo(`Attendance submitted for ${res.marked} student${res.marked === 1 ? '' : 's'}.`);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <>
      <SectionTitle>Attendance</SectionTitle>
      <Card>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {info ? <Notice tone="success">{info}</Notice> : null}
        {/* With nobody on the roster there is nothing to mark, so telling someone
            to mark it is just noise — say the one thing they can act on. */}
        <Text style={styles.meta}>
          {rosterState === null
            ? 'Checking the roster…'
            : activeUids.length === 0
              ? 'Enrol students in this course first — attendance is taken from its roster.'
              : session.attendanceSubmittedAt
              ? 'Submitted. Excused students are assigned the recording and can open it until the due date; present and absent students are not.'
              : 'Everyone starts as Present — mark who was away, and excuse whoever should listen to the recording. Only excusing grants access, and nothing is granted until you submit.'}
        </Text>
        {rosterState === null ? null : activeUids.length === 0 ? (
          <Empty>No students enrolled in this course yet.</Empty>
        ) : (
          <>
            {/*
              ON A WIDE SCREEN THIS IS A REGISTER, not a stack of cards.

              Taking attendance is the teacher's daily job and the step the whole
              product hangs off — nothing is granted to anybody until it is
              submitted — so it is the screen most worth the width. Name above
              control is right on a phone, where 320px cannot hold both; at
              desktop width it doubles the height of a fourteen-student roster
              for nothing and makes the reader's eye travel down two lines per
              student instead of across one. Same markup, one flex direction.
            */}
            {activeUids.map((uid) => (
              <View
                key={uid}
                style={[
                  styles.rosterRow,
                  wide ? styles.rosterRowWide : null,
                ]}
              >
                <View style={[styles.rosterName, wide ? styles.rosterNameWide : null]}>
                  <Text style={styles.rosterNameText}>{nameByUid.get(uid) ?? uid}</Text>
                  {statusOf(uid) === null ? (
                    <Text style={styles.rosterHint} testID={`att-${nameByUid.get(uid) ?? uid}-unmarked`}>
                      Joined after this session — not marked
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.segment, wide ? styles.segmentWide : null]}>
                  {STATUSES.map((s) => {
                    const on = statusOf(uid) === s;
                    return (
                      <Pressable
                        key={s}
                        testID={`att-${nameByUid.get(uid) ?? uid}-${s}`}
                        // The most-tapped control in the staff app, and it had
                        // no role at all — one of three mutually exclusive
                        // marks, so `radio` with the student's name on it.
                        accessibilityRole="radio"
                        aria-checked={on}
                        accessibilityLabel={`${nameByUid.get(uid) ?? uid}: ${STATUS_LABEL[s]}`}
                        onPress={() => setStatus(uid, s)}
                        style={[styles.segBtn, on ? styles.segBtnOn : null]}
                      >
                        <Text style={[styles.segText, on ? styles.segTextOn : null]}>
                          {STATUS_LABEL[s]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ))}
            <Row>
              <Button testID="att-submit" label="Submit attendance" busy={busy} onPress={submit} />
              <Button
                testID="att-mark-all-excused"
                label="Mark all excused"
                variant="secondary"
                onPress={markAllExcused}
              />
            </Row>
          </>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------- recording --

function RecordingSection({
  session,
  recording,
  isAdmin,
  onOpenLedger,
  onPlay,
  onImportZoom,
}: {
  session: SessionRow;
  recording: RecordingRow | null;
  isAdmin: boolean;
  onOpenLedger: (recording: RecordingRow) => void;
  onPlay: (recording: RecordingRow, session: SessionRow, itemId?: string) => void;
  onImportZoom: (session: SessionRow) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploads = useUploads(session.id, recording);

  const run = (key: string, fn: () => Promise<unknown>) =>
    void (async () => {
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    })();

  const uploading = uploads.busy;
  // While files are chosen or going, the panel is the card's one task.
  const choosing = uploads.phase !== null;

  return (
    <>
      <SectionTitle>Recording</SectionTitle>
      <Card>
        {error ? <Notice tone="error">{error}</Notice> : null}

        {!recording ? (
          session.notRecorded ? (
            /*
              ALREADY SETTLED. Saying "no recording yet" under a line that says
              this class was not recorded is the app arguing with itself, so the
              upload and import controls go with it — putting audio here is
              un-marking it, which is the button below.
            */
            <>
              <Text style={styles.meta}>
                This class was not recorded. It has left the work queue, and nobody is being
                reminded to take its register.
              </Text>
              <Button
                testID="session-recorded-after-all"
                label="It was recorded after all"
                variant="secondary"
                busy={busy === 'notRecorded'}
                onPress={() =>
                  run('notRecorded', () =>
                    updateSession({ sessionId: session.id, notRecorded: false }),
                  )
                }
              />
            </>
          ) : (
            <>
              <Text style={styles.meta}>
                No recording yet. Upload the files or import them from Zoom; the session&apos;s
                title and date are used automatically.
              </Text>
              {/* WHERE THE BUTTON IS, so the files appear under the thumb that
                  chose them. The state is this section's, so the panel moves
                  into the card below, unbroken, once the first file has
                  created the recording. */}
              <UploadPanel uploads={uploads} recording={recording} />
              <Button
                testID="recording-upload"
                label="Upload files…"
                disabled={choosing}
                onPress={() => void uploads.pick()}
              />
              <Button
                testID="recording-import-zoom"
                label="Import from Zoom"
                variant="secondary"
                disabled={choosing}
                onPress={() => onImportZoom(session)}
              />
              {/*
                THE WAY OUT OF A CARD THAT OTHERWISE NEVER LEAVES.

                A class that met and was never recorded keeps a "no recording
                yet" row on the work queue for the life of the course — the row
                has no expiry, unlike the publish reminder — and goes on
                producing the morning "attendance still not taken" message. The
                only previous escape was deleting the session, which destroys
                that day's register with it. This says the same thing without
                destroying anything, and it is reversible above.
              */}
              <Button
                testID="session-not-recorded"
                label="This class was not recorded"
                variant="secondary"
                disabled={choosing}
                busy={busy === 'notRecorded'}
                onPress={() =>
                  run('notRecorded', () =>
                    updateSession({ sessionId: session.id, notRecorded: true }),
                  )
                }
              />
            </>
          )
        ) : (
          <RecordingCard
            recording={recording}
            session={session}
            isAdmin={isAdmin}
            busy={busy}
            uploading={uploading}
            choosing={choosing}
            onUpload={() => void uploads.pick()}
            uploadPanel={<UploadPanel uploads={uploads} recording={recording} />}
            onRun={run}
            onOpenLedger={onOpenLedger}
            onPlay={onPlay}
            onImportZoom={onImportZoom}
          />
        )}
      </Card>
    </>
  );
}

function RecordingCard({
  recording: r,
  session,
  isAdmin,
  busy,
  uploading,
  choosing,
  onUpload,
  uploadPanel,
  onRun,
  onOpenLedger,
  onPlay,
  onImportZoom,
}: {
  recording: RecordingRow;
  session: SessionRow;
  isAdmin: boolean;
  busy: string | null;
  uploading: boolean;
  /** Files are being chosen or sent: the upload panel is the card's task. */
  choosing: boolean;
  onUpload: () => void;
  /** The files being chosen or sent, drawn beside the button that chose them. */
  uploadPanel: ReactNode;
  onRun: (key: string, fn: () => Promise<unknown>) => void;
  onOpenLedger: (recording: RecordingRow) => void;
  onPlay: (recording: RecordingRow, session: SessionRow, itemId?: string) => void;
  onImportZoom: (session: SessionRow) => void;
}) {
  const blockers = publishBlockers(r);
  /*
   * THE SESSION'S DEADLINE IS A PUBLISH BLOCKER TOO, and it was the one the
   * screen did not know about.
   *
   * `allowedTransitions` describes the recording's own lifecycle; the server
   * additionally refuses to publish onto a session whose listen-by date has gone
   * ("Move it before publishing, or nobody will be able to open it"). So an
   * end-of-term ARCHIVED recording — the case the manual calls reversible with
   * "one tap puts it back" — drew a Publish button that could only ever return
   * an error. This app's rule is that a control which cannot succeed is not
   * offered; the card says why instead, and the way back is real: move the
   * session's Listen by date forward first.
   */
  const deadlinePassed = isOverdue(session.dueDate, todayInZone(INSTITUTE_TIMEZONE));
  const moves = allowedTransitions(r.status).filter((to) => to !== 'needsAttention');
  const items = Object.values(r.media);
  const playable = startingItem(r.media, r.defaultVersion);
  const arriving = items.some((i) => i.status === 'uploading' || i.status === 'copying');
  const failedZoom = items.some((i) => i.status === 'failed' && i.zoom);
  /*
   * WHO MAY REMOVE A FILE, as the server decides it: from a draft, whoever
   * manages the class; from a recording taken down, an admin, for storage;
   * from a live one, nobody — it is hidden instead, so nothing a student is
   * part-way through vanishes.
   */
  const canRemoveReady =
    r.status === 'draft' ||
    r.status === 'needsAttention' ||
    ((r.status === 'archived' || r.status === 'unpublished') && isAdmin);
  // A file students never saw — still arriving, or failed — can go in any
  // state: that is cancelling an upload or clearing a failed import.
  const canRemove = (item: MediaItem) => item.status !== 'ready' || canRemoveReady;
  // Removing a file DELETES it from the media bucket — it is gone, and a Zoom
  // import has to be re-imported while an upload needs the original again.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const removing = confirmRemove ? r.media[confirmRemove] : undefined;
  // Close the confirm if what it confirms stops being possible underneath it —
  // the same guard ConfirmDanger applies, so the open panel can never outlive
  // its precondition and offer a button that could only fail.
  useEffect(() => {
    if (confirmRemove && (!removing || (removing.status === 'ready' && !canRemoveReady))) setConfirmRemove(null);
  }, [confirmRemove, removing, canRemoveReady]);
  // No media is a NORMAL state here, not a failure: mid-upload, after a failed
  // one, or after a removal. Only say something is wrong once nothing is in
  // flight — otherwise a healthy upload reads as broken for its whole duration.
  const needsMedia = !playable && !arriving && !uploading;
  // Discarding a recording that never held anything destroys nothing, so it is
  // not the admin-only permanent delete. NOT `isEmptyDraft`, which is only
  // "needs media": a recording walked back from published has that same shape
  // with its whole ledger intact, and the server refuses a manager there — so
  // this used to offer a manager a button that could only fail, and an admin the
  // words "nothing is lost" over a term of listening history.
  const canDiscard = isDiscardable(r);
  const totalBytes = items.reduce((n, i) => n + (i.sizeBytes ?? 0), 0);

  // Takes over the card for the same reason ConfirmDanger does: a confirmation
  // that leaves Publish and Delete tappable underneath it is not a confirmation.
  if (removing && canRemove(removing)) {
    return (
      <Card>
        <Notice tone="error">
          Remove “{itemLabel(removing)}” from “{r.title}”? The file is deleted permanently. A
          Zoom file would have to be imported again; an uploaded one needs the original file. The
          recording and its other files stay.
        </Notice>
        <Row>
          <Button
            testID="recording-remove-confirm"
            label="Remove file"
            variant="danger"
            busy={busy === `remove-${r.id}`}
            onPress={() =>
              onRun(`remove-${r.id}`, async () => {
                await removeRecordingMedia({ recordingId: r.id, itemId: removing.id });
                setConfirmRemove(null);
              })
            }
          />
          <Button
            label="Cancel"
            variant="quiet"
            disabled={busy === `remove-${r.id}`}
            onPress={() => setConfirmRemove(null)}
          />
        </Row>
      </Card>
    );
  }

  return (
    <>
      <View style={styles.recMeta}>
        <StatusChip status={r.status} />
        <Text style={styles.hint}>
          {/* Silent while uploading — the progress bar above already says it,
              and two live descriptions of one operation just compete. */}
          {uploading
            ? ''
            : items.length > 0
              ? [r.durationSec ? fmtDuration(r.durationSec) : null, totalBytes ? `${(totalBytes / 1024 / 1024).toFixed(1)}\u00a0MB` : null]
                  .filter(Boolean)
                  .join(' · ')
              : 'no files yet'}
        </Text>
      </View>

      {needsMedia ? (
        <Notice tone="info">
          {failedZoom
            ? 'Nothing on this recording can be played yet. Retry the Zoom import, or upload the file.'
            : 'Nothing on this recording can be played yet. Upload the file, or import it from Zoom.'}
        </Notice>
      ) : null}
      {r.status === 'needsAttention' && r.attentionReason ? (
        <Notice tone="error">{r.attentionReason}</Notice>
      ) : null}

      <ConfirmDanger
        // Never for a live recording — the server refuses it too (unpublish or
        // archive first), so offering the button would only produce an error.
        enabled={r.status !== 'published' && (isAdmin || canDiscard)}
        label={canDiscard ? 'Discard recording' : 'Delete recording'}
        confirmLabel={canDiscard ? 'Discard' : 'Delete permanently'}
        warning={
          canDiscard
            ? 'This clears the empty recording off the session so you can start again. Nothing has been uploaded, so nothing is lost.'
            : "This permanently removes every file and every listening record for it — it can't be undone. Archiving keeps everything; delete only to free up storage."
        }
        busy={busy === `del-${r.id}`}
        testID="recording-delete"
        confirmTestID="recording-delete-confirm"
        onConfirm={() => onRun(`del-${r.id}`, () => deleteRecording({ recordingId: r.id }))}
      >
        {/* EVERY action on this card belongs inside the confirm, so opening it
            replaces all of them. These sat outside at first and stayed
            tappable underneath "discard this?" — the exact flaw ConfirmDanger
            exists to prevent, and one only a native run in the needs-audio state
            surfaced. */}
        <MediaList
          recording={r}
          disabled={uploading || busy !== null}
          canRemove={canRemove}
          onPlay={(itemId) => onPlay(r, session, itemId)}
          onEdit={(edit) => onRun(`edit-${r.id}`, () => editRecordingMedia({ recordingId: r.id, ...edit }))}
          onRemove={setConfirmRemove}
        />
        {uploadPanel}
        <Row>
          {/* MORE FILES, in any state, like more from Zoom: each is a new
              part or another version of one, and students see it once it has
              arrived. */}
          <Button testID="recording-upload" label="Upload files…" variant="secondary" disabled={choosing} onPress={onUpload} />
          {failedZoom ? (
            <Button
              testID="recording-retry-import"
              label="Retry import"
              variant="secondary"
              busy={busy === `retry-${r.id}`}
              disabled={uploading}
              onPress={() => onRun(`retry-${r.id}`, () => retryZoomImport({ recordingId: r.id }))}
            />
          ) : null}
          {/* MORE FROM ZOOM, in any state: the second half of a class in
              another meeting is added as a part, and a published recording
              shows it to students once it has arrived. */}
          <Button
            testID="recording-import-zoom-more"
            label={items.length > 0 ? 'Add from Zoom' : 'Import from Zoom'}
            variant="secondary"
            disabled={uploading}
            onPress={() => onImportZoom(session)}
          />
        </Row>
        <Row>
          {/* PRIMARY, as it is on the library card — unless Publish is on offer,
              which outranks it. Playing what was just published is the one
              thing in this row that is not administration, and drawn like
              Archive and Unpublish it was indistinguishable from the two
              controls that take the recording away. Never two primaries. */}
          {playable ? (
            <Button
              testID="recording-play"
              label="Play"
              variant={moves.includes('published') ? 'secondary' : 'primary'}
              disabled={uploading}
              onPress={() => onPlay(r, session)}
            />
          ) : null}
          {moves.map((to) => (
            <Button
              key={to}
              testID={`recording-${to}`}
              label={LABELS[to]}
              variant={to === 'published' ? 'primary' : 'secondary'}
              disabled={
                uploading || (to === 'published' && (blockers.length > 0 || deadlinePassed))
              }
              busy={busy === `status-${r.id}`}
              onPress={() => onRun(`status-${r.id}`, () => setRecordingStatus({ recordingId: r.id, status: to }))}
            />
          ))}
        </Row>

        {/* SAY WHY THE BUTTON IS OFF, or a greyed Publish reads as a broken app.
            Only when publishing is a move on offer at all — a live recording has
            no Publish to explain. */}
        {moves.includes('published') && deadlinePassed ? (
          <Notice tone="info">
            This session&apos;s due date has passed, so publishing would give nobody access.
            Move the date forward on the session above first.
          </Notice>
        ) : null}

        {hasLedger(r) ? (
          <View style={styles.ledgerRow}>
            <Button
              testID="recording-ledger"
              label="Progress"
              variant="secondary"
              onPress={() => onOpenLedger(r)}
            />
          </View>
        ) : null}
        {/* SAY WHY PUBLISH IS OFF, beside the deadline's reason below. */}
        {moves.includes('published') && blockers.some((b) => b !== 'status') ? (
          <Notice tone="info">
            {blockers.includes('pending')
              ? 'Publishing waits until every file has arrived.'
              : blockers.includes('failed')
                ? 'Retry or remove the failed files before publishing.'
                : 'Add a file students can play before publishing.'}
          </Notice>
        ) : null}
      </ConfirmDanger>
    </>
  );
}

const LABELS: Record<RecordingStatus, string> = {
  draft: 'Back to draft',
  published: 'Publish',
  archived: 'Archive',
  unpublished: 'Unpublish',
  needsAttention: 'Flag a problem',
};

function fmtDuration(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const styles = StyleSheet.create({
  meta: { fontSize: 14, color: t.text.secondary },
  notes: { fontSize: 14, color: t.text.secondary, marginTop: spacing(2) },
  hint: { fontSize: 13, color: t.text.secondary },
  rosterRow: { marginTop: spacing(3) },
  rosterRowWide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(4),
    marginTop: 0,
    paddingVertical: spacing(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.border.subtle,
  },
  rosterName: { marginBottom: spacing(1) },
  rosterNameWide: { flex: 1, marginBottom: 0 },
  rosterNameText: { fontSize: 15, color: t.text.primary },
  rosterHint: { fontSize: 12, color: t.text.secondary, marginTop: 2 },
  segment: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.strong,
    overflow: 'hidden',
    // CAPPED IN THE STACKED LAYOUT TOO, but capped — not shrink-wrapped. Below
    // the 900px breakpoint the name sits above its control, and `segBtn`'s
    // `flex: 1` spread three segments across the whole card: 215px each at a
    // 720px window, twice their width on a desktop. `maxWidth` alone fixes that,
    // because a column child still stretches to the card and stops here.
    // `alignSelf: 'flex-start'` does NOT: it collapses the row to fit its
    // content, and with a zero flex-basis that content is one label's width, so
    // all three came out 49px and "Excused" was sliced mid-letter at 320, 390
    // and 720 alike.
    maxWidth: 330,
  },
  // Fixed rather than capped, so every row's three states line up in a column
  // the eye can run down whatever the names beside them measure.
  segmentWide: { width: 330 },
  /*
   * ONE COLUMN FOR THE WHOLE SCREEN — and `Screen` now carries it, so the
   * heading ends where the cards do.
   *
   * A REGISTER is read one line at a time: at the list width it put every name
   * and its control 470px apart. Capping the ROWS instead left a 339px strip of
   * empty card to the right of each; capping the CARDS left the H1 running 200px
   * past them. `width="read"` caps the page, and every card in it simply fills.
   */
  // 44pt: this is the single most-tapped control in the staff app — once per
  // student, per session — and it was 32px tall at phone width.
  segBtn: {
    flex: 1,
    paddingVertical: spacing(2),
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: t.bg.surface,
  },
  segBtnOn: { backgroundColor: t.accent.base },
  segText: { fontSize: 13, fontWeight: '600', color: t.text.secondary },
  segTextOn: { color: t.accent.onAccent },
  recMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing(3), marginBottom: spacing(2) },
  ledgerRow: { marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: t.border.subtle },
  progressWrap: { marginTop: spacing(3), backgroundColor: t.bg.inset, borderRadius: 6, overflow: 'hidden', minHeight: 26, justifyContent: 'center' },
  progressBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: t.bg.sage },
  progressText: { fontSize: 12, color: t.text.primary, paddingHorizontal: spacing(2), paddingVertical: spacing(1) },
});
