import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import {
  attachmentKind,
  attachmentProblem,
  type AttachmentFile,
  type AttachmentMap,
} from '@sabeel/shared';
import { Button, Row } from './ui';
import { AttachmentAudio } from './AttachmentAudio';
import { canTakePhoto, pickAttachmentFiles, takePhoto } from '../attachmentFiles';
import { readPart, sendPart } from '../mediaFiles';
import type { PickedFile } from '../mediaFileTypes';
import { finalizeAttachment, getAttachmentUrl, removeAttachment, startAttachmentUpload } from '../coursework';
import { errorText } from '../errors';
import { formatClock } from '../playback';
import { getTheme, spacing } from '../theme';

const t = getTheme();

const size = (bytes: number) =>
  bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)}\u00a0MB` : `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`;

const KIND_WORD = { document: 'Document', image: 'Picture', audio: 'Audio' } as const;

/** A file on its way in, shown under the ones that have arrived. */
interface Pending {
  key: string;
  name: string;
  /** Chosen, and waiting for the files chosen before it. */
  waiting: boolean;
  error: string | null;
}

/**
 * The files on an assignment, or on a student's own work, and — where the
 * person may change them — the way to add more.
 *
 * Each file uploads the moment it is chosen, with its own line; the server
 * checks it on arrival and either adds it to the list (the live record shows
 * it) or says why not. `busy` tells the screen something is still on its way,
 * so "Hand in" can wait for it.
 */
export function Attachments({
  target,
  courseworkId,
  files,
  editable,
  studentUid,
  onBusyChange,
}: {
  target: 'coursework' | 'work';
  courseworkId: string;
  files: AttachmentMap;
  editable: boolean;
  /** Whose work the files are on, for a teacher opening them; omitted for the assignment's own. */
  studentUid?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);
  const inFlight = pending.some((p) => p.error === null);
  useEffect(() => onBusyChange?.(inFlight), [inFlight, onBusyChange]);

  /*
   * ONE UPLOAD AT A TIME, in the order the files were chosen, across picks
   * too. Each file is dated from the start of its upload and the list is in
   * that order; sent all at once, a small file chosen second could start
   * first, and the rows changed places as they arrived. Every chosen file is
   * listed the moment it is chosen, so "Hand in" waits for the last of them
   * and not only the one on its way.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const made = useRef(0);
  const enqueue = (chosen: PickedFile[]) => {
    const rows = chosen.map((file) => ({
      file,
      key: `f${(made.current += 1)}`,
      problem: attachmentProblem(file.name, file.sizeBytes),
    }));
    setPending((p) => [
      ...p,
      ...rows.map(({ key, file, problem }) => ({ key, name: file.name, waiting: problem === null, error: problem })),
    ]);
    for (const row of rows) {
      if (row.problem === null) queue.current = queue.current.then(() => send(row.key, row.file));
    }
  };

  const send = async (key: string, file: PickedFile) => {
    // The screen has gone: the files after the one cut short are not started.
    if (abort.current.signal.aborted) return;
    setPending((p) => p.map((x) => (x.key === key ? { ...x, waiting: false } : x)));
    try {
      const start = await startAttachmentUpload({ target, courseworkId, name: file.name, sizeBytes: file.sizeBytes });
      await sendPart(start.url, await readPart(file, 0, file.sizeBytes), abort.current.signal, start.headers);
      await finalizeAttachment({ courseworkId, fileId: start.fileId });
      setPending((p) => p.filter((x) => x.key !== key));
    } catch (e) {
      if (abort.current.signal.aborted) return;
      setPending((p) => p.map((x) => (x.key === key ? { ...x, error: errorText(e) } : x)));
    }
  };

  /*
   * ONE PICKER AT A TIME, one removal per file. A second tap before the
   * picker opened started a second pick, which the native picker refuses with
   * an error; a second Remove ran after the first had gone and showed the
   * server's refusal over a removal that worked.
   */
  const picking = useRef(false);
  const removing = useRef(new Set<string>());
  const [removingIds, setRemovingIds] = useState<string[]>([]);
  const add = async (pick: () => Promise<PickedFile[] | PickedFile | null>) => {
    if (picking.current) return;
    picking.current = true;
    setError(null);
    try {
      const picked = await pick();
      picking.current = false;
      if (!picked) return;
      enqueue(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      picking.current = false;
    }
  };
  const remove = async (fileId: string) => {
    if (removing.current.has(fileId)) return;
    removing.current.add(fileId);
    setRemovingIds([...removing.current]);
    setError(null);
    try {
      await removeAttachment({ courseworkId, fileId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      removing.current.delete(fileId);
      setRemovingIds([...removing.current]);
    }
  };

  const list = Object.values(files).sort((a, b) => a.addedAt - b.addedAt);
  return (
    <View testID={`attachments-${target}`}>
      {list.map((f) => (
        <FileRow
          key={f.id}
          file={f}
          courseworkId={courseworkId}
          studentUid={studentUid}
          onRemove={editable ? () => void remove(f.id) : undefined}
          removing={removingIds.includes(f.id)}
        />
      ))}
      {pending.map((p) => (
        <View key={p.key} style={styles.file}>
          <Text style={styles.name}>{p.name}</Text>
          <Text style={[styles.meta, p.error ? styles.failed : null]}>
            {p.error ?? (p.waiting ? 'Waiting to upload…' : 'Uploading…')}
          </Text>
          {p.error ? (
            <Button
              label="Dismiss"
              variant="quiet"
              hug
              onPress={() => setPending((x) => x.filter((y) => y.key !== p.key))}
            />
          ) : null}
        </View>
      ))}
      {error ? <Text style={[styles.meta, styles.failed]}>{error}</Text> : null}
      {editable ? (
        <Row>
          <Button testID={`attachments-add-${target}`} label="Add files" variant="secondary" hug onPress={() => void add(pickAttachmentFiles)} />
          {canTakePhoto ? (
            <Button testID={`attachments-photo-${target}`} label="Take a photo" variant="secondary" hug onPress={() => void add(takePhoto)} />
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}

/**
 * One file: a picture shown, audio playable in place, a document opened in the
 * phone's or the browser's own viewer. Links are minted on demand and last an
 * hour.
 */
function FileRow({
  file,
  courseworkId,
  studentUid,
  onRemove,
  removing,
}: {
  file: AttachmentFile;
  courseworkId: string;
  studentUid?: string;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const kind = attachmentKind(file.contentType);
  const [url, setUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const link = () => getAttachmentUrl({ courseworkId, fileId: file.id, studentUid }).then((r) => r.url);
  // Pictures and audio are shown in place, so their link is fetched at once.
  useEffect(() => {
    if (kind === 'document') return;
    let live = true;
    link().then((u) => live && setUrl(u), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one link per file
  }, [file.id]);

  // One new link at a time, however often "Try again" is pressed.
  const retrying = useRef(false);
  const retry = () => {
    if (retrying.current) return;
    retrying.current = true;
    setError(null);
    void link()
      .then(
        (u) => {
          setUrl(u);
          setAttempt((n) => n + 1);
        },
        (e) => setError(errorText(e)),
      )
      .finally(() => {
        retrying.current = false;
      });
  };

  const open = async () => {
    try {
      const u = await link();
      if (Platform.OS === 'web') window.open(u, '_blank', 'noopener');
      else await Linking.openURL(u);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <View testID={`attachment-${file.name}`} style={styles.file}>
      <Text style={styles.name}>{file.name}</Text>
      <Text style={styles.meta}>
        {[KIND_WORD[kind], file.durationSec ? formatClock(file.durationSec * 1000) : null, size(file.sizeBytes)].filter(Boolean).join(' · ')}
      </Text>
      {kind === 'image' && url ? (
        <Image source={{ uri: url }} style={styles.picture} resizeMode="contain" accessibilityLabel={file.name} />
      ) : null}
      {kind === 'audio' && url ? (
        <AttachmentAudio
          url={url}
          attempt={attempt}
          name={file.name}
          durationMs={(file.durationSec ?? 0) * 1000}
          onRetry={retry}
        />
      ) : null}
      {error ? <Text style={[styles.meta, styles.failed]}>{error}</Text> : null}
      <Row>
        {kind === 'document' ? <Button label="Open" variant="secondary" hug onPress={() => void open()} /> : null}
        {onRemove ? <Button testID={`attachment-remove-${file.name}`} label="Remove" variant="quiet" hug busy={removing} onPress={onRemove} /> : null}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  file: { marginBottom: spacing(3) },
  name: { fontSize: 14, fontWeight: '600', color: t.text.primary },
  meta: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  failed: { color: t.feedback.danger },
  picture: { width: '100%', aspectRatio: 4 / 3, backgroundColor: t.bg.inset, borderRadius: 8, marginVertical: spacing(1) },
});
