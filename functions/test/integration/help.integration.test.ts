import { describe, it, beforeAll, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { EMULATOR_PROJECT_ID, helpVideoKey } from '@sabeel/shared';
import { getHelpVideoUrl } from '../../src/help';
import { idTokenFor } from './emulatorToken';
import { putObject } from './mediaObjects';

/**
 * A STUDENT WATCHES THE STUDENTS' FILMS AND NO OTHERS; STAFF WATCH EVERY FILM,
 * the students' included, so a teacher can help a student through one. Driven
 * through the callable, which signs against the local media store as
 * production signs against R2, so "gets a link" means "gets a link that plays".
 */
beforeAll(async () => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
  for (const [id, variant] of [
    ['student-to-do', 'phone'],
    ['staff-today', 'computer'],
    ['admin-audit', 'phone'],
  ] as const) {
    await putObject(helpVideoKey(id, variant, 'video'), FILM);
  }
});

/** The film every allowed case must be able to read back through its link. */
const FILM = Uint8Array.from({ length: 2048 }, (_, i) => (i * 7) % 253);

const req = async (role: string | undefined, data: unknown, status = 'active'): Promise<CallableRequest> =>
  ({
    auth: { uid: `help-${role}`, token: { role, status }, rawToken: await idTokenFor(`help-${role}`) },
    data,
  }) as unknown as CallableRequest;

/** null when the caller got a link that plays the film; the refusal's message otherwise. */
async function denialOf(r: CallableRequest): Promise<string | null> {
  let res: { video: { url: string } };
  try {
    res = (await getHelpVideoUrl.run(r)) as { video: { url: string } };
  } catch (e) {
    return (e as { message?: string }).message ?? 'unknown';
  }
  const got = await fetch(res.video.url, { headers: { Range: 'bytes=10-109' } });
  expect(got.status, 'the link handed out does not play').toBe(206);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(FILM.slice(10, 110));
  return null;
}

describe('getHelpVideoUrl', () => {
  it('gives a student the students’ films, and not the teachers’ or the administrators’', async () => {
    expect(await denialOf(await req('student', { id: 'student-to-do', variant: 'phone' }))).toBeNull();
    expect(await denialOf(await req('student', { id: 'staff-today', variant: 'computer' }))).toMatch(/not open to you/);
    expect(await denialOf(await req('student', { id: 'admin-audit', variant: 'phone' }))).toMatch(/not open to you/);
  });

  it('gives a manager every film: the teachers’, the students’ and the administrators’', async () => {
    expect(await denialOf(await req('manager', { id: 'staff-today', variant: 'computer' }))).toBeNull();
    expect(await denialOf(await req('manager', { id: 'student-to-do', variant: 'phone' }))).toBeNull();
    expect(await denialOf(await req('manager', { id: 'admin-audit', variant: 'phone' }))).toBeNull();
  });

  it('gives an admin every film: the teachers’, the students’ and the administrators’', async () => {
    expect(await denialOf(await req('admin', { id: 'staff-today', variant: 'computer' }))).toBeNull();
    expect(await denialOf(await req('admin', { id: 'student-to-do', variant: 'phone' }))).toBeNull();
    expect(await denialOf(await req('admin', { id: 'admin-audit', variant: 'phone' }))).toBeNull();
  });

  it('signs nothing for a film that is not in the list, or a cut that does not exist', async () => {
    expect(await denialOf(await req('admin', { id: 'secret-recording', variant: 'phone' }))).toMatch(/no such help film/);
    expect(await denialOf(await req('admin', { id: 'staff-today', variant: 'tablet' }))).toMatch(/variant/);
  });

  it('signs nothing for an account that is not active, or a sign-in with no role', async () => {
    expect(await denialOf(await req('student', { id: 'student-to-do', variant: 'phone' }, 'disabled'))).toMatch(/not active/);
    expect(await denialOf(await req(undefined, { id: 'student-to-do', variant: 'phone' }))).toMatch(/not open to you/);
  });
});
