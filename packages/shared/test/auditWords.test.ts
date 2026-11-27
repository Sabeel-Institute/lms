import { describe, expect, it } from 'vitest';
import { AUDIT_DETAIL_WORDS, auditIds, describeAuditEntry, type AuditEntryDoc, type CurrentName } from '../src';

/**
 * The audit screen's words for an entry (`describeAuditEntry`).
 *
 * What it promises the staff member reading the log: every thing an entry
 * touched is named in words and NO ID IS EVER PRINTED; a renamed class is
 * found under today's name and still says what it was called; a deleted
 * session is still named; and every detail reads as a phrase, not a field
 * name. Each test asserts on the printed lines.
 */
const ids = ['c1', 'k1', 's1', 'r1', 'w1', 'u1', 'u2', 'i1'];
const entry = (e: Partial<AuditEntryDoc>): AuditEntryDoc => ({
  at: 1,
  actorUid: 'u2',
  actorRole: 'admin',
  action: 'updateSession',
  courseId: 'c1',
  targets: {},
  ...e,
});
const nothing: CurrentName = () => undefined;
const printed = (w: { about: string[]; details: string[] }) => [...w.about, ...w.details].join('\n');
const noIds = (text: string) => {
  for (const id of ids) expect(text, `${id} printed`).not.toMatch(new RegExp(`\\b${id}\\b`));
};

describe('describeAuditEntry', () => {
  it('names everything an entry touched from its names, and prints no id', () => {
    const e = entry({
      action: 'removeRecordingMedia',
      targets: { recordingId: 'r1', sessionId: 's1' },
      detail: { itemId: 'i1' },
      names: { c1: 'Arabic · Hikam', s1: 'Session 9 (2026-11-12)', r1: 'Session 9', i1: 'Part 1, Audio only' },
    });
    const w = describeAuditEntry(e, nothing);
    expect(w.about).toEqual(['Class: Arabic · Hikam', 'Session: Session 9 (2026-11-12)', 'Recording: Session 9']);
    expect(w.details).toEqual(['File: Part 1, Audio only']);
    noIds(printed(w));
  });

  it('says in words what it cannot name, and still prints no id', () => {
    const e = entry({
      action: 'setCourseManagers',
      targets: { courseId: 'c1', sessionId: 's1', studentUid: 'u1' },
      detail: { added: ['u1', 'u2'] },
    });
    const w = describeAuditEntry(e, nothing);
    expect(w.about).toContain('Session: a session no longer in the app');
    expect(w.about).toContain('Class: a class no longer in the app');
    noIds(printed(w));
  });

  it("leads with today's name of a renamed class and keeps the name it had", () => {
    const current: CurrentName = (kind, id) => (kind === 'class' && id === 'c1' ? 'Arabic II · Hikam' : undefined);
    const w = describeAuditEntry(entry({ names: { c1: 'Arabic · Hikam' } }), current);
    expect(w.about).toEqual(['Class: Arabic II · Hikam (then Arabic · Hikam)']);
    // A class with its old name unchanged says it once.
    expect(describeAuditEntry(entry({ names: { c1: 'Arabic II · Hikam' } }), current).about).toEqual(['Class: Arabic II · Hikam']);
  });

  it('keeps the name at the time for a session, even when the screen could know another', () => {
    const current: CurrentName = () => 'something else';
    const w = describeAuditEntry(entry({ targets: { sessionId: 's1' }, names: { s1: 'Week 1 (2026-09-12)' } }), current);
    expect(w.about).toContain('Session: Week 1 (2026-09-12)');
  });

  it("leaves out the class a class's own history is about", () => {
    const w = describeAuditEntry(entry({ targets: { sessionId: 's1' }, names: { c1: 'Arabic', s1: 'Week 1 (2026-09-12)' } }), nothing, 'c1');
    expect(w.about).toEqual(['Session: Week 1 (2026-09-12)']);
  });

  it('says each detail as a phrase', () => {
    const say = (action: string, detail: Record<string, unknown>) =>
      describeAuditEntry(entry({ action, detail, names: { u1: 'Amy' } }), nothing).details;
    expect(say('setEnrollmentActive', { active: false })).toEqual(['Removed from the class']);
    expect(say('setRecordingStatus', { status: 'published' })).toEqual(['Status: Published']);
    expect(say('updateSession', { notRecorded: true, dueDate: '2026-10-21' })).toEqual(['Marked not recorded', 'Listen by: 2026-10-21']);
    expect(say('updateCoursework', { changed: 'dueDate, instructions' })).toEqual(['Changed: due date, instructions']);
    expect(say('editRecordingMedia', { op: 'defaultVersion', version: 'audio' })).toEqual(['Changed what plays first', 'Plays first: Audio only']);
    expect(say('returnWork', { returned: ['u1'], grades: '7/10', retry: false })).toEqual(['Returned to: Amy', 'Grades: 7/10']);
    expect(say('authReject', { reason: 'bad-domain' })).toEqual(['Reason: not an oursabeel.com account']);
  });

  it("does not repeat an assignment's title its target already names", () => {
    const e = entry({ action: 'createCoursework', targets: { courseworkId: 'w1' }, detail: { title: 'Essay', dueDate: '2026-12-01' }, names: { w1: 'Essay' } });
    expect(describeAuditEntry(e, nothing).details).toEqual(['Due: 2026-12-01']);
  });

  it('has a phrase for a key it was never told about, rather than a field name', () => {
    expect(describeAuditEntry(entry({ detail: { someNewThing: 3 } }), nothing).details).toEqual(['Some new thing: 3']);
  });
});

describe('who made the change', () => {
  it('is named from the entry, whether or not the screen has loaded its directory yet', () => {
    const e = entry({ actorUid: 'u2', names: { u2: 'Faisal Shah' } });
    expect(describeAuditEntry(e, nothing).by).toBe('Faisal Shah (admin)');
    expect(describeAuditEntry(e, (kind, id) => (kind === 'person' && id === 'u2' ? 'Faisal Shah' : undefined)).by).toBe('Faisal Shah (admin)');
    expect(describeAuditEntry(entry({ actorRole: 'system', actorUid: 'u2' }), nothing).by).toBe('System');
  });

  it('is not looked up for the system', () => {
    expect(auditIds({ actorUid: 'u9', actorRole: 'system', targets: {} })).toEqual([]);
  });
});

describe('auditIds', () => {
  it('lists who made it, the class, every target and the ids inside the detail, a file with its recording', () => {
    const got = auditIds({
      actorUid: 'u3',
      actorRole: 'admin',
      courseId: 'c1',
      targets: { recordingId: 'r1', uid: 'u1' },
      detail: { itemId: 'i1', added: ['u2'], status: 'x' },
    });
    expect(got).toEqual([
      { kind: 'person', id: 'u3' },
      { kind: 'class', id: 'c1' },
      { kind: 'recording', id: 'r1' },
      { kind: 'person', id: 'u1' },
      { kind: 'file', id: 'i1', recordingId: 'r1' },
      { kind: 'person', id: 'u2' },
    ]);
  });

  it('has words for every detail that holds ids', () => {
    for (const k of ['itemId', 'added', 'removed', 'returned']) expect(Object.hasOwn(AUDIT_DETAIL_WORDS, k)).toBe(true);
  });
});
