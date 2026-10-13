import { StyleSheet, Text, View } from 'react-native';
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
import { Button, Chips } from './ui';
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
 * Parts move up and down rather than by dragging, which has no web/Android
 * parity. Every action is offered only where the server would allow it, so a
 * button here never exists just to fail: `canRemove` carries who may remove
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
  canRemove: boolean;
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
            <Text style={styles.partHead}>
              {[
                `Part ${index + 1}`,
                segmentStart ? zoomRecordingHours({ startTime: segmentStart, durationSec: longest }) : null,
                longest > 0 ? length(longest) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {items.map((item) => (
              <View key={item.id} testID={`media-item-${item.id}`} style={styles.item}>
                <Text style={styles.label}>{itemLabel(item)}</Text>
                <Text style={[styles.state, item.status === 'failed' ? styles.failed : null]}>
                  {stateText(item)}
                </Text>
                {/* ONE LINE OF SMALL ACTIONS, not a Row of full cells: three
                    150px cells per file stacked into a column a phone had to
                    scroll past for every version of every part. */}
                <View style={styles.actions}>
                  {item.status === 'ready' ? (
                    <Button
                      testID={`media-play-${item.id}`}
                      label="Play"
                      variant="secondary"
                      hug
                      disabled={disabled}
                      onPress={() => onPlay(item.id)}
                    />
                  ) : null}
                  {item.status === 'ready' ? (
                    <Button
                      testID={`media-${item.hidden ? 'show' : 'hide'}-${item.id}`}
                      label={item.hidden ? 'Show' : 'Hide'}
                      variant="quiet"
                      hug
                      disabled={disabled}
                      onPress={() => onEdit({ op: item.hidden ? 'show' : 'hide', itemId: item.id })}
                    />
                  ) : null}
                  {canRemove ? (
                    <Button
                      testID={`media-remove-${item.id}`}
                      label="Remove"
                      variant="quiet"
                      hug
                      disabled={disabled}
                      onPress={() => onRemove(item.id)}
                    />
                  ) : null}
                </View>
              </View>
            ))}
            {parts.length > 1 ? (
              <View style={styles.actions}>
                {index > 0 ? (
                  <Button
                    testID={`media-up-${part}`}
                    label={`Move part ${index + 1} up`}
                    variant="quiet"
                    hug
                    disabled={disabled}
                    onPress={() => onEdit({ op: 'moveUp', part })}
                  />
                ) : null}
                {index < parts.length - 1 ? (
                  <Button
                    testID={`media-down-${part}`}
                    label={`Move part ${index + 1} down`}
                    variant="quiet"
                    hug
                    disabled={disabled}
                    onPress={() => onEdit({ op: 'moveDown', part })}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
      {versions.length > 1 ? (
        <View style={styles.part}>
          <Text style={styles.partHead}>Students start on</Text>
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

const styles = StyleSheet.create({
  list: { marginTop: spacing(2) },
  part: { marginTop: spacing(3) },
  partHead: { fontSize: 14, fontWeight: '700', color: t.text.primary },
  // No indent: at 320px it cost the width two actions need side by side.
  item: { marginTop: spacing(3) },
  label: { fontSize: 14, fontWeight: '600', color: t.text.primary },
  state: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing(1), marginTop: spacing(1) },
  failed: { color: t.feedback.danger },
});
