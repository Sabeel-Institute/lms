import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_SHAPES,
  SCREEN_CHECKS,
  checkStored,
  type AttachmentFile,
  type MediaItem,
  type StoredCollection,
  type StoredDocs,
} from '../src';

/*
 * EVERY DOCUMENT THE APP READS IS CHECKED AGAINST ITS TYPE: `check:documents`
 * runs `checkStored` over every live document before a release, and fails on
 * one that lacks a field its type requires — data to migrate.
 *
 * Each collection has one CURRENT document below, every field set. The samples
 * are typed `Required<…>`, so a field added to a type must be added here too,
 * and the first test fails until its shape lists it.
 */

const TODAY = '2026-10-13';

const file = (id: string): Required<AttachmentFile> => ({
  id,
  name: `${id}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 36_000,
  durationSec: null,
  storageKey: `coursework/cw1/${id}`,
  addedAt: 1_791_000_000_000,
});

const item: Required<MediaItem> = {
  id: 'i1',
  part: 1,
  version: 'audio',
  kind: 'audio',
  label: null,
  status: 'ready',
  failReason: null,
  hidden: false,
  storageKey: 'media/r1/i1',
  contentType: 'audio/mp4',
  sizeBytes: 2_900_000,
  durationSec: 720,
  width: null,
  height: null,
  source: 'zoom',
  zoom: null,
  addedAt: 1_791_000_000_000,
  addedBy: 'staff1',
};

const SAMPLES: { [C in StoredCollection]: Required<StoredDocs[C]> } = {
  staffUsers: {
    displayName: 'Faisal Shah',
    email: 'faisal@example.org',
    photoUrl: null,
    role: 'admin',
    status: 'active',
    createdAt: 1,
    approvedAt: 2,
    approvedBy: 'bootstrap',
  },
  students: { displayName: 'Fatima Ahmed', email: 'f@example.com', role: 'student', status: 'active', createdAt: 1, createdBy: 's1' },
  cohorts: { name: 'Autumn 2026', archived: false, createdAt: 1, createdBy: 's1' },
  courses: {
    cohortId: 'c1',
    name: 'Hikam Foundations',
    archived: false,
    effectiveActive: true,
    archivedAccess: false,
    managerUids: ['m1'],
    createdAt: 1,
    createdBy: 's1',
  },
  enrollments: { studentUid: 'u1', courseId: 'k1', cohortId: 'c1', active: true, enrolledAt: 1, enrolledBy: 's1', unenrolledAt: 2 },
  sessions: {
    courseId: 'k1',
    cohortId: 'c1',
    date: '2026-10-09',
    title: 'Session 3',
    dueDate: '2026-10-17',
    notes: '',
    recordingId: 'r1',
    attendance: { u1: 'excused' },
    attendanceSubmittedAt: 3,
    attendanceSubmittedBy: 's1',
    notRecorded: false,
    createdAt: 1,
    createdBy: 's1',
    updatedAt: 2,
  },
  attendanceRecords: {
    studentUid: 'u1',
    sessionId: 'x1',
    courseId: 'k1',
    cohortId: 'c1',
    date: '2026-10-09',
    title: 'Session 3',
    status: 'excused',
    submittedAt: 3,
  },
  recordings: {
    sessionId: 'x1',
    courseId: 'k1',
    cohortId: 'c1',
    title: 'Session 3',
    notes: '',
    date: '2026-10-09',
    status: 'published',
    source: 'zoom',
    media: { i1: item },
    defaultVersion: 'audio',
    durationSec: 720,
    attentionReason: 'none',
    createdAt: 1,
    createdBy: 's1',
    updatedAt: 2,
    publishedAt: 3,
  },
  coursework: {
    courseId: 'k1',
    cohortId: 'c1',
    title: 'Hikma reflection',
    instructions: 'Recite it.',
    files: { f1: file('f1') },
    dueDate: '2026-10-20',
    lateUntil: '2026-10-27',
    grading: { kind: 'points', outOf: 10 },
    status: 'posted',
    closedAt: null,
    postedAt: 2,
    postedBy: 's1',
    createdAt: 1,
    createdBy: 's1',
    updatedAt: 2,
    editedAt: null,
  },
  submissions: {
    note: 'My answer',
    files: { f2: file('f2') },
    studentUid: 'u1',
    courseworkId: 'cw1',
    courseId: 'k1',
    cohortId: 'c1',
    active: true,
    dueDate: '2026-10-20',
    lateUntil: '2026-10-27',
    closedEarly: false,
    state: 'handedIn',
    attempt: 2,
    handedInAt: 5,
    returned: null,
    attempts: [
      {
        note: 'First',
        files: { f3: file('f3') },
        attempt: 1,
        handedInAt: 4,
        returned: { grade: { points: 7 }, feedback: 'Once more, slowly.', at: 5, seq: 1, retry: true },
      },
    ],
    notRequired: null,
    moreTime: null,
    assignedAt: 1,
  },
  drafts: { note: 'Draft', files: { f4: file('f4') }, studentUid: 'u1', courseworkId: 'cw1', courseId: 'k1', updatedAt: 1 },
  grades: {
    studentUid: 'u1',
    courseworkId: 'cw1',
    courseId: 'k1',
    grade: { points: 9 },
    feedback: 'Well done.',
    gradedBy: 's1',
    gradedAt: 6,
    withoutHandIn: false,
  },
  submissionEvents: { studentUid: 'u1', courseworkId: 'cw1', courseId: 'k1', kind: 'handIn', attempt: 1, at: 4, late: false },
  assignments: {
    studentUid: 'u1',
    recordingId: 'r1',
    sessionId: 'x1',
    courseId: 'k1',
    cohortId: 'c1',
    dueDate: '2026-10-17',
    active: true,
    assignedAt: 1,
    assignedBy: 's1',
  },
  listeningProgress: {
    studentUid: 'u1',
    recordingId: 'r1',
    courseId: 'k1',
    positionMs: 60_000,
    part: 1,
    version: 'audio',
    listenedMs: 90_000,
    updatedAt: 2,
  },
  completions: { studentUid: 'u1', recordingId: 'r1', courseId: 'k1', completed: true, completedAt: 2, updatedAt: 2 },
  completionOverrides: {
    studentUid: 'u1',
    recordingId: 'r1',
    courseId: 'k1',
    completed: true,
    reason: 'Listened in class',
    overriddenBy: 's1',
    at: 3,
  },
  notifications: {
    recordingReady: true,
    lastDay: true,
    assignmentPosted: true,
    handInLastDay: false,
    workReturned: true,
    attendanceMissing: true,
    updatedAt: 1,
  },
  auditLog: { at: 1, actorUid: 's1', actorRole: 'admin', action: 'setRecordingStatus', courseId: 'k1', targets: { recordingId: 'r1' }, detail: {} },
  config: { minVersionCode: 30 },
};

const collections = Object.keys(DOCUMENT_SHAPES) as StoredCollection[];
type Entry = string | { each: Record<string, Entry> };

describe('every collection the app reads has its fields listed', () => {
  it.each(collections)('%s: the current document and its shape list the same fields', (c) => {
    const shape = DOCUMENT_SHAPES[c] as Record<string, Entry>;
    expect(Object.keys(SAMPLES[c]).sort()).toEqual(Object.keys(shape).sort());
    for (const [key, field] of Object.entries(shape)) {
      if (typeof field === 'string') continue;
      const records = Object.values(SAMPLES[c][key as never] as object) as object[];
      expect(records.length, `${c}.${key} needs one record to compare`).toBeGreaterThan(0);
      expect(Object.keys(records[0]).sort(), `${c}.${key}`).toEqual(Object.keys(field.each).sort());
    }
  });

  it.each(collections)('%s: a current document lacks nothing, and every screen check runs on it', (c) => {
    expect(checkStored(c, SAMPLES[c] as never)).toEqual([]);
    for (const check of SCREEN_CHECKS[c] ?? []) check(SAMPLES[c] as never, TODAY);
  });
});

describe('a document that lacks a field its type requires', () => {
  it('is reported by the field: data to migrate', () => {
    const { courseId: _gone, ...stored } = SAMPLES.sessions;
    expect(checkStored('sessions', stored)).toEqual(['courseId']);
  });

  it('is reported by its path inside a map of records, once however many records lack it', () => {
    const files = { f1: file('f1'), f2: file('f2') };
    for (const f of Object.values(files)) delete (f as Partial<AttachmentFile>).storageKey;
    expect(checkStored('coursework', { ...SAMPLES.coursework, files })).toEqual(['files.*.storageKey']);
  });

  it('inside a list of records, as a past attempt, is reported too', () => {
    const [attempt] = SAMPLES.submissions.attempts;
    const { handedInAt: _gone, ...lacking } = attempt;
    expect(checkStored('submissions', { ...SAMPLES.submissions, attempts: [lacking] })).toEqual(['attempts.*.handedInAt']);
  });

  it('a recording without media — the shape that blanked the live site — is reported, not repaired', () => {
    const { media: _m, defaultVersion: _v, ...stored } = SAMPLES.recordings;
    expect(checkStored('recordings', stored).sort()).toEqual(['defaultVersion', 'media']);
  });

  it('an optional field left out is not reported', () => {
    const { part: _p, version: _v, ...stored } = SAMPLES.listeningProgress;
    expect(checkStored('listeningProgress', stored)).toEqual([]);
  });
});

describe('an audit entry whose action has no words', () => {
  it('fails its check, as data to migrate rather than a name to label', () => {
    const [words] = SCREEN_CHECKS.auditLog ?? [];
    expect(() => words({ ...SAMPLES.auditLog, action: 'importZoomRecording' }, TODAY)).toThrow(
      /no words for the action importZoomRecording/,
    );
    // Inherited names are not words either.
    expect(() => words({ ...SAMPLES.auditLog, action: 'constructor' }, TODAY)).toThrow(/no words/);
  });
});

describe('an audit entry whose detail the screen cannot print', () => {
  it('fails its check: a map, or a list of anything but ids', () => {
    const [, flat] = SCREEN_CHECKS.auditLog ?? [];
    expect(() => flat({ ...SAMPLES.auditLog, detail: { before: { dueDate: '2026-10-21' } } }, TODAY)).toThrow(/before/);
    expect(() => flat({ ...SAMPLES.auditLog, detail: { grades: [{ points: 7 }] } }, TODAY)).toThrow(/grades/);
    expect(() => flat({ ...SAMPLES.auditLog, detail: { dueDate: '2026-10-21 → 2026-10-23', returned: ['u1'], retry: false, n: 2 } }, TODAY)).not.toThrow();
  });
});
