import type { CourseworkGrading } from '@sabeel/shared';

/** How an assignment is graded, in a few words: "graded out of 10", "satisfactory / needs work". */
export function gradingText(grading: CourseworkGrading): string {
  return grading.kind === 'points' ? `graded out of ${grading.outOf}` : 'satisfactory / needs work';
}
