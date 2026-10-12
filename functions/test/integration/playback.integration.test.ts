import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { COLLECTIONS, EMULATOR_PROJECT_ID, assignmentId, audioStoragePath } from '@sabeel/shared';
import { getPlaybackUrl } from '../../src/playback';
import { signGet } from '../../src/mediaStore';
import { idTokenFor } from './emulatorToken';
import { putObject } from './mediaObjects';

/**
 * The one callable that hands out audio, driven end to end.
 *
 * `playback.test.ts` covers `playbackDenial` exhaustively and is the best test
 * in this repo — but it covers a pure function, and nothing drove the callable
 * that consults it. `if (denial) throw` deleted, or moved below the signing
 * call, mints a playing URL for any signed-in account and leaves every unit test
 * green. THE DEADLINE IS ENFORCED HERE AND NOWHERE ELSE — `firestore.rules`
 * deliberately does not know about it — so this callable is the whole of the
 * lock on a closed recording, and the whole of the lock on a classmate's.
 *
 * The URL that comes back is SIGNED, by the same code production runs, against
 * the local media store (SeaweedFS), which checks signatures and expiry the way
 * R2 does. So "gets a URL" here means "gets a URL that plays": every allowed
 * case fetches a byte range of the audio through it.
 */
beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

/** The audio every allowed case must be able to read back through its URL. */
const AUDIO = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

const db = () => getFirestore();
const COURSE = 'course-play';
const RECORDING = 'recording-play';
const STUDENT = 'student-play';
const OTHER_STUDENT = 'student-play-other';
const MANAGER = 'manager-play';

const req = async (uid: string, role: string, status = 'active'): Promise<CallableRequest> =>
  ({
    auth: { uid, token: { role, status }, rawToken: await idTokenFor(uid) },
    data: { recordingId: RECORDING },
  }) as unknown as CallableRequest;

/** Today is well before the deadline unless a test moves the grant's due date. */
const FUTURE = '2099-01-01';
const PAST = '2020-01-01';

async function grant(uid: string, dueDate: string, active = true) {
  await db()
    .collection(COLLECTIONS.assignments)
    .doc(assignmentId(uid, RECORDING))
    .set({
      studentUid: uid,
      recordingId: RECORDING,
      sessionId: 'session-play',
      courseId: COURSE,
      cohortId: 'cohort-play',
      dueDate,
      active,
      assignedAt: 1,
      assignedBy: 'system',
    });
}

beforeEach(async () => {
  const d = db();
  for (const id of [STUDENT, OTHER_STUDENT]) {
    await d.collection(COLLECTIONS.assignments).doc(assignmentId(id, RECORDING)).delete();
  }
  await d.collection(COLLECTIONS.courses).doc(COURSE).set({
    cohortId: 'cohort-play',
    name: 'Playable',
    managerUids: [MANAGER],
    archived: false,
    effectiveActive: true,
    archivedAccess: false,
    createdAt: 1,
    createdBy: 'admin-uid',
  });
  await d.collection(COLLECTIONS.recordings).doc(RECORDING).set({
    sessionId: 'session-play',
    courseId: COURSE,
    cohortId: 'cohort-play',
    title: 'Playable',
    status: 'published',
    source: 'manual',
    audioPath: audioStoragePath(RECORDING),
    durationSec: 60,
    sizeBytes: 16,
    createdAt: 1,
    createdBy: 'admin-uid',
    updatedAt: 1,
  });
  await putObject(audioStoragePath(RECORDING), AUDIO);
});

/** Read bytes 100..199 through a URL, as a player seeking would. */
async function rangeThrough(url: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** null when the caller got a URL that plays; the refusal's message otherwise. */
const denialOf = async (r: CallableRequest): Promise<string | null> => {
  let res: { url: string };
  try {
    res = (await getPlaybackUrl.run(r)) as { url: string };
  } catch (e) {
    return (e as { message?: string }).message ?? 'unknown';
  }
  const got = await rangeThrough(res.url);
  expect(got.status, 'the URL handed out does not play').toBe(206);
  expect(got.bytes).toEqual(AUDIO.slice(100, 200));
  return null;
};

describe('getPlaybackUrl', () => {
  it('gives the excused student their audio', async () => {
    await grant(STUDENT, FUTURE);
    expect(await denialOf(await req(STUDENT, 'student'))).toBeNull();
  });

  /*
   * THE DEADLINE, WHICH LIVES ONLY HERE. The grant is still active and the
   * student still reads the recording's metadata — that is the design, so their
   * Missed card and their listening record survive. The audio is what closes.
   */
  it('refuses the same student once their listen-by date has passed', async () => {
    await grant(STUDENT, PAST);
    expect(await denialOf(await req(STUDENT, 'student'))).toMatch(/due date/i);
  });

  it('refuses a student with no grant, and one whose grant was withdrawn', async () => {
    expect(await denialOf(await req(OTHER_STUDENT, 'student'))).toMatch(/not assigned/i);
    await grant(OTHER_STUDENT, FUTURE, false);
    expect(await denialOf(await req(OTHER_STUDENT, 'student'))).toMatch(/not assigned/i);
  });

  it('refuses a student whose account is not active, grant or no grant', async () => {
    await grant(STUDENT, FUTURE);
    expect(await denialOf(await req(STUDENT, 'student', 'disabled'))).toMatch(/not active/i);
    expect(await denialOf(await req(STUDENT, 'student', 'pending'))).toMatch(/not active/i);
  });

  it('gives the class manager their audio, with no grant of their own', async () => {
    expect(await denialOf(await req(MANAGER, 'manager'))).toBeNull();
  });

  it('refuses a manager who does not run the class', async () => {
    expect(await denialOf(await req('manager-elsewhere', 'manager'))).toMatch(/not assigned to that class/i);
  });

  it('refuses an unauthenticated call', async () => {
    expect(await denialOf({ data: { recordingId: RECORDING } } as CallableRequest)).toMatch(
      /sign in/i,
    );
  });

  it('refuses a recording that does not exist, without leaking whether it might', async () => {
    const r = {
      auth: { uid: STUDENT, token: { role: 'student', status: 'active' }, rawToken: await idTokenFor(STUDENT) },
      data: { recordingId: 'no-such-recording' },
    } as unknown as CallableRequest;
    expect(await denialOf(r)).toMatch(/no such recording/i);
  });

  /*
   * A CLOSED CLASS — the other way access ends, and the one that is not a date.
   *
   * Asserted for the STUDENT only, deliberately. `playbackDenial` checks
   * `canPlayFromCourse` inside the student branch, so a class manager is still
   * served the audio; the app's `canPlayNow` checks it before the staff branch,
   * so the player draws no transport for them. The two disagree, and which is
   * right is a product question rather than a bug with an obvious side: staff
   * needing to hear an archived recording is what makes the student's own
   * message — "ask your teacher if you need access again" — a sentence anyone
   * can act on. Pinning either side here would settle it by accident, in a test,
   * which is how a defect becomes a specification.
   */
  it('refuses a student once their class is archived with listening off', async () => {
    await grant(STUDENT, FUTURE);
    await db()
      .collection(COLLECTIONS.courses)
      .doc(COURSE)
      .update({ archived: true, effectiveActive: false, archivedAccess: false });
    expect(await denialOf(await req(STUDENT, 'student'))).toMatch(/archived/i);
  });
});

/*
 * THE URL ITSELF: what a leaked link is worth. These run the production signing
 * path against a store that enforces signatures, which the Firebase Storage
 * emulator never could.
 */
describe('a playback URL', () => {
  it('stops working when it expires', async () => {
    const { url } = await signGet(audioStoragePath(RECORDING), 1000);
    expect((await rangeThrough(url)).status).toBe(206);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await rangeThrough(url)).status).toBe(403);
  });

  it('opens only the recording it was signed for', async () => {
    await putObject(audioStoragePath('recording-someone-else'), AUDIO);
    const { url } = await signGet(audioStoragePath(RECORDING), 60_000);
    const other = url.replace(RECORDING, 'recording-someone-else');
    expect((await rangeThrough(other)).status).toBe(403);
  });

  it('cannot be used to write', async () => {
    const { url } = await signGet(audioStoragePath(RECORDING), 60_000);
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(8) });
    expect(res.status).toBe(403);
    expect((await rangeThrough(url)).bytes).toEqual(AUDIO.slice(100, 200));
  });
});
