import './setup';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  INSTITUTE_TIMEZONE,
  courseworkTally,
  type CourseworkDoc,
  type CourseworkTallyDoc,
  type GradeDoc,
  type SubmissionDoc,
} from '@sabeel/shared';
import { SENTRY_DSN } from './reported';
import { reportError } from './sentry';

/**
 * ONE ASSIGNMENT'S FIGURES, KEPT AS ITS WORK CHANGES. A course's page and its
 * Assignments list showed every assignment's figures by reading every piece
 * of work and every grade in the course: on a phone, a full term of a large
 * class was two seconds of a page that would not answer a tap. They read
 * these instead, one small document per assignment (`courseworkTally` in
 * @sabeel/shared, whose date-free form needs no rewriting as days pass).
 *
 * Recomputed from the work itself, never adjusted: every path that changes a
 * student's work or grade writes a submission or a grade, and each write
 * brings its assignment's tally back to what the work says.
 *
 * ONE TRANSACTION THAT READS THE WORK AND WRITES THE TALLY BLIND. A change to
 * work a recompute has read waits for it to commit, then brings its own
 * recompute, so the answer stored last is always the newest. The stored tally
 * is deliberately not read: posting to a class starts one recompute per
 * student at once, and transactions that all read and write one document
 * mostly abort each other.
 */
export async function recomputeCourseworkTally(db: Firestore, courseworkId: string): Promise<void> {
  const ref = db.collection(COLLECTIONS.courseworkTallies).doc(courseworkId);
  await db.runTransaction(async (tx) => {
    const cw = (await tx.get(db.collection(COLLECTIONS.coursework).doc(courseworkId))).data() as CourseworkDoc | undefined;
    if (!cw) {
      tx.delete(ref);
      return;
    }
    const subs = await tx.get(db.collection(COLLECTIONS.submissions).where('courseworkId', '==', courseworkId));
    const grades = await tx.get(db.collection(COLLECTIONS.grades).where('courseworkId', '==', courseworkId));
    const tally = courseworkTally(
      cw.grading,
      subs.docs.map((d) => d.data() as SubmissionDoc),
      new Map(grades.docs.map((g) => [(g.data() as GradeDoc).studentUid, g.data() as GradeDoc])),
      INSTITUTE_TIMEZONE,
    );
    const doc: CourseworkTallyDoc = { ...tally, courseId: cw.courseId, updatedAt: Date.now() };
    tx.set(ref, doc);
  });
}

/** The assignment a written submission or grade belongs to, before or after. */
const courseworkOf = (event: { data?: { before: { data(): unknown }; after: { data(): unknown } } }) =>
  ((event.data?.after.data() ?? event.data?.before.data()) as { courseworkId?: string } | undefined)?.courseworkId;

async function recompute(source: string, courseworkId: string | undefined): Promise<void> {
  if (!courseworkId) return;
  try {
    await recomputeCourseworkTally(getFirestore(), courseworkId);
  } catch (e) {
    await reportError(e, { source });
    throw e;
  }
}

export const onSubmissionTallied = onDocumentWritten(
  { document: `${COLLECTIONS.submissions}/{submissionId}`, secrets: [SENTRY_DSN] },
  (event) => recompute('onSubmissionTallied', courseworkOf(event)),
);

export const onGradeTallied = onDocumentWritten(
  { document: `${COLLECTIONS.grades}/{gradeId}`, secrets: [SENTRY_DSN] },
  (event) => recompute('onGradeTallied', courseworkOf(event)),
);

/** How it is graded, and the assignment's own existence, decide its tally too. */
export const onCourseworkTallied = onDocumentWritten(
  { document: `${COLLECTIONS.coursework}/{courseworkId}`, secrets: [SENTRY_DSN] },
  (event) => recompute('onCourseworkTallied', event.params.courseworkId),
);
