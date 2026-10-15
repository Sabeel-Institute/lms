import { doc, setDoc } from 'firebase/firestore';
import { COLLECTIONS, progressId, type BookmarkDoc } from '@sabeel/shared';
import { db } from './firebase';
import { useLiveDocState } from './liveQuery';
import { read } from './documents';
import { captureError } from './sentry';

/**
 * A student's bookmark in one recording, LIVE: one set on the phone is
 * offered on the laptop already open on it. The place each device keeps
 * (`placeStore.ts`) stays on that device; the bookmark is how a student
 * takes their place to another one, on purpose.
 */
export function useMyBookmark(studentUid: string | null, recordingId: string): BookmarkDoc | null {
  return useLiveDocState<BookmarkDoc | null>(
    () => (studentUid ? doc(db, COLLECTIONS.bookmarks, progressId(studentUid, recordingId)) : null),
    [studentUid, recordingId],
    { label: 'myBookmark', map: (snap) => read('bookmarks', snap), empty: null },
  ).value;
}

/**
 * Set the bookmark, over the last one. Not awaited: the write resolves when
 * the server has it, which offline is whenever the connection comes back,
 * while the bookmark shows at once from the device's own copy.
 */
export function setBookmark(bookmark: BookmarkDoc): void {
  setDoc(doc(db, COLLECTIONS.bookmarks, progressId(bookmark.studentUid, bookmark.recordingId)), bookmark).catch(
    (e: unknown) => captureError(e, { source: 'setBookmark' }),
  );
}
