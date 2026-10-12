import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  EMULATOR_PROJECT_ID,
  audioStoragePath,
  type RecordingDoc,
  type SessionDoc,
} from '@sabeel/shared';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { createCohortRecord } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSessionRecord, deleteSession, updateSession } from '../../src/sessions';
import { idTokenFor } from './emulatorToken';
import { clearPrefix, objectExists, objectInfo, putObject } from './mediaObjects';
import {
  MAX_AUDIO_BYTES,
  applyDeleteRecording,
  applyRecordingStatus,
  clearAudio,
  RECORDING_DEPENDENTS,
  applyRecordingDelete,
  createRecordingDraft,
  finalizeRecording,
  requireDeleteRights,
  startRecordingUpload,
  startUpload,
  validateStartUpload,
  validateCreateRecording,
  validateFinalize,
  validateSetStatus,
} from '../../src/recordings';

beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'admin-uid';

async function clearAll() {
  const db = getFirestore();
  for (const c of [COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.sessions, COLLECTIONS.recordings]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await clearPrefix('recordings/');
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

async function putAudio(recordingId: string, bytes = 2048) {
  await putObject(audioStoragePath(recordingId), new Uint8Array(bytes));
}

async function ready(): Promise<string> {
  const { id } = await newDraft();
  await putAudio(id);
  await finalizeRecording({ recordingId: id, durationSec: 60 });
  return id;
}

describe('createRecordingDraft', () => {
  it('creates a draft with NO audio, inherits course/cohort, and links the session', async () => {
    const sessionId = await newSession();
    const { id, audioPath } = await createRecordingDraft(ADMIN, { sessionId });
    const d = await rec(id);
    expect(d).toMatchObject({ sessionId, courseId, status: 'draft', source: 'manual' });
    // Student-facing display copy is denormalized from the session.
    expect(d).toMatchObject({ title: 'Session 1', date: '2026-07-06', notes: '' });
    expect(d.audioPath).toBeNull(); // stays null until the upload is CONFIRMED
    // EXACT. `toBeTruthy` passed just as happily on `cohortId: session.courseId`
    // — the denormalization it exists to check, copied from the wrong field.
    expect(d.cohortId).toBe(cohortId);
    expect(audioPath).toBe(audioStoragePath(id));
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
      (o): o is PromiseFulfilledResult<{ id: string; audioPath: string }> => o.status === 'fulfilled',
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

describe('finalizeRecording', () => {
  it('reads size from the media store rather than trusting the client', async () => {
    const { id } = await newDraft();
    await putAudio(id, 4096);
    const res = await finalizeRecording({ recordingId: id, durationSec: 720 });
    expect(res.sizeBytes).toBe(4096);
    const d = await rec(id);
    expect(d.audioPath).toBe(audioStoragePath(id));
    expect(d.durationSec).toBe(720);
  });

  it('refuses when no audio actually landed', async () => {
    const { id } = await newDraft();
    await expect(finalizeRecording({ recordingId: id, durationSec: 1 })).rejects.toThrow(/No audio/);
    expect((await rec(id)).audioPath).toBeNull();
  });

  it('accepts a null duration', async () => {
    const { id } = await newDraft();
    await putAudio(id);
    await finalizeRecording({ recordingId: id, durationSec: null });
    expect((await rec(id)).durationSec).toBeNull();
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

  it('REFUSES to publish a draft with no audio', async () => {
    const { id } = await newDraft();
    await expect(applyRecordingStatus({ recordingId: id, status: 'published' })).rejects.toThrow(
      /audio/,
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

describe('clearAudio', () => {
  it('deletes the object so a replacement can be uploaded', async () => {
    const id = await ready();
    await clearAudio(id);
    expect(await objectExists(audioStoragePath(id))).toBe(false);
    const d = await rec(id);
    expect(d.audioPath).toBeNull();
    expect(d.sizeBytes).toBeNull();
  });

  it('REFUSES while the recording is live', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await expect(clearAudio(id)).rejects.toThrow(/draft/i);
    expect(await objectExists(audioStoragePath(id))).toBe(true);
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
  const audioExists = (id: string) => objectExists(audioStoragePath(id));

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
    await putAudio(id);
    await finalizeRecording({ recordingId: id, durationSec: 5 });
    await seedDeps(id);
    expect(await depCount(id)).toBe(DEPS.length);

    await applyDeleteRecording(id);

    expect(await audioExists(id)).toBe(false);
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
   * legal pair of moves, `clearAudio` accepts a draft, and the recording then
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
      await clearAudio(id);

      const walkedBack = await rec(id);
      // Indistinguishable by shape from a brand-new draft — which is the bug.
      expect(walkedBack.audioPath).toBeNull();
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
  });

  it('REFUSES a published recording and removes nothing (unpublish/archive first)', async () => {
    const id = await ready();
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await seedDeps(id);
    await expect(applyDeleteRecording(id)).rejects.toThrow(/publish/i);
    expect(await audioExists(id)).toBe(true);
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

  it('deletes a draft that never had audio', async () => {
    const { id } = await newDraft();
    await applyDeleteRecording(id);
    expect(await recExists(id)).toBe(false);
  });

  // The two round-trips the session screen's recovery paths depend on. Both
  // failed silently before: the UI offered no way back from a recording with no
  // audio, so these are the invariants that keep it out of a dead-end.
  it('deletes audio that landed but never finalized (audioPath still null)', async () => {
    // The real failure this guards: the bytes land, then finalize fails,
    // so the doc's audioPath is still null. Deleting only what the field points at
    // would leave those bytes orphaned and billable forever.
    const { id } = await newDraft();
    await putAudio(id);
    expect((await rec(id)).audioPath).toBeNull(); // never finalized
    expect(await audioExists(id)).toBe(true);

    await applyDeleteRecording(id);
    expect(await audioExists(id)).toBe(false);
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

  it('audio removed from a draft can be re-uploaded onto the SAME recording', async () => {
    // clearAudio exists "so it can be re-uploaded" — the upload URL is
    // write-once, so this only works because clearAudio deletes it first.
    const { id } = await newDraft();
    await putAudio(id);
    await finalizeRecording({ recordingId: id, durationSec: 5 });
    expect((await rec(id)).audioPath).not.toBeNull();

    await clearAudio(id);
    expect((await rec(id)).audioPath).toBeNull();
    expect(await audioExists(id)).toBe(false);

    await putAudio(id);
    await finalizeRecording({ recordingId: id, durationSec: 7 });
    const after = await rec(id);
    expect(after.audioPath).toBe(audioStoragePath(id));
    expect(after.durationSec).toBe(7);
  });
});

/*
 * THE UPLOAD PATH: staff's browser or phone PUTs the audio straight into the
 * bucket on a URL `startUpload` signed. The promises are the ones the bucket
 * rule used to keep, now kept by the URL and the server together: audio lands
 * on a draft once and only once, only as audio, and a file over the cap does
 * not stay.
 */
describe('uploading audio', () => {
  const AUDIO = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
  const send = (
    put: { url: string; headers: Record<string, string> },
    body: Uint8Array,
    headers = put.headers,
  ) => fetch(put.url, { method: 'PUT', headers, body });

  it('stores the audio a draft is given, and finalize records it', async () => {
    const { id } = await newDraft();
    const put = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: AUDIO.length });
    expect((await send(put, AUDIO)).status).toBe(200);
    await finalizeRecording({ recordingId: id, durationSec: 60 });
    expect(await rec(id)).toMatchObject({ audioPath: audioStoragePath(id), sizeBytes: AUDIO.length });
  });

  it('writes once: the same URL cannot replace what it stored', async () => {
    const { id } = await newDraft();
    const put = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: AUDIO.length });
    expect((await send(put, AUDIO)).status).toBe(200);
    const before = await objectInfo(audioStoragePath(id));
    expect((await send(put, new Uint8Array(10))).status).toBe(412);
    expect(await objectInfo(audioStoragePath(id))).toEqual(before);
  });

  it('refuses a different content type, or a PUT that drops the write-once condition', async () => {
    const { id } = await newDraft();
    const put = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: AUDIO.length });
    expect((await send(put, AUDIO, { ...put.headers, 'Content-Type': 'video/mp4' })).status).toBe(403);
    expect((await send(put, AUDIO, { 'Content-Type': 'audio/mp4' })).status).toBe(403);
    expect(await objectExists(audioStoragePath(id))).toBe(false);
  });

  it('gives no URL for a recording that has its audio, or one students can hear', async () => {
    const id = await ready();
    const stored = await objectInfo(audioStoragePath(id));
    await expect(startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: 10 })).rejects.toThrow(
      /already has audio/,
    );
    await applyRecordingStatus({ recordingId: id, status: 'published' });
    await expect(startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: 10 })).rejects.toThrow(
      /draft/,
    );
    expect(await objectInfo(audioStoragePath(id))).toEqual(stored);
  });

  it('clears an upload that landed but was never finalized, so a retry can land', async () => {
    const { id } = await newDraft();
    const first = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: AUDIO.length });
    expect((await send(first, AUDIO)).status).toBe(200);
    // Finalize never happened (the tab closed); the person tries again.
    const second = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: 10 });
    expect((await send(second, new Uint8Array(10))).status).toBe(200);
    await finalizeRecording({ recordingId: id, durationSec: 1 });
    expect((await rec(id)).sizeBytes).toBe(10);
  });

  it('deletes and refuses a file over the cap that the URL could not stop', async () => {
    // The URL signs the type, not the size, so a client can send more than it
    // declared. Finalize is where that is caught, and the file goes.
    const { id } = await newDraft();
    const put = await startUpload({ recordingId: id, contentType: 'audio/mp4', sizeBytes: 1000 });
    expect((await send(put, new Uint8Array(MAX_AUDIO_BYTES + 1))).status).toBe(200);
    await expect(finalizeRecording({ recordingId: id, durationSec: 1 })).rejects.toThrow(/too large/);
    expect(await objectExists(audioStoragePath(id))).toBe(false);
    expect((await rec(id)).audioPath).toBeNull();
  });

  it('gives a student no upload URL at all', async () => {
    const { id } = await newDraft();
    const asStudent = {
      auth: { uid: 'stu-1', token: { role: 'student', status: 'active' }, rawToken: await idTokenFor('stu-1') },
      data: { recordingId: id, contentType: 'audio/mp4', sizeBytes: 10 },
    } as unknown as CallableRequest;
    await expect(startRecordingUpload.run(asStudent)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('is a private bucket: without a signed URL nothing reads or writes', async () => {
    const id = await ready();
    const direct = `${process.env.MEDIA_S3_ENDPOINT}/${process.env.MEDIA_BUCKET}/${audioStoragePath(id)}`;
    expect((await fetch(direct)).status).toBe(403);
    expect((await fetch(direct, { method: 'PUT', body: new Uint8Array(4) })).status).toBe(403);
    expect((await objectInfo(audioStoragePath(id)))?.size).toBe(2048);
  });

  it('refuses anything but audio, and a declared size over the cap, before signing', () => {
    expect(() => validateStartUpload({ recordingId: 'r', contentType: 'video/mp4', sizeBytes: 10 })).toThrow(
      /audio/,
    );
    expect(() =>
      validateStartUpload({ recordingId: 'r', contentType: 'audio/mp4', sizeBytes: MAX_AUDIO_BYTES + 1 }),
    ).toThrow(/too large/);
    expect(validateStartUpload({ recordingId: 'r', contentType: 'audio/x-m4a', sizeBytes: 10 })).toEqual({
      recordingId: 'r',
      contentType: 'audio/x-m4a',
      sizeBytes: 10,
    });
  });
});

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

  it('reject a nonsensical duration', () => {
    for (const bad of [0, -5, 'ten', NaN]) {
      expect(() => validateFinalize({ recordingId: 'r', durationSec: bad })).toThrow();
    }
    expect(validateFinalize({ recordingId: 'r', durationSec: null }).durationSec).toBeNull();
  });
});
