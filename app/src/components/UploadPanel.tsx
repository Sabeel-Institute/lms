import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  isVideoContentType,
  maxUploadBytes,
  uploadContentType,
  type UploadContentType,
  type UploadPlacement,
} from '@sabeel/shared';
import { Button, Chips, Row } from './ui';
import { pickMediaFiles, readPart, sendPart } from '../mediaFiles';
import type { PickedFile } from '../mediaFileTypes';
import { UploadCancelled, uploadMedia } from '../upload';
import { createRecording, deleteRecording, uploadApi, type RecordingRow } from '../recordings';
import { errorText } from '../errors';
import { placementOptions } from '../uploadPlacement';
import { getTheme, spacing } from '../theme';

const t = getTheme();

type RowState = 'waiting' | 'sending' | 'checking' | 'done' | 'failed' | 'cancelled';

interface UploadRow {
  key: string;
  file: PickedFile;
  contentType: UploadContentType | null;
  /** Why this file will not be sent, decided before anything is. */
  problem: string | null;
  placement: UploadPlacement;
  state: RowState;
  progress: number;
  message: string | null;
}

type Phase = 'choosing' | 'running' | 'finished';

const mb = (bytes: number) =>
  bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}\u00a0GB` : `${(bytes / 2 ** 20).toFixed(1)}\u00a0MB`;

function toRow(file: PickedFile, i: number): UploadRow {
  const contentType = uploadContentType(file.name);
  const problem = !contentType
    ? 'Not a file the app takes. Use M4A, MP3, WAV or MP4.'
    : file.sizeBytes > maxUploadBytes(contentType)
      ? isVideoContentType(contentType)
        ? 'Too large: a video can be 8 GB at most.'
        : 'Too large: an audio file can be 300 MB at most.'
      : file.sizeBytes === 0
        ? 'This file is empty.'
        : null;
  return {
    key: `${i}-${file.name}`,
    file,
    contentType,
    problem,
    placement: { as: 'part' },
    state: problem ? 'failed' : 'waiting',
    progress: 0,
    message: problem,
  };
}

/**
 * The files being added to a session's recording: chosen, placed, sent.
 *
 * Owned ABOVE the session page's recording/no-recording branch, because the
 * first upload creates the recording and the live listener flips that branch
 * mid-upload. LEAVING THE PAGE STOPS IT: the hook's cleanup aborts what is in
 * flight, and `uploadMedia` removes the half-sent file, so nothing waits on
 * the session as "upload not finished" (docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md,
 * "Staff upload").
 */
export function useUploads(sessionId: string, recording: RecordingRow | null) {
  const [rows, setRows] = useState<UploadRow[] | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const patch = (key: string, p: Partial<UploadRow>) =>
    setRows((rs) => rs?.map((r) => (r.key === key ? { ...r, ...p } : r)) ?? null);

  /*
   * ONE PICK AND ONE RUN AT A TIME. `phase` is state, a frame late: a double
   * tap on Upload started two runs over the same rows and sent every file
   * twice, and a double tap on the picker opened two.
   */
  const picking = useRef(false);
  const running = useRef(false);
  const pick = async () => {
    if (picking.current || running.current) return;
    picking.current = true;
    try {
      const files = await pickMediaFiles();
      if (!files) return;
      setRows(files.map(toRow));
      setPhase('choosing');
    } finally {
      picking.current = false;
    }
  };

  const run = async () => {
    const queue = (rows ?? []).filter((r) => !r.problem);
    if (queue.length === 0 || running.current) return;
    running.current = true;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase('running');
    let recordingId = recording?.id ?? null;
    let created: string | null = null;
    let added = 0;
    try {
      if (!recordingId) recordingId = created = (await createRecording({ sessionId })).id;
      for (const row of queue) {
        if (ctrl.signal.aborted) {
          patch(row.key, { state: 'cancelled', message: 'Not sent.' });
          continue;
        }
        patch(row.key, { state: 'sending', message: null });
        try {
          await uploadMedia({
            recordingId,
            contentType: row.contentType as UploadContentType,
            sizeBytes: row.file.sizeBytes,
            placement: row.placement,
            api: uploadApi,
            io: {
              read: (start, end) => readPart(row.file, start, end),
              send: (url, body, signal, onSent) => sendPart(url, body, signal, {}, onSent),
            },
            signal: ctrl.signal,
            onProgress: (progress) => patch(row.key, { progress }),
            onStage: (stage) => patch(row.key, { state: stage }),
          });
          added++;
          patch(row.key, { state: 'done', progress: 1, message: 'Added.' });
        } catch (e) {
          patch(row.key, e instanceof UploadCancelled
            ? { state: 'cancelled', message: 'Stopped. Nothing was kept.' }
            : { state: 'failed', message: errorText(e) });
        }
      }
    } catch (e) {
      // Creating the recording failed: no file was sent.
      setRows((rs) => rs?.map((r) => (r.state === 'waiting' ? { ...r, state: 'failed', message: errorText(e) } : r)) ?? null);
    } finally {
      // A recording this attempt created and nothing landed on would block
      // the next attempt (a session takes one recording) behind a delete.
      // Only if it is still empty: someone else may have added to it since.
      if (created && added === 0) await deleteRecording({ recordingId: created, ifEmpty: true }).catch(() => undefined);
      abort.current = null;
      running.current = false;
      setPhase('finished');
    }
  };

  return {
    rows,
    phase,
    busy: phase === 'running',
    pick,
    run,
    setPlacement: (key: string, placement: UploadPlacement) => patch(key, { placement }),
    stop: () => abort.current?.abort(),
    dismiss: () => {
      setRows(null);
      setPhase(null);
    },
  };
}

const STATE_TEXT: Record<RowState, (r: UploadRow) => string> = {
  waiting: () => 'Waiting',
  sending: (r) => `Sending ${Math.round(r.progress * 100)}%`,
  checking: () => 'Checking the file…',
  done: (r) => r.message ?? 'Added.',
  failed: (r) => r.message ?? 'Not added.',
  cancelled: (r) => r.message ?? 'Stopped.',
};

/**
 * The chosen files with where each goes, then each one's progress.
 *
 * Each file is a new part unless staff say it is another version of a part
 * already there — phone video of the whiteboard beside the Zoom audio is the
 * case the plan names. A part is offered only if it has no file of that kind,
 * which is the rule the server holds.
 */
export function UploadPanel({
  uploads,
  recording,
}: {
  uploads: ReturnType<typeof useUploads>;
  recording: RecordingRow | null;
}) {
  const { rows, phase } = uploads;
  if (!rows || !phase) return null;
  const sendable = rows.filter((r) => !r.problem).length;
  return (
    <View testID="upload-panel" style={styles.panel}>
      <Text style={styles.heading}>
        {phase === 'choosing' ? 'Files to upload' : phase === 'running' ? 'Uploading' : 'Upload finished'}
      </Text>
      {rows.map((r, i) => (
        <View key={r.key} testID={`upload-row-${i}`} style={styles.row}>
          <Text style={styles.name}>{r.file.name}</Text>
          <Text style={[styles.meta, r.state === 'failed' ? styles.failed : null]}>
            {phase === 'choosing'
              ? (r.problem ?? [r.contentType && isVideoContentType(r.contentType) ? 'video' : 'audio', mb(r.file.sizeBytes)].join(' · '))
              : STATE_TEXT[r.state](r)}
          </Text>
          {/* Only when there is a choice: a lone "New part" pill is a
              question with one answer. */}
          {phase === 'choosing' && !r.problem && placementOptions(recording?.media ?? {}, r.contentType).length > 1 ? (
            <Chips<string>
              value={r.placement.as === 'part' ? 'part' : `v${r.placement.part}`}
              testIdPrefix={`upload-place-${i}`}
              options={placementOptions(recording?.media ?? {}, r.contentType)}
              onChange={(v) =>
                uploads.setPlacement(r.key, v === 'part' ? { as: 'part' } : { as: 'version', part: Number(v.slice(1)) })
              }
            />
          ) : null}
          {r.state === 'sending' ? (
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(r.progress * 100)}%` }]} />
            </View>
          ) : null}
        </View>
      ))}
      <Row>
        {phase === 'choosing' ? (
          <>
            <Button
              testID="upload-start"
              label={sendable === 1 ? 'Upload 1 file' : `Upload ${sendable} files`}
              disabled={sendable === 0}
              onPress={() => void uploads.run()}
            />
            <Button testID="upload-dismiss" label="Cancel" variant="quiet" onPress={uploads.dismiss} />
          </>
        ) : phase === 'running' ? (
          <Button testID="upload-stop" label="Stop uploading" variant="secondary" onPress={uploads.stop} />
        ) : (
          <Button testID="upload-done" label="Done" variant="secondary" onPress={uploads.dismiss} />
        )}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: spacing(3), marginBottom: spacing(3) },
  heading: { fontSize: 14, fontWeight: '700', color: t.text.primary },
  row: { marginTop: spacing(3) },
  name: { fontSize: 14, fontWeight: '600', color: t.text.primary },
  meta: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  failed: { color: t.feedback.danger },
  track: { height: 6, borderRadius: 3, backgroundColor: t.bg.inset, overflow: 'hidden', marginTop: spacing(1) },
  fill: { height: 6, backgroundColor: t.accent.base },
});
