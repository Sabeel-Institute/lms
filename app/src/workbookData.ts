import { collection, doc, getDoc, getDocs, limit, orderBy, query, where, type DocumentData, type Query } from 'firebase/firestore';
import {
  AUDIT_PAGE,
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  buildXlsx,
  courseWorkbook,
  studentWorkbook,
  todayInZone,
  workbookFilename,
  type CourseData,
  type CourseDoc,
  type StudentDoc,
  type StoredCollection,
  type StoredDocs,
  type StudentHistoryRow,
  type WorkbookContext,
} from '@sabeel/shared';
import { db } from './firebase';
import { saveWorkbook } from './exportWorkbook';
import { describeHistoryRow } from './studentHistory';
import { read, readIfExists } from './documents';

/**
 * The reads behind the two export buttons, and the file each produces.
 *
 * ONE-SHOT `getDocs`, not listeners: an export is a photograph, taken when
 * the button is pressed. Every query is a shape a screen already sends —
 * course-pinned where the rules want it, per managed course for a manager's
 * student — so the file can never show a manager more than their screens do.
 * The building is `@sabeel/shared` (`courseWorkbook`, `studentWorkbook`); this
 * file only fetches, joins and saves.
 */

const rows = async <C extends StoredCollection>(coll: C, q: Query<DocumentData>): Promise<(StoredDocs[C] & { id: string })[]> =>
  (await getDocs(q)).docs.map((d) => ({ id: d.id, ...read(coll, d) }));
const byCourse = (name: string, courseId: string) =>
  query(collection(db, name), where('courseId', '==', courseId));
/**
 * One student's enrolment in one course, ASKED, not fetched by id: the
 * student's page asks it this way, and a manager may. A get of the document
 * by id is refused outright when the student was never in the course, since
 * there is no document for the rules to read the course from.
 */
const enrolment = (studentUid: string, courseId: string) =>
  rows(
    COLLECTIONS.enrollments,
    query(collection(db, COLLECTIONS.enrollments), where('courseId', '==', courseId), where('studentUid', '==', studentUid)),
  );

/** Everyone's name and address: the two directories every staff member may read. */
async function directory(): Promise<Pick<WorkbookContext, 'names' | 'emails'>> {
  const [staff, students] = await Promise.all([
    rows(COLLECTIONS.staffUsers, query(collection(db, COLLECTIONS.staffUsers))),
    rows(COLLECTIONS.students, query(collection(db, COLLECTIONS.students))),
  ]);
  const names = new Map<string, string>();
  const emails = new Map<string, string>();
  for (const p of [...staff, ...students]) {
    names.set(p.id, p.displayName);
    emails.set(p.id, p.email);
  }
  return { names, emails };
}

async function cohortName(cohortId: string): Promise<string> {
  const snap = await getDoc(doc(db, COLLECTIONS.cohorts, cohortId));
  return readIfExists('cohorts', snap)?.name ?? '';
}

/** A course and everything the workbook needs about it. */
async function courseData(course: CourseDoc & { id: string }, forStudent?: string): Promise<CourseData> {
  const pin = (name: string) =>
    forStudent
      ? query(collection(db, name), where('studentUid', '==', forStudent), where('courseId', '==', course.id))
      : byCourse(name, course.id);
  const [cohort, sessions, recordings, enrollments, assignments, completions, overrides, progress, coursework, submissions, grades] =
    await Promise.all([
      cohortName(course.cohortId),
      rows(COLLECTIONS.sessions, byCourse(COLLECTIONS.sessions, course.id)),
      rows(COLLECTIONS.recordings, byCourse(COLLECTIONS.recordings, course.id)),
      forStudent ? enrolment(forStudent, course.id) : rows(COLLECTIONS.enrollments, byCourse(COLLECTIONS.enrollments, course.id)),
      rows(COLLECTIONS.assignments, pin(COLLECTIONS.assignments)),
      rows(COLLECTIONS.completions, pin(COLLECTIONS.completions)),
      rows(COLLECTIONS.completionOverrides, pin(COLLECTIONS.completionOverrides)),
      rows(COLLECTIONS.listeningProgress, pin(COLLECTIONS.listeningProgress)),
      rows(COLLECTIONS.coursework, byCourse(COLLECTIONS.coursework, course.id)),
      rows(COLLECTIONS.submissions, pin(COLLECTIONS.submissions)),
      rows(COLLECTIONS.grades, pin(COLLECTIONS.grades)),
    ]);
  return {
    course,
    cohortName: cohort,
    sessions,
    recordings,
    enrollments,
    assignments,
    completions,
    overrides,
    progress,
    coursework,
    submissions,
    grades,
  };
}

function context(
  dir: Pick<WorkbookContext, 'names' | 'emails'>,
  exportedBy: string,
  scopeNote?: string,
): WorkbookContext {
  return {
    ...dir,
    timeZone: INSTITUTE_TIMEZONE,
    today: todayInZone(INSTITUTE_TIMEZONE),
    exportedAt: Date.now(),
    exportedBy: dir.names.get(exportedBy) ?? exportedBy,
    scopeNote,
  };
}

/** The course workbook: every student, every session, every grant, every assignment. */
export async function exportCourseWorkbook(course: CourseDoc & { id: string }, byUid: string): Promise<void> {
  const [dir, data] = await Promise.all([directory(), courseData(course)]);
  const ctx = context(dir, byUid);
  await saveWorkbook(workbookFilename(`${course.name} — ${data.cohortName}`), buildXlsx(courseWorkbook(data, ctx)));
}

/**
 * The student workbook: every course the file may cover.
 *
 * An admin's covers every course the student is or was in; a manager's the
 * courses they run that the student is or was in, each asked first
 * (`enrolment`), so a course the student never joined costs one query rather
 * than the whole course's reads. The Summary's Scope line says which.
 */
export async function exportStudentWorkbook(
  student: StudentDoc & { uid: string },
  byUid: string,
  isAdmin: boolean,
): Promise<void> {
  const dir = await directory();
  let courses: (CourseDoc & { id: string })[];
  if (isAdmin) {
    const enrolled = await rows(
      COLLECTIONS.enrollments,
      query(collection(db, COLLECTIONS.enrollments), where('studentUid', '==', student.uid)),
    );
    const snaps = await Promise.all(enrolled.map((e) => getDoc(doc(db, COLLECTIONS.courses, e.courseId))));
    courses = snaps.flatMap((s) => (s.exists() ? [{ id: s.id, ...read('courses', s) }] : []));
  } else {
    const managed = await rows(
      COLLECTIONS.courses,
      query(collection(db, COLLECTIONS.courses), where('managerUids', 'array-contains', byUid)),
    );
    const theirs = await Promise.all(managed.map(async (c) => ((await enrolment(student.uid, c.id)).length ? c : null)));
    courses = theirs.filter((c): c is (typeof managed)[number] => c !== null);
  }
  const data = (await Promise.all(courses.map((c) => courseData(c, student.uid)))).filter((d) =>
    d.enrollments.some((e) => e.studentUid === student.uid),
  );
  const scope = data.map((d) => d.course.id);
  const audit =
    scope.length === 0
      ? []
      : await rows(
          COLLECTIONS.auditLog,
          isAdmin
            ? query(
                collection(db, COLLECTIONS.auditLog),
                where('targets.studentUid', '==', student.uid),
                orderBy('at', 'desc'),
                limit(AUDIT_PAGE),
              )
            : query(
                collection(db, COLLECTIONS.auditLog),
                where('courseId', 'in', scope.slice(0, 30)),
                where('targets.studentUid', '==', student.uid),
                orderBy('at', 'desc'),
                limit(AUDIT_PAGE),
              ),
        );
  const courseLabel = (id: string) => {
    const d = data.find((x) => x.course.id === id);
    return d ? `${d.course.name} (${d.cohortName})` : id;
  };
  const history: StudentHistoryRow[] = audit
    .map((e) => describeHistoryRow(e, courseLabel))
    .filter((h): h is StudentHistoryRow => h !== null);
  const ctx = context(dir, byUid, isAdmin ? undefined : 'the courses you manage');
  await saveWorkbook(
    workbookFilename(`${student.displayName} — ${ctx.today}`),
    buildXlsx(
      studentWorkbook(
        {
          student: {
            uid: student.uid,
            name: student.displayName,
            email: student.email,
            status: student.status,
            createdAt: student.createdAt,
          },
          courses: data,
          history,
        },
        ctx,
      ),
    ),
  );
}
