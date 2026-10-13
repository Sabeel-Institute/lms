import { describe, it, expect } from 'vitest';
import type { TokenClaims } from '@sabeel/shared';
import { playbackDenial } from '../../src/playback';

const activeCourse = { effectiveActive: true, archivedAccess: false, managerUids: ['mgr'] };
const archivedClosed = { effectiveActive: false, archivedAccess: false, managerUids: ['mgr'] };
const archivedOpen = { effectiveActive: false, archivedAccess: true, managerUids: ['mgr'] };
const published = { status: 'published' as const };
const ready = { status: 'ready' as const, hidden: false };
const TODAY = '2026-07-25';
/** Excused, deadline still ahead — the only shape that opens a recording. */
const granted = { active: true, dueDate: '2026-07-30' };

const ask = (over: Partial<Parameters<typeof playbackDenial>[0]>) =>
  playbackDenial({
    claims: { role: 'student', status: 'active' } as TokenClaims,
    recording: published,
    item: ready,
    cls: activeCourse,
    uid: 'stu',
    assignment: granted,
    today: TODAY,
    ...over,
  });

describe('students', () => {
  it('may play a published recording they were excused from, before the deadline', () => {
    expect(ask({})).toBeNull();
  });

  it('may NOT play anything unpublished', () => {
    for (const status of ['draft', 'archived', 'unpublished', 'needsAttention'] as const) {
      expect(ask({ recording: { ...published, status } })).toBe('not-published');
    }
  });

  it('may not play a recording they were never granted', () => {
    // Present and absent students have no assignment at all: enrolment on its
    // own opens nothing.
    expect(ask({ assignment: null })).toBe('not-assigned');
  });

  it('may not play once the grant has been withdrawn', () => {
    // Corrected to present, unpublished, or unenrolled — all set active:false.
    expect(ask({ assignment: { ...granted, active: false } })).toBe('not-assigned');
  });

  it('may play right up to the end of the due date, and not after', () => {
    expect(ask({ assignment: { active: true, dueDate: TODAY } })).toBeNull();
    expect(ask({ assignment: { active: true, dueDate: '2026-07-24' } })).toBe('past-due');
  });

  it('may not play from an archived class with listening turned off', () => {
    // The class is still visible in their history — this is about playback only.
    expect(ask({ cls: archivedClosed })).toBe('class-listening-off');
  });

  it('MAY play from an archived class when staff kept listening on', () => {
    expect(ask({ cls: archivedOpen })).toBeNull();
  });

  it('is refused before anything else when the file is missing or not ready', () => {
    // Checked first so a broken recording reports the real problem rather than
    // an access one, which would send staff looking in the wrong place.
    expect(ask({ item: null })).toBe('no-media');
    for (const status of ['uploading', 'copying', 'failed'] as const) {
      expect(ask({ item: { status, hidden: false } })).toBe('no-media');
    }
  });

  it('may NOT play a hidden file, even in a recording they may play', () => {
    expect(ask({ item: { status: 'ready', hidden: true } })).toBe('no-media');
  });
});

describe('staff', () => {
  const manager = { role: 'manager', status: 'active' } as TokenClaims;
  const admin = { role: 'admin', status: 'active' } as TokenClaims;

  it('let a scoped manager play ANY status, so imports can be verified', () => {
    for (const status of ['draft', 'published', 'unpublished', 'needsAttention'] as const) {
      expect(ask({ claims: manager, uid: 'mgr', recording: { ...published, status } })).toBeNull();
    }
  });

  it('do not gate staff on an assignment or a deadline', () => {
    // Staff are never excused from anything, so they never have an assignment.
    // Gating them on one would lock every manager out of their own recordings.
    expect(
      ask({ claims: manager, uid: 'mgr', assignment: null, today: '2099-01-01' }),
    ).toBeNull();
  });

  it('do not let a manager play a class they are not assigned to', () => {
    expect(ask({ claims: manager, uid: 'someone-else' })).toBe('not-your-class');
  });

  it('let an admin play anything', () => {
    expect(ask({ claims: admin, uid: 'admin', cls: archivedClosed })).toBeNull();
  });

  it('do not gate staff on the archived-listening switch', () => {
    // That switch governs STUDENT access. Staff still need to hear an archived
    // class's audio to answer questions about it.
    expect(ask({ claims: manager, uid: 'mgr', cls: archivedClosed })).toBeNull();
  });

  it('still refuses staff when the file is missing', () => {
    expect(ask({ claims: admin, uid: 'admin', recording: { status: 'draft' }, item: null })).toBe('no-media');
  });

  it('lets staff hear a hidden file, to decide what to do with it', () => {
    expect(ask({ claims: admin, uid: 'admin', item: { status: 'ready', hidden: true } })).toBeNull();
  });
});
