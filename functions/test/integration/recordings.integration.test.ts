import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  type MediaItem,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSessionRecord, deleteSession, updateSession } from '../../src/sessions';
import { idTokenFor } from './emulatorToken';
import { clearPrefix, objectExists, objectInfo, putObject, uploadIsOpen } from './mediaObjects';
import { uploadFile } from './uploadVia';
import { sample } from '../mediaSamples';
import { mediaFixture } from '../mediaFixtures';
import {
  applyDeleteRecording,
  applyMediaEdit,
  applyRecordingStatus,
  removeMedia,
  validateMediaEdit,
  RECORDING_DEPENDENTS,
  applyRecordingDelete,
  createRecordingDraft,
  requireDeleteRights,
  validateCreateRecording,
  validateSetStatus,
} from '../../src/recordings';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';

async function clearAll() {
  const db = getFirestore();
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.sessions, COLLECTIONS.recordings, COLLECTIONS.mediaUploads]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('media/');
}

let courseId = '';
let cohortId = '';
beforeEach(async () => {
  await clearAll();
  ({ id: cohortId } = await createCohortRecord(ADMIN, 'C'));
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'K' }));
});

const rec = async (id: string) =>
  (await getFirestore().collection(COLLECTIONS.recordings).doc(id).get()).data() as RecordingDoc;
const session = async (id: string) =>
  (await getFirestore().collection(COLLECTIONS.sessions).doc(id).get()).data() as SessionDoc;

async function newSession(): Promise<string> {
  const { id } = await createSessionRecord(ADMIN, {
    courseId,
    date: '2026-07-06',
    title: 'Session 1',
    // A REAL DATE. `null` is a session the app cannot produce — `createSession`
    // refuses one, because "a blank one would mean permanent access" — and it
    // only reached the stored document here because the test calls the core
    // rather than the callable that validates. Typechecking the tests is what
    // surfaced it.
    dueDate: '2099-01-01',
    notes: '',
  });
  return id;
}

/** A draft recording under a fresh session. Returns both ids. */
async function newDraft(): Promise<{ id: string; sessionId: string }> {
  const sessionId = await newSession();
  const { id } = await createRecordingDraft(ADMIN, { sessionId });
  return { id, sessionId };
}

/** The recording's items, and its one item when a test has made exactly one. */
const items = async (id: string): Promise<MediaItem[]> => Object.values((await rec(id)).media);
const onlyItem = async (id: string): Promise<MediaItem> => {
  const all = await items(id);
  expect(all).toHaveLength(1);
  return all[0];
};

/**
 * An upload whose parts were sent but never confirmed — what a closed tab
 * leaves. Returns the item id.
 */
async function landed(recordingId: string): Promise<string> {
  return (await uploadFile(ADMIN, recordingId, sample('m4a'), 'audio/mp4', { finalize: false })).itemId;
}

/** A draft with one ready audio file, uploaded the way staff upload one. */
async function ready(): Promise<string> {
  const { id } = await newDraft();
  await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
  return id;
}

const keyOf = async (id: string) => (await onlyItem(id)).storageKey;

describe('createRecordingDraft', () => {
  it('creates a draft with NO media, inherits course/cohort, and links the session', async () => {
    const sessionId = await newSession();
    const { id } = await createRecordingDraft(ADMIN, { sessionId });
    const d = await rec(id);
    expect(d).toMatchObject({ sessionId, courseId, status: 'draft', source: 'manual' });
    // Student-facing display copy is denormalized from the session.
    expect(d).toMatchObject({ title: 'Session 1', date: '2026-07-06', notes: '' });
    expect(d.media).toEqual({}); // nothing until an upload is started
    expect(d.durationSec).toBeNull();
    // EXACT. `toBeTruthy` passed just as happily on `cohortId: session.courseId`
    // — the denormalization it exists to check, copied from the wrong field.
    expect(d.cohortId).toBe(cohortId);
    // The session points back at its recording (0..1).
    expect((await session(sessionId)).recordingId).toBe(id);
  });

  it('rejects an unknown session', async () => {
    await expect(createRecordingDraft(ADMIN, { sessionId: 'nope' })).rejects.toThrow();
  });

  it('refuses a session that already has a recording', async () => {
    const sessionId = await newSession();
    await createRecordingDraft(ADMIN, { sessionId });
    await expect(createRecordingDraft(ADMIN, { sessionId })).rejects.toThrow(/already/i);
  });

  /*
   * "THIS CLASS WAS NOT RECORDED" AND A RECORDING CANNOT BOTH BE TRUE. The flag
   * takes the session off the work queue and out of the morning "attendance
   * still not taken" message; a recording attached underneath it — from a Zoom
   * picker opened before somebody else set the flag — sat in a session those
   * two readers had stopped looking at: a draft nobody was reminded to publish,
   * a register nobody was chased for. The session page's own words: putting
   * audio here is un-marking it, and that is the button it shows. Both
   * directions are refused at the boundary, so the flag and the link never
   * disagree in a stored document.
   */
  it('refuses a session marked as not recorded', async () => {
    const sessionId = await newSession();
    await getFirestore().collection(COLLECTIONS.sessions).doc(sessionId).update({ notRecorded: true });
    await expect(createRecordingDraft(ADMIN, { sessionId })).rejects.toThrow(/not recorded/i);
    expect((await session(sessionId)).recordingId).toBeNull();
  });

  /*
   * A POINTER TO NOTHING IS NOT A RECORDING. `applyDeleteRecording` deletes
   * the document and then clears the session's pointer; a crash between the
   * two — and any recording document deleted by hand — left a session whose
   * `recordingId` names a document that is gone. That session was wedged: a
   * new draft was refused as "already has a recording", and Delete session
   * failed on the cascade's "No such recording". Both paths now read the
   * pointed-at recording inside their own transaction and treat a missing one
   * as no recording at all; the delete clears the pointer in one transaction
   * with the document, so the state is not left behind again.
   */
  it('takes a new draft when the session points at a recording that no longer exists', async () => {
    const sessionId = await newSession();
    await getFirestore().collection(COLLECTIONS.sessions).doc(sessionId).update({ recordingId: 'gone' });
    const { id } = await createRecordingDraft(ADMIN, { sessionId });
    expect((await session(sessionId)).recordingId).toBe(id);
  });

  it('will not let a session that has a recording be marked as not recorded', async () => {
    const { sessionId } = await newDraft();
    const req = {
      auth: { uid: ADMIN, token: { role: 'admin', status: 'active' }, rawToken: await idTokenFor(ADMIN) },
      data: { sessionId, notRecorded: true },
    } as unknown as CallableRequest;
    await expect(updateSession.run(req)).rejects.toThrow(/has a recording/i);
    expect((await session(sessionId)).notRecorded).toBe(false);
    // …and the same call on the session's other fields still goes through, so
    // the refusal is the flag's and not the fixture's.
    await updateSession.run({ ...req, data: { sessionId, title: 'Renamed' } } as CallableRequest);
    expect((await session(sessionId)).title).toBe('Renamed');
  });

  it('lets exactly ONE of two simultaneous drafts through, and links the session to it', async () => {
    /*
     * A double tap on Upload, or a Zoom import racing a manual upload: both
     * read "no recording yet" before either wrote, so the session ended up
     * pointing at one draft while a second sat orphaned — listed in the
     * library, publishable from there, never cascaded by a session delete,
     * its audio billed for good, and its fan-out written against the OTHER
     * recording's grants. One session, one recording, held by a transaction.
     */
    const sessionId = await newSession();
    const outcomes = await Promise.allSettled([
      createRecordingDraft(ADMIN, { sessionId }),
      createRecordingDraft(ADMIN, { sessionId }),
    ]);
    const won = outcomes.filter(
      (o): o is PromiseFulfilledResult<{ id: string }> => o.status === 'fulfilled',
    );
    expect(won).toHaveLength(1);
    expect(String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already/i);
    const drafts = await getFirestore()
      .collection(COLLECTIONS.recordings)
      .where('sessionId', '==', sessionId)
      .get();
    expect(drafts.size).toBe(1);
    expect((await session(sessionId)).recordingId).toBe(won[0].value.id);
  });
});

describe('publishing', () => {
  it('publishes a complete draft and stamps publishedAt', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    const d = await rec(id);
    expect(d.status).toBe('published');
    expect(typeof d.publishedAt).toBe('number');
  });

  it('REFUSES to publish a draft with nothing to play', async () => {
    const { id } = await newDraft();
    await expect(applyRecordingStatus({ recordingId: id, status: 'published' })).rejects.toThrow(
      /media/,
    );
    expect((await rec(id)).status).toBe('draft');
  });

  it('REFUSES to publish while an upload is still unconfirmed', async () => {
    // Nothing staff have not seen settle goes out to students.
    const { id } = await newDraft();
    await landed(id);
    await expect(applyRecordingStatus({ recordingId: id, status: 'published' })).rejects.toThrow(
      /pending/,
    );
    expect((await rec(id)).status).toBe('draft');
  });

  it('refuses a transition the state machine does not draw', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await applyRecordingStatus({ recordingId: id, status: 'unpublished' });
    await expect(applyRecordingStatus({ recordingId: id, status: 'published' })).rejects.toThrow(
      /cannot become/,
    );
    await applyRecordingStatus({ recordingId: id, status: 'draft' });
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    expect((await rec(id)).status).toBe('published');
  });

  it('does not re-stamp publishedAt on a re-publish', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    const first = (await rec(id)).publishedAt;
    await applyRecordingStatus({ recordingId: id, status: 'archived' });
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    expect((await rec(id)).publishedAt).toBe(first);
  });
});

describe('removeMedia', () => {
  it('deletes the object and the item, so a replacement can be uploaded', async () => {
    const id = await ready();
    const { id: itemId, storageKey } = await onlyItem(id);
    await removeMedia(id, itemId);
    expect(await objectExists(storageKey)).toBe(false);
    const d = await rec(id);
    expect(d.media).toEqual({});
    expect(d.durationSec).toBeNull();
  });

  it('REFUSES while the recording is live', async () => {
    const id = await ready();
    const { id: itemId, storageKey } = await onlyItem(id);
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await expect(removeMedia(id, itemId)).rejects.toThrow(/hidden, not removed/);
    expect(await objectExists(storageKey)).toBe(true);
    expect(Object.keys((await rec(id)).media)).toEqual([itemId]);
  });
});

/**
 * A recording of two parts — the first in two versions — as a Zoom import of a
 * class recorded in two stretches leaves it, every file in the bucket.
 */
async function twoParts(): Promise<string> {
  const { id } = await newDraft();
  const media = {
    p1v: mediaFixture(id, 'p1v', { part: 1, version: 'speaker', kind: 'video', durationSec: 3600 }),
    p1a: mediaFixture(id, 'p1a', { part: 1, version: 'audio', durationSec: 3600 }),
    p2a: mediaFixture(id, 'p2a', { part: 2, version: 'audio', durationSec: 600 }),
  };
  for (const item of Object.values(media)) await putObject(item.storageKey, new Uint8Array(16));
  await getFirestore().collection(COLLECTIONS.recordings).doc(id).update({ media, durationSec: 4200 });
  return id;
}

describe('editing a recording’s media', () => {
  const parts = async (id: string) =>
    Object.fromEntries(Object.values((await rec(id)).media).map((i) => [i.id, i.part]));

  it('hides a file from students, keeps it, and shortens the length only when a whole part goes', async () => {
    const id = await twoParts();
    await applyMediaEdit(id, { op: 'hide', itemId: 'p1v' });
    expect((await rec(id)).media.p1v.hidden).toBe(true);
    expect(await objectExists((await rec(id)).media.p1v.storageKey)).toBe(true);
    expect((await rec(id)).durationSec).toBe(4200); // part 1 still has its audio
    await applyMediaEdit(id, { op: 'hide', itemId: 'p2a' });
    expect((await rec(id)).durationSec).toBe(3600);
    await applyMediaEdit(id, { op: 'show', itemId: 'p2a' });
    expect((await rec(id)).durationSec).toBe(4200);
  });

  it('refuses to hide the last file students can play in a published recording, and changes nothing', async () => {
    const id = await twoParts();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await applyMediaEdit(id, { op: 'hide', itemId: 'p1v' });
    await applyMediaEdit(id, { op: 'hide', itemId: 'p1a' });
    await expect(applyMediaEdit(id, { op: 'hide', itemId: 'p2a' })).rejects.toThrow(/Unpublish/);
    expect((await rec(id)).media.p2a.hidden).toBe(false);
  });

  it('moves a part, taking all its versions with it', async () => {
    const id = await twoParts();
    await applyMediaEdit(id, { op: 'moveDown', part: 1 });
    expect(await parts(id)).toEqual({ p1v: 2, p1a: 2, p2a: 1 });
    await applyMediaEdit(id, { op: 'moveUp', part: 2 });
    expect(await parts(id)).toEqual({ p1v: 1, p1a: 1, p2a: 2 });
    await expect(applyMediaEdit(id, { op: 'moveUp', part: 1 })).rejects.toThrow(/cannot move/);
  });

  /*
   * A PLACE IS KEPT BY PART NUMBER, so moving a part moved every student's
   * place into the other stretch of class: paused eleven seconds into the
   * second stretch, a student reopened eleven seconds into the first.
   */
  it('moving a part moves the places saved in it, so each stays in its stretch of class', async () => {
    const id = await twoParts();
    const progress = (uid: string) => getFirestore().collection(COLLECTIONS.listeningProgress).doc(`${uid}_${id}`);
    const row = (part: number | undefined) => ({
      studentUid: 'x', recordingId: id, courseId, positionMs: 11_000, listenedMs: 11_000, updatedAt: 1,
      ...(part === undefined ? {} : { part, version: 'audio' }),
    });
    await progress('in-second').set({ ...row(2), studentUid: 'in-second' });
    // Saved before parts existed: a place in Part 1.
    await progress('before-parts').set({ ...row(undefined), studentUid: 'before-parts' });
    await applyMediaEdit(id, { op: 'moveUp', part: 2 });
    // p2a, the second stretch, is Part 1 now; the first stretch is Part 2.
    expect((await rec(id)).media.p2a.part).toBe(1);
    expect((await progress('in-second').get()).data()).toMatchObject({ part: 1, positionMs: 11_000 });
    expect((await progress('before-parts').get()).data()).toMatchObject({ part: 2, positionMs: 11_000 });
  });

  it('sets the version students start on', async () => {
    const id = await twoParts();
    await applyMediaEdit(id, { op: 'defaultVersion', version: 'speaker' });
    expect((await rec(id)).defaultVersion).toBe('speaker');
  });

  it('validates the edit before reading anything', () => {
    expect(() => validateMediaEdit({ recordingId: 'r', op: 'paint' })).toThrow(/Unknown edit/);
    expect(() => validateMediaEdit({ recordingId: 'r', op: 'hide' })).toThrow(/itemId/);
    expect(() => validateMediaEdit({ recordingId: 'r', op: 'moveUp', part: 0 })).toThrow(/part/);
    expect(() => validateMediaEdit({ recordingId: 'r', op: 'defaultVersion', version: 'hd' })).toThrow(/version/);
  });
});

describe('who may remove a file', () => {
  it('nobody, from a published recording: it is hidden instead, and stays in the bucket', async () => {
    const id = await twoParts();
    const key = (await rec(id)).media.p2a.storageKey;
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await expect(removeMedia(id, 'p2a', true)).rejects.toThrow(/hidden, not removed/);
    expect(await objectExists(key)).toBe(true);
  });

  it('an admin, from an archived recording; a manager may not', async () => {
    const id = await twoParts();
    const key = (await rec(id)).media.p2a.storageKey;
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await applyRecordingStatus({ recordingId: id, status: 'archived' });
    await expect(removeMedia(id, 'p2a', false)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await objectExists(key)).toBe(true);
    await removeMedia(id, 'p2a', true);
    expect(await objectExists(key)).toBe(false);
    expect((await rec(id)).media.p2a).toBeUndefined();
  });

  it('nor a manager, from a recording walked back to draft after it was published', async () => {
    const id = await twoParts();
    const key = (await rec(id)).media.p2a.storageKey;
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await applyRecordingStatus({ recordingId: id, status: 'unpublished' });
    await applyRecordingStatus({ recordingId: id, status: 'draft' });
    await expect(removeMedia(id, 'p2a', false)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await objectExists(key)).toBe(true);
    expect((await rec(id)).media.p2a).toBeDefined();
    await removeMedia(id, 'p2a', true);
    expect(await objectExists(key)).toBe(false);
  });
});

describe('applyDeleteRecording', () => {
  /*
   * THE PRODUCTION LIST, not a copy of it. Retyped here, adding a sixth
   * dependent collection would silently stop this file covering it: `it.each`
   * would skip it, and `depCount` — which counts only what the fixture seeded —
   * would still report a clean cascade while the new collection's rows were left
   * orphaned pointing at a recording that no longer exists.
   */
  const DEPS = RECORDING_DEPENDENTS;
  async function seedDeps(recordingId: string) {
    const db = getFirestore();
    const s = 'stu-1';
    await Promise.all(
      DEPS.map((c) =>
        db.collection(c).doc(`${s}_${recordingId}`).set({ recordingId, studentUid: s, courseId }),
      ),
    );
  }
  async function depCount(recordingId: string) {
    const db = getFirestore();
    const sizes = await Promise.all(
      DEPS.map((c) => db.collection(c).where('recordingId', '==', recordingId).get().then((q) => q.size)),
    );
    return sizes.reduce((a, b) => a + b, 0);
  }
  const recExists = async (id: string) =>
    (await getFirestore().collection(COLLECTIONS.recordings).doc(id).get()).exists;

  it('deletes a session whose recording is already gone, rather than failing on the cascade', async () => {
    const sessionId = await newSession();
    await getFirestore().collection(COLLECTIONS.sessions).doc(sessionId).update({ recordingId: 'gone' });
    const req = {
      auth: { uid: ADMIN, token: { role: 'admin', status: 'active' }, rawToken: await idTokenFor(ADMIN) },
      data: { sessionId },
    } as unknown as CallableRequest;
    await deleteSession.run(req);
    expect((await getFirestore().collection(COLLECTIONS.sessions).doc(sessionId).get()).exists).toBe(false);
  });

  /*
   * NOT TESTED HERE, and said so: `deleteSession` also drops the students'
   * own copies of their marks (`reconcileAttendanceRecords`) before it
   * returns, because `onSessionWritten` — which drops them too — has no retry.
   * Under the emulator that trigger lands before a read issued after the
   * callable answers, so a test of "gone by the time it returns" passed with
   * the callable's cascade deleted (tried, 2026-09-11). The trigger's own
   * behaviour is covered in assignments.integration ("drops every row when the
   * session is deleted"); the callable's copy of it is belt and braces.
   */
  it('cascades: audio, doc, every dependent record, AND clears the session pointer', async () => {
    const sessionId = await newSession();
    const { id } = await createRecordingDraft(ADMIN, { sessionId });
    await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
    const key = await keyOf(id);
    await seedDeps(id);
    expect(await depCount(id)).toBe(DEPS.length);

    await applyDeleteRecording(id);

    expect(await objectExists(key)).toBe(false);
    expect(await recExists(id)).toBe(false);
    expect(await depCount(id)).toBe(0);
    expect((await session(sessionId)).recordingId).toBeNull(); // session freed for a new recording
  });

  /*
   * WHO MAY DESTROY LISTENING HISTORY — asked of the collections, not inferred
   * from the recording's shape.
   *
   * `isEmptyDraft` was the whole gate, and it is a proxy that only holds for a
   * recording that was NEVER published. `published → unpublished → draft` is a
   * legal pair of moves, `removeMedia` accepts a draft, and the recording then
   * looks exactly like one created five minutes ago while a term of assignments
   * and completions still points at it. Four course-scoped calls in a row turned
   * a manager into an admin for the one irreversible act in the product.
   */
  describe('requireDeleteRights', () => {
    const manager = (uid: string) =>
      ({ auth: { uid, token: { role: 'manager', status: 'active' } } }) as never;
    const admin = () =>
      ({ auth: { uid: ADMIN, token: { role: 'admin', status: 'active' } } }) as never;

    /** The manager this course actually names, so only the recording is at issue. */
    async function scopedManager(uid: string) {
      await getFirestore()
        .collection(COLLECTIONS.courses)
        .doc(courseId)
        .update({ managerUids: [uid] });
      return manager(uid);
    }

    it('lets the manager who made an empty draft discard it', async () => {
      const { id } = await newDraft();
      const req = await scopedManager('mgr-1');
      await expect(requireDeleteRights(req, await rec(id), id)).resolves.toBeUndefined();
    });

    /*
     * EVERY COLLECTION, ONE AT A TIME. `seedDeps` writes a row into all five at
     * once, so a test using it proves only that the probe looks at SOME of them
     * — narrowing `hasRecordingHistory` to `[assignments]` would leave a manager
     * able to permanently delete a draft carrying completions, listening
     * progress, events and overrides, with nothing failing.
     */
    /*
     * THE PROMISE: a caller who may not delete leaves every listening record
     * exactly where it was. Driven through `applyRecordingDelete`, which is the
     * gate AND the cascade in the order the callable runs them — asserting the
     * gate alone proves it throws, not that nothing was destroyed, and the order
     * of those two steps is the whole guarantee.
     */
    it.each(DEPS)('refuses a manager, and destroys nothing, once %s exists', async (coll) => {
      const { id } = await newDraft();
      const req = await scopedManager('mgr-1');
      await getFirestore()
        .collection(coll)
        .doc(`stu-1_${id}`)
        .set({ recordingId: id, studentUid: 'stu-1', courseId });

      await expect(applyRecordingDelete(req, id)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      expect(await depCount(id)).toBe(1);
      expect(await recExists(id)).toBe(true);

      // And an admin still may — this is a question of WHO, not of whether.
      await expect(applyRecordingDelete(admin(), id)).resolves.toMatchObject({ recordingId: id });
      expect(await depCount(id)).toBe(0);
      expect(await recExists(id)).toBe(false);
    });

    /*
     * WITHOUT SEEDING ANY DEPENDENT ROW, deliberately: `publishedAt` alone must
     * carry this. With `seedDeps` here, reverting the gate from `isDiscardable`
     * to `isEmptyDraft` still failed on the collection probe, so the test said
     * nothing about the predicate it was written for.
     */
    it('refuses a manager a recording walked back to an empty draft after publishing', async () => {
      const id = await ready();
      await applyRecordingStatus({ recordingId: id, status: 'published' });
      await applyRecordingStatus({ recordingId: id, status: 'unpublished' });
      await applyRecordingStatus({ recordingId: id, status: 'draft' });
      // An admin clears its files for storage: no manager may, once it was published.
      await removeMedia(id, (await onlyItem(id)).id, true);

      const walkedBack = await rec(id);
      // Indistinguishable by shape from a brand-new draft — which is the bug.
      expect(walkedBack.media).toEqual({});
      expect(walkedBack.status).toBe('draft');

      const req = await scopedManager('mgr-1');
      await expect(applyRecordingDelete(req, id)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      expect(await recExists(id)).toBe(true);
    });

    it('refuses a manager an archived recording outright', async () => {
      const id = await ready();
      await applyRecordingStatus({ recordingId: id, status: 'published' });
      await applyRecordingStatus({ recordingId: id, status: 'archived' });
      const req = await scopedManager('mgr-1');
      await expect(requireDeleteRights(req, await rec(id), id)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('refuses a manager scoped to a DIFFERENT class even for an empty draft', async () => {
      const { id } = await newDraft();
      await getFirestore()
        .collection(COLLECTIONS.courses)
        .doc(courseId)
        .update({ managerUids: ['someone-else'] });
      await expect(requireDeleteRights(manager('mgr-1'), await rec(id), id)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    /*
     * A FAILED UPLOAD'S CLEANUP THROWS AWAY ONLY THE EMPTY DRAFT IT MADE. An
     * admin's upload that did not land cleared away the recording it had
     * created, and since an admin may delete anything, a colleague's file
     * added meanwhile went with it: its bytes, its Zoom claim, the session's
     * recording.
     */
    it('the cleanup after a failed upload leaves a recording someone else has added to, even for an admin', async () => {
      const id = await ready();
      await expect(applyRecordingDelete(admin(), id, { ifEmpty: true })).resolves.toMatchObject({ deleted: false });
      expect(await recExists(id)).toBe(true);
      expect((await onlyItem(id)).status).toBe('ready');
    });

    it('and throws away the draft it made when nothing landed on it', async () => {
      const { id } = await newDraft();
      await expect(applyRecordingDelete(admin(), id, { ifEmpty: true })).resolves.toMatchObject({ deleted: true });
      expect(await recExists(id)).toBe(false);
    });
  });

  it('REFUSES a published recording and removes nothing (unpublish/archive first)', async () => {
    const id = await ready();
    const key = await keyOf(id);
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await seedDeps(id);
    await expect(applyDeleteRecording(id)).rejects.toThrow(/publish/i);
    expect(await objectExists(key)).toBe(true);
    expect(await recExists(id)).toBe(true);
    expect(await depCount(id)).toBe(DEPS.length);
  });

  it('deletes an ARCHIVED recording — the space-reclaim path', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await applyRecordingStatus({ recordingId: id, status: 'archived' });
    await applyDeleteRecording(id);
    expect(await recExists(id)).toBe(false);
  });

  it('deletes a draft that never had media', async () => {
    const { id } = await newDraft();
    await applyDeleteRecording(id);
    expect(await recExists(id)).toBe(false);
  });

  // The two round-trips the session screen's recovery paths depend on. Both
  // failed silently before: the UI offered no way back from a recording with no
  // audio, so these are the invariants that keep it out of a dead-end.
  it('stops an upload that was never confirmed, so its parts stop costing storage', async () => {
    // The real failure this guards: the parts land, then the tab closes, so
    // nothing playable points at them. Deleting only ready items would leave
    // them in the bucket until its own one-day rule.
    const { id } = await newDraft();
    const itemId = await landed(id);
    const upload = (await getFirestore().collection(COLLECTIONS.mediaUploads).doc(itemId).get()).data() as {
      storageKey: string;
      uploadId: string;
    };
    expect(await uploadIsOpen(upload.storageKey, upload.uploadId)).toBe(true);

    await applyDeleteRecording(id);
    expect(await uploadIsOpen(upload.storageKey, upload.uploadId)).toBe(false);
  });

  it('discarding an empty draft frees the session for a NEW recording', async () => {
    const { id, sessionId } = await newDraft();
    // A session holds 0..1 recordings, so a stale pointer here would make every
    // later attempt fail with "This session already has a recording".
    await applyDeleteRecording(id);
    expect((await session(sessionId)).recordingId).toBeNull();

    const second = await createRecordingDraft(ADMIN, { sessionId });
    expect(second.id).not.toBe(id);
    expect((await session(sessionId)).recordingId).toBe(second.id);
  });

  it('a file removed from a draft can be replaced on the SAME recording', async () => {
    const { id } = await newDraft();
    const first = await uploadFile(ADMIN, id, sample('m4a'), 'audio/mp4');
    const firstKey = await keyOf(id);

    await removeMedia(id, first.itemId);
    expect((await rec(id)).media).toEqual({});
    expect(await objectExists(firstKey)).toBe(false);

    const second = await uploadFile(ADMIN, id, sample('mp3'), 'audio/mpeg');
    expect(await onlyItem(id)).toMatchObject({ id: second.itemId, status: 'ready', part: 1 });
    expect((await rec(id)).durationSec).toBe(3);
  });

});

describe('the media bucket', () => {
  it('is a private bucket: without a signed URL nothing reads or writes', async () => {
    const id = await ready();
    const key = await keyOf(id);
    const direct = `${process.env.MEDIA_S3_ENDPOINT}/${process.env.MEDIA_BUCKET}/${key}`;
    expect((await fetch(direct)).status).toBe(403);
    expect((await fetch(direct, { method: 'PUT', body: new Uint8Array(4) })).status).toBe(403);
    expect((await objectInfo(key))?.size).toBe(sample('m4a').length);
  });});

describe('validators', () => {
  it('require a session on create', () => {
    for (const bad of [null, {}, { sessionId: '' }]) {
      expect(() => validateCreateRecording(bad)).toThrow();
    }
    expect(validateCreateRecording({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
  });

  it('reject an unknown status', () => {
    expect(() => validateSetStatus({ recordingId: 'r', status: 'live' })).toThrow();
    expect(validateSetStatus({ recordingId: 'r', status: 'archived' }).status).toBe('archived');
  });


});
