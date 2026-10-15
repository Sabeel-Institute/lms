import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { checkEnrolmentStretches, checkStretches, grantOutcome, type CourseDoc, type EnrollmentDoc } from '@sabeel/shared';

/**
 * The migration of enrolments to their stretches, as the backfill and the
 * switchover seed run it on stored documents and the audit log beside them.
 *
 * What it promises a person: a student taken out of a class and brought
 * back, twice, has both absences on record after the migration — so the
 * workbook does not charge them for a date that passed while they were out
 * — and nothing else about the enrolment changes.
 */
const REPO = resolve(import.meta.dirname, '../../..');
type Row = { at: number; action: string; courseId: string | null; targets: Record<string, string>; detail?: Record<string, unknown> };
const mod = (await import(resolve(REPO, 'scripts/lib/stretches.mjs'))) as {
  enrolmentHistory: (rows: Row[]) => Map<string, Row[]>;
  convertEnrolment: (data: Record<string, unknown>, history: Row[] | undefined) => { data: EnrollmentDoc; inferred: boolean } | null;
  archiveHistory: (rows: Row[]) => Map<string, Row[]>;
  convertCourse: (
    id: string,
    data: Record<string, unknown>,
    cohort: Record<string, unknown> | undefined,
    history: Map<string, Row[]>,
  ) => { data: CourseDoc; inferred: boolean } | null;
};

const D = (d: string) => Date.parse(`${d}T12:00:00-05:00`);
const row = (at: number, action: string, courseId: string | null, detail?: Record<string, unknown>): Row => ({
  at,
  action,
  courseId,
  targets: { studentUid: 'stu', ...(courseId ? { courseId } : {}) },
  ...(detail ? { detail } : {}),
});

describe('migrating an enrolment to its stretches', () => {
  const log = [
    row(D('2026-08-24'), 'createEnrollment', 'hikam'),
    row(D('2026-09-15'), 'setEnrollmentActive', 'hikam', { active: false }),
    row(D('2026-09-29'), 'createEnrollment', 'hikam', { reenrolled: true }),
    row(D('2026-10-06'), 'setEnrollmentActive', 'hikam', { active: false }),
    // Another class, and a row about no class: neither is this enrolment's.
    row(D('2026-09-20'), 'setEnrollmentActive', 'arabic', { active: false }),
    row(D('2026-09-21'), 'setStudentAccess', null, { status: 'disabled' }),
  ];
  const old = { studentUid: 'stu', courseId: 'hikam', cohortId: 'k', active: false, enrolledAt: D('2026-08-24'), enrolledBy: 'mgr', unenrolledAt: D('2026-10-06') };

  it('keeps both absences, drops the two dates, and leaves every other field as it was', () => {
    const history = mod.enrolmentHistory(log);
    expect(history.get('stu_hikam')).toHaveLength(4);
    const converted = mod.convertEnrolment(old, history.get('stu_hikam'))!;
    expect(converted.inferred).toBe(false);
    expect(converted.data).toEqual({
      studentUid: 'stu',
      courseId: 'hikam',
      cohortId: 'k',
      active: false,
      enrolledBy: 'mgr',
      stretches: [
        { from: D('2026-08-24'), to: D('2026-09-15') },
        { from: D('2026-09-29'), to: D('2026-10-06') },
      ],
    });
    expect(() => checkEnrolmentStretches(converted.data)).not.toThrow();
  });

  it('leaves an enrolment that has its stretches alone, so it can run again', () => {
    expect(mod.convertEnrolment({ ...old, stretches: [{ from: 1, to: null }] }, undefined)).toBeNull();
  });

  it('with no log at all, keeps what the two dates say', () => {
    expect(mod.convertEnrolment(old, undefined)?.data.stretches).toEqual([{ from: D('2026-08-24'), to: D('2026-10-06') }]);
  });
});

/*
 * A class archived with its recordings closed before a student's date, and
 * the date long gone when the record is read: after the migration the ledger
 * says Closed, as the student's own home does, not Missed.
 */
describe('migrating a class to its closed stretches', () => {
  const log: Row[] = [
    { at: D('2026-09-10'), action: 'updateCourse', courseId: 'hikam', targets: { courseId: 'hikam' }, detail: { archived: true } },
    // Another class's archive, and its cohort's: neither is this class's.
    { at: D('2026-09-11'), action: 'updateCourse', courseId: 'arabic', targets: { courseId: 'arabic' }, detail: { archived: true } },
    { at: D('2026-09-12'), action: 'setCohortArchived', courseId: null, targets: { cohortId: 'other' }, detail: { archived: true } },
  ];
  const old = { cohortId: 'k', name: 'Hikam', archived: true, effectiveActive: false, archivedAccess: false, managerUids: [], createdAt: D('2026-08-01'), createdBy: 'adm' };

  it('keeps when it was closed, so a date inside that stretch is closed, not missed', () => {
    const converted = mod.convertCourse('hikam', old, { archived: false }, mod.archiveHistory(log))!;
    expect(converted).toMatchObject({ inferred: false, data: { ...old, recordingsClosed: [{ from: D('2026-09-10'), to: null }] } });
    expect(() => checkStretches(converted.data.recordingsClosed, true)).not.toThrow();
    expect(grantOutcome({ completed: false, dueDate: '2026-09-15' }, '2026-10-15', converted.data, 'America/Chicago')).toBe('closed');
    expect(grantOutcome({ completed: false, dueDate: '2026-09-05' }, '2026-10-15', converted.data, 'America/Chicago')).toBe('missed');
  });

  it('leaves a class that has them alone', () => {
    expect(mod.convertCourse('hikam', { ...old, recordingsClosed: [] }, undefined, new Map())).toBeNull();
  });
});
