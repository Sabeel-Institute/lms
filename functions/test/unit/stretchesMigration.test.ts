import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { checkEnrolmentStretches, type EnrollmentDoc } from '@sabeel/shared';

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
