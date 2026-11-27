import type { AuditEntryDoc } from './audit';
import { COLLECTIONS } from './collections';
import type { CourseworkDoc } from './coursework';
import { VERSION_LABELS, itemLabel, type MediaItem, type MediaVersion } from './media';
import type { RecordingDoc } from './recordings';
import type { CohortDoc, CourseDoc, SessionDoc, StaffUserDoc, StudentDoc } from './types';

/**
 * AN AUDIT ENTRY IN WORDS, WITH NO ID IN THEM.
 *
 * An entry records the ids it touched (`targets`, and a few ids inside
 * `detail`), and the screen printed them: `sessionId=AV52ezx…`, `itemId=…`,
 * which nobody can match to a session without leaving the screen. Each entry
 * now also carries `names`: what every one of those ids was called when the
 * change was made, written by the server (`functions/src/auditNames.ts`)
 * before the change runs, so a deletion still says what it deleted.
 *
 * WHICH NAME IS SHOWN. The name at the time, always available. For people,
 * classes and cohorts, which the screen already has in hand, today's name
 * leads and the old one follows as "then …" when they differ: a reader finds
 * a class under the name it has now, and the record still says what it was
 * called. Sessions, recordings and assignments show the name at the time
 * only; the screen does not read them, and a session also carries its date.
 * An id with neither (an entry older than names, about something deleted
 * since) says so in words.
 */

/** What an id in an audit entry names. */
export type AuditNameKind = 'class' | 'session' | 'recording' | 'cohort' | 'assignment' | 'person' | 'file';

/** The target keys the server writes, what each names, and the word the screen puts before it, in screen order. */
export const AUDIT_TARGETS: Readonly<Record<string, { kind: AuditNameKind; word: string }>> = {
  cohortId: { kind: 'cohort', word: 'Cohort' },
  courseId: { kind: 'class', word: 'Class' },
  sessionId: { kind: 'session', word: 'Session' },
  recordingId: { kind: 'recording', word: 'Recording' },
  courseworkId: { kind: 'assignment', word: 'Assignment' },
  studentUid: { kind: 'person', word: 'Student' },
  uid: { kind: 'person', word: 'Account' },
};

/** The detail keys that hold ids rather than words, and what they name. */
const DETAIL_IDS: Readonly<Record<string, AuditNameKind>> = {
  itemId: 'file',
  added: 'person',
  removed: 'person',
  returned: 'person',
};

/** What is said for an id no name can be found for. */
const GONE: Readonly<Record<AuditNameKind, string>> = {
  class: 'a class no longer in the app',
  session: 'a session no longer in the app',
  recording: 'a recording no longer in the app',
  cohort: 'a cohort no longer in the app',
  assignment: 'an assignment no longer in the app',
  person: 'an account no longer in the app',
  file: 'a file no longer in the app',
};

/** One id an entry names: what it is and, for a file, the recording it is in. */
export interface AuditId {
  kind: AuditNameKind;
  id: string;
  recordingId?: string;
}

/**
 * Every id an entry (or a call's request data) names, for the server to look
 * up: its class, its targets, and the ids inside its detail. A file is named
 * through its recording, so it carries the recording's id.
 */
export function auditIds(e: { courseId?: string | null; targets?: Record<string, unknown>; detail?: Record<string, unknown> }): AuditId[] {
  const out: AuditId[] = [];
  const recordingId = typeof e.targets?.recordingId === 'string' ? e.targets.recordingId : undefined;
  if (e.courseId) out.push({ kind: 'class', id: e.courseId });
  for (const [k, v] of Object.entries(e.targets ?? {})) {
    const t = AUDIT_TARGETS[k];
    if (t && typeof v === 'string' && v) out.push({ kind: t.kind, id: v });
  }
  for (const [k, v] of Object.entries(e.detail ?? {})) {
    const kind = DETAIL_IDS[k];
    if (!kind) continue;
    for (const id of Array.isArray(v) ? v : [v]) {
      if (typeof id !== 'string' || !id) continue;
      if (kind === 'file') {
        if (recordingId) out.push({ kind, id, recordingId });
      } else out.push({ kind, id });
    }
  }
  return out;
}

// Each kind's name, built once here for the server, the backfill and the
// screen's "today" names alike, so "then …" compares like with like.
export const auditClassName = (course: { name: string }, cohortName: string | null | undefined) =>
  cohortName ? `${course.name} · ${cohortName}` : course.name;
export const auditSessionName = (s: { title: string; date: string }) => `${s.title} (${s.date})`;
export const auditFileName = (item: Pick<MediaItem, 'part' | 'label' | 'version'>) => `Part ${item.part}, ${itemLabel(item)}`;

/** Today's name of a person, class or cohort, when the screen has it. */
export type CurrentName = (kind: AuditNameKind, id: string) => string | undefined;

/** An entry's lines in words: who it was about, then what changed. */
export interface AuditWords {
  /** "Class: Arabic QI 2026 · Quran Immersion 2026 Istiqlal", one per thing touched. */
  about: string[];
  /** "Status: Published", one per detail. */
  details: string[];
}

const LINK_REASONS: Readonly<Record<string, string>> = {
  'bad-domain': 'not an oursabeel.com account',
  'unsupported-provider': 'not a Google sign-in',
  'self-signup': 'signed itself up',
};
const EDIT_OPS: Readonly<Record<string, string>> = {
  hide: 'Hid a file from students',
  show: 'Showed a file to students',
  moveUp: 'Moved a part earlier',
  moveDown: 'Moved a part later',
  defaultVersion: 'Changed what plays first',
};
const GIVE_OUTCOMES: Readonly<Record<string, string>> = {
  opened: 'Given',
  moved: 'Date moved',
  reopened: 'Given again',
};
const CHANGED_FIELDS: Readonly<Record<string, string>> = {
  title: 'title',
  instructions: 'instructions',
  dueDate: 'due date',
  lateUntil: 'late work date',
  grading: 'grading',
  files: 'files',
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n: unknown, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

type Words = (v: unknown, e: AuditEntryDoc, name: (kind: AuditNameKind, id: string) => string) => string | null;

/**
 * THE WORDS FOR EVERY DETAIL THE SERVER WRITES. A key missing here would print
 * as its camelCase name; `functions/test/unit/auditLabels.test.ts` reads the
 * keys the callables write from their source and fails on any without words,
 * and `check:documents` fails on a stored entry with one.
 */
export const AUDIT_DETAIL_WORDS: Readonly<Record<string, Words>> = {
  title: (v) => `Title: ${String(v)}`,
  name: (v, e) => `${e.action === 'renameCohort' ? 'New name' : 'Name'}: ${String(v)}`,
  status: (v) => `Status: ${capital(String(v))}`,
  role: (v) => `Role: ${capital(String(v))}`,
  email: (v) => `Email: ${String(v)}`,
  reason: (v, e) => `Reason: ${e.action === 'authReject' ? (LINK_REASONS[String(v)] ?? String(v)) : String(v)}`,
  account: (v) => (v === 'staff' ? 'A staff account' : 'A student account'),
  active: (v) => (v === false ? 'Removed from the class' : v === true ? 'Back in the class' : null),
  reenrolled: (v) => (v === true ? 'Enrolled again' : null),
  archived: (v) => (v === true ? 'Archived' : 'Unarchived'),
  archivedAccess: (v) => (v === true ? 'Students keep recordings once archived' : 'Recordings close once archived'),
  notRecorded: (v) => (v === true ? 'Marked not recorded' : 'Marked as recorded'),
  date: (v) => `Class date: ${String(v)}`,
  dueDate: (v, e) => `${e.action === 'updateSession' ? 'Listen by' : 'Due'}: ${String(v)}`,
  lateUntil: (v) => `Late work until: ${v === null ? 'no late work' : String(v)}`,
  beforeDueDate: (v) => `Was due: ${String(v)}`,
  openUntil: (v) => `Open until: ${String(v)}`,
  previousOpenUntil: (v) => `Was open until: ${String(v)}`,
  outcome: (v) => GIVE_OUTCOMES[String(v)] ?? null,
  attempts: (v) => `${count(v, 'attempt', 'attempts')} that day`,
  files: (v) => count(v, 'file', 'files'),
  file: (v) => `File: ${String(v)}`,
  students: (v) => count(v, 'student', 'students'),
  given: (v) => `Given to ${count(v, 'student', 'students')} who joined since`,
  grading: (v) => `Graded ${String(v)}`,
  grade: (v) => `Grade: ${String(v)}`,
  grades: (v) => `Grades: ${String(v)}`,
  retry: (v) => (v === true ? 'With another try' : null),
  notRequired: (v) => (v === true ? 'Marked not required' : 'Required again'),
  completed: (v) => (v === true ? 'Marked complete' : 'Marked not complete'),
  changed: (v) =>
    `Changed: ${String(v)
      .split(', ')
      .map((f) => CHANGED_FIELDS[f] ?? f)
      .join(', ')}`,
  op: (v) => EDIT_OPS[String(v)] ?? null,
  part: (v) => `Part ${String(v)}`,
  version: (v) => `Plays first: ${VERSION_LABELS[v as MediaVersion] ?? String(v)}`,
  itemId: (v, _e, name) => `File: ${name('file', String(v))}`,
  added: (v, _e, name) => `Added: ${(v as string[]).map((u) => name('person', u)).join(', ')}`,
  removed: (v, _e, name) => `Removed: ${(v as string[]).map((u) => name('person', u)).join(', ')}`,
  returned: (v, _e, name) => `Returned to: ${(v as string[]).map((u) => name('person', u)).join(', ')}`,
  kind: (v) => (v === 'reset' ? 'A password reset link' : 'A set-password link'),
  mail: (v) => (v === 'sent' ? 'Email sent' : v === 'failed' ? 'The email failed' : 'No email sent'),
};

/** The kinds the screen knows today's name of. */
const CURRENT_KINDS: ReadonlySet<AuditNameKind> = new Set(['person', 'class', 'cohort']);

/**
 * An entry in words. `current` gives today's name of a person, class or
 * cohort; `screenCourseId` is the class a class's own history is about, which
 * its entries need not repeat.
 */
export function describeAuditEntry(e: AuditEntryDoc, current: CurrentName, screenCourseId: string | null = null): AuditWords {
  const name = (kind: AuditNameKind, id: string): string => {
    const then = e.names?.[id];
    const now = CURRENT_KINDS.has(kind) ? current(kind, id) : undefined;
    if (now && then && now !== then) return `${now} (then ${then})`;
    return now ?? then ?? GONE[kind];
  };
  const about: string[] = [];
  const seen = new Set<string>();
  const say = (key: string, id: string) => {
    const t = AUDIT_TARGETS[key];
    if (!t || seen.has(`${key}:${id}`)) return;
    seen.add(`${key}:${id}`);
    about.push(`${t.word}: ${name(t.kind, id)}`);
  };
  // The class an entry belongs to leads, unless it is the screen's own.
  const classId = (typeof e.targets.courseId === 'string' ? e.targets.courseId : null) ?? e.courseId;
  for (const key of Object.keys(AUDIT_TARGETS)) {
    if (key === 'courseId') {
      if (classId && classId !== screenCourseId) say(key, classId);
      continue;
    }
    const id = e.targets[key];
    if (typeof id === 'string' && id) say(key, id);
  }
  const shown = new Set(about.map((line) => line.slice(line.indexOf(': ') + 2)));
  const details: string[] = [];
  for (const [k, v] of Object.entries(e.detail ?? {})) {
    // The title of the assignment or recording the entry is about is already said.
    if (k === 'title' && shown.has(String(v))) continue;
    const words = AUDIT_DETAIL_WORDS[k];
    const line = words ? words(v, e, name) : `${capital(k.replace(/([A-Z])/g, ' $1').toLowerCase())}: ${String(v)}`;
    if (line) details.push(line);
  }
  return { about, details };
}

/** Reads documents by path (`courses/k1`), answering with those that exist. */
export type ReadDocs = (paths: string[]) => Promise<Map<string, unknown>>;

/**
 * What each id is called now: `{ [id]: name }`, in two reads at most (a class
 * is named with its cohort, which only the class says). An id that resolves
 * to nothing is left out. ONE LOOKUP for the server, which names every entry
 * as it is written (`functions/src/auditNames.ts`), and the backfill, which
 * names the entries written before (`scripts/backfill-audit-names.mjs`).
 */
export async function resolveAuditNames(ids: AuditId[], read: ReadDocs): Promise<Record<string, string>> {
  const pathOf = (kind: AuditNameKind, id: string, recordingId?: string): string[] => {
    switch (kind) {
      case 'class':
        return [`${COLLECTIONS.courses}/${id}`];
      case 'session':
        return [`${COLLECTIONS.sessions}/${id}`];
      case 'recording':
        return [`${COLLECTIONS.recordings}/${id}`];
      case 'cohort':
        return [`${COLLECTIONS.cohorts}/${id}`];
      case 'assignment':
        return [`${COLLECTIONS.coursework}/${id}`];
      case 'file':
        return recordingId ? [`${COLLECTIONS.recordings}/${recordingId}`] : [];
      case 'person':
        return [`${COLLECTIONS.students}/${id}`, `${COLLECTIONS.staffUsers}/${id}`];
    }
  };
  const first = [...new Set(ids.flatMap((i) => pathOf(i.kind, i.id, i.recordingId)))];
  if (first.length === 0) return {};
  const docs = await read(first);
  const cohorts = [...docs]
    .filter(([path]) => path.startsWith(`${COLLECTIONS.courses}/`))
    .map(([, c]) => `${COLLECTIONS.cohorts}/${(c as CourseDoc).cohortId}`)
    .filter((path) => !first.includes(path));
  if (cohorts.length) for (const [p, d] of await read([...new Set(cohorts)])) docs.set(p, d);

  const of = <T>(collection: string, id: string) => docs.get(`${collection}/${id}`) as T | undefined;
  const out: Record<string, string> = {};
  for (const { kind, id, recordingId } of ids) {
    let name: string | undefined;
    if (kind === 'class') {
      const c = of<CourseDoc>(COLLECTIONS.courses, id);
      if (c) name = auditClassName(c, of<CohortDoc>(COLLECTIONS.cohorts, c.cohortId)?.name);
    } else if (kind === 'session') {
      const s = of<SessionDoc>(COLLECTIONS.sessions, id);
      if (s) name = auditSessionName(s);
    } else if (kind === 'recording') name = of<RecordingDoc>(COLLECTIONS.recordings, id)?.title;
    else if (kind === 'cohort') name = of<CohortDoc>(COLLECTIONS.cohorts, id)?.name;
    else if (kind === 'assignment') name = of<CourseworkDoc>(COLLECTIONS.coursework, id)?.title;
    else if (kind === 'file' && recordingId) {
      const item = of<RecordingDoc>(COLLECTIONS.recordings, recordingId)?.media[id];
      if (item) name = auditFileName(item);
    } else if (kind === 'person') {
      name = of<StudentDoc>(COLLECTIONS.students, id)?.displayName ?? of<StaffUserDoc>(COLLECTIONS.staffUsers, id)?.displayName;
    }
    if (name) out[id] = name;
  }
  return out;
}
