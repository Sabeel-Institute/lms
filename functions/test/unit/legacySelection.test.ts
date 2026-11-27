import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

/**
 * Which part of the live app the switchover seed copies, and which part of
 * this project survives its wipe (`scripts/lib/legacy-selection.mjs`).
 *
 * What it promises the institute, in their words:
 *  - the chosen cohorts arrive whole, and nothing of the others does;
 *  - a student left out is gone everywhere, registers included, while the
 *    sessions they sat in arrive with everyone else's marks;
 *  - a duplicate account's classes and marks arrive on the account its owner
 *    uses, and the duplicate itself does not;
 *  - a test session, or a broken recording, does not arrive, and a session
 *    whose recording is dropped still arrives with its register;
 *  - nothing that arrives points at something that did not;
 *  - the App Review class and the kept test accounts survive the wipe, but
 *    not those accounts' work in classes that go.
 * Each test drives the selection over REST documents shaped as the seed
 * builds them and asserts on what would be WRITTEN.
 */
const REPO = resolve(import.meta.dirname, '../../..');
type Fields = Record<string, unknown>;
type Doc = { rel: string; fields: Fields };
type Plan = Record<string, unknown>;
const sel = (await import(resolve(REPO, 'scripts/lib/legacy-selection.mjs'))) as {
  parsePlan: (raw: unknown) => Plan;
  selectFromLegacy: (
    docs: Doc[],
    accounts: { localId: string }[],
    plan: Plan,
  ) => { writes: Doc[]; uids: Set<string>; report: { marksRemoved: Map<string, number>; notEnrolled: string[] } };
  keptHere: (
    docs: Doc[],
    accounts: { localId: string }[],
    plan: Plan,
  ) => { docs: Doc[]; accounts: Set<string>; keepsObject: (key: string) => boolean };
};
const { encodeValue } = (await import(resolve(REPO, 'scripts/lib/firestore-rest.mjs'))) as {
  encodeValue: (v: unknown) => { mapValue: { fields: Fields } };
};
const doc = (rel: string, data: Record<string, unknown>): Doc => ({ rel, fields: encodeValue(data).mapValue.fields });

/*
 * A live app with the shapes that matter: two cohorts (one copied), a staff
 * member, students who stay, one left out, one duplicate of another, and one
 * only in the cohort that is not copied.
 */
function liveApp() {
  const docs: Doc[] = [
    doc('cohorts/keep', { name: 'Hikam' }),
    doc('cohorts/drop', { name: 'TEST' }),
    doc('courses/c1', { cohortId: 'keep', name: 'Arabic', managerUids: ['staff1'] }),
    doc('courses/c2', { cohortId: 'keep', name: 'Fiqh', managerUids: ['staff1'] }),
    doc('courses/c9', { cohortId: 'drop', name: 'Board', managerUids: ['staff1'] }),
    doc('staffUsers/staff1', { displayName: 'Teacher', role: 'admin' }),
    ...['amy', 'bea', 'out', 'dupe', 'testonly'].map((u) => doc(`students/${u}`, { displayName: u, createdBy: 'staff1' })),
    doc('notifications/dupe', { attendanceMissing: true }),
    doc('enrollments/amy_c1', { studentUid: 'amy', courseId: 'c1', cohortId: 'keep', active: true }),
    doc('enrollments/out_c1', { studentUid: 'out', courseId: 'c1', cohortId: 'keep', active: false }),
    doc('enrollments/dupe_c1', { studentUid: 'dupe', courseId: 'c1', cohortId: 'keep', active: true }),
    doc('enrollments/bea_c9', { studentUid: 'bea', courseId: 'c9', cohortId: 'drop', active: true }),
    doc('enrollments/bea_c2', { studentUid: 'bea', courseId: 'c2', cohortId: 'keep', active: true }),
    doc('enrollments/testonly_c9', { studentUid: 'testonly', courseId: 'c9', cohortId: 'drop', active: true }),
    doc('sessions/s1', {
      courseId: 'c1',
      cohortId: 'keep',
      title: 'Week 1',
      recordingId: 'r1',
      attendance: { amy: 'excused', out: 'absent', dupe: 'present' },
    }),
    doc('sessions/s2', { courseId: 'c1', cohortId: 'keep', title: 'Week 2', recordingId: 'rbad', attendance: { amy: 'excused' } }),
    doc('sessions/stest', { courseId: 'c1', cohortId: 'keep', title: 'Test attendance', recordingId: null, attendance: { amy: 'present' } }),
    doc('sessions/s9', { courseId: 'c9', cohortId: 'drop', title: 'Meeting', recordingId: 'r9', attendance: { bea: 'present' } }),
    doc('recordings/r1', { courseId: 'c1', sessionId: 's1', title: 'Week 1' }),
    doc('recordings/rbad', { courseId: 'c1', sessionId: 's2', title: 'Week 2' }),
    doc('recordings/r9', { courseId: 'c9', sessionId: 's9', title: 'Meeting' }),
    doc('zoomImports/fbad', { recordingId: 'rbad', sessionId: 's2' }),
    doc('zoomImports/f1', { recordingId: 'r1', sessionId: 's1' }),
    doc('assignments/amy_s1', { studentUid: 'amy', sessionId: 's1', recordingId: 'r1', courseId: 'c1' }),
    doc('assignments/amy_s2', { studentUid: 'amy', sessionId: 's2', recordingId: 'rbad', courseId: 'c1' }),
    doc('attendanceRecords/out_s1', { studentUid: 'out', sessionId: 's1', courseId: 'c1' }),
    doc('attendanceRecords/dupe_s1', { studentUid: 'dupe', sessionId: 's1', courseId: 'c1' }),
    doc('attendanceRecords/amy_stest', { studentUid: 'amy', sessionId: 'stest', courseId: 'c1' }),
    doc('auditLog/a1', { action: 'createStudent', courseId: 'c1', targets: { studentUid: 'dupe' } }),
    doc('auditLog/a2', { action: 'createEnrollment', courseId: 'c1', targets: { studentUid: 'dupe', courseId: 'c1' } }),
    doc('auditLog/a3', { action: 'submitAttendance', courseId: 'c1', targets: { sessionId: 'stest' } }),
    doc('auditLog/a4', { action: 'setStaffAccess', courseId: null, targets: { uid: 'staff1' } }),
    doc('auditLog/a5', { action: 'createCohort', courseId: null, targets: {} }),
    doc('auditLog/a6', { action: 'setCourseManagers', courseId: 'c9', targets: { courseId: 'c9' } }),
  ];
  const accounts = ['staff1', 'amy', 'bea', 'out', 'dupe', 'testonly'].map((localId) => ({ localId }));
  return { docs, accounts };
}
const PLAN = {
  cohorts: ['keep'],
  leaveOut: ['out'],
  merge: { dupe: 'bea' },
  dropSessions: ['stest'],
  dropRecordings: ['rbad'],
};
const run = (plan: Plan = PLAN) => {
  const { docs, accounts } = liveApp();
  const out = sel.selectFromLegacy(docs, accounts, sel.parsePlan(plan));
  const written = new Map(out.writes.map((w) => [w.rel, w.fields]));
  return { ...out, written };
};
const marks = (f: Fields | undefined) =>
  Object.fromEntries(
    Object.entries((f?.attendance as { mapValue: { fields: Record<string, { stringValue: string }> } }).mapValue.fields).map(([k, v]) => [
      k,
      v.stringValue,
    ]),
  );

describe('selectFromLegacy', () => {
  it('copies the chosen cohort and nothing of the other, people included', () => {
    const { written, uids, report } = run();
    expect(written.has('cohorts/keep')).toBe(true);
    for (const rel of ['cohorts/drop', 'courses/c9', 'sessions/s9', 'recordings/r9', 'enrollments/bea_c9', 'auditLog/a6']) {
      expect(written.has(rel), rel).toBe(false);
    }
    // In no copied class: not copied, account and all.
    expect(uids.has('testonly')).toBe(false);
    expect(written.has('students/testonly')).toBe(false);
    expect(report.notEnrolled).toEqual(['testonly']);
    // Staff come whatever they teach.
    expect(uids.has('staff1')).toBe(true);
    expect(written.has('auditLog/a4')).toBe(true);
  });

  it('takes a left-out student out of every register and record, and keeps the session', () => {
    const { written, uids, report } = run();
    expect(uids.has('out')).toBe(false);
    expect(written.has('students/out')).toBe(false);
    expect(written.has('enrollments/out_c1')).toBe(false);
    expect(written.has('attendanceRecords/out_s1')).toBe(false);
    expect(marks(written.get('sessions/s1'))).toEqual({ amy: 'excused', bea: 'present' });
    expect(report.marksRemoved.get('sessions/s1')).toBe(1);
  });

  it("moves a duplicate's classes and marks onto the account its owner uses", () => {
    const { written, uids } = run();
    expect(uids.has('dupe')).toBe(false);
    expect(written.has('students/dupe')).toBe(false);
    expect(written.has('notifications/dupe')).toBe(false);
    expect(written.get('enrollments/bea_c1')).toBeDefined();
    expect(written.get('attendanceRecords/bea_s1')?.studentUid).toEqual({ stringValue: 'bea' });
    expect(marks(written.get('sessions/s1')).bea).toBe('present');
    // What was done to the student moves; the duplicate's creation does not.
    expect(written.get('auditLog/a2')?.targets).toEqual(encodeValue({ targets: { studentUid: 'bea', courseId: 'c1' } }).mapValue.fields.targets);
    expect(written.has('auditLog/a1')).toBe(false);
  });

  it('refuses to fold a duplicate into an account with a mark in the same session', () => {
    const { docs, accounts } = liveApp();
    const clash = docs.map((d) =>
      d.rel === 'sessions/s1' ? doc('sessions/s1', { courseId: 'c1', recordingId: 'r1', attendance: { dupe: 'present', bea: 'absent' } }) : d,
    );
    expect(() => sel.selectFromLegacy(clash, accounts, sel.parsePlan(PLAN))).toThrow(/both dupe and bea have a mark/);
  });

  it('drops a test session with its records, and a broken recording while its session stays', () => {
    const { written } = run();
    expect(written.has('sessions/stest')).toBe(false);
    expect(written.has('attendanceRecords/amy_stest')).toBe(false);
    expect(written.has('auditLog/a3')).toBe(false);
    expect(written.has('recordings/rbad')).toBe(false);
    expect(written.has('zoomImports/fbad')).toBe(false);
    expect(written.has('assignments/amy_s2')).toBe(false);
    const s2 = written.get('sessions/s2');
    expect(s2?.recordingId).toEqual({ nullValue: null });
    expect(marks(s2)).toEqual({ amy: 'excused' });
    // The rest of the class is untouched.
    expect(written.has('recordings/r1')).toBe(true);
    expect(written.has('zoomImports/f1')).toBe(true);
    expect(written.has('assignments/amy_s1')).toBe(true);
  });

  it('copies no audit entry that names nothing it touched, in no class', () => {
    expect(run().written.has('auditLog/a5')).toBe(false);
  });

  it('writes nothing that names a cohort, class, session, recording or person not copied', () => {
    const { writes, uids } = run();
    const here = new Set([...writes.map((w) => w.rel.split('/')[1]), ...uids]);
    const everyId = new Set(liveApp().docs.map((d) => d.rel.split('/')[1]));
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
    for (const w of writes) {
      for (const s of strings(w.fields)) {
        if (everyId.has(s)) expect(here.has(s), `${w.rel} names ${s}`).toBe(true);
      }
    }
  });

  it('refuses a plan naming what does not exist or is not copied anyway', () => {
    const { docs, accounts } = liveApp();
    const go = (p: Plan) => () => sel.selectFromLegacy(docs, accounts, sel.parsePlan(p));
    expect(go({ ...PLAN, cohorts: ['nope'] })).toThrow(/no cohort nope/);
    expect(go({ ...PLAN, leaveOut: ['testonly'] })).toThrow(/no enrolment in a copied class/);
    expect(go({ ...PLAN, dropSessions: ['s9'] })).toThrow(/not a session of a copied class/);
    expect(go({ ...PLAN, dropRecordings: ['r9'] })).toThrow(/not a recording of a copied class/);
  });
});

describe('parsePlan', () => {
  it('refuses a malformed plan at the boundary', () => {
    expect(() => sel.parsePlan({ cohorts: [] })).toThrow(/at least one cohort/);
    expect(() => sel.parsePlan({ cohorts: ['a'], leavOut: ['x'] })).toThrow(/unknown key/);
    expect(() => sel.parsePlan({ cohorts: ['a'], merge: { x: 'y', y: 'z' } })).toThrow(/itself folded away/);
    expect(() => sel.parsePlan({ cohorts: ['a'], merge: { x: 'y' }, leaveOut: ['y'] })).toThrow(/leaveOut names one/);
    expect(() => sel.parsePlan({ cohorts: ['a', 'a'] })).toThrow(/twice/);
  });
});

describe('keptHere', () => {
  const here = () => ({
    docs: [
      doc('config/app', { minVersionCode: 1001000 }),
      doc('cohorts/app-review', { name: 'App Review' }),
      doc('cohorts/hunt', { name: 'HUNT' }),
      doc('courses/arc', { cohortId: 'app-review' }),
      doc('courses/hc', { cohortId: 'hunt' }),
      doc('sessions/as1', { cohortId: 'app-review', courseId: 'arc', attendance: { rev: 'excused' } }),
      doc('recordings/ar1', { cohortId: 'app-review', courseId: 'arc' }),
      doc('coursework/acw', { cohortId: 'app-review', courseId: 'arc' }),
      doc('courseworkTallies/acw', { courseId: 'arc' }),
      doc('enrollments/rev_arc', { studentUid: 'rev', courseId: 'arc', cohortId: 'app-review' }),
      doc('students/rev', { displayName: 'Reviewer' }),
      doc('students/alpha', { displayName: 'Test Alpha' }),
      doc('notifications/alpha', {}),
      doc('notifications/alpha/devices/d1', { token: 't' }),
      doc('enrollments/alpha_hc', { studentUid: 'alpha', courseId: 'hc', cohortId: 'hunt' }),
      doc('submissions/alpha_hcw', { studentUid: 'alpha', courseId: 'hc' }),
      doc('students/tester', { displayName: 'Tester' }),
    ],
    accounts: ['rev', 'alpha', 'tester'].map((localId) => ({ localId })),
  });
  const plan = sel.parsePlan({ cohorts: ['x'], keepHere: { cohorts: ['app-review'], accounts: ['rev', 'alpha'] } });

  it('keeps the floor, the kept cohort whole and the kept accounts, but not their work elsewhere', () => {
    const { docs, accounts } = here();
    const kept = new Set(sel.keptHere(docs, accounts, plan).docs.map((d) => d.rel));
    for (const rel of [
      'config/app',
      'cohorts/app-review',
      'courses/arc',
      'sessions/as1',
      'recordings/ar1',
      'coursework/acw',
      'courseworkTallies/acw',
      'enrollments/rev_arc',
      'students/rev',
      'students/alpha',
      'notifications/alpha',
      'notifications/alpha/devices/d1',
    ]) {
      expect(kept.has(rel), rel).toBe(true);
    }
    for (const rel of ['cohorts/hunt', 'courses/hc', 'enrollments/alpha_hc', 'submissions/alpha_hcw', 'students/tester']) {
      expect(kept.has(rel), rel).toBe(false);
    }
  });

  it("keeps a kept recording's files and a kept assignment's, and no others", () => {
    const { docs, accounts } = here();
    const { keepsObject } = sel.keptHere(docs, accounts, plan);
    expect(keepsObject('media/ar1/item1')).toBe(true);
    expect(keepsObject('coursework/acw/file1')).toBe(true);
    expect(keepsObject('work/rev/acw/file1')).toBe(true);
    expect(keepsObject('media/hunt-rec/item1')).toBe(false);
    expect(keepsObject('work/alpha/hcw/file1')).toBe(false);
  });

  it('refuses to keep a class whose student the wipe would delete', () => {
    const { docs, accounts } = here();
    const narrow = sel.parsePlan({ cohorts: ['x'], keepHere: { cohorts: ['app-review'], accounts: ['alpha'] } });
    expect(() => sel.keptHere(docs, accounts, narrow)).toThrow(/its student rev is not in keepHere.accounts/);
  });
});
