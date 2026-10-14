/**
 * THE HELP FILMS, as a script: for each film in `HELP_VIDEOS`, who it signs
 * in as, where it starts, and what is said over what is done.
 *
 * Each step's `say` is one line of narration, rendered by `tts.py`; its `do`
 * is what happens on screen while it is said, through the helpers `record.mjs`
 * hands it (`tap`, `type`, `scroll`, …), which draw the touch or the pointer so
 * a viewer can follow. Every film is recorded against a freshly seeded guide
 * world (`seed-guide.mjs`), so what one film changes is not in the next.
 * A step with `cut: 'phone'` is in the phone's cut alone: it shows something
 * a computer's wider column never needs, like a title too long for its line.
 *
 * The narration is written for adults, in the app's own words: required,
 * listen by, missed, hand in — never anything childish or punitive.
 */
import { AUDIO_FIXTURE } from '../lib/media-fixtures.mjs';

/** A small PDF to attach: a worksheet, as a teacher or a student would. */
const WORKSHEET = {
  name: 'Worksheet.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  ),
};

export const TUTORIALS = [
  // ------------------------------------------------------------------ students
  {
    id: 'student-sign-in',
    as: null,
    steps: [
      { say: 'This is how you sign in to Sabeel Institute as a student.', do: (t) => t.wait(600) },
      {
        say: 'When your teacher creates your account, you get an email with a link. Open it, and choose your password.',
        do: (t) => t.highlight('signin-email'),
      },
      { say: 'Then enter the email address your teacher used.', do: (t) => t.type('signin-email', 'fatima.ahmed@example.com') },
      {
        say: 'If your link has expired, this sends you a new one.',
        do: (t) => t.highlight('signin-reset'),
      },
      { say: 'Enter your password, and tap Sign in.', do: async (t) => { await t.type('signin-password', 'HikamStudent1'); await t.tap('signin-student'); } },
      { say: 'You land on To do: everything you owe, soonest first.', do: (t) => t.waitTitle('To do') },
      {
        say: 'The first time, it offers to send you notifications: when a recording is ready, and before a deadline. Enable notifications to get them, or Not now to decide later, under More.',
        // The card stays while the line describes it; Not now as the line reaches it.
        do: async (t) => { await t.highlight('nudge-enable-push'); await t.wait(5500); await t.tapText('Not now'); },
      },
    ],
  },
  {
    id: 'student-to-do',
    as: 'student',
    steps: [
      { say: 'To do is the first screen you see.', do: (t) => t.waitTitle('To do') },
      { say: 'It lists the recordings you need to play, and the assignments you need to hand in, soonest first.', do: (t) => t.scroll(300) },
      { say: 'The one to do next is at the top.', do: (t) => t.scroll(-300) },
      { say: 'Each card says which class it is from, and its date: watch by, listen by, or hand in by.', do: (t) => t.highlight('task-Memorize the first hikma') },
      { say: 'Missed ones stay on the list, quietly, so you can see what they were. Done holds what you finished in the last two weeks.', do: (t) => t.scroll(700) },
      { say: 'Tap a card to open it.', do: async (t) => { await t.scroll(-700); await t.tap('next-up-Session 3 — Patience in Hardship'); } },
      { say: 'A recording opens in the player.', do: (t) => t.waitEnabled('player-play') },
    ],
  },
  {
    id: 'student-playing',
    as: 'student',
    start: (t) => t.tap('next-up-Session 3 — Patience in Hardship'),
    steps: [
      { say: 'This is the player.', do: (t) => t.waitEnabled('player-play') },
      {
        say: 'A long title slides along its line. Tap it to read it whole, and again to fold it back.',
        cut: 'phone',
        do: async (t) => { await t.tap('player-title'); await t.wait(1400); await t.tap('player-title'); },
      },
      { say: 'This class has video. Choose a version: slides and speaker, or audio only. You carry on from the same moment.', do: async (t) => { await t.tap('player-version-audio1'); await t.wait(1200); await t.tap('player-version-video1'); } },
      { say: 'The round button plays and pauses.', do: (t) => t.tap('player-play') },
      { say: 'The side buttons skip back fifteen seconds, and ahead thirty.', do: async (t) => { await t.tap('player-back'); await t.wait(700); await t.tap('player-forward'); } },
      { say: 'Choose the speed beside the times.', do: (t) => t.select('player-rate', '1.5') },
      { say: 'Your place is saved as you go, on any device.', do: (t) => t.wait(400) },
      { say: 'You can leave this screen and it keeps playing. The bar at the bottom brings you back.', do: async (t) => { await t.tap('tab-classes'); await t.wait(1500); await t.tap('mini-player-open'); } },
    ],
  },
  {
    id: 'student-complete',
    as: 'student',
    start: (t) => t.tap('next-up-Session 3 — Patience in Hardship'),
    steps: [
      { say: 'When you have finished a recording, mark it complete.', do: (t) => t.scrollTo('mark-complete') },
      { say: 'The button is ready once you have pressed play at least once.', do: (t) => t.highlight('mark-complete') },
      { say: 'Tap Mark complete.', do: (t) => t.tap('mark-complete') },
      { say: 'It moves to Done on your list. If you are offline, the app keeps your mark, and sends it when you are back.', do: async (t) => { await t.tap('tab-todo'); await t.wait(800); await t.scroll(900); } },
    ],
  },
  {
    id: 'student-assignment',
    as: 'student',
    steps: [
      { say: 'Assignments appear on To do, with the date to hand them in by.', do: (t) => t.highlight('task-Memorize the first hikma') },
      { say: 'Open one to read your teacher’s instructions, and any files they attached.', do: (t) => t.tap('task-Memorize the first hikma') },
      { say: 'Write your answer in the box. Bold, lists and links are on the bar above it.', do: (t) => t.append('work-note', 'I recited it twice, slowly, and wrote out the words I found hardest.') },
      { say: 'Tap the paperclip to add files: a document, a picture, or a recording.', do: (t) => t.attach('attachments-add-work', 'attachments-files-work', [WORKSHEET]) },
      { say: 'Everything saves as you go. When it is ready, tap Hand in.', do: (t) => t.tap('work-hand-in') },
      { say: 'Until the due date, and until it is returned, Take back lets you change it and hand it in again.', do: (t) => t.highlight('work-take-back') },
      { say: 'When your teacher returns your work, your grade and feedback appear at the top.', do: async (t) => { await t.tap('tab-todo'); await t.wait(800); await t.tapIfShown('task-Reflection on the first hikma'); } },
    ],
  },
  {
    id: 'student-classes',
    as: 'student',
    steps: [
      { say: 'Classes lists the classes you are in.', do: (t) => t.tap('tab-classes') },
      { say: 'Open one to see your own record.', do: (t) => t.tap('myclass-Hikam Foundations') },
      { say: 'One line counts the meetings you were present for, absent from, and excused from.', do: (t) => t.highlight('attendance-tally-excused') },
      { say: 'Where you were excused, the row says a recording was required, and whether you completed it.', do: (t) => t.scroll(350) },
      { say: 'The Assignments tab shows every assignment in the class, and where it stands.', do: async (t) => { await t.scroll(-350); await t.tap('class-tab-assignments'); } },
    ],
  },
  {
    id: 'student-notifications',
    as: 'student',
    steps: [
      { say: 'To choose which messages the app sends you, open More, then Notifications.', do: async (t) => { await t.tap('tab-more'); await t.tap('more-notifications'); } },
      { say: 'If this device is not set up for them yet, Enable notifications asks for permission.', do: (t) => t.highlight('enable-push') },
      { say: 'There are five kinds, and all start switched on. Tap one to turn it off.', do: (t) => t.tap('notify-lastDay') },
      { say: 'Tap it again to turn it back on. Tapping a message opens what it is about.', do: (t) => t.tap('notify-lastDay') },
    ],
  },
  // --------------------------------------------------------------------- staff
  {
    id: 'staff-today',
    as: 'admin',
    steps: [
      { say: 'Today is what is waiting on you, across your courses, most urgent first.', do: (t) => t.waitTitle('Today') },
      { say: 'Attendance not taken comes first: until a register is submitted, nobody in that class has access to its recording.', do: (t) => t.highlight('today-att-g-s5') },
      { say: 'Then recordings waiting to publish, classes with no recording yet, access closing soon, and work to grade.', do: (t) => t.scroll(600) },
      { say: 'Each row opens the screen where you do it, and leaves Today as soon as it is done.', do: async (t) => { await t.scroll(-600); await t.tap('today-att-g-s5'); } },
    ],
  },
  {
    id: 'staff-attendance',
    as: 'admin',
    start: (t) => t.openSession('Session 5 — Reliance and Trust'),
    steps: [
      { say: 'Attendance is taken on the session.', do: (t) => t.waitFor('att-submit') },
      { say: 'Everyone starts as present. Mark who was away.', do: (t) => t.tap('att-Bilal Khan-absent') },
      { say: 'Excused is the mark that gives a student the recording, and makes it required, until the due date.', do: (t) => t.tap('att-Fatima Ahmed-excused') },
      { say: 'Mark all excused when everyone should catch up on this one.', do: (t) => t.highlight('att-mark-all-excused') },
      { say: 'Tap Submit attendance. You can correct it, and submit again, later.', do: (t) => t.tap('att-submit') },
      { say: 'A note at the top of the register confirms it.', do: (t) => t.highlightText('Attendance submitted for') },
    ],
  },
  {
    id: 'staff-recording',
    as: 'admin',
    start: (t) => t.openSession('Session 7 — Today (recording pending)'),
    steps: [
      { say: 'When a class has no recording yet, add it on its session.', do: (t) => t.scrollTo('recording-upload') },
      { say: 'Upload files from this device, or import them from Zoom.', do: (t) => t.chooseFiles('recording-upload', [AUDIO_FIXTURE]) },
      { say: 'The files are listed before anything is sent. Tap Upload.', do: (t) => t.tap('upload-start') },
      { say: 'Each file shows how far it has got.', do: async (t) => { await t.waitFor('upload-done', 90000); await t.tap('upload-done'); } },
      { say: 'Each file’s name plays it, so you can check it. The eye hides a file from students.', do: (t) => t.scrollTo('recording-media') },
      { say: 'The plus beside Files adds more, from this device or from Zoom.', do: (t) => t.highlight('recording-add') },
      { say: 'When it is ready, tap Publish. The students you excused can now play it.', do: (t) => t.tap('recording-published') },
      { say: 'Archive and Unpublish are under the menu beside its status.', do: (t) => t.highlight('recording-actions') },
    ],
  },
  {
    id: 'staff-progress',
    as: 'admin',
    start: async (t) => { await t.openSession('Session 3 — Patience in Hardship'); await t.scrollTo('recording-ledger'); },
    steps: [
      { say: 'Progress shows who has played a recording. Open it from its session, or from the library.', do: (t) => t.tap('recording-ledger') },
      { say: 'The line at the top counts who it is required of, who completed it, who has not, and who missed it.', do: (t) => t.highlight('ledger-counts') },
      { say: 'It opens on Not complete: the people who still need a nudge. All lists everyone it is required of.', do: (t) => t.tap('ledger-filter-all') },
      { say: 'If a student caught up another way, tap the pencil on their row.', do: (t) => t.tapFirst('override-open-') },
      { say: 'Give a reason. It is recorded, and they see it. Then mark them complete.', do: async (t) => { await t.typeFirst('override-reason-', 'Caught up with the teacher after class.'); await t.tapFirst('override-complete-'); } },
      {
        say: 'Their row now says Completed, with your reason under it.',
        do: async (t) => { await t.waitText('ledger-row-Fatima Ahmed', 'Completed (override)'); await t.highlight('ledger-row-Fatima Ahmed'); },
      },
    ],
  },
  {
    id: 'staff-assignment',
    as: 'admin',
    start: (t) => t.openCourseNav('nav-coursework'),
    steps: [
      { say: 'A course’s assignments are on its Assignments page. The plus starts a new one.', do: (t) => t.tap('coursework-new') },
      { say: 'Give it a title and instructions. Bold, lists and links are on the bar.', do: async (t) => { await t.type('coursework-title', 'Week 3 worksheet'); await t.tap('coursework-instructions'); await t.typeFocused('Complete both pages, and bring your questions to class.'); } },
      { say: 'Add files with the paperclip: worksheets, pictures, or audio.', do: (t) => t.attach('attachments-add-coursework', 'attachments-files-coursework', [WORKSHEET]) },
      { say: 'Choose the date to hand it in by, how it is graded, and whether late work is accepted.', do: (t) => t.scrollTo('coursework-accept-late') },
      { say: 'Post sends it to everyone in the class, and tells them. Save as draft keeps it for staff.', do: (t) => t.tap('coursework-post') },
    ],
  },
  {
    id: 'staff-grading',
    as: 'admin',
    start: async (t) => { await t.openCourseNav('nav-coursework'); await t.tap('coursework-Memorize the first hikma'); },
    steps: [
      { say: 'An assignment’s page counts who has handed in, and lists the class.', do: (t) => t.waitFor('coursework-grade') },
      { say: 'Tap Grade to open the first piece of work waiting.', do: (t) => t.tap('coursework-grade') },
      { say: 'Read their answer and their files, then enter the grade, and feedback.', do: async (t) => { await t.type('grade-points', '9'); await t.type('grade-feedback', 'Steady and clear. Well done.'); } },
      { say: 'It saves as you type, and only staff see it.', do: (t) => t.wait(600) },
      { say: 'Return now sends it back, and the student is told. Or move to the next, and return them together at the end.', do: (t) => t.tap('grade-return') },
    ],
  },
  {
    id: 'staff-students',
    as: 'admin',
    start: (t) => t.openCourse('Arabic I'),
    steps: [
      { say: 'A course’s roster is on its page. Tap a student to see their progress in the course.', do: (t) => t.scrollTo('roster-add') },
      { say: 'The plus adds students who are not in the course yet. It stays open while you add several.', do: async (t) => { await t.tap('roster-add'); await t.tapFirst('enrol-'); await t.wait(1500); await t.closeSheet(); } },
      { say: 'The cross at the end of a row takes a student off the course, after asking. Their history is kept.', do: async (t) => { await t.tapFirst('roster-remove-'); await t.wait(1200); await t.tapText('Cancel'); } },
      { say: 'People lists every student. Open one for their courses and their history.', do: async (t) => { await t.tap('tab-people'); await t.tap('student-open-fatima.ahmed@example.com'); } },
      { say: 'The menu beside their name sends a new password link, or exports their record.', do: (t) => t.tap('student-actions') },
    ],
  },
  {
    id: 'staff-report',
    as: 'admin',
    start: (t) => t.openCourseNav('nav-attendance'),
    steps: [
      { say: 'The attendance report rolls a course up, by session.', do: (t) => t.waitFor('attendance-tab-students') },
      { say: 'Or by student, with what each was required to catch up on.', do: (t) => t.tap('attendance-tab-students') },
      { say: 'Tap any row to go straight to that student, or that session.', do: (t) => t.tapFirst('attendance-student-') },
      { say: 'On the course page, Export workbook saves the whole course as one spreadsheet.', do: async (t) => { await t.goBack(); await t.goBack(); await t.highlight('course-export'); } },
    ],
  },
  {
    id: 'staff-library',
    as: 'admin',
    steps: [
      { say: 'The library is every recording you can see, in one list.', do: (t) => t.tap('tab-library') },
      { say: 'Narrow it by cohort, course, or status. The cross clears them.', do: async (t) => { await t.select('library-status', 'published'); await t.wait(800); await t.tap('library-clear'); } },
      { say: 'Tap a row to play the recording.', do: (t) => t.tap('library-play-Session 3 — Patience in Hardship') },
      { say: 'And the small chart at a row’s end opens its progress.', do: async (t) => { await t.goBack(); await t.tap('library-progress-Session 3 — Patience in Hardship'); } },
    ],
  },
  // -------------------------------------------------------------------- admins
  {
    id: 'admin-staff',
    as: 'admin',
    steps: [
      { say: 'New staff sign in with their Sabeel Google account, and wait for you to approve them.', do: async (t) => { await t.tap('tab-people'); await t.tap('segment-staff'); } },
      { say: 'Approve them as a manager, who runs the courses you give them, or as an admin.', do: (t) => t.tap('approve-nadia.karim@oursabeel.com') },
      { say: 'The menu on a colleague’s row changes their role, or disables them.', do: (t) => t.tap('staff-actions-nadia.karim@oursabeel.com') },
    ],
  },
  {
    id: 'admin-structure',
    as: 'admin',
    steps: [
      { say: 'Courses lists the cohorts: each a term, and the courses taught in it.', do: (t) => t.tap('tab-courses') },
      { say: 'Open a cohort to see its courses. The plus adds one, and the pencil renames the cohort.', do: async (t) => { await t.tap('cohort-open-Autumn 2026'); await t.highlight('courses-add'); } },
      { say: 'On a course, tick who manages it: a manager sees only the courses they are ticked on, and an admin who teaches the course can be ticked too.', do: async (t) => { await t.tap('course-open-Hikam Foundations'); await t.highlight('course-manager-faisal.shah@oursabeel.com'); } },
      { say: 'Its settings decide whether recordings stay open after the course is archived, and archive it when the term ends.', do: (t) => t.highlight('course-archived-access') },
    ],
  },
  {
    id: 'admin-audit',
    as: 'admin',
    steps: [
      { say: 'Audit history, under More, records every change that matters: who, what, and when.', do: async (t) => { await t.tap('tab-more'); await t.tap('more-audit'); } },
      { say: 'A course’s own history is on its page, and its managers can read it too.', do: (t) => t.scroll(500) },
    ],
  },
];
