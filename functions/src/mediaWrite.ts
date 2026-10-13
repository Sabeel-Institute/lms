import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { deriveDurationSec, type MediaItem, type MediaMap, type RecordingDoc } from '@sabeel/shared';

/**
 * Write one item and the derived duration in a transaction that has already
 * read the recording. `null` removes the item.
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
  });
}
