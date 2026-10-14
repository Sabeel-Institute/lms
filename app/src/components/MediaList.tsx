import { Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  VERSION_LABELS,
  VERSION_ORDER,
  isPlayable,
  itemLabel,
  mediaParts,
  zoomRecordingHours,
  type MediaEdit,
  type MediaItem,
  type MediaVersion,
  type RecordingDoc,
} from '@sabeel/shared';
import { Chips, IconButton } from './ui';
import { getTheme, spacing } from '../theme';

const t = getTheme();

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}\u00a0MB`;
const length = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

/** Where a file is, in words a member of staff can act on. */
function stateText(item: MediaItem): string {
  switch (item.status) {
    case 'ready':
      return [item.hidden ? 'hidden from students' : null, item.sizeBytes ? mb(item.sizeBytes) : null]
        .filter(Boolean)
        .join(' · ');
    case 'copying':
      return 'copying from Zoom…';
    case 'uploading':
      return 'upload not finished';
    case 'failed':
      return item.failReason ?? 'failed';
  }
}

/**
 * A recording's files, as staff manage them: its parts in play order, each
 * with its versions, what state each file is in, and what may be done to it.
 *
 * ROWS LIKE AN ASSIGNMENT'S FILES: the name is the link that plays it, and
 * hiding and removing are small icons at the end of its row. Three buttons
 * under every version of every part made a two-part recording a column a phone
 * scrolled past.
 *
 * Parts move up and down rather than by dragging, which has no web/Android
 * parity. Every action is offered only where the server would allow it, so a
 * control here never exists just to fail: `canRemove` carries who may remove
 * what, and hiding is offered on every ready file because it is reversible
 * and changes no file.
 */
export function MediaList({
  recording: r,
  disabled,
  canRemove,
  onPlay,
  onEdit,
  onRemove,
}: {
  recording: RecordingDoc & { id: string };
  /** True while anything on the card is in flight. */
  disabled: boolean;
  /** Whether this file may be removed, as the server decides it. */
  canRemove: (item: MediaItem) => boolean;
  onPlay: (itemId: string) => void;
  onEdit: (edit: MediaEdit) => void;
  onRemove: (itemId: string) => void;
}) {
  const parts = mediaParts(Object.values(r.media));
  if (parts.length === 0) return null;
  const playable = new Set(Object.values(r.media).filter(isPlayable).map((i) => i.version));
  const versions = VERSION_ORDER.filter((v) => playable.has(v));
  return (
    <View testID="recording-media" style={styles.list}>
      {parts.map(({ part, items }, index) => {
        const segmentStart = items.find((i) => i.zoom?.segmentStart)?.zoom?.segmentStart ?? null;
        const longest = Math.max(0, ...items.map((i) => i.durationSec ?? 0));
        return (
          <View key={part} testID={`media-part-${part}`} style={styles.part}>
            <View style={styles.partHead}>
              <Text style={styles.partTitle}>
                {[
                  `Part ${index + 1}`,
                  segmentStart ? zoomRecordingHours({ startTime: segmentStart, durationSec: longest }) : null,
                  longest > 0 ? length(longest) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {index > 0 ? (
                <IconButton
                  testID={`media-up-${part}`}
                  icon="arrow-upward"
                  bare
                  label={`Move part ${index + 1} up`}
                  disabled={disabled}
                  onPress={() => onEdit({ op: 'moveUp', part })}
                />
              ) : null}
              {index < parts.length - 1 ? (
                <IconButton
                  testID={`media-down-${part}`}
                  icon="arrow-downward"
                  bare
                  label={`Move part ${index + 1} down`}
                  disabled={disabled}
                  onPress={() => onEdit({ op: 'moveDown', part })}
                />
              ) : null}
            </View>
            {items.map((item) => (
              <FileRow
                key={item.id}
                item={item}
                disabled={disabled}
                removable={canRemove(item)}
                onPlay={() => onPlay(item.id)}
                onEdit={onEdit}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </View>
        );
      })}
      {versions.length > 1 ? (
        <View style={styles.part}>
          <Text style={styles.partTitle}>Students start on</Text>
          <Chips<MediaVersion>
            value={r.defaultVersion}
            testIdPrefix="media-default"
            options={versions.map((v) => ({ value: v, label: VERSION_LABELS[v] }))}
            onChange={(version) => onEdit({ op: 'defaultVersion', version })}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One file: a link that plays it once it is ready, plain words until then. */
function FileRow({
  item,
  disabled,
  removable,
  onPlay,
  onEdit,
  onRemove,
}: {
  item: MediaItem;
  disabled: boolean;
  removable: boolean;
  onPlay: () => void;
  onEdit: (edit: MediaEdit) => void;
  onRemove: () => void;
}) {
  const label = itemLabel(item);
  const ready = item.status === 'ready';
  const face = (
    <>
      <MaterialIcons
        name={item.kind === 'video' ? 'videocam' : 'audiotrack'}
        size={20}
        color={ready ? t.text.secondary : t.text.muted}
      />
      <View style={styles.text}>
        <Text style={ready ? styles.link : styles.name}>{label}</Text>
        <Text style={[styles.state, item.status === 'failed' ? styles.failed : null]}>{stateText(item)}</Text>
      </View>
    </>
  );
  return (
    <View testID={`media-item-${item.id}`} style={styles.row}>
      {ready ? (
        <Pressable
          testID={`media-play-${item.id}`}
          accessibilityRole="link"
          accessibilityLabel={`Play ${label}`}
          disabled={disabled}
          onPress={onPlay}
          style={({ pressed }) => [styles.face, pressed ? styles.pressed : null, disabled ? styles.off : null]}
        >
          {face}
        </Pressable>
      ) : (
        <View style={styles.face}>{face}</View>
      )}
      {ready ? (
        <IconButton
          testID={`media-${item.hidden ? 'show' : 'hide'}-${item.id}`}
          icon={item.hidden ? 'visibility' : 'visibility-off'}
          bare
          label={item.hidden ? `Show ${label} to students` : `Hide ${label} from students`}
          disabled={disabled}
          onPress={() => onEdit({ op: item.hidden ? 'show' : 'hide', itemId: item.id })}
        />
      ) : null}
      {removable ? (
        <IconButton
          testID={`media-remove-${item.id}`}
          icon="delete-outline"
          variant="danger"
          bare
          label={`Remove ${label}`}
          disabled={disabled}
          onPress={onRemove}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: spacing(1) },
  part: { marginTop: spacing(3) },
  partHead: { flexDirection: 'row', alignItems: 'center', gap: spacing(1), minHeight: 44 },
  partTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: t.text.primary },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(1), minHeight: 44 },
  face: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing(2), paddingVertical: spacing(1) },
  pressed: { opacity: 0.6 },
  off: { opacity: 0.5 },
  // minWidth 0: a flex child keeps its content's width on the web unless told
  // it may shrink, and a long label would push the icons off the row.
  text: { flex: 1, minWidth: 0 },
  link: { fontSize: 15, color: t.text.accent, textDecorationLine: 'underline' },
  name: { fontSize: 15, color: t.text.primary },
  state: { fontSize: 13, color: t.text.secondary },
  failed: { color: t.feedback.danger },
});
