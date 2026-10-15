import { LATEST_CLIENT_TIME, type AppConfigDoc } from './constants';
import type {
  AttendanceRecordDoc,
  CohortDoc,
  CourseDoc,
  EnrollmentDoc,
  SessionDoc,
  StaffUserDoc,
  StudentDoc,
} from './types';
import type { BookmarkDoc, ListeningProgressDoc, RecordingDoc } from './recordings';
import { canPublish, hasLedger, isEmptyDraft, listenedShare, publishBlockers } from './recordings';
import { deriveDurationSec, mediaParts, mediaSummary, playVerb, startingItem } from './media';
import type { AssignmentDoc, CompletionDoc } from './assignments';
import { hasRecordingAccess } from './assignments';
import type {
  CourseworkDoc,
  DraftDoc,
  GradeDoc,
  CourseworkTallyDoc,
  SubmissionDoc,
  SubmissionEventDoc,
} from './coursework';
import { closesOn, nextDeadline, workState } from './coursework';
import { AUDIT_ACTION_LABELS, type AuditEntryDoc } from './audit';
import type { CompletionOverrideDoc } from './ledger';
import { effectiveCompletion } from './ledger';
import type { NotificationPrefsDoc } from './notifications';
import { canPlayFromCourse } from './structure';
import { checkEnrolmentStretches } from './membership';

/*
 * THE FIELDS OF EVERY DOCUMENT THE APP READS, as data: each one `required` or
 * `optional`, matching its TypeScript type — a field added to a type without a
 * line here fails to compile. What it is for is checking documents against
 * the code: `npm run check:documents` reads every live document through
 * `checkStored` before a release and after a migration, and fails on any that
 * lacks a field its type requires. Old data is MIGRATED, never accommodated:
 * nothing here gives a document what it lacks (a recording read without
 * `media` once blanked the live site, 2026-10-13).
 */

/** Keys a type allows to be absent. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** What one record of a map or a list is. */
type ItemOf<V> =
  NonNullable<V> extends readonly (infer I)[] ? I : NonNullable<V> extends Record<string, infer I> ? I : never;

/** A map or a list of records, each with its own fields; `optional` where its type allows it absent. */
type Each<T, K extends keyof T> = { each: Shape<ItemOf<T[K]>> } & (K extends OptionalKeys<T>
  ? { optional: true }
  : { optional?: undefined });

type Field<T, K extends keyof T> = (K extends OptionalKeys<T> ? 'optional' : 'required') | Each<T, K>;

/** Every field of a document type. */
export type Shape<T> = { [K in keyof T]-?: Field<T, K> };

/** The collections the app reads, and the type of the documents in each. */
export interface StoredDocs {
  staffUsers: StaffUserDoc;
  students: StudentDoc;
  cohorts: CohortDoc;
  courses: CourseDoc;
  enrollments: EnrollmentDoc;
  sessions: SessionDoc;
  attendanceRecords: AttendanceRecordDoc;
  recordings: RecordingDoc;
  coursework: CourseworkDoc;
  submissions: SubmissionDoc;
  drafts: DraftDoc;
  grades: GradeDoc;
  submissionEvents: SubmissionEventDoc;
  courseworkTallies: CourseworkTallyDoc;
  assignments: AssignmentDoc;
  listeningProgress: ListeningProgressDoc;
  bookmarks: BookmarkDoc;
  completions: CompletionDoc;
  completionOverrides: CompletionOverrideDoc;
  notifications: NotificationPrefsDoc;
  auditLog: AuditEntryDoc;
  config: AppConfigDoc;
}

export type StoredCollection = keyof StoredDocs;

const ATTACHMENT_FILE: Shape<CourseworkDoc['files'][string]> = {
  id: 'required',
  name: 'required',
  contentType: 'required',
  sizeBytes: 'required',
  durationSec: 'required',
  storageKey: 'required',
  addedAt: 'required',
};

const PAST_ATTEMPT: Shape<SubmissionDoc['attempts'][number]> = {
  note: 'required',
  files: { each: ATTACHMENT_FILE },
  attempt: 'required',
  handedInAt: 'required',
  returned: 'required',
};

export const DOCUMENT_SHAPES: { [C in StoredCollection]: Shape<StoredDocs[C]> } = {
  staffUsers: {
    displayName: 'required',
    email: 'required',
    photoUrl: 'required',
    role: 'required',
    status: 'required',
    createdAt: 'required',
    approvedAt: 'optional',
    approvedBy: 'optional',
  },
  students: {
    displayName: 'required',
    email: 'required',
    role: 'required',
    status: 'required',
    createdAt: 'required',
    createdBy: 'required',
  },
  cohorts: { name: 'required', archived: 'required', createdAt: 'required', createdBy: 'required' },
  courses: {
    cohortId: 'required',
    name: 'required',
    archived: 'required',
    effectiveActive: 'required',
    archivedAccess: 'required',
    managerUids: 'required',
    createdAt: 'required',
    createdBy: 'required',
  },
  enrollments: {
    studentUid: 'required',
    courseId: 'required',
    cohortId: 'required',
    active: 'required',
    stretches: { each: { from: 'required', to: 'required' } },
    enrolledBy: 'required',
  },
  sessions: {
    courseId: 'required',
    cohortId: 'required',
    date: 'required',
    title: 'required',
    dueDate: 'required',
    notes: 'required',
    recordingId: 'required',
    attendance: 'required',
    attendanceSubmittedAt: 'required',
    attendanceSubmittedBy: 'optional',
    notRecorded: 'required',
    createdAt: 'required',
    createdBy: 'required',
    updatedAt: 'required',
  },
  attendanceRecords: {
    studentUid: 'required',
    sessionId: 'required',
    courseId: 'required',
    cohortId: 'required',
    date: 'required',
    title: 'required',
    status: 'required',
    submittedAt: 'required',
  },
  recordings: {
    sessionId: 'required',
    courseId: 'required',
    cohortId: 'required',
    title: 'required',
    notes: 'required',
    date: 'required',
    status: 'required',
    source: 'required',
    media: {
      each: {
        id: 'required',
        part: 'required',
        version: 'required',
        kind: 'required',
        label: 'required',
        status: 'required',
        failReason: 'required',
        hidden: 'required',
        storageKey: 'required',
        contentType: 'required',
        sizeBytes: 'required',
        durationSec: 'required',
        width: 'required',
        height: 'required',
        source: 'required',
        zoom: 'required',
        addedAt: 'required',
        addedBy: 'required',
      },
    },
    defaultVersion: 'required',
    durationSec: 'required',
    attentionReason: 'optional',
    createdAt: 'required',
    createdBy: 'required',
    updatedAt: 'required',
    publishedAt: 'optional',
  },
  coursework: {
    courseId: 'required',
    cohortId: 'required',
    title: 'required',
    instructions: 'required',
    files: { each: ATTACHMENT_FILE },
    dueDate: 'required',
    lateUntil: 'required',
    grading: 'required',
    status: 'required',
    closedAt: 'required',
    postedAt: 'required',
    postedBy: 'required',
    createdAt: 'required',
    createdBy: 'required',
    updatedAt: 'required',
    editedAt: 'required',
  },
  submissions: {
    note: 'required',
    files: { each: ATTACHMENT_FILE },
    studentUid: 'required',
    courseworkId: 'required',
    courseId: 'required',
    cohortId: 'required',
    active: 'required',
    dueDate: 'required',
    lateUntil: 'required',
    closedEarly: 'required',
    state: 'required',
    attempt: 'required',
    handedInAt: 'required',
    returned: 'required',
    attempts: { each: PAST_ATTEMPT },
    notRequired: 'required',
    moreTime: 'required',
    assignedAt: 'required',
  },
  drafts: {
    note: 'required',
    files: { each: ATTACHMENT_FILE },
    studentUid: 'required',
    courseworkId: 'required',
    courseId: 'required',
    updatedAt: 'required',
    basedOn: 'optional',
  },
  grades: {
    studentUid: 'required',
    courseworkId: 'required',
    courseId: 'required',
    grade: 'required',
    feedback: 'required',
    gradedBy: 'required',
    gradedAt: 'required',
    withoutHandIn: 'required',
  },
  submissionEvents: {
    studentUid: 'required',
    courseworkId: 'required',
    courseId: 'required',
    kind: 'required',
    attempt: 'required',
    at: 'required',
    late: 'required',
  },
  courseworkTallies: {
    courseId: 'required',
    updatedAt: 'required',
    handedIn: 'required',
    late: 'required',
    toGrade: 'required',
    lateToGrade: 'required',
    toReturn: 'required',
    returned: 'required',
    notRequired: 'required',
    shareSum: 'required',
    shareCount: 'required',
    waiting: { each: { dueDate: 'required', lateUntil: 'required', closedEarly: 'required', count: 'required' } },
  },
  assignments: {
    studentUid: 'required',
    recordingId: 'required',
    sessionId: 'required',
    courseId: 'required',
    cohortId: 'required',
    dueDate: 'required',
    active: 'required',
    assignedAt: 'required',
    assignedBy: 'required',
  },
  listeningProgress: {
    studentUid: 'required',
    recordingId: 'required',
    courseId: 'required',
    listenedMs: 'required',
    sittings: 'required',
    sitting: 'required',
    updatedAt: 'required',
  },
  bookmarks: {
    studentUid: 'required',
    recordingId: 'required',
    courseId: 'required',
    itemId: 'required',
    positionMs: 'required',
    setAt: 'required',
  },
  completions: {
    studentUid: 'required',
    recordingId: 'required',
    courseId: 'required',
    completed: 'required',
    completedAt: 'required',
    updatedAt: 'required',
  },
  completionOverrides: {
    studentUid: 'required',
    recordingId: 'required',
    courseId: 'required',
    completed: 'required',
    reason: 'required',
    overriddenBy: 'required',
    at: 'required',
  },
  notifications: {
    recordingReady: 'optional',
    lastDay: 'optional',
    assignmentPosted: 'optional',
    handInLastDay: 'optional',
    workReturned: 'optional',
    attendanceMissing: 'optional',
    updatedAt: 'optional',
  },
  auditLog: {
    at: 'required',
    actorUid: 'required',
    actorRole: 'required',
    action: 'required',
    courseId: 'required',
    targets: 'required',
    detail: 'optional',
  },
  config: { minVersionCode: 'required' },
};

type AnyShape = Readonly<Record<string, 'required' | 'optional' | { each: AnyShape; optional?: true }>>;

function missingIn(shape: AnyShape, stored: Readonly<Record<string, unknown>>, at: string, missing: Set<string>): void {
  for (const [key, field] of Object.entries(shape)) {
    const value = stored[key];
    const required = field === 'required' || (typeof field === 'object' && !field.optional);
    if (required && value === undefined) missing.add(at + key);
    if (typeof field === 'string' || value === null || typeof value !== 'object') continue;
    const records = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const r of records) {
      if (r !== null && typeof r === 'object') missingIn(field.each, r as Record<string, unknown>, `${at}${key}.*.`, missing);
    }
  }
}

/**
 * The required fields a stored document lacks, as paths (`courseId`,
 * `files.*.storageKey`): data to migrate. Empty for a document of today's shape.
 */
export function checkStored(collection: StoredCollection, stored: Readonly<Record<string, unknown>>): string[] {
  const missing = new Set<string>();
  missingIn(DOCUMENT_SHAPES[collection] as unknown as AnyShape, stored, '', missing);
  return [...missing];
}

/**
 * A stored document typed by its collection: the one place a document's data
 * becomes its type, for the app's `read()` (src/documents.ts).
 */
export function storedDoc<C extends StoredCollection>(_collection: C, stored: Readonly<Record<string, unknown>>): StoredDocs[C] {
  return stored as unknown as StoredDocs[C];
}

/** A time a client wrote, within what the rules accept; anything else is data to migrate. */
function clientTime(v: number): void {
  if (!(Number.isInteger(v) && v > 0 && v < LATEST_CLIENT_TIME)) throw new Error(`not a time the rules accept: ${v}`);
}

/**
 * What the screens do with a document of each kind, run over every document
 * in the shape tests and by `npm run check:documents`: a document the code
 * can read but a screen cannot draw is a crash waiting for whoever opens it,
 * and an audit entry it cannot put into words is a function name on the one
 * screen people read to establish what happened. Collections without a shared
 * helper are read and nothing more.
 */
export const SCREEN_CHECKS: { [C in StoredCollection]?: ((doc: StoredDocs[C], today: string) => unknown)[] } = {
  recordings: [
    (r) => mediaParts(Object.values(r.media)),
    (r) => startingItem(r.media, r.defaultVersion),
    (r) => deriveDurationSec(r.media),
    (r) => mediaSummary(r.media),
    (r) => playVerb(r.media),
    (r) => publishBlockers(r),
    (r) => canPublish(r),
    (r) => isEmptyDraft(r),
    (r) => hasLedger(r),
  ],
  courses: [(c) => canPlayFromCourse(c)],
  enrollments: [(e) => checkEnrolmentStretches(e)],
  assignments: [(a, today) => hasRecordingAccess(a, today)],
  listeningProgress: [
    (p) => listenedShare(p.listenedMs, null),
    (p) => clientTime(p.updatedAt),
    (p) => {
      const sum = Object.values(p.sittings).reduce((total, ms) => total + ms, 0);
      if (sum !== p.listenedMs) throw new Error(`listened ${p.listenedMs} is not its sittings' ${sum}`);
    },
  ],
  bookmarks: [(b) => clientTime(b.setAt)],
  completions: [
    (c) => effectiveCompletion(c, null),
    (c) => {
      if (c.completedAt !== null) clientTime(c.completedAt);
      clientTime(c.updatedAt);
    },
  ],
  completionOverrides: [(o) => effectiveCompletion(null, o)],
  coursework: [(c) => closesOn(c), (c) => Object.values(c.files).map((f) => f.name)],
  submissions: [
    (s, today) => nextDeadline(workState(s, today, true), s),
    (s) => s.attempts.flatMap((a) => Object.values(a.files).map((f) => f.name)),
  ],
  drafts: [(d) => Object.values(d.files).map((f) => f.name), (d) => clientTime(d.updatedAt)],
  auditLog: [
    (e) => {
      if (!Object.hasOwn(AUDIT_ACTION_LABELS, e.action)) throw new Error(`no words for the action ${e.action}`);
    },
    // The audit screen prints each detail as "key: value", so a value is a
    // word, a number or a list of ids it can name: a map printed as
    // [object Object].
    (e) => {
      for (const [k, v] of Object.entries(e.detail ?? {})) {
        const flat = v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
        if (!flat) throw new Error(`the detail ${k} is not something the audit screen can print`);
      }
    },
  ],
};
