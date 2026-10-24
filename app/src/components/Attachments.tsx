import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../icons';
import {
  attachmentContentType,
  attachmentProblem,
  type AttachmentFile,
  type AttachmentMap,
} from '@sabeel/shared';
import { Button, IconButton, inputLook } from './ui';
import { Sheet, SheetOption } from './Sheet';
import { canTakePhoto, pickAttachmentFiles, takePhoto } from '../attachmentFiles';
import { readPart, sendPart } from '../mediaFiles';
import type { PickedFile } from '../mediaFileTypes';
import { finalizeAttachment, getAttachmentUrl, removeAttachment, startAttachmentUpload } from '../coursework';
import { errorText } from '../errors';
import { openFile } from '../openFile';
import { useOneAtATime } from '../oneAtATime';
import { formatClock } from '../playback';
import { getTheme, spacing } from '../theme';

const t = getTheme();

const size = (bytes: number) =>
  bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)}\u00a0MB` : `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`;

/** What a file is, in the word its own name ends with: PDF, DOCX, M4A. */
const typeWord = (name: string) => name.match(/\.([a-z0-9]{1,4})$/i)?.[1].toUpperCase() ?? 'FILE';


/** The pictogram for a file, from what it is stored as. */
function glyphFor(contentType: string | null): IconName {
  if (!contentType) return 'insert-drive-file';
  if (contentType === 'application/pdf') return 'picture-as-pdf';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audiotrack';
  if (/presentation|powerpoint/.test(contentType)) return 'slideshow';
  if (/sheet|excel/.test(contentType)) return 'table-chart';
  return 'description';
}

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
 * person may change them — the paperclip to add more and a bin on each.
 *
 * A file is a link: tapping it opens it in the phone's or the browser's own
 * viewer, whatever it is — a worksheet, a picture, a recitation — or saves it
 * under its own name where the browser only downloads that kind (`openFile`).
 * Nothing is drawn or played in place (Faisal, 2026-10-13).
 *
 * Each file uploads the moment it is chosen, with its own line; the server
 * checks it on arrival and either adds it to the list (the live record shows
 * it) or says why not. `busy` tells the screen something is still on its way,
 * so "Hand in", "Post" and "Save" can wait for it.
 */
export function Attachments({
  target,
  courseworkId,
  files,
  editable,
  studentUid,
  courseId,
  onHeld,
  onBusyChange,
  removalWarning,
}: {
  target: 'coursework' | 'work';
  courseworkId: string;
  files: AttachmentMap;
  editable: boolean;
  /** Whose work the files are on, for a teacher opening them; omitted for the assignment's own. */
  studentUid?: string;
  /** The class, for an assignment not saved yet, which has no record to name it. */
  courseId?: string;
  /**
   * For an assignment not saved yet: its files are held under the id its form
   * reserved, and no live record lists them, so the form keeps the list.
   */
  onHeld?: Dispatch<SetStateAction<AttachmentMap>>;
  onBusyChange?: (busy: boolean) => void;
  /**
   * Files that students already have: a removal is final the moment it is
   * made, so it is asked first, with this said.
   */
  removalWarning?: string;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);

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
      const start = await startAttachmentUpload({ target, courseworkId, courseId, name: file.name, sizeBytes: file.sizeBytes });
      await sendPart(start.url, await readPart(file, 0, file.sizeBytes), abort.current.signal, start.headers);
      const { file: held } = await finalizeAttachment({ courseworkId, fileId: start.fileId });
      onHeld?.((m) => ({ ...m, [held.id]: held }));
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
  /*
   * BUSY UNTIL A REMOVAL HAS FINISHED TOO. Hand in (or Post) pressed straight
   * after a bin copied the file into the work while its bytes were being
   * deleted, and the work listed a file nobody could open.
   */
  const inFlight = pending.some((p) => p.error === null) || removingIds.length > 0;
  useEffect(() => onBusyChange?.(inFlight), [inFlight, onBusyChange]);
  const [asking, setAsking] = useState<AttachmentFile | null>(null);
  const [choosing, setChoosing] = useState(false);
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
  // Where a file can come from: the files, or — on a phone — the camera too.
  const attach = () => (canTakePhoto ? setChoosing(true) : void add(pickAttachmentFiles));
  const from = (pick: () => Promise<PickedFile[] | PickedFile | null>) => {
    setChoosing(false);
    void add(pick);
  };
  const remove = async (fileId: string) => {
    if (removing.current.has(fileId)) return;
    removing.current.add(fileId);
    setRemovingIds([...removing.current]);
    setError(null);
    try {
      await removeAttachment({ courseworkId, fileId });
      onHeld?.(({ [fileId]: _gone, ...rest }) => rest);
    } catch (e) {
      setError(errorText(e));
    } finally {
      removing.current.delete(fileId);
      setRemovingIds([...removing.current]);
    }
  };

  /*
   * ONE FILE OPENING AT A TIME. Its link is minted for the tap, so a second
   * tap while the first is on its way would open the file twice.
   */
  const opener = useOneAtATime();
  const [openFailed, setOpenFailed] = useState<{ id: string; text: string } | null>(null);
  const open = (file: AttachmentFile) =>
    void opener.run(file.id, async () => {
      setOpenFailed(null);
      try {
        await openFile(file, () => getAttachmentUrl({ courseworkId, fileId: file.id, studentUid }).then((r) => r.url));
      } catch (e) {
        setOpenFailed({ id: file.id, text: errorText(e) });
      }
    });

  const list = Object.values(files).sort((a, b) => a.addedAt - b.addedAt);
  return (
    <View testID={`attachments-${target}`}>
      {editable ? (
        <View style={styles.head}>
          <Text style={[inputLook.label, styles.title]}>{list.length ? `Files (${list.length})` : 'Files'}</Text>
          <IconButton testID={`attachments-add-${target}`} icon="attach-file" label="Add files" bare onPress={attach} />
        </View>
      ) : null}
      {list.map((f) => {
        const isOpening = opener.active === f.id;
        const failed = openFailed?.id === f.id ? openFailed.text : null;
        return (
          <View key={f.id} testID={`attachment-${f.name}`} style={styles.row}>
            <Pressable
              testID={`attachment-open-${f.name}`}
              accessibilityRole="link"
              accessibilityLabel={isOpening ? `Opening ${f.name}` : `Open ${f.name}`}
              accessibilityState={{ busy: isOpening }}
              onPress={() => open(f)}
              style={({ pressed }) => [styles.face, pressed ? styles.pressed : null]}
            >
              {isOpening ? (
                // The glyph's own box, so the row does not jump as it starts and stops.
                <ActivityIndicator size="small" color={t.accent.base} style={styles.glyph} />
              ) : (
                <Icon name={glyphFor(f.contentType)} size={20} color={t.text.secondary} style={styles.glyph} />
              )}
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={[styles.meta, failed ? styles.failed : null]}>
                  {isOpening
                    ? 'Opening…'
                    : (failed ??
                      [typeWord(f.name), f.durationSec ? formatClock(f.durationSec * 1000) : null, size(f.sizeBytes)]
                        .filter(Boolean)
                        .join(' · '))}
                </Text>
              </View>
            </Pressable>
            {editable ? (
              <IconButton
                testID={`attachment-remove-${f.name}`}
                icon="delete-outline"
                label={`Remove ${f.name}`}
                variant="danger"
                bare
                busy={removingIds.includes(f.id)}
                onPress={() => (removalWarning ? setAsking(f) : void remove(f.id))}
              />
            ) : null}
          </View>
        );
      })}
      {pending.map((p) => (
        <View key={p.key} style={styles.row}>
          <View style={styles.face}>
            {p.error ? (
              <Icon name="error-outline" size={20} color={t.text.danger} style={styles.glyph} />
            ) : p.waiting ? (
              <Icon name={glyphFor(attachmentContentType(p.name))} size={20} color={t.text.muted} style={styles.glyph} />
            ) : (
              <ActivityIndicator size="small" color={t.accent.base} style={styles.glyph} />
            )}
            <View style={styles.text}>
              <Text style={styles.pendingName} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={[styles.meta, p.error ? styles.failed : null]}>
                {p.error ?? (p.waiting ? 'Waiting to upload…' : 'Uploading…')}
              </Text>
            </View>
          </View>
          {p.error ? (
            <IconButton
              icon="close"
              label={`Dismiss ${p.name}`}
              bare
              onPress={() => setPending((x) => x.filter((y) => y.key !== p.key))}
            />
          ) : null}
        </View>
      ))}
      {error ? <Text style={[styles.meta, styles.failed]}>{error}</Text> : null}
      <Sheet visible={asking !== null} title={`Remove ${asking?.name ?? ''}?`} onClose={() => setAsking(null)} closeLabel="Keep it">
        <Text style={styles.warning}>{removalWarning}</Text>
        <Button
          testID="attachment-remove-confirm"
          label="Remove it"
          variant="danger"
          block
          onPress={() => {
            const file = asking;
            setAsking(null);
            if (file) void remove(file.id);
          }}
        />
      </Sheet>
      <Sheet visible={choosing} title="Where from?" onClose={() => setChoosing(false)} closeLabel="Cancel" closeAt="corner">
        <SheetOption
          testID={`attachments-files-${target}`}
          label="Choose files"
          detail="Documents, pictures or audio"
          onPress={() => from(pickAttachmentFiles)}
        />
        <SheetOption
          testID={`attachments-photo-${target}`}
          label="Take a photo"
          detail="Use the camera now"
          onPress={() => from(takePhoto)}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { marginBottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(1), minHeight: 44 },
  face: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing(2), paddingVertical: spacing(1) },
  pressed: { opacity: 0.6 },
  glyph: { width: 20, height: 20 },
  // minWidth 0: a flex child keeps its content's width on the web unless
  // told it may shrink, and a long name would push the bin off the row.
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, color: t.text.accent, textDecorationLine: 'underline' },
  pendingName: { fontSize: 15, color: t.text.primary },
  meta: { fontSize: 13, color: t.text.secondary },
  failed: { color: t.feedback.danger },
  warning: { fontSize: 15, lineHeight: 22, color: t.text.secondary },
});
