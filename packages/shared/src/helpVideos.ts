/**
 * THE HELP VIDEOS: one short film per thing people do in the app, each made
 * twice — on a phone and on a computer — narrated, with captions.
 *
 * This list is the one source. The Help screen lists from it, the server
 * signs only what it names, and `scripts/tutorials` records exactly these —
 * its check fails on a film this list does not name, or on one it names and
 * nothing records.
 */

/** Who a film is for: a student's, a teacher's, or an administrator's work. */
export type HelpAudience = 'student' | 'staff' | 'admin';

/** The two cuts of every film. */
export type HelpVariant = 'phone' | 'computer';

export const HELP_VARIANTS: readonly HelpVariant[] = ['phone', 'computer'];

export interface HelpVideo {
  id: string;
  title: string;
  /** One line under the title: what the film shows. */
  summary: string;
  audience: HelpAudience;
}

export const HELP_VIDEOS: readonly HelpVideo[] = [
  { id: 'student-sign-in', audience: 'student', title: 'Signing in', summary: 'Your email, the password you set from the emailed link, and a fresh link if it expired.' },
  { id: 'student-to-do', audience: 'student', title: 'To do', summary: 'Everything you owe, soonest first.' },
  { id: 'student-playing', audience: 'student', title: 'Playing a recording', summary: 'Video or audio only, skipping, speed, and carrying on elsewhere in the app.' },
  { id: 'student-complete', audience: 'student', title: 'Marking a recording complete', summary: 'When you have finished, and what it does.' },
  { id: 'student-assignment', audience: 'student', title: 'An assignment', summary: 'Your answer, your files, Hand in, Take back, and your grade.' },
  { id: 'student-classes', audience: 'student', title: 'Your classes', summary: 'Your attendance, and every assignment, class by class.' },
  { id: 'student-notifications', audience: 'student', title: 'Notifications', summary: 'Turning them on for this device, and choosing which ones you get.' },
  { id: 'staff-today', audience: 'staff', title: 'Today', summary: 'What is waiting on you across your courses.' },
  { id: 'staff-attendance', audience: 'staff', title: 'Taking attendance', summary: 'Present, absent and excused — and why excused matters.' },
  { id: 'staff-recording', audience: 'staff', title: 'Adding a recording', summary: 'Uploading the files, checking them, and publishing.' },
  { id: 'staff-progress', audience: 'staff', title: 'Who has caught up', summary: 'A recording’s progress, and overriding a completion.' },
  { id: 'staff-assignment', audience: 'staff', title: 'Writing and posting an assignment', summary: 'Instructions, files, dates and grading.' },
  { id: 'staff-grading', audience: 'staff', title: 'Grading and returning', summary: 'One student’s work at a time, and returning it.' },
  { id: 'staff-students', audience: 'staff', title: 'A class’s students', summary: 'The roster, adding and removing, and a student’s page.' },
  { id: 'staff-report', audience: 'staff', title: 'The attendance report', summary: 'A course by session and by student, and its workbook.' },
  { id: 'staff-library', audience: 'staff', title: 'The recording library', summary: 'Every recording you can see, narrowed and played.' },
  { id: 'admin-staff', audience: 'admin', title: 'Approving staff', summary: 'Waiting accounts, roles, and access.' },
  { id: 'admin-structure', audience: 'admin', title: 'Cohorts and courses', summary: 'Terms and their courses, renaming, managers and archiving.' },
  { id: 'admin-audit', audience: 'admin', title: 'Audit history', summary: 'Who changed what, and when.' },
];

/**
 * The films a person sees. A student sees the students' films and no others.
 * Staff see every film, the students' included: a teacher or an administrator
 * is who a student asks when they are stuck, and the film is the answer.
 */
export function helpVideosFor(role: 'student' | 'manager' | 'admin'): HelpVideo[] {
  return role === 'student' ? HELP_VIDEOS.filter((v) => v.audience === 'student') : [...HELP_VIDEOS];
}

/** Where a film is kept in the media bucket: private, and served only by signed link. */
export function helpVideoKey(id: string, variant: HelpVariant, kind: 'video' | 'captions'): string {
  return `help/${id}-${variant}.${kind === 'video' ? 'mp4' : 'vtt'}`;
}
