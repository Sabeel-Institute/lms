import type { DocumentData, DocumentSnapshot, QueryDocumentSnapshot } from 'firebase/firestore';
import { storedDoc, type StoredCollection, type StoredDocs } from '@sabeel/shared';

/*
 * THE WAY THE APP READS A DOCUMENT: typed by the collection it comes from, the
 * one place its data becomes a type. ESLint allows `.data() as` nowhere in the
 * app, so a document cannot be read as the wrong type, and the fields each
 * type requires are the ones `npm run check:documents` holds the live data to
 * (`documentShapes` in @sabeel/shared). Old data is migrated, not read around.
 */

/** A document from a query, or one known to exist. */
export function read<C extends StoredCollection>(collection: C, snap: QueryDocumentSnapshot<DocumentData>): StoredDocs[C] {
  return storedDoc(collection, snap.data());
}

/** A document that may not exist; undefined if it does not. */
export function readIfExists<C extends StoredCollection>(
  collection: C,
  snap: DocumentSnapshot<DocumentData>,
): StoredDocs[C] | undefined {
  const data = snap.data();
  return data === undefined ? undefined : storedDoc(collection, data);
}
