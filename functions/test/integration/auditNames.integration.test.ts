import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { COLLECTIONS, EMULATOR_PROJECT_ID, describeAuditEntry, type AuditEntryDoc } from '@sabeel/shared';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { createCohortRecord, renameCohort } from '../../src/cohorts';
import { createCourseRecord } from '../../src/courses';
import { createSession, createSessionRecord, deleteSession } from '../../src/sessions';
import { idTokenFor } from './emulatorToken';

/**
 * What the audit screen will say about a change, from the entry the real
 * callable writes (`auditedCall` → `nameAuditIds`).
 *
 * The promise, in a staff member's words: the log names what was changed in
 * words, a DELETED session included, and a renamed cohort is still shown
 * under the name it had when the change was made. Each test runs the callable
 * through its wrapper and reads the entry back as the screen would, with no
 * names known today (`describeAuditEntry(e, () => undefined)`), so every word
 * on the line came from the entry itself.
 */
beforeAll(() => {
  if (getApps().length === 0) initializeApp({ projectId: EMULATOR_PROJECT_ID });
});

const ADMIN = 'audit-names-admin';
const asAdmin = async (data: unknown) =>
  ({
    auth: { uid: ADMIN, token: { role: 'admin', status: 'active' }, rawToken: await idTokenFor(ADMIN) },
    data,
  }) as unknown as CallableRequest;

let cohortId = '';
let courseId = '';
beforeEach(async () => {
  const db = getFirestore();
  for (const c of [COLLECTIONS.auditLog, COLLECTIONS.cohorts, COLLECTIONS.courses, COLLECTIONS.sessions]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  ({ id: cohortId } = await createCohortRecord(ADMIN, 'Hikam Year 3'));
  ({ id: courseId } = await createCourseRecord(ADMIN, { cohortId, name: 'Arabic' }));
});

async function lastEntry(action: string): Promise<AuditEntryDoc> {
  const snap = await getFirestore().collection(COLLECTIONS.auditLog).where('action', '==', action).get();
  expect(snap.size).toBe(1);
  return snap.docs[0].data() as AuditEntryDoc;
}
const said = (e: AuditEntryDoc) => {
  const w = describeAuditEntry(e, () => undefined);
  return [...w.about, ...w.details];
};

describe('audit entries name what they touched', () => {
  it('names a deleted session as it was, and its class with its cohort', async () => {
    const { id: sessionId } = await createSessionRecord(ADMIN, { courseId, date: '2026-07-06', title: 'Week 1', dueDate: '2099-01-01', notes: '' });
    await deleteSession.run(await asAdmin({ sessionId }));
    const e = await lastEntry('deleteSession');
    expect(said(e)).toEqual(expect.arrayContaining(['Class: Arabic · Hikam Year 3', 'Session: Week 1 (2026-07-06)']));
    expect(said(e).join(' ')).not.toContain(sessionId);
  });

  it('names a session the call created', async () => {
    await createSession.run(await asAdmin({ courseId, date: '2026-07-13', title: 'Week 2', dueDate: '2099-01-01', notes: '' }));
    expect(said(await lastEntry('createSession'))).toContain('Session: Week 2 (2026-07-13)');
  });

  it('keeps the name a cohort had before it was renamed', async () => {
    await renameCohort.run(await asAdmin({ cohortId, name: 'Hikam Year 4' }));
    const e = await lastEntry('renameCohort');
    expect(said(e)).toEqual(['Cohort: Hikam Year 3', 'New name: Hikam Year 4']);
    // And today's name leads once the screen knows it.
    const w = describeAuditEntry(e, (kind) => (kind === 'cohort' ? 'Hikam Year 4' : undefined));
    expect(w.about).toEqual(['Cohort: Hikam Year 4 (then Hikam Year 3)']);
  });
});
