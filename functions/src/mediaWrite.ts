import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { deriveDurationSec, type MediaItem, type MediaMap, type RecordingDoc } from '@sabeel/shared';

/**
 * Write one item, the derived duration and the settled status in a
 * transaction that has already read the recording. `null` removes the item.
 */
export function writeItem(
  tx: Transaction,
  ref: DocumentReference,
  rec: RecordingDoc,
  itemId: string,
  item: MediaItem | null,
): void {
  const media: MediaMap = { ...rec.media };
  if (item) media[itemId] = item;
  else delete media[itemId];
  tx.update(ref, {
    [`media.${itemId}`]: item ?? FieldValue.delete(),
    durationSec: deriveDurationSec(media),
    updatedAt: Date.now(),
    ...settledStatus(rec, media),
  });
}

/**
 * A recording not yet out, settled by what it now holds: it needs attention
 * when every file it holds failed, and stops needing it once none has. A
 * recording that is out keeps its status; its failed files show on the
 * session page. Asked on EVERY change to the files: asked on the Zoom paths
 * alone, a failed import whose file was removed and uploaded instead, as the
 * session page advises, left the recording needing attention, with nothing
 * failed and no way to publish it.
 */
function settledStatus(rec: RecordingDoc, media: MediaMap): Record<string, unknown> {
  if (rec.status !== 'draft' && rec.status !== 'needsAttention') return {};
  const items = Object.values(media);
  const failed = items.filter((i) => i.status === 'failed');
  if (items.length > 0 && failed.length === items.length) {
    return { status: 'needsAttention', attentionReason: failed[0].failReason ?? 'Zoom import failed.' };
  }
  if (rec.status === 'needsAttention' && failed.length === 0) {
    return { status: 'draft', attentionReason: FieldValue.delete() };
  }
  return {};
}
