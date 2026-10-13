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
import { getTheme, spacing } from '../theme';

const t = getTheme();

const size = (bytes: number) =>
  bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)}\u00a0MB` : `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`;
const length = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

const KIND_WORD = { document: 'Document', image: 'Picture', audio: 'Audio' } as const;

/** A file on its way in, shown under the ones that have arrived. */
interface Pending {
  key: string;
  name: string;
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

  const send = async (file: PickedFile) => {
    const key = `${Date.now()}-${file.name}`;
    const problem = attachmentProblem(file.name, file.sizeBytes);
    setPending((p) => [...p, { key, name: file.name, error: problem }]);
    if (problem) return;
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

  const add = async (pick: () => Promise<PickedFile[] | PickedFile | null>) => {
    setError(null);
    try {
      const picked = await pick();
      if (!picked) return;
      await Promise.all((Array.isArray(picked) ? picked : [picked]).map(send));
    } catch (e) {
      setError(errorText(e));
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
          onRemove={editable ? () => void removeAttachment({ courseworkId, fileId: f.id }).catch((e) => setError(errorText(e))) : undefined}
        />
      ))}
      {pending.map((p) => (
        <View key={p.key} style={styles.file}>
          <Text style={styles.name}>{p.name}</Text>
          <Text style={[styles.meta, p.error ? styles.failed : null]}>{p.error ?? 'Uploading…'}</Text>
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
}: {
  file: AttachmentFile;
  courseworkId: string;
  studentUid?: string;
  onRemove?: () => void;
}) {
  const kind = attachmentKind(file.contentType);
  const [url, setUrl] = useState<string | null>(null);
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
        {[KIND_WORD[kind], file.durationSec ? length(file.durationSec) : null, size(file.sizeBytes)].filter(Boolean).join(' · ')}
      </Text>
      {kind === 'image' && url ? (
        <Image source={{ uri: url }} style={styles.picture} resizeMode="contain" accessibilityLabel={file.name} />
      ) : null}
      {kind === 'audio' && url ? <AttachmentAudio url={url} /> : null}
      {error ? <Text style={[styles.meta, styles.failed]}>{error}</Text> : null}
      <Row>
        {kind === 'document' ? <Button label="Open" variant="secondary" hug onPress={() => void open()} /> : null}
        {onRemove ? <Button testID={`attachment-remove-${file.name}`} label="Remove" variant="quiet" hug onPress={onRemove} /> : null}
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
