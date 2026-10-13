# Phase status

Live build status. Phases from `PLAN.md`; a commit lands at each phase boundary.

Nine phases, not ten: Phase 2 was absorbed into Phase 1. The later numbers are
deliberately NOT renumbered — they are referenced from `PLAN.md`, code comments
and commit messages, and renaming them would strand every one of those.

| Phase | What | Status |
|---|---|---|
| 0 | Scaffold, theme, CI green | **complete** (2026-07-21: token screen verified on tb_emu AVD + web export, rules suite mutation-tested, full chain green) |
| 1a | Identity: two auth populations, roles, approval | **complete** (2026-07-21) |
| 1b | Academic structure: cohorts, classes, enrollments, manager scoping | **complete** (2026-07-22) |
| 1c | Rules hardening, e2e harness | **complete** (2026-07-22) |
| ~~2~~ | *Academic structure — absorbed into Phase 1, see the decision log* | — |
| 3a | Media spike: background audio, seek, rate | **complete** (2026-07-22) |
| 3b | Ingestion & lifecycle: upload → Storage → draft → publish | **complete** (2026-07-22) |
| 3c | Playback: signed URLs, player, progress | **complete** (2026-07-22) |
| 3d | Offline downloads | deferred to its own phase |
| 4a | Client persistence seam (offline groundwork) | **complete** (2026-07-22) |
| 4b | Assignments model, publish fan-out trigger, rules | **complete** (2026-07-22) |
| 4c | Student experience: home ordering, mark-complete, offline | **complete** (2026-07-22) |
| 4d | Catch-up assignment UI + polish | **complete** (2026-07-22) |
| 5a | Audit spine: auditedCall wrapper + auditLog | **complete** (2026-07-22) |
| 5b | Staff ledger reads + completion override | **complete** (2026-07-22) |
| 5c | Ledger + library + audit UI | **complete** (2026-07-22) |
| 5d | CSV export + polish | **complete** (2026-07-22) |
| 4 | Assignments, progress, completion | **complete** — see 4a–4d above |
| 5 | Staff ledger, reporting, audit | **complete** — see 5a–5d above |
| A | Excused-only access, with a deadline | **complete** (2026-08-14) |
| B | The student's own attendance record | **complete** (2026-08-14) |
| 6 | Zoom import | **built** — waiting on institute credentials and its first live import |
| 7 | Notifications | **complete** (2026-08-15: delivered to an Android device end to end; web delivery still a browser check) |
| 8 | Admin backend stats | not started |
| 9 | Deploy, manual, release | **complete** (2026-10-11: v0.7.1 deployed, device pass on tb_emu, published to both release homes and the download page) |

## Decision log

- 2026-10-13 — **Staff upload several files, video included** (video plan
  V3). Every upload is multipart in 16 MiB pieces, signed a batch at a time
  and sent straight to the bucket, each piece retried alone; the server joins
  them and then PROBES what arrived, reading the file's own headers in a few
  range requests (music-metadata 11.16.1 over `@tokenizer/range`, about 0.4
  MiB for a 184 MiB MP4 with its index at the end). Anything but AAC, MP3 or
  PCM audio, or H.264 in MP4, is deleted with how to export it instead, and
  the stored length is the file's own. Each file is a new part or a version
  of one, on a recording in any state. Write-once now rests on the upload id:
  a client holds part URLs only, and a completed upload takes no more parts —
  checked against production R2 in `s3-conformance.mjs`. Remove aborts an
  upload in flight, and may take a file students never saw off a published
  recording; a daily sweep clears what is left. On tb_emu a 45 MB video went
  up in three parts from the system picker, read through expo-file-system's
  FileHandle and sent with `expo/fetch`, and landed byte-exact.
- 2026-10-13 — **The words follow the recording** (video plan V6). A card,
  a ledger row and the player say "Watch by" when the student can play any
  video of the recording and "Listen by" when it is audio only; buttons say
  Play. Where no single recording decides it the words name neither: the
  student's home and tab are "Your recordings" / Recordings, staff set a
  session's **Due by** date, the archived-course switch opens and closes
  recordings, and the workbook says Completed, Played and Due by. The
  notifications lost their "listen" verbs the same way. The manual covers
  versions, parts, the Zoom picker and the media list. Admin stats stay with
  Phase 8. The player's fullscreen control is an icon over the picture's
  corner. Deployed (functions and hosting) the same day. On tb_emu the icon
  draws over expo-video's native view, opens its full-screen activity, and
  Back returns to the player still playing.
- 2026-10-13 — **Students watch and listen by part and version** (video plan
  V5). One engine, expo-video, plays audio and video on Android; the web uses
  a `<video>` element. Proven three ways: `playback.test.ts` (resume in the
  saved part and version, a version switch that keeps the place and counts
  nothing, auto-advance, the last part's end); the browser e2e, which adds a
  video version to the student's recording mid-session, switches to it at
  541 s and lands on 541 s with the picture showing, plays it, and switches
  back keeping the place (155 checks and the three new ones green); and
  `tb_emu`, where the debug build switched audio to video at 0:11 with the
  picture's own clock agreeing, went to picture-in-picture on Home, kept its
  foreground service and `USAGE_MEDIA` playback in the background, and showed
  title, course and working pause on the lock screen. Rules (progress may
  carry `part` and `version`) and hosting deployed; smoke green.

- 2026-10-13 — **Zoom imports take any file, and the session page lists a
  recording's files** (video plan V2 and V4, commits `dafbe2d`, `117edfb`,
  `4a97f7b`). The picker lists every meeting with its segments and formats
  and imports several files at once; a Cloud Tasks queue (`copyZoomFile`)
  copies each through the Worker, which now takes Zoom's MP4s. The session
  page shows parts and versions with their state, and staff hide, show,
  remove, reorder and choose the starting version. Deployed in order (Worker,
  functions, hosting); the queue needed the Cloud Tasks API, three grants and
  a workaround for a firebase-tools bug (DEPLOY.md). Proven on production: the
  real Zoom account listed 18 meetings in all three formats; a speaker video
  and its audio imported in 2.4 s, the queue copied both in 13 s, both played
  from R2 with their content types, and deleting the session released both
  claims. Students still play one file per recording until the player
  learns parts and versions (V5).

- 2026-10-12 — **Recordings hold media items** (video plan V1, commit
  `7a34552`). A recording's one `audioPath` became a `media` map of items
  (part, version, status, storage key), with `durationSec` derived from the
  playable ones and Zoom files claimed in `zoomImports/{fileId}`. The UI still
  takes one audio file per recording; V3 and V4 lift that. Worker, functions
  and hosting deployed in that order; the 10 recordings already here were
  converted in place (8 files, all present in R2 at their recorded size, 8
  claims) and the switchover seed now converts as it copies. Proven on
  production: a converted recording plays from R2, and a real Zoom file
  imported through the Worker landed at `media/{recording}/{item}`, claimed,
  played, and was released on delete. Local loop green, including
  `test:e2e` (155 checks, upload and playback through the item path).

- 2026-10-12 — **Listening on the lock screen keeps its place across an app
  kill.** Found in the release device pass on `oursabeel-lms`: progress saved
  while the app was in the background did not reach the server until the app
  came back, and was lost if it was closed first. React Native stops JS
  timers in the background and the Firebase SDK's network runs on them; the
  audio and its ticks carry on. Every save is now also journalled on the
  device (`app/src/progressJournal.ts`, AsyncStorage, one key per progress
  document), replayed on launch and merged when the recording is reopened,
  and the write queue keeps one write in flight and at most one waiting per
  document, where it had queued one per 15-second save. Proven on `tb_emu`
  against production: played, backgrounded 70 s, paused from the media
  controls, force-stopped. The server stood at the pre-background place, held
  the paused place within seconds of relaunch, and the player resumed there.
  Same pass, release build against production: student sign-in, push
  delivered on its channel and opening the app, playback from R2, seek and
  speed, background playback with the foreground service, lock-screen
  controls, and a staff upload from the phone (byte-exact on R2, duration
  read on device) played back.

- 2026-10-11 — **v0.7.1 shipped to every surface** (build commit `56c3c8d`,
  versionCode 34): functions → hosting, `smoke:prod`, `check:queries` and
  `check:push` green against the live project, CI dispatched by hand and
  green on the build commit, tagged, both release homes, download page and
  manual PDF. Functions went out from `32a16dd`; nothing under `functions/`
  or `packages/` changed after it. In it: the Zoom picker's hours and its
  same-day filter, and Zoom recordings dated by the institute's calendar in
  the picker and in the range the server asks Zoom for.
  Device pass on `tb_emu`. The release APK installed at `v0.7.1 · 56c3c8d`,
  versionCode 34, with no dev panel. The debug build against the emulators:
  on Hermes the audit log printed an entry stamped 18:05 UTC as
  `2026-10-10 13:05` and a 1 am one as `01:14`, the 24-hour institute clock
  (`wallClock`) the picker's AM/PM is built from; at font scale 1.3 the
  picker's date checkbox label wraps to two lines inside the column, the
  whole row toggles it, and Android reads its checked state.
  What no emulator can show: the picker's cards against the live Zoom
  account, since the emulator holds no Zoom credentials. That is Faisal's
  check on production.
  Seen during the pass and not from this release (nothing in
  `app/src/components` changed since v0.7.0): on a tab root with no header,
  such as Today, scrolled content passes under the status bar's clock and
  icons.

- 2026-09-17 — **v0.7.0 shipped to every surface** (build commit `8cbddc5`,
  versionCode 33): rules → functions → hosting, `smoke:prod` and
  `check:queries` green against the live site, tagged, both release homes,
  download page and manual PDF. In it: the two Excel workbooks in place of
  the CSV exports; the queue's stale-scope fix (SABEEL-RECORDING-WEB-4,
  resolved with this release); Sentry events carrying release and role, never
  identity; `setCourseManagers` auditing who was added and removed; the
  minimum-build gate (`config/app.minVersionCode`, unset — the floor raise to
  33 is Faisal's, TODO §7); a push shown while the app is open, on both
  surfaces. Device pass on `tb_emu` with the debug build against the
  emulators and a REAL push to its token (`scripts/send-test-push.mjs`):
  with the app open, expo-notifications drew it — `dumpsys` record tagged
  with the FCM message id, `icon=…id=0x7f080102` = `drawable/ic_notification`,
  `color=0xff83114f`, channel `sabeel-alerts`, tap brought the app forward;
  with the app in the background, FCM drew it — record tagged
  `FCM-Notification:…`, the same icon id and colour, tap launched the app.
  The release APK installed clean at `v0.7.0 · 8cbddc5` with no dev panel.
  What no emulator can show and remains for a person: the web banner on a
  focused tab (`onMessage` → `showNotification`), which needs a signed-in
  production browser holding a token.

  **Two things the first deploy taught.** (1) `firebase deploy --only
  functions` failed every container's start-up probe — `Cannot find module
  'fflate'`: esbuild inlined `@sabeel/shared` from its compiled CommonJS
  `lib/`, which cannot be tree-shaken, so the app-only .xlsx writer and its
  dependency rode into a package that never declared it. Cloud Run kept the
  previous revisions serving throughout; nothing local could see it because
  the emulator resolves the hoisted workspace `node_modules`. Fixed in
  `fcaf658` (inline from source, `sideEffects: false`, a static import in
  place of the one lazy `require` that had switched tree-shaking off) and
  held by `bundleExternals.test.ts`, which builds the real bundle and
  refuses a bare `require()` this package does not declare. (2) A release
  rebuilt after a JS-free commit reused the cached bundle with the previous
  label — `EXPO_PUBLIC_COMMIT` is not a Gradle input; DEPLOY.md says how to
  tell and what to check.

- 2026-09-17 — **A push is shown whether the app is open or closed, on both
  surfaces.** Faisal's decision, made after the sibling kanban app showed the
  same push in two styles on his phone. Until now a push that arrived while
  this app was OPEN was dropped silently on both surfaces, and only a comment
  in the manifest said so: on Android, FCM displays a message itself only
  when the app is in the background or closed, and in the foreground hands it
  to expo-notifications, whose default with no `setNotificationHandler` is
  to show nothing; on the web, FCM's service worker forwards a message to any
  visible window instead of displaying it, and `push.web.ts` never wired
  `onMessage`. Now `push.ts` registers a handler at module scope (banner and
  list, no sound — the person is already in the app) and the manifest carries
  the `expo.modules.notifications` icon and colour pair beside FCM's, pointing
  at the same resources, because expo-notifications' fallback is the launcher
  icon untinted — kanban's symptom (`notificationIcon.test.ts` holds the two
  pairs to one resource). On the web, once the tab holds a token it listens
  with `onMessage` and shows the payload through the worker's registration,
  marked `data.page`; the worker's `notificationclick` acts only on those,
  focusing an open window or opening the app, and leaves FCM's own banners to
  the SDK. One banner, never two: the worker displays only when no window is
  visible, and `onMessage` fires only when one is. Tests: `push.test.ts`
  (the handler and its answer), `push.web.test.ts` (listened for once a token
  is held, shown with title and body, not listened for while push is
  unavailable), `serviceWorkerConfig.test.ts` (the marker the page sets is
  the one the worker checks). What no test can reach is delivery itself —
  no emulator sends a push — so the device check is a real message to a real
  device with the app open and then closed, and the `dumpsys notification`
  icon id for both.

- 2026-09-17 — **Sentry SABEEL-RECORDING-WEB-4, triaged and reproduced: a
  manager's cold load refuses the work queue when the cached course list is
  stale.** Three incidents in one Sentry group (grouped by the frame that
  reports every listener failure): 2026-09-15 20:43Z on the People tab, with
  `students`, `allCourses`, `todaySessions` and `todayRecordings` all refused;
  2026-09-16 03:37Z on Today and 2026-09-16 19:30Z on a student's ledger, each
  refusing ONLY `todaySessions` and `todayRecordings` while the courses listener
  that feeds them, and everything else on the screen, was served. Breadcrumbs on
  the last two show a cold page load: token refresh, Listen stream opened,
  the two refusals, nothing else.

  **The mechanism, reproduced locally** (`scripts/repro-stale-scope.mjs`,
  against the emulator and the e2e dev server): the shell builds the queue's
  `courseId in [...]` scope from the FIRST courses snapshot, which on a cold
  load with IndexedDB persistence comes from the cache. Rules judge every `in`
  value against live data — each value must pass — and `get(courses/X)` on a
  course that no longer exists is an evaluation error, so one course the
  manager no longer runs (deleted, or they were taken off it while their
  browser was closed) refuses the whole query. The server's courses snapshot
  then changes the scope and the re-issued queries succeed: a banner flash and
  two Sentry events per stale state, self-healing, no data exposed. The
  emulator's error text names the line production hides (the sessions rule's
  `.data.managerUids` on a missing course). Both `delete` and `remove` variants
  reproduce the signature; the control does not. Two refusals per label on
  2026-09-15 night were two stale states before the server caught up. The demo
  wipe of 2026-09-11 deleted courses, which is the likeliest way a real
  manager's cache came to hold one.

  The first incident is a different cause: a token that was not staff at all
  under an admin's tab while the session believed itself readable — most
  likely a second tab of the same browser signed in as a student, since
  Firebase Auth shares the credential across tabs. Unconfirmed; the Auth
  sign-in times around that minute would settle it.

  **Not fixed yet.** The fix is for the queue's `in` queries to stop being
  judged on a cache-derived scope, or for a refusal of one to stop counting as
  an error: expose `fromCache` from the courses `State` hooks and treat the
  queue's refusal as expected until the server has confirmed the scope. The
  repro script is the test — `delete` and `remove` must report no refusal and
  still render the queue, `none` unchanged. Two diagnostic gaps found on the
  way: the web Sentry init sets no `release` and no user, so no event says
  which build or which account; and every listener failure shares one issue.
  Also seen: SABEEL-RECORDING-ANDROID-3 is a student still on the 12 August
  APK 0.3.0, whose `studentRecordings` listener the excused-only rules of
  2026-08-15 refuse; there is no minimum-version gate.

  **Production checks, 2026-09-17 (read-only, Admin SDK; uids by email).**
  Incidents 2 and 3 are the `remove` variant, and the removal is dated: on
  2026-09-15 20:41–20:44Z the admin cleared the managers of four courses and
  archived three (`setCourseManagers` and `updateCourse {archived:true}` on
  Quran Immersion, Tafseer, Arabic Year 3, Board meetings). Both managers
  in the incidents had acted AS managers on those courses — Khadija in Quran
  Immersion and Board meetings, Rida in Quran Immersion and Tafseer (their
  own audit rows and session writes) — so both were on their `managerUids`
  before that minute, and neither is now. Khadija had been signed in since
  2026-09-10 (a persisted session; her `createSession` lands at 03:38Z, one
  minute after incident 2, Chrome/Mac); Rida's Safari opened cold at 19:30Z
  on 2026-09-16 and her `createSession` rows follow at 19:30–19:35Z (she
  re-signed-in at 20:10Z). Each browser's cached course list still held a
  course whose `managerUids` no longer named them; the manager arm judges
  every `in` value, so the queue's two queries were refused until the
  server's course list replaced the scope. The demo wipe is not involved:
  the demo seed made only demo staff managers of demo courses, and no audit
  row since 2026-09-01 names a course that no longer exists. Diagnostic gap
  found on the way: `setCourseManagers` audits no detail, so the rows say a
  course's managers changed and not who was added or removed.

  Incident 1 is not a student tab. No student signed in or refreshed a token
  on 2026-09-15 after 02:21Z (`test.student@oursabeel.com` has never signed
  in; Test One last on 2026-08-25). What the minute holds is the admin
  herself: `lastSignInTime` 2026-09-15 20:43:25Z — a fresh sign-in — while
  her existing session was mid-burst (`setCourseManagers` at 20:41Z,
  `renameCohort`, three `setCourseManagers` and an archive at 20:43Z, more
  at 20:44–20:45Z). The refused labels are exactly the admin-only reads.
  The most consistent account is listeners issued across the credential
  swap of a re-sign-in in a browser that already had an admin tab open;
  unconfirmed, and it cannot be settled from stored data — the release,
  user id and role that item B adds to web events are what would settle a
  recurrence.

- 2026-09-11 — **Five review passes over the whole product, and what they
  found.** Five read-only reviews in parallel — backend callables and
  triggers; rules against every client query; client playback and sync logic;
  every screen's states; identity, notifications and the ops scripts — each
  asked for `file:line` evidence, a reproduction, a proposed test and a note
  on what else the change would touch. Every finding below was then confirmed
  by a test that is red on the old code before anything was changed, or by
  tracing the path end to end where a test cannot reach. Fixed:

  **Entitlement and data.** A closed session revived a lapsed grant on any
  later edit (the fixture that hid it had dates that were "next month" when
  written and closed by September). `createRecordingDraft`, `applyEnrollmentActive`
  and `clearOverride` were read-then-write like the enrolment double tap, and
  are transactions now; the wrapper writes no audit row for a call that
  changed nothing (`audit.noop`). `retryZoomImport` would re-download over a
  published recording's audio and drop it to draft. `createStudent` left an
  orphan Auth user when an admin named a stale course, and accepted a
  colleague's `@oursabeel.com` address — which would have folded that
  colleague's first Google sign-in into a student account with no way into
  the approval queue. Dates like `2026-99-99` passed validation. The register
  wrote "present" for a student who joined the class after a session was
  taken, on the next correction of anybody else's mark.

  **Notifications.** A send that failed kept its once-marker, so the one
  delivery was spent on nobody, and the trigger did not retry. The last-day
  reminder was keyed on the recording alone, so a reopened session's new last
  day passed in silence. Neither student message respected an archived
  course with listening off, nor (recordingReady) a due date already gone.

  **Rules.** The two student-written collections took any type, so a string
  `updatedAt` would have thrown in the ledger's date formatter for every
  staff member of that class. A student removed from a class went on reading
  it — the enrolment row exists for the history. Missing positive halves of
  four rules tests added.

  **Client.** The signed-URL cache reused a URL that would expire before the
  recording ended. The native outbox replayed an old completion over a newer
  one made on another device, an acknowledgement could forget a queued
  un-mark, and two mutations could erase each other's entry. Audio failures
  printed "audio error 2"; Storage failures printed the object path. The
  player route re-used one instance across recordings; the cohort page was
  reachable by a manager by URL; the player and the docked bar held a
  student's deadline as it was when the link was made, not as their grant
  has it now; a staff card and the ledger's override editor re-enabled
  before the snapshot confirmed; the ledger said "no one was excused" of a
  register never taken; two loading states stated an answer before the
  listener had one; a slash in a course name broke the phone's CSV export
  silently; the gate screen polled every three seconds for as long as it was
  open.

  **Ops.** `seed-demo-prod` wrote fabricated completions, progress and
  overrides over REAL students' active grants (flagged as demo, so the wipe
  then deleted them) — filtered to demo grants, and its committed password
  minted per run. Checked against the live data: every real completion event
  has its document and every real grant its progress, so nothing real was
  lost. `prod-smoke`'s two bundle checks could not fail (an idle sign-in
  screen makes no Auth request; the dev row's id was wrong); it now provokes
  one and matches the prefix. The wipe's verify reads the `sent` and
  `devices` groups and every Auth page.

  **Reviewed and left as decisions**, recorded in TODO.md: whether a callable
  should check the token against the user record on every call, closing the
  up-to-an-hour window a disabled account keeps by holding its token (one
  Auth lookup per call); whether the student home should move an archived
  course's recordings out of "required listening"; whether the three
  student-write creates should require an ACTIVE grant rather than any
  grant; the remaining empty states that render before the first snapshot.

- 2026-09-11 — **A review of v0.6.0 against production found the double tap.**

  Reading the five features back against the live data before Faisal tried
  them, rather than against the fixture that shipped them. Two things the
  fixture could not show:

  1. **Two enrolments from one tap.** Two `createEnrollment` audit rows 24 ms
     apart for the same student and course — twice over, for two real students.
     The "Add a student" row was a bare `Pressable` with no in-flight lock, and
     stayed listed until the roster snapshot took it away; a second tap in that
     window sent a second call, and `createEnrollmentRecord` read "not enrolled"
     for both before either wrote. Nothing was wrong on the roster — the two
     writes set the same document — but the History card, which reads those
     rows, said "Enrolled in Tafseer" twice. Three layers, each for a different
     reader: the callable now checks and writes inside a **transaction**, so
     the second call is refused as already enrolled (a concurrency test that
     is red on the old code); the row **locks on tap** and stays locked until
     the roster holds the student, the lock in a ref so a same-frame second
     click is refused before any render — the same shape as the manager rows,
     for the same reason; and `studentHistory` **collapses a row identical to
     the one before it**, by the same person, within a minute, because the two
     rows already in the log are one enrolment. The audit screen keeps showing
     both, because both calls ran.
  2. **Every student created before v0.6.0 had no "Enrolled in" line.** The
     page reads `targets.studentUid`, which the callables have written since
     8b250bb; the sixteen `createStudent` rows already in the log named the
     student under `targets.uid` (nine) or under nothing (seven — the wrapper
     derives targets from the payload, and a new account has no uid in it).
     `scripts/backfill-audit-student-key.mjs` adds the one key and nothing
     else, from `targets.uid`, from `detail.email`, or from the student the
     same actor created within five seconds before the row who is enrolled in
     the row's course; anything ambiguous is left alone. Dry run by default;
     run once, 16 of 16 keyed, and the History card now reads whole for every
     existing student. The manual's promise was already "from the day the
     account was created".

  Also found: the sign-in screen's fallback printed the raw message, and the
  functions SDK reports a server it cannot reach as the bare word `internal` —
  so a Google sign-in on a phone that lost signal between the chooser and the
  `accountExists` call would have shown `internal` in the error band. The copy
  now lives in `auth/signInMessage.ts` and falls back to `errorText`, which
  turns machine tokens away; the store-exemption guard reads that module too.

  Reviewed and left alone: the manager-scoped history query and its rules
  (served pinned to their courses, refused widened by one — asserted in
  `rules.audit.test.ts`); the library filters' pure logic (unit-tested at
  every branch, and the archived-cohort, cross-cohort-course and
  manager-with-no-courses cases driven in a browser); rename validation on
  the real control (blank and unchanged disabled, 121 characters refused with
  the server's sentence in the page, a rename followed live by the page title
  and by the History card's course label); the create-student picker with
  every course archived (hidden, creation still works, history reads
  "Account created" alone). Production after the demo wipe: every reference
  resolves — each Auth user has exactly one document and each document an
  Auth user, every enrolment, assignment, projection, recording and
  completion points at things that exist, every submitted mark has its
  projection, and the bucket holds audio for exactly the recordings that
  claim it.

- 2026-09-11 — **Five requests from use: a student's history, cohort and course
  filters on the library, a cohort rename, disabled staff out of the way, and
  archived courses out of the student picker.**

  1. **A student's page carries their history, read out of the audit log.** When
     the account was created and by whom (the student document's own
     `createdAt`/`createdBy`, which every student has), then every enrolment,
     removal, return, disable and re-enable — each with who did it and when.
     **Not a second record.** Every one of those changes already lands in
     `auditLog` through `auditedCall`, so the history is one query on the log
     under `targets.studentUid`, and `studentHistory.ts` is only the reading of
     it. What the log had to learn to make that reading honest: `createStudent`
     and `setStudentAccess` now name the student under `studentUid` (they named
     `uid`, the key `setStaffAccess` uses for a colleague), `setEnrollmentActive`
     records WHICH WAY (`detail.active` — it audited a removal and a return
     identically), and `createEnrollment` says when it was a return through
     "Add a student" (`detail.reenrolled`). A row from before the boolean was
     recorded reads as "Enrolment changed", never as a guessed direction. An
     admin reads by the student; a manager's read is pinned to the courses they
     run with the same `in` shape as the work queue, bounded at
     `QUEUE_SCOPE.manager`, and the card says that is what it lists. Two
     composite indexes (`targets.studentUid, at` and `courseId,
     targets.studentUid, at`), both in the shape probe. Disable/enable rows
     written before this change carry `targets.uid` and are not found — a few
     days of production, and the creation line does not depend on them.

  2. **The library filters by cohort and course, as dropdowns.** The brief had
     recorded status as the one filter, with cohort and class left to the
     Classes tab; by the third term the institute-wide list is mostly other
     terms. The shape is the sibling kanban's Search: a `Select` seam — a real
     `<select>` on the web, a `Sheet` of rows on native, one line until opened
     — and one rule between the two: the cohort narrows what the course
     dropdown offers, never the reverse, and choosing a cohort the chosen
     course is not in lets the course go (`libraryFilters.ts`, unit-tested on
     which recordings survive). The count line describes the narrowed set, and
     **Clear filters** exists only while something is narrowing. The same two
     controls serve a manager, built from the courses they run.

  3. **A cohort can be renamed** — `renameCohort`, its own callable rather than a
     `name` on `setCohortArchived`, because archiving cascades over every class
     and a rename touches one document; one call that might do either would
     have to be read twice in the audit log to know which. The name passes the
     rule a new cohort's does.

  4. **Disabled staff move into a closed Disabled section**, exactly as disabled
     students do, with Re-enable still on the card. "Everyone else" became
     "Staff".

  5. **The create-student picker offers only running courses** (`effectiveActive`,
     so a course switched off by its cohort's archiving goes too). Enrolling
     into an archived course is still possible from the course's own page — it
     is a deliberate act there and noise here.

  Proved on the web: the e2e drives the rename and its live heading, the picker
  with Hikam archived, the `<select>`s through every state and the clear
  control, Bilal's five-row history in order and the manager's pinned view,
  and the manager disabled into the section and re-enabled out of it; the
  sweep tours the staff Disabled section open, the library with a cohort
  chosen, and both student pages anchored on a seeded history row. Rules tests
  hold the manager's pinned read and refuse it widened by one course.

- 2026-09-07 — **The app can no longer create an account, which is what keeps it
  off the hook for in-app account deletion.**

  The decision is not this app's — it is
  `sabeel-institute-kanban/docs/STORE-RELEASE.md`, taken 2026-08-18 for all three
  apps — but only half of it had been implemented here. `CAN_CREATE_ACCOUNTS`
  already kept "Add a student" off the Android build. What was missing is the
  half that matters more: **staff Google sign-in still created an account for
  anybody**, and relied on the auth trigger to delete it again a moment later.
  Creation followed by cleanup is still creation, and it is exactly the state
  Kanban replaced.

  **Why it is worth the code.** Apple 5.1.1(v) and Play both require in-app
  account DELETION only if an app supports account CREATION — and Play triggers
  as well if the app "directs the user to an app account creation flow outside of
  the app". Satisfy neither and neither requirement is engaged. What that avoids
  is not a button: it is having to decide what happens to a student's academic
  record when they delete themselves, on a product whose whole subject is
  retained records. FERPA gives a right to inspect and amend, never to erase.

  `accountExists` verifies **Google's** ID token — not Firebase's, which is a
  different issuer and the confusing part — pins the audience to the web OAuth
  client id so a token minted for another client cannot be replayed, and asks
  Auth whether that address has an account. `signInWithCredential` is the line
  that would create one, and nothing reaches it until the answer is yes.

  **Only the Google door needed it.** `signInWithEmailAndPassword` cannot bring an
  account into existence — it fails when there is none — so the student door was
  never a trigger. Worth stating because the shared doc's "the mobile refusal
  applies to both doors" reads as though both needed building.

  **Two consequences, both intended.** A new colleague cannot sign in on the
  phone until they have signed in on the web once; the instruction goes in the
  onboarding email, because putting it in the app is the second trigger stated
  almost verbatim. And the refusal names no website: "This account isn't set up
  for the app yet. Contact your administrator."

  **What the tests assert is an absence.** Seven emulator tests on the callable,
  each checking the **user count** afterwards rather than the boolean — a version
  answering `exists: false` while quietly minting a record would pass a
  return-value test and fail the only promise anyone cares about. Two of them are
  the awkward cases: a real colleague on the allowed domain whose account does
  not exist yet is refused like any stranger, and an unverified address is refused
  even when it matches a real account. Five unit tests on the ordering, the
  load-bearing one being that `signInWithCredential` is never reached; shown to
  fail with the gate bypassed.

  **Still unverified, and it is the assertion the store claim rests on.** The
  native round trip — a personal Google account with no account here, refused on
  a device against production, with Auth confirming no record was created — has
  not been run. It needs a Google account this session did not have. Kanban ran
  the equivalent on 2026-08-18; do it before submitting.

  The shared decision record was also stale about this app and has been
  corrected: it said the student email/password system did not exist and asked
  for two labelled sign-in doors to be built. Both have existed for some time.

- 2026-09-07 — **Four decisions taken in review, and one field renamed to say
  what it means.**

  1. **An archived class with listening off closes the audio to STUDENTS, and
     staff keep access.** The server had always read it that way — `playbackDenial`
     returns from its staff branch before either of a student's two closures — and
     the client did not, so a manager opening an archived recording got no
     transport and the student's own sentence, "ask your teacher if you need access
     again", shown to the teacher being asked. Staff keeping access is what makes
     that sentence answerable: somebody has to hear the recording to decide whether
     to turn listening back on. `canPlayNow` now checks the staff branch first.

  2. **The "attendance still not taken" message goes to a class's managers and to
     nobody else** — no fallback, no copy to admins. An admin who manages no class
     therefore has no switch for it; the notifications screen names who does get it
     instead of offering a control whose only possible effect would be to silence
     something already silent. The brief and manual said "staff", which was never
     what the job did.

  3. **A class that met and was not recorded can be marked as such.** The card it
     otherwise leaves on the staff work queue has no expiry, and the only previous
     escape was deleting the session — which destroys that day's register with it.
     The mark is reversible, it is audited through `updateSession`, and its whole
     job is silence: the queue row goes and the morning reminder stops. The
     register is untouched, and the marks already in it still count.

  4. **The by-student attendance report lists everyone the submitted registers
     name, not the current roster.** A student unenrolled mid-term keeps their
     marks — "an attendance record is what happened on the day and outlives the
     enrolment" — and those marks go on counting in every session's totals, so
     listing the active roster alone meant the two cuts of one report stopped
     adding up. They are shown, and exported, flagged *no longer enrolled*.

  Decision 3 needed a field. `sessions.archived` was written `false` at creation
  and set true by nothing — no callable offered it, no screen showed it — while
  the work queue and the reminder job both already read it as "leave this session
  alone". It is now `sessions.notRecorded`, which says which kind of leaving-alone
  it means. `scripts/migrate-not-recorded.mjs` renames it on stored documents;
  both readers test truthiness, so nothing changes behaviour either way.

- 2026-09-06 — **A persistent navigation shell, a real desktop layout, and a
  work queue as the staff landing screen.**

  Three designs were built behind `?nav=a|b|c` and compared against one seeded
  world at both widths; **B** was chosen and the other two deleted. Thirteen rounds
  of independent review followed, and every one of them found real defects — the
  most serious being a teardown race that made playing a second recording leave
  a permanently dead transport; a `closePlayback` that erased a student's place
  in a two-hour lecture whenever a session was closed before it loaded; a
  multi-device catch-up applied once per queued write, which turned a laptop's
  fifteen minutes into forty-four in the number the ledger presents as evidence;
  a roster with no `orderBy` behind the register staff mark by hand; and audio
  that kept playing out of a foreground service, with no control anywhere to
  stop it, when an account was disabled mid-lecture — because hoisting playback
  out of the player screen removed the unmount that used to end it; and
  `QUEUE_SCOPE.manager` set at 15 against Firestore's documented ceiling of ten
  document-access calls per query request, which the emulator does not enforce —
  eleven live courses would have failed the staff landing screen closed for that
  manager in production while every suite stayed green. What survived:

  **The chrome.** A bottom bar below `WIDE_BREAKPOINT` (900) and a 76px activity
  rail above it, branched on WIDTH, never on platform. It shows on *every*
  screen, not only the tab roots — the reflex is to copy the sibling kanban,
  which hides its bar on the immersive board, and that is wrong here: this app is
  navigated while something is playing, and hiding the bar on the player makes
  the most-used screen a cul-de-sac. Tabs reset the stack; More-menu destinations
  push. Resetting for both was the first version and the sweep caught it as three
  screens reporting "no Back in the header".

  Staff: **Today · Courses · Library · People · More**. Students:
  **Listening · Classes · More**. The set does not change with role — an admin
  and a manager see the same four words, resolved to different routes. Both hub
  screens are gone; `Home` is simply the first tab.

  **Playback moved out of `PlayerScreen` into a module-level session.** It had
  to: while the audio lived in that screen's state, leaving the screen unmounted
  the hook and tore it down, so a student could not check their attendance record
  without losing their place in a two-hour lecture. The player is now one view
  onto the session and the docked bar is another. `player.ts` keeps its module
  handle, but "at most one player alive" stopped being a rule it defends by hand
  and became the shape.

  **Three content maxima instead of one.** `CONTENT_MAX_WIDTH` (720) is now the
  READING cap only; `LAYOUT_WIDTHS.list` (1180) serves collections, which flow
  into a measured grid. Prose and a card grid want opposite things from a 1500px
  window and one number cannot serve both. Attendance lays out as a register
  above 900px — name and control on one line — which halves the height of a
  fourteen-student roster on the screen a teacher uses most.

  **Today is derived and live.** Sessions past their date with no attendance,
  drafts waiting to publish, sessions with no audio, recordings closing within
  the week — computed from documents the reader can already see, with no queue
  collection to keep in step. Two `onSnapshot` listeners rather than a one-shot
  read, because the tab carries a count of the sessions blocking access and a
  badge that lies about work you have just finished is worse than no badge. The
  count and the screen come from one subscription held at the shell.

  Also shipped, from Faisal's locked decisions: `PRIVACY_URL` reachable inside
  the app (Apple 5.1.1(i)); `CAN_CREATE_ACCOUNTS` removing "Add a student" from
  the native builds with nothing in its place, since a pointer at the web flow is
  itself the Play trigger; and a student's own first-party password reset. Offline
  downloads were confirmed still deferred — `expo-file-system` is imported in one
  module, for CSV export — so there is no Downloads tab.

  `screens-e2e.mjs` now reads its fixture from `scripts/lib/seed-world.mjs`
  rather than building three hundred lines of it inline in front of the checks.

  **What the reviews were worth, and what they could not reach.** The sweep
  found two of the navigation defects itself — More-menu destinations arriving
  with no Back, and a route crashing on undefined params. It could not see the
  worst layout fault: a shared `Row` primitive that grew its cells on every
  width, leaving pairs of related buttons 400px apart on five screens at once.
  Nothing overlapped, nothing clipped, the column capped correctly, and it was
  still the ugliest thing in the app. It took looking at a screenshot and then
  measuring the DOM. The sweep says a layout is not broken; it never says it is
  good.

  Green on this machine: lint, typecheck, knip, 303 unit, 254 emulator,
  1057/1057 sweep at five widths, and 109/109 web e2e. **Not yet run on a device** — this
  box has no hardware virtualization, and the playback refactor touches exactly
  the seam a browser cannot reach, so the pre-release AVD pass is mandatory
  before any release.

- 2026-08-28 — **v0.4.3: the first Android verification this app has had, and it
  found two things every other check is blind to.**

  **Shipped the same day.** Rules, functions and hosting, in that order. The
  deployed bundle carries the commit, contains no `EXPO_PUBLIC_USE_EMULATORS`,
  and its `.map` URLs return `text/html`; source maps uploaded (the skip line is
  the silent failure, and it did not appear). `smoke:prod` green.
  `gcloud functions describe` reads 540s / 512Mi against a 60s / 256Mi baseline
  captured before the deploy — **config verified, not import verified**: no suite
  moves a real two-hour file.

  The release build failed first with a Gradle `Metaspace` exhaustion and left
  the PREVIOUS version's APKs in the output directory, timestamped hours earlier.
  `BUILD SUCCESSFUL` was absent, but nothing else would have said so — the files
  were all present and plausibly sized. Deleted them, stopped the daemons, built
  clean, and confirmed the installed APK reports 0.4.3 / 24 with no dev sign-in
  panel.

  **`check-query-shapes.mjs` was still listing the PRE-FIX ledger shapes.** It
  queried `recordingId` alone on three collections and omitted the assignments
  shape entirely, so it passed while exercising queries the app had stopped
  sending and skipping the four it now sends. The same failure the ledger bug
  itself was: a check written against the author's intent rather than the
  caller's query. Corrected and re-run against the real project — all four
  equality-only shapes are servable, so no composite index is needed, which is
  now evidence rather than reasoning.

  The release pass for the ledger permissions fix, the notification rework and
  the Zoom import limits. Gates green on this machine: lint, typecheck, knip,
  202 unit, 252 emulator, 674/674 sweep, 101/101 e2e.

  **The ledger was confirmed AS A MANAGER, which is the only account that can
  see it fail.** All four rules answer an admin from a zero-read arm, so an
  admin's pass is evidence about nothing. Judged on the reads the bug denied —
  the completion, override and listened-% values — not on the page having rows,
  because the names come from the session's attendance map and render either
  way. Then mutation-tested: with `courseId` removed from the four queries again
  the screen kept every student name under "excused, access closed" while the
  override line vanished, every row read 0% listened, and the console carried
  `ledgerAssignments` / `ledgerCompletions` / `ledgerOverrides` /
  `ledgerProgress` — the four production Sentry labels, reproduced exactly.
  Restored and green. Confirmed on web and on the AVD, which ships the same
  bundle.

  **Two defects that only a real device shows, both pre-existing, both fixed.**
  A push was delivered end to end for the first time — token minted on the AVD,
  written to Firestore, sent from the real project, banner read on the shade —
  and the banner itself is what carried the news:

  - **Every notification landed in FCM's fallback channel, named
    "Miscellaneous."** `push.ts` created a `default` channel called "Class
    recordings", but nothing ever targeted it: `fcmSender` set no
    `android.notification.channelId`, so the configured importance never
    applied. Fixed the way the sibling kanban app fixed the identical bug,
    deliberately down to the constant names: `PUSH_CHANNEL_ID` /
    `PUSH_CHANNEL_NAME` in `@sabeel/shared`, created by the client before it
    hands over a token and addressed by the server on every send. A NEW id
    (`sabeel-alerts`) rather than a correction to the old one, because Android
    fixes a channel's importance at creation and an app may never raise it
    afterwards — only the person can. The dead `default` channel is deleted so
    it does not sit in settings as a second, permanently silent entry.

    The one deliberate behaviour change: HIGH rather than the fallback's
    DEFAULT, matching the sibling, so a deadline message can raise a heads-up
    banner. It had to be decided now — this is the only moment the choice is
    ours.

  - **The notification icon rendered as an empty ring.** Android draws the small
    icon from the alpha silhouette alone, and the launcher icon is a full-bleed
    ivory square, so its silhouette carried no mark at all. Now a vector
    drawable of the microphone from the app icon's badge, wired up in the
    MANIFEST rather than through the expo-notifications config plugin, which
    does nothing here: `android/` is committed and prebuild never runs.

  Both confirmed on the device afterwards — `channel=sabeel-alerts`,
  `importance=4`, `color=0xff83114f`, and a microphone in the shade where the
  blank ring had been. Both halves of the channel contract are pinned by tests
  (`push.test.ts`, `senderSelection.test.ts`), each mutation-checked: dropping
  the server's `android` block and pointing the client back at `default` were
  each watched to go red.

  Both were invisible to the unit suite, the rules suite, the sweep and the
  e2e, and would have stayed invisible: nothing in this repo renders a system
  notification. That is the argument for the device pass being mandatory rather
  than a formality.

  Also confirmed on the device: the notifications screen raises NO system dialog
  on arrival (focus stays on MainActivity), offering **Enable notifications**
  instead; the button does raise it; granting flips the screen to "enabled" and
  writes a real FCM token; the home nudge clears on return, which is the
  focus-versus-mount fix; "Not now" persists. Both populations, each on its own
  home screen.

  A third defect, found by reading the same screenshots rather than by any
  check: the ledger's four summary tiles broke "Accountable" mid-word as
  "Accountabl / e" on any phone. The row now wraps, at a `minWidth` chosen to
  break CLEANLY — 84 fits the label but leaves three across at 390px with
  "Missed" orphaned full-width, so 112, which gives a tidy two-by-two on phones
  and one row of four from the 720 content cap up. Every layout assertion passed
  before and after: they can see overlap and clipping, not a word broken in
  half.

  The staff half of the manual never got the device-permission paragraph the
  student half got in `3899318`. Added, and the PDF re-rendered.

- 2026-08-28 — **The recording ledger was denied for every manager, and the
  suites were green throughout. Four defects fixed.**

  Production Sentry (`sabeel-recording-web`) carried four
  `Live data error (ledger*): permission-denied` events, one per listener, 71
  seconds after a manager published a Zoom import. `useRecordingLedger` filtered
  `assignments`, `completions`, `completionOverrides` and `listeningProgress` on
  **`recordingId` alone**, on the reasoning — stated in a comment — that one
  recording belongs to one class, so the reads are class-scoped. They are not.
  **Firestore evaluates a `list` rule against the QUERY's constraints, not only
  against the documents it would return**, and the staff arm of all four
  collections resolves `get(/courses/$(resource.data.courseId))`. A query that
  does not pin `courseId` leaves that path unresolvable and is refused outright.

  Proven against the real rules on an isolated emulator: a manager listing
  `recordingId ==` is denied on all four collections **even when the query
  matches nothing**, which is what makes the failure total rather than
  data-dependent; the same query with `courseId ==` added is allowed; and an
  admin is allowed either way, because every one of these rules answers an admin
  from a zero-read arm that touches no `resource.data`. So the bug was invisible
  to the only person who could have reported it and total for everyone else.
  The 10-call document-access budget was ruled out on the way: 30 rows resolving
  the same `get()` path are served fine, so same-path results are cached.

  Why nothing caught it: `rules.ledger.test.ts` only ever queried
  `where('courseId','==',…)` — the shape the rules were **designed for**, never
  the shape the app **sends** — and the `web-e2e` and screens sweeps drove the
  ledger as an admin only. A rules suite that asserts the author's intent rather
  than the caller's query proves the rule, not the product. Both suites now
  carry the app's shape and a manager's pass over the ledger; the e2e was
  mutation-tested by restoring the unscoped queries, which reproduced the exact
  four Sentry labels and failed three checks.

  Three more, all found in the same trace:

  - **The listener-error banner outlived its screen.** `lastListenerError` was a
    module-global cleared only by a later success from the same label. Nothing
    else subscribes under `ledger*`, so the red message followed the manager onto
    every screen afterwards — which is why the ledger denial was reported as
    "the upload is broken", with a screenshot of the session screen. Errors are
    now keyed by label and dropped when the subscription is torn down.
  - **The Zoom import ran on the platform defaults.** 60 s and 256 MiB, with the
    whole file streamed through the function; a two-hour class is 100-250 MB.
    Now 540 s / 512 MiB, with the client's callable timeout raised to match —
    raising one end alone just moves which side gives up.
  - **A failed import could not be retried through the button that started it.**
    The draft is created before the download, so a mid-transfer failure leaves
    the dedupe key behind and the retry answered `alreadyExisted: true` —
    reporting success for a recording holding no audio. It now finishes the
    download when the existing draft has none and belongs to the same session.

  Still open: a separate `courseRecordings` denial from a different account six
  minutes earlier on `/library`. The query shape there is proven allowed for a
  manager of an existing course, empty or not, so it is specific to one course
  in that person's list. The label was identical for every course section, so
  the event could not be chased; `useCourseRecordings` now tags its Sentry
  events with the course id.

- 2026-08-27 — **Two defects in `web-e2e.mjs`, found while validating something
  else, both fixed. 98/98.**

  **A fixed-budget wait that asserted once.** The off-domain sign-in check slept
  6000ms then read the page, so it had to cover sign-in, the auth trigger, the
  delete and a re-render. Observed FAILING and PASSING on byte-identical code —
  which is how it was attributed: a check returning both results from the same
  bytes is evidence about the machine, not the app.

  The obvious repair is wrong and worth recording as such. Polling for
  `Emulator sign-in` — the assertion's own text — would pass instantly and test
  nothing, because that text is on the SIGN-IN screen, which is where the check
  starts. It is not a landmark; its RETURN is. The fix waits for the transition:
  the dev row going hidden (we left sign-in), then visible again (the trigger
  deleted the account). Both waits are tolerant so a timeout surfaces as the
  assertion failing with the page's real text rather than an exception with none.

  **A byte count pinned to one ffmpeg build's output.** `sizeBytes === '3049585'`
  made the suite unrunnable anywhere ffmpeg is absent — `E2E_AUDIO` is offered as
  the escape hatch 200 lines earlier and every substitute fixture failed here.
  Now read from the fixture with `statSync`, which keeps the check strict (it
  still proves the app recorded the real file, not a default) while the
  documented escape hatch works. Duration moved to a shared `AUDIO_SECONDS`
  constant used by both the generator and the assertion so they cannot drift, and
  the error message now states a substitute must be that long AND live outside
  `e2e-shots/`, which the suite wipes on startup.

  Note the flake fix is justified structurally, not by the green run: the old
  code passed sometimes too. What changed is that a fixed budget became a state
  transition.

- 2026-08-27 — **Two silent defects in the sweep's own runner, both found by
  checking a guess.** Neither changed any output; both made a safety mechanism a
  no-op while the script's comments claimed otherwise.

  **`exec` kills the cleanup trap.** `scripts/screens-e2e.sh` declared
  `trap cleanup EXIT` and then ended with `exec firebase emulators:exec …`.
  `exec` replaces the shell, so the trap can never fire and every run orphaned
  its Expo dev server — one was found 11m29s old after a run that reported
  success. Invisible because the script also kills stale servers on the port at
  startup, so the leak self-heals on the next run and only shows as a straggler
  between them, which is exactly when another checkout wants the port. The
  kanban reference this was modelled on has the same shape. Fixed by dropping
  `exec`; `set -e` still propagates the status.

  **The trap and the stale-server kill both depended on `lsof`, which is not on
  the default non-interactive PATH here** — and both silenced stderr, so
  "command not found" was indistinguishable from "no listener". Absent `lsof`,
  the two mechanisms switch off with nothing to show. Switched to `ss`, which
  `scripts/free-emulator-ports.sh` already used; deviating from that was the
  original mistake.

  **`trap cleanup EXIT INT TERM` would have made it worse, measured not
  reasoned.** Bash defers a TRAPPED signal until the foreground command returns,
  and the foreground command here runs for minutes. With a 2s command and a
  SIGTERM at 300ms: `EXIT` cleaned up at 406ms, `EXIT INT TERM` at 2056ms. A
  Node harness is the reverse — its handlers fire at once — so the same change is
  right in one runtime and a leak in the other.

  Verified with a three-point observation rather than one: port 8086 **before**
  (0), **during** (bound — so there was something to clean up), and **after** (0).
  A clear port on its own would have been equally true if the server never
  started.

- 2026-08-27 — **A squashed-control check, and the inert first version that
  proved why sabotage is not optional.** The sweep's checks were all relative, so
  nothing in it could see a control too narrow to use. Added one scoped to
  fixed-format controls — `date`/`time`/`number` inputs and `select`, whose
  content cannot be scrolled to — deliberately excluding text fields, where
  overflow is ordinary and a check would fire constantly and be deleted.

  **The first implementation could not fail.** It used `scrollWidth >
  clientWidth`; the sabotage (this app's `<input type="date">` capped at 40px)
  came back **125/125 green**. Chromium draws a date input's widget in a UA
  shadow root with `overflow: hidden`, so scrollWidth never exceeds clientWidth
  however badly it is crushed. The signal does work for `select`, which is what
  made it plausible enough to write.

  Rewritten to measure the control's own **min-content** width — clone it, let
  the clone size to its content, read it back, discard. Same sabotage now gives
  **122/125**, naming six controls across `sessions`, `session-editing` and
  `zoom-import` (the last two of which nobody predicted had date fields).

  The lesson is not about scrollbars or shadow DOM. A check written *because of*
  a hard-won lesson is not thereby exempt from the lesson.

- 2026-08-27 — **The sweep asserts its own premise, because 124 of 127 checks
  passed at the wrong width.** Every geometric check in `screens-e2e.mjs`
  measures the DOM against the DOM, which makes them internally consistent and
  completely silent about WHICH width they ran at. The width came from a
  Playwright viewport option and was believed: threaded runner → tour → visitor
  through three layers and, after an earlier refactor, read by nothing at all.

  Proved by setting the viewport to `w - 40` while still claiming `w`: the run
  came back **124/127**, and the only three failures were the new check, once per
  context. Everything else sailed through at 280px, correctly, against the wrong
  reference. That is the file's own headline rule — a tour that cannot fail is a
  screenshot generator — one level up, at the tour's premise rather than at its
  steps.

  `width` is now READ rather than threaded past: one check per context, placed
  before the tour so a bad viewport fails in one honest line instead of after a
  whole tour has been measured against it. Note ESLint could not have found the
  dead parameter — `@typescript-eslint/no-unused-vars` defaults to
  `args: 'after-used'`, so a parameter followed by used ones is never reported.
  Found by a sibling repo hitting the same shape, not by tooling.

- 2026-08-27 — **The sweep's first honest run found a real bug, at 320px only.**
  The recording ledger's override editor laid its two actions out with a bespoke
  `flexDirection: 'row'` and no wrap, so "Mark not complete" ran 27px off the
  right edge of a 320px phone. Perfect at 390 and every width above — which is
  the whole argument for straddling rather than sampling.

  Fixed by using the shared `Row` instead of the local style. `Row` already
  wraps, and its own comment says why: `rowItem` refuses to shrink, so a line
  that does not quite fit must wrap rather than squeeze a button until its label
  breaks mid-word. The bespoke style had quietly opted out of that rule. **When
  a screen needs a line of buttons, use `Row`** — a local `flexDirection: 'row'`
  is opting out of the app's only wrapping rule, usually without meaning to.

  Only reachable with the editor OPEN, which is why the sweep tours open editors
  as screens in their own right rather than trusting the screen underneath them.

- 2026-08-27 — **The screens sweep landed, and was proven by breaking a layout.**
  `scripts/screens-e2e.mjs` tours every screen of both populations at five widths
  straddling `CONTENT_MAX_WIDTH`, which it reads out of `app/src/theme/index.ts`
  rather than restating. **623 checks, 5 viewports x 34 screens, ~5m25s** — green, and re-run green
  on the exact shipped bytes (sha recorded before and after).

  It is only evidence because it was watched failing: `minWidth: 420` was added
  to the shared `Card` style and the 320px run went **94/123**, naming 29
  screens and the exact controls carried past the right edge — including four
  that only the second, scrolled-to-the-end pass could see. Reverted and green
  again. A harness nobody has watched fail is not yet evidence.

  Three things cost real time and are worth not rediscovering. The header Back is
  an `<a role="link">`, not a `<button>` — `PlatformPressable` renders a link
  whenever it has an `href`, and the linking config gives it one — so a
  button-only query reported every pushed screen in the app as a dead end. The
  content column must be measured against `clientWidth`, not the bounding rect,
  or a classic scrollbar makes a correctly centred column look 7px off. And
  seeding a student with a password on `createUser` gives them a `password`
  provider at creation, which `onUserCreate` reads as a self-signup and deletes —
  the same failure the trigger's own comment records from production.

  In CI where `test:e2e` cannot be, because it starts its own emulators and its
  own dev server instead of expecting a world somebody else built.
  `functions/test/unit/ciCoverage.test.ts` fails if the step is ever dropped.

- 2026-08-15 — **Under the emulator, the send is suppressed at the source.**
  `notify.integration` went flaky in CI: `notifyLastDay` returned 0 with nothing
  in the log. The cause was not the test. The integration suite runs the FUNCTIONS
  emulator, so writing an assignment fires the real `onAssignmentWritten` in a
  SEPARATE PROCESS, which a test's `setSender` cannot reach — it called the real
  FCM sender against a credential-less project, and whatever came back was read
  as a verdict on real tokens, with device deletion as a possible outcome. A
  live trigger deleting the device row a running test depends on surfaces three
  tests later as a plain count mismatch. `messaging.ts` now picks its default
  sender from `FUNCTIONS_EMULATOR`, so the emulated process sends nothing and
  prunes nothing. Pinned in both directions by `senderSelection.test.ts`, because
  both ways of getting it wrong are silent: suppressing in production stops every
  notification with nothing failing. Mutation-tested — forcing either branch
  turns two tests red.

- 2026-08-15 — **v0.4.2 shipped to every surface.** A code review of
  `d428fdd..24f3a3c` — the excused-only policy, notifications, the attendance
  projection, the required due date — turned up fifteen findings, all fixed in
  one release. The three that were live defects rather than tidying: a closed
  session could not be edited or have its attendance corrected at all; the
  notification idempotency marker could be spent on a student with no device,
  costing them that message permanently; and re-registering a device was denied
  by the rules, so the settings screen called a working device unusable. Nothing
  here changes policy — every fix restores what the docs already claimed.
  Deployed indexes → rules → storage → functions → hosting, APKs to both release
  homes, download page and manual PDF refreshed.

- 2026-08-15 — **A sweep swallows one recipient's failure; a trigger does not.**
  `notifyOnce` rethrows anything that is not "already claimed", which is right
  for `onAssignmentWritten` because it retries. The morning sweep is not retried
  and `lastDay` has no second chance — tomorrow the deadline has passed and the
  query no longer matches — so an error a third of the way through a batch would
  cost every student after it their only reminder. The sweeps catch per
  recipient and log; the trigger still throws.

- 2026-08-15 — **A due date is judged as a CHANGE, not as a value.** The session
  editor sends all four fields on every save, so an unchanged deadline arrives on
  the wire exactly like a new one — and a validator that only asked "is this in
  the past?" made every closed session uneditable in every other respect. Fixing
  a typo in a title would have required moving the deadline forward, silently
  reopening access for everyone excused. `validateUpdateSession` now checks shape
  alone and the callable compares against what is stored, which is the only place
  that comparison can be made. The same shape of mistake, one layer down: the
  past-due guard on attendance measured the SUBMITTED map, but the attendance
  screen rebuilds the whole roster on every submit, so correcting one student
  resent every existing excusal and was refused as five new ones. It now compares
  against `session.attendance` and refuses only a genuinely new excusal.

- 2026-08-15 — **The marker is claimed once there is somewhere to send.** The
  claim still precedes the send (below), but it now follows the device read: a
  student who has not opened the settings screen has no token, and claiming for
  them spends the one delivery that notification will ever get — registering a
  device an hour later would find it already marked sent. A failed `create` is
  only treated as "someone else won" for ALREADY_EXISTS; anything else rethrows,
  because an unavailable Firestore is not proof the message was delivered.

- 2026-08-15 — **Re-registering a device is an UPDATE, so the rules allow one.**
  The row is keyed by the token and the client writes a fresh `registeredAt`,
  which Firestore evaluates as an update, not a create. `allow update: if false`
  therefore denied every visit to the notification settings after the first, and
  the screen reported a registered, working device as unable to receive push.
  What is actually forbidden is editing a row into a DIFFERENT token, so both
  arms now require `request.resource.data.token == token`.

- 2026-08-15 — **A push token is cached only when it succeeds, and sign-out never
  prompts.** Caching the null too made every failure permanent for the process:
  a service worker that lost the activation race, or permission granted a moment
  later in system settings, left the screen saying "this device can't receive
  notifications" until an app restart. And `devicePushToken` now takes an
  explicit `prompt` — the settings screen passes true (a user gesture, the only
  kind a browser honours), sign-out passes false, so signing out cannot raise a
  permission dialog or wait ten seconds on a service worker for a person who
  never asked about notifications. A device that already has permission still
  hands its token over, which is what closes the shared-device leak.

- 2026-08-15 — **The notification switches are switches, not the word "On".**
  They shipped in 0.4.0 as a label reading On/Off, which states the value without
  affording the change — nothing about it says "tap me", and the row it sits in
  gives no hint either. Built as two Views and a `translateX` rather than React
  Native's `Switch`: on react-native-web that renders a browser control whose
  track and thumb colours are only partly reachable from JS, so it arrives in
  system blue — and this app has a fixed palette with an ESLint rule against
  stray colours precisely so that cannot happen. The whole row is the target,
  because a 52pt pill is a poor one on a phone.

- 2026-08-15 — **0.4.0, not 0.3.2.** The middle number, because this is the one
  release so far that takes something away: a student who was marked absent
  could open a recording yesterday and cannot today. Patch numbering would have
  filed the largest product change in the app's life alongside a banner-colour
  fix.

- 2026-08-15 — **Three notifications, and deliberately no fourth.** A student is
  told once when a recording opens to them, and once on the morning it closes;
  staff are told when a session has met and its attendance was never submitted.
  There is no day-after overdue reminder, which the brief originally asked for
  daily: once the deadline passes the recording is gone, so the message could
  only say "you missed it" — a scolding with no action attached, and the tone the
  brief rules out. The staff one is not a convenience: under excused-only access
  an un-taken sheet grants nobody anything, so a published recording sits there
  openable by no one and nothing else in the app says so.

- 2026-08-15 — **A missing preferences document means ON.** Every switch defaults
  on, and someone who has never opened the settings screen has no document at
  all. Defaulting the absent document to OFF would mean nobody is ever notified
  until they visit a screen whose whole purpose is turning notifications off.

- 2026-08-15 — **The idempotency marker is CLAIMED, not checked.** `create` on
  `notifications/{uid}/sent/{kind}_{target}` fails if it exists, which is both
  the "already sent" answer and an atomic one. Reading first and writing after
  would leave a window two invocations could pass through — and both paths here
  can double-fire: trigger delivery is at-least-once, and the morning sweep runs
  whether or not yesterday's finished.

- 2026-08-15 — **Dead tokens are pruned; failed ones are not.** Only the two FCM
  codes specific to a token — `registration-token-not-registered` and
  `invalid-registration-token` — delete a registration. Pruning on any failure
  would unregister working devices during an outage, and the only symptom would
  be notifications quietly stopping, indistinguishable from a person having
  turned them off. `invalid-argument` looks like it belongs and does not: FCM
  returns it for a malformed MESSAGE as well, so one bad title would come back
  against every entry in a batch and unregister every recipient at once.

- 2026-08-15 — **`expo-notifications` needed no prebuild.** The worry was real —
  its config plugin does not run in a bare workflow, and `android/` is committed
  — but the plugin only contributes a default icon and colour. The MODULE is
  picked up by expo-modules autolinking at Gradle time, which the merged
  manifest confirms: `ExpoFirebaseMessagingService` and Firebase's own
  `FirebaseMessagingService` are both registered. The committed `android/` was
  not touched. `getDevicePushTokenAsync` is used, never `getExpoPushTokenAsync`:
  the latter returns an ExponentPushToken that only Expo's service understands,
  and sending one to the Admin SDK fails with an invalid-token error that reads
  like a misconfiguration and is not one.

- 2026-08-14 — **Being excused is the whole of a student's entitlement**
  (Faisal's decision). Enrolment used to open every published recording in a
  course, and `absent ∪ excused` created the obligation on top. Now one
  `assignments` document does both jobs and only the EXCUSED get one: present
  needs nothing, absent is an unexcused miss and opens nothing. The brief's
  "access and accountability are separate" principle is retired by decision, not
  by drift — it is named in the brief and in CLAUDE.md so nobody re-splits them
  later. Practical consequences worth knowing: "everyone must listen" is now said
  by excusing everyone (the bulk button changed to match, because "Mark all
  absent" would have quietly done the opposite of what it promised); and the
  browse-all-recordings screen was deleted, because a student's list of what they
  MAY hear and what they MUST hear became the same list.

- 2026-08-14 — **The deadline is enforced at the audio, never in the rules.**
  Access closes when the session's due date passes. Rules would have to compare
  `request.time` against a `YYYY-MM-DD` string in `America/Chicago` — a second
  implementation of the maths in `@sabeel/shared`, free to drift, and the exact
  duplication the project rejected when it chose to STORE `effectiveActive`
  rather than derive it in rules. So `firestore.rules` gates a recording's
  metadata on an active grant, and `getPlaybackUrl` gates the audio on the date.
  The split is visible in the product: a missed recording is still listed, with
  the date it closed, and cannot be played. The 12-hour signed URL still means a
  student who pressed play on the due date finishes their session — the same
  accepted consequence already documented for unenrolment.

- 2026-08-14 — **A grant does NOT go inactive when its deadline passes.**
  Tempting, and wrong: `active:false` is what the ledger reads to count who was
  required to listen, so expiring the flag would erase the record of everyone who
  missed something. Expiry is a function of the date instead
  (`hasRecordingAccess`), which also means it needs no scheduled job to happen.
  Completion is checked BEFORE the deadline, so someone who listened in time is
  never later recast as having missed it.

- 2026-08-14 — **A student's own attendance mark needs its own document.**
  Attendance is a map on the session, and `/sessions` is staff-only because the
  map holds the whole roster. Firestore security is per-document: there is no
  rule that reveals one key of a map to the student it belongs to, and no query
  can ask "sessions where attendance[myUid] exists". So `submitAttendance` is
  projected onto `attendanceRecords/{uid}_{sessionId}` by the same trigger that
  reconciles the grants, reading stored truth rather than the event payload so it
  converges however the writes interleave. The session stays canonical; date and
  title are denormalised for the same reason the recording already denormalises
  them — the reader cannot open the session they came from.

- 2026-08-14 — **A due date is required, and is never written in the past.** It
  is the day access closes, so a blank one would mean permanent access — the most
  permissive setting in the product reachable by leaving a field alone. It
  prefills to the session date plus 7 days. One invariant covers three callables:
  `createSession` and `updateSession` refuse a past date, and `submitAttendance`
  refuses to mark anyone EXCUSED once the deadline has gone, so nothing is ever
  born expired. Publishing onto a past-due session is refused for the same
  reason. Deliberately narrow: correcting an old session to present/absent still
  works, so the attendance report stays correctable.

- 2026-08-14 — **"Missed", not "overdue", once access has closed.** Overdue
  implies the work is still doable and it no longer is. One word for one state,
  in the student's list, the staff ledger and the CSV headers alike.

- 2026-08-14 — **The emulator suite was testing yesterday's triggers.** The
  Functions emulator loads the BUILT bundle (`functions/lib`, per `main`), and
  nothing in `scripts/test-emulator.sh` built it — so trigger behaviour under
  test was whatever was last compiled, while the test bodies ran fresh source
  through vitest. It passed either way, which is what made it invisible; it
  surfaced only because the excused-only fan-out was live in `src` and the
  emulator kept assigning absentees from a two-day-old `lib`. The script now
  builds first. Any change to a Firestore trigger before this date was verified
  against a bundle nobody checked.

- 2026-08-13 — **The course name in a header is the way back to the course**
  (Faisal's request). Sessions, one session, and the attendance report all
  already NAMED their course in the subtitle, so that name became the link
  rather than a new breadcrumb row — the header gains an affordance and no line.
  It is not a duplicate of the back arrow: two screens into a course, Back
  returns the list you came through, and a session opened from a URL has nothing
  beneath it at all, so Back is not even drawn. `navigate` rather than `goBack`
  for exactly that reason. Underlined as well as raspberry, because colour alone
  does not say "link", and the testID names its screen — react-navigation keeps
  the screen below mounted, so one shared id matched two elements at once.

- 2026-08-13 — **The two populations get two route tables.** One navigator held
  every screen for every role. That was harmless while no screen had a path —
  a screen was reachable only if the UI offered it, and neither home offers the
  other's. Giving every screen a URL in v0.3.0 made all of them reachable by
  anyone signed in, and the way people actually arrive is not a typed URL but a
  **shared device**: staff finish on a session page, sign out, a student signs in,
  and React Navigation restores the path. The student got `SessionDetail` fully
  rendered, every query beneath it denied; a manager landing on `/my-recordings`
  got the student's "Your recordings" the same way. The rules held throughout —
  nothing leaked — but the wrong screen rendered, and the denials underneath are
  what reached Sentry (`session` at a staff URL, `myAssignments`). Staff and
  student screen sets are now registered separately, with a linking config each,
  so the other population's path matches nothing and falls back to their own home.
  Adding a screen to both arms puts it back within reach of both.

- 2026-08-13 — **A denial to an account that cannot read anything is not a
  defect.** Signing out does not unsubscribe first: Firestore re-issues every
  live listen the moment the credential drops and the server refuses them, while
  React is still unmounting the screens that own them. The last thing a student
  does before leaving therefore raised a permission denial from their own home —
  which is where the Sign out button is. The auth session now publishes whether
  the account can read anything at all, set in the same tick the credential
  changes, and `permission-denied` in that state is logged and marked expected
  rather than bannered and reported. Deliberately narrow: a denial to a
  signed-in, ACTIVE user is the interesting kind and still reports, which the
  e2e proves by still failing on all three real denials with the guard in place.

- 2026-08-13 — **An absent document is not a readable one.** Firestore rules see
  `resource == null` for a document that does not exist, so any arm dereferencing
  `resource.data` is an evaluation ERROR and the read is REFUSED — never answered
  "no such document". The manager's student page asked "is this student in this
  course of mine?" as a document get, and the honest answer is usually no, so it
  drew a permission denial per non-matching course: a live-data error banner over
  the page and a Sentry event per row. It now asks as a list constrained to that
  one course and that one student, which returns nothing for an absent enrollment
  and still costs the single class `get()` the rule can afford. The rules are
  unchanged: the trap is documented on `listeningProgress` and `completions`,
  which allow the missing-document read because there is nothing there to leak.
  `/enrollments` gets no such allowance — whether the document exists IS the
  private fact, and a manager who could read the absent ones could probe any
  student against any course, with the denial itself as the yes.

- 2026-08-13 — **A listener error reports OUR message, not Firestore's.** Every
  live subscription in the app fed Sentry the raw `FirebaseError`, so all of them
  collapsed into one issue titled "Missing or insufficient permissions" over a
  stack of minified SDK internals naming no screen and no collection — an issue
  that cannot be acted on without guessing which of two dozen subscriptions
  produced it. The label was already in the on-screen banner and only in a tag;
  it is now the title.

- 2026-08-12 — **Every route carries an id, and the browser Back button works**
  (v0.3.0). React Navigation only touches browser history when a `linking`
  config is present; there was none, so the whole app sat in one history entry
  and Back left the site. Adding one is not enough on its own: params are
  serialised into the URL with `String(value)`, so the eight routes carrying
  whole documents would have produced `[object Object]`. They now carry ids,
  resolved live in the `App.tsx` wrappers — which also finished the
  snapshot→live work of v0.2.9, since no navigation param is a frozen document
  any more. Gated to web: native's stack already has a back gesture, and
  `expo-linking` would be a dependency for nothing.
- 2026-08-12 — **`useCourse` and `useRecording` are document listeners, not
  `__name__` queries** (v0.3.0). The player is reached by students, whose arm on
  the courses rule grants `get` without `list`, so the query form failed closed
  for exactly that population — an empty screen and a console warning. The e2e
  caught it. `rules.structure.test.ts` owns the get/list split and says why.
- 2026-08-12 — **A live read reports whether it has answered** (v0.3.0).
  `useLiveDocState` returns `resolved` alongside the value, because empty alone
  cannot tell "still loading" from "there is nothing there". Without it any
  screen resolving its subject from a URL sat on a spinner — including a student
  whose recording was unpublished while they had the player open, which revokes
  their access to it.
- 2026-08-12 — **Screens are keyed on their subject** (v0.3.0). `navigate` to a
  route already on top updates its params in place, so a screen would keep state
  belonging to the previous subject: a rename field holding the old course's
  name, attendance marks from another session. No path does that yet; making
  every route addressable is what makes it possible.
- 2026-08-12 — **A manager sees only the courses they manage on a student's
  page** (v0.3.0). There is no query for "this student's courses" a manager may
  run — the enrollments rule resolves a course `get()` per row, so a
  cross-course `studentUid` list denies as soon as the student is in a class
  they do not run. They walk their own courses and read one enrollment document
  each. That is also the right product answer, since a manager is scoped class
  by class, so the heading says "Courses you manage" rather than implying it is
  the student's whole record.
- 2026-08-12 — **Confirm only what cannot be undone** (v0.3.0). Removing audio
  deletes the object from Storage and sat unguarded among the safe controls, so
  it now asks; so does removing a student from a course, since the row became
  tappable. Archiving a cohort does NOT ask — it is reversible, and it states
  its blast radius instead ("also turns off N courses"). Obstructing the safe
  action is how people learn to click through warnings.

- 2026-08-12 — **A screen never renders from a snapshot it also writes**
  (v0.2.9). Course detail read its `CourseRow` from a navigation param — a copy
  frozen when the row was tapped — while every control on it both renders from
  the course and computes its next write from it. The manager ticks never moved,
  and each toggle was derived from the same pre-change array, so three taps left
  only the last standing. The same shape appeared in the session editor (fields
  seeded at mount, not on open, so Save reverted anything changed since) and,
  server-side, in the assignment fan-out (reconciling from the trigger's event
  snapshot, which Cloud Functions may deliver out of order).
  `exhaustive-deps` is now an error, and `useLiveQuery` takes `(make, deps,
  options)` **specifically** so the rule can read it — with any other argument
  order it reports "dependencies are unknown" and checks nothing. Declined the
  plugin's own preset: v7 bundles the React Compiler rules, three of whose
  findings here are the deliberate resets that CLEAR stale state.
- 2026-08-12 — **`useLiveDoc`, because get and list are different rules**
  (v0.2.9). A student is granted `get` on their course and never `list`, and
  `where('__name__','==',id)` is a **list** — so the staff subscription hook
  fails closed on a student screen, as an empty screen and a console warning.
  A document listener is a `get`. The browse screen now holds its course live
  through one, which matters because it decides whether the archived-listening
  notice shows and which course the player gates its transport on. Asserted on
  the exact query shape in `rules.structure.test.ts`, mutation-tested by opening
  the student arm to `allow get, list`.
- 2026-08-12 — **A guard that reports "more than ten" is not a guard**
  (v0.2.9). The composite-index checker matched 21 of 25 `useLiveQuery` calls —
  a nested generic its regex could not cross — while its self-check passed. No
  index was missing (both skipped queries are equality-only), but it was
  certifying coverage it did not have. It now counts call sites independently
  and demands the parser account for every one.

- 2026-07-31 — **One Sabeel mark, badged per app; no wordmark** (v0.2.8). The
  three Sabeel apps now share one calligraphic mark and are told apart only by a
  Dark Raspberry badge — board, stopwatch, microphone. "SABEEL INSTITUTE" is
  dropped from the icon: at 48dp it is a smudge, and it costs the space the badge
  needs to read. Two things about this change are easy to get wrong:
  - **`app.json` alone ships nothing.** Because `android/` is committed, Gradle
    compiles `res/mipmap-*` and never reads `app.json`. Both must change
    together, and they are kept identical so a later `expo prebuild` is a no-op.
  - **Do not run `expo prebuild` to regenerate them.** It rewrites the native
    project from its template and silently reverts hand edits — in this repo
    `android/build.gradle` carries the `google-services` classpath and the
    jitpack repo, neither of which the template knows about. The icons come from
    one generator (`scripts/make-app-icons.py recordings` in the kanban repo),
    which re-proves its geometry on every run.

  The safe-radius rule is the part worth writing down, because a plausible check
  gets it wrong: the adaptive foreground fills all 108dp and only the central
  72dp survives the mask, so the safe radius on a 1024 canvas is **341px**
  (66.67%, not the ~68% that "roughly two thirds" suggests). Measuring *any*
  non-transparent pixel fails it — the ivory halo around the badge reaches 351px.
  What matters is *ink*: raspberry, calligraphy and gold all stop at 337px, and
  the halo is `#F6EBDD`, identical to the adaptive background, so the mask clips
  it invisibly. Verify against visible ink, not against alpha.

- 2026-07-25 — **A control may wrap, but must never be crushed** (v0.2.3). A
  screen-recording showed **Publish** rendered at a third the width of the button
  beside it with its label broken mid-word — "Publ / ish". `Row`'s items had
  `flexShrink: 1`, so a line that did not quite fit was squeezed rather than
  wrapped, and a squeezed button is narrower than its own text. Now
  `flexShrink: 0`: a line either fits or wraps. Separately, a label longer than
  its button still broke mid-word at large accessibility font sizes ("Submit att
  / endance" at font scale 2.0), so button labels allow two lines, wrap between
  words, and scale down only as a last resort (`minimumFontScale` 0.7).
  Two process notes worth keeping:
  - **The exact trigger was never reproduced** — not on web at 12 viewport
    widths, nor on the AVD across density 420/440/455/520 × font scale
    1.0/1.3/2.0, and the reporter's display and font settings were both default.
    Fixing the *mechanism* rather than the trigger was what made that acceptable:
    with shrink disabled a button cannot be narrower than its basis no matter why
    a line does not fit. Confirmed fixed on the reporting device.
  - **Web is not evidence about native, again.** This never reproduced under
    react-native-web at any width; it is a Yoga behaviour. The same run also
    caught `Upload audio` sitting outside `ConfirmDanger` (v0.2.2) — invisible on
    web because that check ran in a state where the button was not rendered. A
    state-dependent control needs its assertions *in that state*.

- 2026-07-24 — **The recording upload is a state, not a branch** (v0.2.1 fixes,
  from a screen-recording of the live app). A staff upload *spans* the moment the
  recording document starts existing — the server must mint the id before the
  client may write to Storage — so the live listener flips `recording` from null
  to set **mid-upload**. Anything keyed on that branch is destroyed exactly when
  it is needed: the progress bar lived only in the no-recording branch, so a
  healthy upload rendered as `draft · no duration` + *"This recording has no
  audio"* + a delete button for its whole duration. Fixed by owning the upload
  state **above** the branch and making "exists but has no audio" a first-class,
  recoverable state (mid-upload / failed / audio removed) rather than an error.
  Consequences worth keeping:
  - **An audio-less recording must offer a way back.** `clearAudio` was always
    documented "so it can be re-uploaded" and `storage.rules` re-allows the write
    once the object is gone, but no UI path existed — so **Remove audio was a
    one-way door** out of a usable recording, escapable only by deleting it.
  - **Discarding an empty draft is not permanent deletion.** Deletion is
    admin-only *because* it destroys listening history; an empty draft provably
    has none (publish is blocked without audio — `publishBlockers` — and
    assignments only fan out on publish), so course scope suffices. See
    `isEmptyDraft`. This is what lets a manager clean up their own failed upload.
  - **Delete the audio object at its CANONICAL path, not via `audioPath`.** Bytes
    that landed but never finalized leave the field `null`; keying the delete off
    the field orphaned them in Storage forever — the one thing here that costs
    money.
  - **A confirmation that leaves its subject operable is not a confirmation.**
    Both destructive confirms appended below still-live action rows. Now one
    shared `ConfirmDanger` that *replaces* the actions while open.
  - **Testing gotcha:** going offline mid-upload does **not** fail an upload —
    `uploadBytesResumable` resumes when the network returns (this produced a
    false negative). Block the `finalizeRecordingUpload` callable instead: bytes
    land, confirmation never does, which is a real failure mode and fails fast.

- 2026-07-24 — **Attendance-driven assignment: Class → Course, and a new Session
  entity (major model rework).** The app exists for students who *missed* the
  in-person class; a recording is required listening only for the absentees. So
  obligations are now driven by attendance, not by a blanket publish fan-out.
  Model is now **Cohort → Course → Session → Recording**: `class` → `course`
  throughout, and a new `sessions/{id}` owns `attendance`
  (`present`/`absent`/`excused` per student, an explicit-submit SNAPSHOT),
  `date`, `title`, `dueDate`, `notes`, and its 0..1 `recordingId`. A recording is
  pure media + lifecycle, linked by `recording.sessionId`; the student-facing
  `title`/`notes`/`date` are **denormalised** onto it (students cannot read
  sessions). Assignment target = `absent ∪ excused`, reconciled by
  `reconcileSessionAssignments` once the recording is published AND attendance
  submitted; two triggers converge on it (`onRecordingWritten` +
  `onSessionWritten`). Greenfield, so this was a rewrite, not a migration:
  **deleted** the `catchup` concept + its screen, `assignment.source`, the
  retroactive late-enroll fan-out (accountability is now enrollment-onward — a
  student not in a session's snapshot is never assigned it), and the recording's
  own `title`/`dueDate`/`notes`/`recordedAt`. Phases: **A** model/engine/rules/
  re-seed, **B** staff UI (Sessions + SessionDetail with 3-state attendance,
  recording-in-session, Zoom→session), **C** recording-ledger split (accountable
  = absent+excused with the excused flagged; attendees = present, listening shown
  but never overdue), **D** course attendance report (by-session / by-student
  toggle + catch-up status, CSV per cut). All green: unit + emulator suites and
  the rewritten `web-e2e.mjs` drive the full attendance→publish→assign→ledger
  flow. Supersedes the recording-centric class screen shipped 2026-07-22/24.

- 2026-07-24 — **Cohort shown with class name in cross-cohort STAFF views;
  deferred for STUDENT views.** A class name alone is ambiguous when the same
  name recurs across cohorts (two "Arabic 1"s). Fixed in the recording library,
  the listening-progress ledger and the staff player via `useCohortName()`
  (v0.1.7). **Student-facing screens ("Your listening", a student's recordings)
  are deliberately left as-is:** the rules make `cohorts` staff-only
  (`allow get, list: if isStaff()`), so students cannot read cohort names —
  showing them there would need the cohort name **denormalised** onto the class
  (or recording) docs students already read, written by a Cloud Function.
  Deferred as a potential improvement: low impact (a student's classes are
  usually one cohort); revisit if students end up enrolled across cohorts with
  colliding class names.

- 2026-07-22 — **Phase 5 locked in planning.** (1) Audit via a wrapper
  (`auditedCall`) — comprehensiveness by construction, not per-callable
  discipline. (2) Staff completion override is a SEPARATE server-only doc
  (`completionOverrides`) the student cannot clobber; effective status = override
  ?? student. (3) Ledger aggregation is a client-side live join (no server
  aggregation); manager queries stay class-scoped. (4) Scope = ledger/reporting/
  audit only — the cross-cohort recording library + CSV are in; admin backend
  stats stays Phase 8; permanent deletion is out (no delete callables exist).

- 2026-07-22 — **Phase 4 accountability model, locked in planning.** (1) Offline
  completion uses Firestore's native persistent cache + `hasPendingWrites`, not a
  hand-rolled queue. (2) Publish fan-out is a Firestore trigger
  (`onRecordingWritten`), not inline in the publish callable, so publish / class
  move / due-date edit / unpublish all funnel through one idempotent path. (3)
  Normal (`publish`) assignments track the recording's due date; `catchup`
  assignments keep their staff-chosen date. (4) The "never played" completion
  gate is client-side only — a rule requiring the progress doc would false-reject
  offline completions on replay. (5) Overdue = the day AFTER the due date in
  `America/Chicago`; computed client-side, no cron. (6) A queryable `completions`
  state doc AND an append-only `completionEvents` log, both client-written and
  self-only. Completion is keyed by student+recording so it can exist for an
  accessible-but-unassigned recording.

- 2026-07-22 — **Institute timezone is `America/Chicago`** (Houston, TX). Due
  dates are date-only, so "overdue" is decided entirely by where the day rolls
  over; this is ONE institute-wide constant, not per-student. Recorded here
  rather than added to `@sabeel/shared` today, because this repo adds
  infrastructure with its first consumer and knip fails on anything unused — it
  lands in Phase 4 alongside the code that reads it.

- 2026-07-22 — **GCS returns 400 on an expired signed URL, not 403.** The body is
  `<Code>ExpiredToken</Code>`. Any refresh logic keyed on 403 would silently
  never fire, so URLs are re-minted PROACTIVELY when under an hour remains
  rather than in response to a failure.

- 2026-07-22 — **The emulator playback URL needs a download token.** A plain
  `?alt=media` URL is rules-governed, and `storage.rules` denies all reads by
  design — production playback bypasses rules by being signed. The emulator
  branch therefore uses the one other mechanism that bypasses them: a download
  token. That is precisely the never-expiring mechanism rejected for production,
  and it is acceptable only because that branch cannot run against a real
  project.

- 2026-07-22 — **`listeningProgress` is the only client-written collection.** A
  callable every 15 seconds per listening student is pure overhead, and listened
  time is audit evidence rather than the gate — completion is student-attested
  and blocked only if they never played. The rule is self-only and field-scoped.
  Note the null guard: `resource` is null when the document does not exist,
  which is the first-time resume path, and dereferencing it is an evaluation
  ERROR rather than a denial — it surfaced as a broken player.

- 2026-07-22 — **The emulator Storage bucket needs an explicit constant.**
  Neither side has a usable default: the client's `firebaseConfig.storageBucket`
  is a placeholder until the real project exists, and the Admin SDK throws
  "Bucket name not specified" without one. Overriding only `projectId` for the
  emulator left the client uploading to one bucket while the server looked in
  another — and the only symptom was finalize reporting "no audio found" for a
  file that had uploaded successfully. `EMULATOR_STORAGE_BUCKET` in
  `@sabeel/shared` is now used by the app, the functions and the tests. The
  integration suite had hidden the mismatch by hardcoding its own bucket name.

- 2026-07-22 — **Recording audio is write-once in Storage.** `resource == null`
  in `storage.rules` means a published recording's audio can never be swapped
  underneath students who already listened. Replacing it goes through
  `clearRecordingAudio`, which refuses unless the recording is a draft. Storage
  rules cannot read Firestore, so class scope is enforced in `createRecording`
  (before the id is handed out) and again at publish; the rule can only ask "is
  this active staff".

- 2026-07-22 — **Uploading is web-only for now** (`filePicker.ts` seam). It needs
  a document-picker native module, and the brief describes upload as the staff
  exception path done from the recording library. Android explains this rather
  than showing a control that cannot work.

- 2026-07-22 — **`expo-audio` config had to be made explicit**, found by the 3a
  spike. Config plugins only run during `prebuild`, and this is the bare workflow
  with a committed `android/`, so adding the plugin to `app.json` silently added
  nothing: no `FOREGROUND_SERVICE`, no media service, no notification permission.
  Background audio still *worked* on the emulator without them, which is exactly
  how this would have shipped broken. `npx expo prebuild --platform android`
  regenerates the manifest; `recordAudioAndroid: false` keeps the plugin from
  requesting a microphone this app never uses; `POST_NOTIFICATIONS` is requested
  explicitly because the plugin only adds it for background *recording*, not
  playback. Generalised into the `expo-firebase-stack` skill (`9bef5a0`).

- 2026-07-22 — **Offline downloads deferred out of Phase 3** into their own
  phase. The brief calls them optional while streaming is required, and Phase 3
  is the highest-risk phase already.

- 2026-07-22 — **`listeningProgress` moved from Phase 4 into Phase 3.** "Resume
  progress" is a Phase 3 playback requirement and is meaningless without
  persistence; building it locally now and again in Firestore later is waste.
  Phase 4 keeps assignments, completion and the ledger — accountability, not
  playback.

- 2026-07-22 — **`list` rules must reference `resource.data`.** The first draft
  of the enrollments rule was `isAdmin() || isStudent() || isStaff()` with a
  comment saying students would constrain their query — which would have let any
  student list every enrollment in the institute. Referencing `resource.data` is
  what makes Firestore reject an unconstrained query; a comment enforces nothing.

- 2026-07-22 — **A `get()` resolved from document data costs one read per row.**
  Firestore caps document-access calls per query, so such an arm is only
  affordable when every row resolves the same path — true of a roster query
  (`classId ==`), false of anything spanning classes. Each read-requiring arm is
  therefore kept behind a role guard that excludes populations whose queries span
  many parents. `rules.structure.test.ts` sizes both cases at 25 rows, because at
  three they pass either way.

- 2026-07-22 — **Arm ordering is NOT what protects the student query.** An
  earlier comment claimed it was. Reordering the arms and re-running the scale
  tests proved otherwise: `isStaff() &&` short-circuits before the `get()`, so a
  student never triggers a class read whatever the order. Read-free arms are
  still written first as defence in depth, but the guard is what holds.

- 2026-07-22 — **`effectiveActive` is computed inside the callables**, not by a
  Firestore trigger. Clients cannot write these collections at all, so there is
  nothing for a trigger to defend against; inline means no propagation lag and
  one testable path. The cohort cascade never writes a class's own `archived`
  flag, which is what makes reactivation restore each class to its prior state.

- 2026-07-22 — **Unenrolling sets `active: false`; it never deletes.** The brief
  requires listening history to survive across enrollments, and a hard delete
  removes the record that history hangs off. Re-enrolling reuses the same
  composite-id document and preserves the original enrolment date.

- 2026-07-22 — **`managerClassScopes` dropped; `managerUids` lives on the class.**
  Recorded in the plan and implemented here. `setClassManagers` validates every
  uid is an *active* staff member, because the rules read that array directly —
  writing an invented or disabled uid into it is granting access.

- 2026-07-22 — **Class mutation is admin-only.** The brief gives admins
  "manage cohorts/classes globally" and "assign Managers class by class", while
  managers get "create/manage students in assigned classes". So there is no
  manager-write case on a class; managers get scoped read plus the roster.

- 2026-07-22 — **The student directory is readable by all staff** (Faisal). A
  manager can list every student, not only those in their classes — that is what
  makes enrolling an existing student possible. Every student mutation is still
  scoped or admin-only. A deliberate privacy call, noted in `firestore.rules` so
  it is not later read as an oversight and "fixed".

- 2026-07-21 — **Phases 1 and 2 merged.** Manager scopes are class-by-class and
  student quick-create takes an enrolled class, so splitting them would mean
  writing the security rules twice — once in a shape that cannot be enforced,
  then again against real classes. Nine phases, not ten.

- 2026-07-21 — **`managerClassScopes` dropped in favour of `managerUids` on the
  class document.** A rule that depends on a cross-document `get()` forces every
  listing client to carry a matching `where` clause and costs a read per row; a
  denormalised array supports `array-contains` instead. Same reasoning puts
  enrollments at a composite id `{studentUid}_{classId}`, so a student lists
  their own enrollments and never lists classes. The brief's data model states it
  "is not the final schema"; this is a sanctioned consolidation.

- 2026-07-21 — **`role` is one claim** (`admin` | `manager` | `student`), kanban's
  shape rather than the time-tracker's role + separate `admin` boolean. Nobody
  here is a manager *and* separately an admin, so one field cannot get into an
  inconsistent pair.

- 2026-07-21 — **Students arrive active, with no pending state.** Staff creating
  them is the approval. No separate email verification either: completing the
  set-password link proves mailbox control, and the address was asserted by
  staff.

- 2026-07-21 — **App identity**: `com.sabeelinstitute.classrecordings`, slug
  `sabeel-class-recordings`, launcher label "Class Recordings". The brief's
  product name (*Hikam Foundations Class Recordings*) is too long for a launcher
  and bakes one course into the identifier.

- 2026-07-21 — **Phase 0 runs entirely on emulators.** `firebase-config.ts` ships
  placeholders and `.firebaserc` is unset, so nothing before Phase 6 blocks on
  Faisal. The real project is created when Phase 1 first needs a real sign-in.

- 2026-07-21 — **Playback is a 12-hour V4 signed URL** minted by a callable that
  has already checked enrollment, with App Check enforced on it. Faisal's threat
  model: a leaked link must *expire*, but a determined user extracting audio from
  their own device is acceptable. That rules out `getDownloadURL()`, whose
  download token never expires. It does **not** require download-then-play, so
  progressive streaming, instant start and free seeking all stay. Audio is never
  proxied through a Function — the 60-minute timeout would kill a 2-hour session.

- 2026-07-21 — **Zoom import deferred to Phase 6**, against the risk register's
  "prove Zoom first". Zoom credentials are a pending external input, and manual
  upload exercises the whole media pipeline anyway.

- 2026-07-21 — **Infrastructure arrives with its first consumer.** `liveQuery.ts`,
  Firestore/Storage/Auth initialisation and navigation were all deferred out of
  Phase 0 because nothing consumed them, and `knip` correctly called them dead.
  Scaffolding ahead of need makes the dead-code audit lie, and an audit that
  reports nothing is worse than none.

## Verification log

- 2026-10-07 — **Set-password links, measured against production after a
  teacher's report.** A student kept landing on Firebase's hosted "Try
  resetting your password again". That is the reset handler's one failure
  screen (read from its `action.js`), so the screen names no cause; the causes
  were measured with throwaway password-less accounts and are tabulated in
  `docs/DEV-TOOLING.md`, "A student can't set a password". Every send the app
  makes (creation, Resend, "Email me a password link", Change password) kills
  every earlier link at once; a used or truncated link fails the same way, and
  every link expires an hour after it is issued (valid at 58 minutes,
  `EXPIRED_OOB_CODE` at 60); a disabled account fails at Save; opening a link
  does not consume it.
  **No student had ever signed in.** Of the 31 student records, nine are not
  students: two test accounts and seven staff members' own accounts, matched to
  `staffUsers` by name, and every sign-in in the collection was one of those.
  The 22 students were all created 10–25 September; 21 have never set a
  password, and the one who did (a little after 1 pm on 6 October, after 14
  links went out in the noon hour) has not signed in. Auth's request counts
  are project-wide and cannot be split by account, so they place events in
  time and count nothing per student.
  **Open, Faisal's decision:** a continue URL, so "Password changed" leads to
  sign-in; an action handler of our own (the template's action URL changes in
  the console); password-setup status and audited resends on the student page;
  a fresh link at a student's first excusal. Added `npm run students:report`,
  which counts the students apart from the staff and test records.

- 2026-09-11 — **v0.6.4: the second review round.**

  Five review agents over the round-1 diff and the areas beside it, then
  one over this round's own diff; every fix with a test red first where
  the seam allows it, and the two that do not (the trigger-shadowed cascade
  in `deleteSession`, the range branch of the index parser) say so in the
  test file. Backend: `notifyRecordingReady` reads the grant it is handed,
  not the retried event; `shutOutAccount` drops a disabled account's device
  registrations for both populations; a register submission overlays the
  stored map; "not recorded" and a recording are refused together at both
  boundaries, in one transaction; a needs-attention import is always
  retryable; a revoked session is `unauthenticated` "sign in again"; web
  push carries `fcmOptions.link`; four crash-in-the-middle states repair
  (enrolment side-effect on no-op, delete + pointer in one transaction,
  dangling pointer tolerated by draft and delete, attendance projection
  cascaded); a disabled student is refused re-enrolment on both doors; an
  identical override is a no-op. Client: the poll chain (`pollChain.ts`,
  fake-timer race red on the old rule); `hasLedger` (with `publishedAt`),
  `grantOutcome`, `listenedShare`; the recording ledger reads every grant
  and keeps a closed recording's rows; the student's class record says
  "course archived"; a student's withdrawn recording is not a listener
  fault; Play no longer prompts for notifications. Scripts and tests: the
  three drill-down e2e checks wait for their destination and read the
  screen's own H1 (`screen-title`); unhandled page errors fail the run;
  the seeded world carries an open grant on an archived class and the
  sweep reads both its home group and its ledger row; the index parser
  reads ranges and one shape per `query(`; the scope table holds every
  audited callable; the store-exemption scan tokenizes every shipped file;
  the service worker's config is held to `firebase-config.ts`; the release
  script refuses an emulator flag, a bundle without HEAD's commit, and
  warns on a dirty tree; the smoke asserts the live label and that the
  `.map` is not served.

  Device pass on the API 35 AVD with the manifest changes: no storage
  permissions, `allowBackup=false`, `SYSTEM_ALERT_WINDOW` debug-only, the
  document picker opens, the dev overlay still shows; with
  POST_NOTIFICATIONS denied ("don't ask again") the media controls appear
  and playback runs, so the prompt at Play was removed and re-verified
  from a clean install. Found on the way: the AVD needs `adb reverse
  tcp:61107` for the emulator's playback URL (DEPLOY.md). Two decisions
  from Faisal: an archived recording leaves the course totals (manual
  reworded — closing a term is archiving the course), and the release key
  stays the debug key for this release (TODO §9 has the switch).

  Gate on 9cf10d8: lint, typecheck, knip, 433 unit (121 shared, 132
  functions, 180 app), **436 emulator**, **148/148** e2e, **1228/1228**
  sweep. Release APK `v0.6.4 · 9cf10d8`, `versionCode 32`, no dev rows.
  Deployed every function (`--force`; 33 updated, none deleted) and
  hosting; `smoke:prod` green including the new label and `.map` checks,
  `check:queries` servable including the ledger's every-grant shape. Tag
  v0.6.4, APKs on both releases, download page and manual on 0.6.4.

- 2026-09-11 — **v0.6.3: three decisions taken.**

  Faisal's three answers to the review's open questions, each built the same
  way as the round before it: a test red first, the fix, the lateral read.
  (1) Every callable re-checks the account behind its token — `verifyIdToken`
  with `checkRevoked` in both wrappers, refresh tokens revoked on disable —
  proved against real Auth-emulator tokens: live passes, disabled refused,
  revoked refused, re-minted passes. The scope table and the playback suite
  now mint a real token per hand-built request, so the check runs there too
  rather than being skipped; the first cut created those users with no email,
  which `onUserCreate` deletes, and the deletion sometimes landed between the
  mint and the check — created with an email, the shape the trigger leaves
  alone, and two full runs green. (2) An archived course's recordings sit in a
  quiet Archived group on the student home, not the hero, not counted as
  still to listen to — driven in a browser: archive the course, the hero moves
  to the other class, the completed row stays under Completed. (3) A student's
  progress, completion and completion-event writes need an ACTIVE grant, on
  create and on update — rules tests red on the old rules.

  Gate on 25a8153: lint, typecheck, knip, 415 unit, **420 emulator** (twice),
  **141/141** e2e — the whole callable path under the new check, with real
  tokens — and **1168/1168** sweep. Release APK: `v0.6.3 · 25a8153`,
  `versionCode 31`, no dev panel. Deployed rules, every function (`--force`
  for the retry policy; nothing deleted), hosting with 25a8153 inlined;
  `smoke:prod` and `check:queries` green; no function errors in the fifteen
  minutes after. Tag v0.6.3, APKs on both releases, download page and manual
  on 0.6.3, public arm64 APK 43,186,365 bytes.

- 2026-09-11 — **v0.6.2: the review round shipped.**

  Gate on e6429ab: lint, typecheck, knip, **415 unit** (115 shared, 125
  functions, 175 app), **415 emulator** (+17: two simultaneous drafts, two
  simultaneous removals, a closed session's later edit, a Missed grant across
  a reconcile and a reopen, a retry refused on a published recording, an
  orphan account not left behind, a send released on failure, a new deadline
  reminded again, an archived course kept quiet, shaped student rows, an
  unenrolled student refused a class, the missing positive halves), **141/141**
  `test:e2e` — which caught one regression on the way: the staff card's lock
  was set on the callable's response and the snapshot had already landed, so
  the lock never lifted; it is set from the tap now — and **1168/1168** sweep.
  Browser, against the seeded world: a student enrolled after a session was
  submitted shows unmarked, is left out of a correction to somebody else, gets
  no projection, and is sent once marked.

  **Device, debug build against the seeded world — the outbox, for real.**
  Play, then aeroplane mode (`svc wifi disable; svc data disable`), Mark
  complete ("✓ Completed · Pending sync"), `am force-stop`, network back,
  relaunch: the server holds `completed: true` — the replay path. And with a
  NEWER un-mark written server-side while the phone was dead: after relaunch
  the server still holds `completed: false` — the replay yielded. One dev-build
  trap on the way: the LogBox "Open debugger" toast swallows a tap landing
  under it; close it first. **Release APK** on `tb_emu`: `versionName 0.6.2`,
  `versionCode 30`, `v0.6.2 · e6429ab`, no dev panel.

  Shipped: `firestore.rules` (the shape checks and the active-enrolment
  read), every function (with `--force`, which the retry policy on
  `onAssignmentWritten` requires and which deleted nothing — every deployed
  function is in source), hosting with e6429ab inlined and no emulator flag,
  `smoke:prod` green on all eleven including the new Auth-host probe,
  `check:queries` green. Tag v0.6.2 → e6429ab, four APKs on the source
  release and on `recording-latest`, download page and published manual on
  0.6.2, public arm64 APK 43,186,201 bytes.

- 2026-09-11 — **v0.6.1: the review's fixes, through the gate and a device.**

  Gate on 13b6af4: lint, typecheck, knip, **393 unit** (+4 sign-in copy, +1
  history collapse), **398 emulator** (+1: two simultaneous enrolments, one
  through — red on the read-then-write version, green on the transaction),
  **1168/1168** sweep, **141/141** `test:e2e`. Then 24 exploratory checks in a
  browser against the seeded world — rename validation on the real control,
  the History label following a rename live, the archived cohort marked in the
  library dropdown and a cross-cohort course let go, the picker hidden with
  every course archived and creation still working, a double-clicked enrol
  row producing one enrolment and one audit row, a manager with no courses.

  **Device, debug build against the seeded world**: a double tap on an "Add a
  student" row — two `input tap`s in one shell — produced one enrolment and
  one `createEnrollment` row; the row left the list, no error band, and the
  student's History reads "Account created" then one "Enrolled in Hikam
  Foundations · Autumn 2026". **Release APK** on `tb_emu`: `versionName
  0.6.1`, `versionCode 29`, `v0.6.1 · fdc3ea4` on sign-in, no dev panel. Not
  re-proved on this release: push delivery and signed-URL minting, which
  v0.6.0 proved a day earlier on unchanged code and which now have no demo
  account left in production to sign in with — by design.

  Shipped: `createEnrollment` updated (the only function that changed;
  indexes, rules and storage untouched), hosting with fdc3ea4 inlined, no
  emulator flag in the bundle, `.map` served as `text/html`, `smoke:prod`
  green on all ten. `check:queries` and `check:push` green. Tag v0.6.1 →
  fdc3ea4, four APKs on the source release and on `recording-latest`;
  download page reads v0.6.1 with a What's new; published manual cover reads
  0.6.1; public arm64 APK 43,178,781 bytes.

  **Seen in Sentry on the way**: one Android error in thirty days, on
  2026-09-08 — `Missing or insufficient permissions` from `studentRecordings`,
  on a real phone running **0.3.0 (build 19)**. That build lists a course's
  published recordings directly, which the rules have refused to students
  since 2026-08-14 (a recording opens on an active assignment). Nothing in
  the app tells an old build to update, so that student sees an empty
  library and no reason. Left for Faisal's decision — see TODO.md.

- 2026-09-11 — **The demo dataset is out of production, and the wipe had to grow
  to do it.**

  A dry run of `wipe-demo-prod.mjs` against the live project, checked against an
  independent scan of every collection, showed the script reaching 973 of the
  2,011 documents the seed and its use had produced. What it missed: 16
  enrolments and 1,022 attendance projections it never swept by reference; the
  `notifications/demo-stu-01` tree (2 devices, 1 sent) from the push checks,
  which Firestore does not cascade; and five REAL documents naming demo
  accounts — four "Quran Immersion" sessions with six demo students on each
  register, and the course itself with the two demo staff as managers. Staff had
  demoed with real classes open. Fixed at 79123b8, then run with `--yes`:
  **2,011 documents, 73 storage objects, 52 auth accounts** gone, the five real
  documents edited (each register down to its three real marks, projections
  reconciled to three by the trigger, `attendanceSubmittedAt` kept, three real
  managers left on the course), and the script's own post-delete rescan of
  every collection found no id, key or value starting with `demo-`. Independent
  recount: students 67 → 17, staff 17 → 15, auth users 84 → 32, enrolments
  165 → 39, assignments 196 → 4, sessions 93 → 13, recordings 78 → 5; no
  function errors from the trigger cascade.

  **Two accounts left in place, on Faisal's decision**: "Test One"
  (`teyokoj335@prodbits.com`, created 25 Aug from his own staff account, no
  class, no history) and "Test Student" (`test.student@oursabeel.com`, created
  12 Aug by an admin, enrolled in Quran Immersion, never signed in). Neither
  came from the seed or from an agent session, so neither was the wipe's to
  take.

- 2026-09-11 — **v0.6.0: the native `Select`'s first time on a device, and a
  fixture that was hiding a check.**

  Gate re-run on this machine before anything else and matching the author's
  numbers exactly: lint, typecheck, knip, **388 unit**, **397 emulator** (2
  skipped), **1168/1168** sweep.

  **Debug build against the seeded world**, as admin and as the manager:

  - **Library filters.** Both dropdowns open the sheet with the current row
    tinted; picking a cohort narrows the course sheet (Spring 2026 offers only
    Seerah Survey) and the list (0 of 8); **Clear filters** appears, and at
    phone width the row wraps it onto its own line cleanly rather than
    squeezing the dropdowns; clearing restores all eight and the button goes.
    The manager's course dropdown holds only their one course, and after the
    rename below it already read "Autumn 2026 Term" — the label follows the
    document live.
  - **Student history.** As admin, all seven rows in order — created, enrolled,
    removed, re-enrolled, disabled, re-enabled, re-enrolled elsewhere — each
    with who and when. As the manager, four rows under "Enrolment changes in
    the courses you manage": the disable/re-enable pair and the other course's
    re-enrolment correctly absent. The long course name in the last row **wraps
    at word boundaries** — the Yoga check, and this time it passed.
  - **Cohort rename.** With the keyboard up, the field and the Rename button
    both stay visible above the IME; Rename is disabled until the name differs
    and lights up on the first changed character; the page title followed the
    write live and Rename greyed out again once the name matched.
  - **Disabled staff.** The closed section opens, Re-enable is on the card, and
    pressing it moved the person back into Staff (2 → 3) with the section gone.

  **Found: the fixture, not the app.** The first press of Re-enable failed
  `auth/user-not-found`. The seed wrote `staffUsers/sw-disabled` straight to
  Firestore with no Auth user behind it — a shape production cannot produce,
  since every staff document there was written by the trigger for a real
  sign-in — and `setStaffAccess` writes the Auth record first. The app did the
  right thing: "Something went wrong. Try again in a moment." at the top of the
  screen. But the pass had pressed the button and learned nothing. Fixed by
  giving the fixture a password-less Auth user (the shape `onUserCreate`
  ignores), and the check above is against that. The web e2e already exercised
  Re-enable against a real account, so nothing was uncovered on the web; the
  device pass simply could not see it until now.

  **Release APK against production.** `versionName=0.6.0`, `versionCode=28`,
  labelled `v0.6.0 · ac2ead3`, **no dev sign-in panel**. Push delivered end to
  end to the demo student on this build — app icon, `sabeel-alerts` channel,
  alerting section.

  **Not re-exercised, and why.** Playback minting a signed URL needs a student
  with an open grant, and production has none — every due date has passed,
  the demo students' included. The handoff assumed the demo student was that
  account; it is not, and reopening one is a production write standing in for
  a test. Verified on v0.5.0, and nothing in this release touches
  `getPlaybackUrl` or the player. The library on production data needs a staff
  sign-in, which is Google, which this session holds no account for; the same
  screens were exercised on the debug build.

  **Deployed in order**, and the order was load-bearing: indexes first, then a
  five-minute wait for the two `auditLog` composites to build — and a further
  minute after `gcloud` said READY before the query planner would use them, so
  `check:queries` failed once with "currently building" and passed on the
  retry. Then rules, storage, functions (`renameCohort`, a new function and
  therefore a cold build, deployed first time on the committed lockfile), and
  hosting: bundle inlines `ac2ead3`, `0.6.0`, no emulator flag, `.map` returns
  `text/html`, `smoke:prod` green. Tag `v0.6.0`, four APKs on both release
  homes, download page and published manual both reading 0.6.0.

  **The machine lost KVM between passes.** `/dev/kvm`'s ACL had only the
  display manager on it — the device node had been recreated without the
  session's entry — so the AVD refused to start in hardware mode. A reboot
  re-applied the ACL. `sudo gpasswd -a $USER kvm` makes access not depend on
  the session; recorded in TODO.

- 2026-09-07 (v0.5.2) — **The account gate and the public pages, shipped.**

  Everything from the store-prep work is now in people's hands: web deployed and
  verified (`ff79d22`, `0.5.2`, no emulator flag, `smoke:prod` green on all ten
  checks including the three pages fetched anonymously), tag `v0.5.2`, four APKs
  on both release homes, download page and published manual both reading 0.5.2.
  Release APK confirmed on the AVD as `versionName=0.5.2`, `versionCode=27`,
  labelled `v0.5.2 · ff79d22`, no dev sign-in panel.

  Gate green: lint, typecheck, knip, **368 unit**, **390 emulator** (2 skipped),
  **1108/1108** sweep.

  **Two self-inflicted delays worth not repeating.** The AVD was killed
  mid-release because it was running alongside both the Gradle build and the full
  gate — `earlyoom` on this box prefers `qemu-system-x86`, which this repo's own
  notes say. Then a `pkill -f qemu-system-x86` to clean up matched the killing
  shell's own command line and took the session with it — the exact trap
  `free-emulator-ports.sh` documents for `pkill -f firebase`. Kill by executable
  name (`ps -eo pid,comm`), and do not run the AVD next to a build.

  Still outstanding and unchanged: the refusal round trip on a real device with a
  personal Google account, and `privacy@oursabeel.com` needing to exist before
  the policy's promise means anything. Both are in `TODO.md`.

- 2026-09-07 (store prep) — **The account gate and the three public pages, live —
  and the lockfile fix paid for itself.**

  `accountExists` deployed and **ACTIVE**, which is worth recording for a reason
  beyond the feature: it is a brand-new function, and a new function is exactly
  the case that broke the v0.5.0 deploy twice — a cache miss forces Cloud Build
  to resolve dependencies from scratch, and with no lockfile in `functions/` that
  resolution crashes. With `functions/package-lock.json` committed it deployed
  first time, no stub, no `--force`. 32 gen-2 functions, all ACTIVE.

  **Deployed deliberately ahead of any APK that calls it.** On a build carrying
  the gate, a missing callable is not a degraded sign-in — it is no staff sign-in
  at all. Written into `docs/DEPLOY.md` so the order is not rediscovered.

  **The three pages answer anonymously**, on the web app's own domain:
  `/privacy`, `/support`, `/get-app`, each fetched with no session and checked to
  be the page rather than the app shell. `smoke:prod` green on all ten checks.
  `PRIVACY_URL` now resolves — it previously pointed at
  `recordings.oursabeel.com`, attached to nothing, so the one link a reviewer is
  guaranteed to follow led nowhere.

  **A false failure worth keeping.** The first `smoke:prod` after the deploy
  reported all three as "the rewrite is behind `**`" — which is a precise and
  entirely wrong diagnosis. The rewrites were right and the files were exported;
  the edge was still serving the cached catch-all response for those paths, and a
  minute later everything passed. Reported once, that sends you to
  `firebase.json` to fix something that is not broken. The check now retries for
  twenty seconds, bounded so a real fault still fails — verified by pointing the
  same logic at a path with no rewrite, which is still correctly detected as the
  app shell.

  Neither of these is in anyone's hands yet: no APK contains the gate, and the
  live web bundle is the one that ships with the next release.

- 2026-09-07 (v0.5.1) — **Both defects the device pass found, shipped — and a
  third thing it turned up about the fixture.**

  A patch release for the two faults recorded above, on every surface: web
  deployed and verified live (bundle inlines `02dbc0a`, contains `0.5.1`,
  contains `EXPO_PUBLIC_USE_EMULATORS` zero times, `.map` returns `text/html`,
  `smoke:prod` green), tag `v0.5.1`, four APKs on both release homes, and the
  download page and published manual both reading 0.5.1.

  **The lock screen and the notification now name what is playing.**
  `setActiveForLockScreen(true)` was being called with no metadata argument, so
  the OS had nothing to display and drew transport controls over a blank space
  — on the notification, the lock screen, and any car or Bluetooth display.
  Every version has shipped that way. The title now travels with `load`, and is
  applied twice on purpose: the audio setup is async and is not ordered against
  `load`, and `updateLockScreenMetadata` is a documented no-op until the player
  is active for the lock screen, so whichever finishes last carries it. Web
  feeds the same values to `navigator.mediaSession`.

  Confirmed on the device: `dumpsys media_session` went from `metadata: null` to
  `metadata: size=4, description=Session 2 — Knowledge and Certainty, Hikam
  Foundations`, and the shade shows those two lines where it showed none.

  **A defect the emulator fixture cannot catch, and nearly caused a false
  alarm.** The seeded recording does not actually PLAY: the session sits in
  `ERROR(7) Source error` with the position frozen, while the app's transport
  looks enabled and reports a duration. That read exactly like a regression in
  the change under test. Removing the metadata call and re-running produced the
  identical error, which is what settled it — the same recording plays correctly
  against production, verified earlier the same day, so this is the storage
  emulator, not the app and not the fix.

  Worth writing down because of WHY it went unnoticed: the sweep only needs a
  duration to render a transport, and `seed-world.mjs` says so in as many words
  — "it has to actually decode: the transport renders disabled until the media
  reports a duration". Decoding a header is all any automated check has ever
  asked of that fixture. **Nothing in this repo plays audio to the end**, on any
  surface, and the one place it could be noticed is a device pass.

  **What that leaves unproven, stated rather than glossed.** The metadata was
  confirmed against the emulator build. Production playback was NOT re-exercised
  for this release: no student in the live project has an open grant today, and
  opening one is a production write standing in for a build — the mistake this
  release's own runbook change exists to stop. The before-state, a blank title
  over genuinely playing production audio, was seen on v0.5.0; the after-state
  was seen on the emulator. The path between them is the same `load` call on the
  same build type.

  **The mid-word title fix** verified on the device too: "Hikam Foundations"
  reads on one line and the two actions wrap onto their own row, which is what
  `headRow`'s `flexWrap` was for all along.

  Gate green on this machine: lint, typecheck, knip, **359 unit** (the new one
  asserts the session hands the player what to display, and was shown to fail
  with the argument dropped), **383 emulator** (2 skipped), **1108/1108** sweep.
  Release APK confirmed on the AVD as `versionName=0.5.1`, `versionCode=26`,
  labelled `v0.5.1 · 02dbc0a`, with no dev sign-in panel.

- 2026-09-07 (later) — **The half of the device pass that was skipped, run
  properly — and it found a defect that had already shipped.**

  The v0.5.0 pass above recorded eight seams as unreachable: staff screens
  needed a Google account, the offline outbox needed an incomplete grant
  production did not have. Both were reachable the whole time. `devSignIn.ts`
  mints staff identities through the AUTH EMULATOR, and `seed-world.mjs` builds
  any data shape on demand — so a **debug build against the emulator suite**
  reaches every one of them.

  **The reasoning error is worth keeping**, because the runbook invited it.
  "Do the device pass on the release APK" is about proving the shipped artifact
  is a production build; it was read as "the release APK is the only build
  allowed on the device", which silently converted every seam that build cannot
  reach into a seam nobody checks. Two builds, two jobs — `docs/DEPLOY.md` now
  says which rows belong to which, and the seeded world is available as
  `npm run seed:emulators`.

  It also cost a production write: the demo seed was re-run and a real session's
  due date moved forward, to open a grant so audio could be played at all. The
  emulator world has an open, incomplete grant sitting in it.

  **FOUND, on the staff course screen: a page title broken mid-word.** "Hikam
  Foundations" rendered as **"Hikam / Foundat / ions"** on a Pixel 6, with
  "Sessions, roster and listening" crushed to three lines beside it. `headRow`
  is `flexWrap: 'wrap'` and was meant to drop the actions onto their own line,
  but `headText` had `flexShrink: 1` with no floor — so it shrank instead, the
  row never overflowed, and it never wrapped. `headActions` carries no
  `flexShrink`, which Yoga defaults to 0, so all of the give came from the
  title. Fixed with `minWidth: 220`; the actions now wrap and the heading reads
  on one line.

  Same defect class, and the same remedy, as the ledger tiles' "Accountabl / e"
  in the v0.4.3 pass. **Nothing else could have caught it.** The sweep asserts
  that nothing is clipped, nothing overlaps and the column caps — all true of a
  crushed heading — and react-native-web does not reproduce Yoga's
  `flexShrink: 0` default, so the squeeze does not happen in a browser at any
  width. It is device-only, twice now.

  **Verified on the device, as a student and as staff:** the Today work queue
  with its blocking badge; marking a class not recorded, which took the row off
  Today live (**7 waiting → 6**) and left the register untouched, with "It was
  recorded after all" to undo; an admin who manages no class seeing NO
  notification switches and the sentence naming who does get them; the
  by-student attendance report listing an unenrolled student as *No longer
  enrolled* with her seven excused still counting; and the **offline outbox** —
  airplane mode on, mark complete, "Pending sync", airplane mode off, the badge
  clears and the row lands in Firestore. Long class and student names wrap
  correctly everywhere else that was looked at.

  **A trap that wasted an hour and is now written down.** `expo run:android
  --no-bundler`, pointed at a dev server started separately, produces an app that
  installs, signs in and looks entirely healthy — and never picks up another
  source edit. Metro logs the rebuild, the served bundle contains the change, and
  the device goes on rendering the old one. Every "the fix did not work" reading
  during that hour was false; the fix had been correct since the first attempt.
  Let `expo run:android` start its own Metro.

  Still not reached: long-press and swipe gesture paths beyond scrolling, and
  Zoom import, which has no credentials.

- 2026-09-07 — **v0.5.0 shipped to every surface, and the device pass paid for
  itself twice — once by finding a defect, once by disproving one.**

  **Deployed in order**: indexes → rules → storage → functions → migration →
  hosting. `check:queries` earned its place before a line was deployed: it failed
  on the collection-group index `onDeviceRegistered` needs, which
  `firestore.indexes.json` declared and production did not have. Deploying
  indexes first fixed it and the re-run is green on all 34 shapes. `check:push`
  green. The live ruleset was read back from the Rules API and is **byte-identical
  to `firestore.rules`**, rather than trusted from "Deploy complete".

  **The functions deploy failed twice, and the cause was not the code.** Cloud
  Build receives only `functions/`, and with no lockfile there it runs
  `npm install --package-lock-only` to make one — which crashes under the
  builder's Node 22 npm with `Cannot read properties of null (reading
  'edgesOut')`. Every previous deploy survived only because unchanged functions
  restore a cached layer and never reach that step; `onDeviceRegistered` is new,
  got a cache miss, and could not. Each failed attempt left a FAILED stub with no
  trigger, which the next deploy reads as an HTTPS function and refuses to
  convert — so the second failure was a *consequence* of the first, not a new
  fault. Fixed by committing `functions/package-lock.json`, pinned to the versions
  the suite actually ran against rather than a fresh resolution (which would have
  shipped `@sentry/node` 10.73.0 and `firebase-functions` 7.3.2 against a tree
  tested on 10.67.0 and 7.3.0). All 30 gen-2 functions ACTIVE, `onUserCreate`
  (gen-1) ACTIVE, and `onDeviceRegistered` carries the Firestore trigger on
  `notifications/{uid}/devices/{token}`.

  **The migration**: 91 sessions, 91 renamed, **0** carrying `archived: true`, 0
  left on the old shape. Its one sharp edge — it rewrites `notRecorded: false`
  over any document still carrying `archived` — is closed by running it before
  hosting, and the dry run confirmed the window was empty (0 already
  `notRecorded`).

  **Web, checked live rather than announced**: the deployed bundle inlines
  `d57cded`, contains `0.5.0`, contains `EXPO_PUBLIC_USE_EMULATORS` zero times,
  and a `.map` URL returns `text/html` — the content-type, not the status.
  Source maps uploaded to Sentry (the skip line did not appear). `smoke:prod`
  green on all seven.

  **The device pass, on the release APK** (`versionName=0.5.0`, `versionCode=25`,
  sign-in reads `v0.5.0 · d57cded`, **no dev sign-in panel** — which is what
  proves it is a production build), signed in as the demo student against
  production:

  - **Background audio really is background.** Playback ran 0:28 → 2:20 with the
    app sent to HOME, and `AudioControlsService` held a foreground service with
    `types=0x00000002` (mediaPlayback). It continued 3:18 → 3:58 across a
    screen-off/on.
  - **Seek and rate**: `+30` moved 2:20 → 3:18; 1.5× took and playback carried on.
  - **Push, end to end and for real**: a token was minted on the device, written
    to Firestore, and **`onDeviceRegistered` fired in production** on that write
    (a new instance at 17:21:36 UTC, no error) — the first live exercise of a
    trigger this release added. A send from the Admin SDK then arrived in the
    shade carrying the app's own icon, under the `sabeel-alerts` channel and in
    the **alerting** section, not FCM's "Miscellaneous" fallback. Reactivating a
    grant also produced a real `onAssignmentWritten` notification, unprompted.
  - **Keyboard**: the focused field stays above the IME on both sign-in fields,
    and the view scrolls to keep the Sign in button reachable.
  - **The v0.5.0 shell on a real device**: Listening · Classes · More, and a
    completed row reading "Marked complete by your teacher" with the reason —
    one of this release's four decisions, seen rather than reasoned about.
  - **Orientation is not a gap**: `android:screenOrientation="portrait"` on
    MainActivity, so "both orientations" is satisfied by design.

  **Found: the media session publishes no title.** `dumpsys media_session` reports
  `metadata: null`, so the transport notification — and the lock screen, and any
  car or Bluetooth display — shows controls with no indication of what is
  playing. `docs/DEPLOY.md` asks this row to confirm "the notification shows the
  right title", and it does not. **Not a regression**: v0.4.3 reports
  `metadata: size=2, description=null`, which renders the same nothing, so this
  release is no worse than what is already shipped. Left open deliberately rather
  than fixed inside a release.

  **A false alarm, recorded because the method matters.** The first resume test
  showed the app signed OUT after a kill, with AsyncStorage empty — which looked
  like a broken `getReactNativePersistence` and a release blocker. It was an
  artifact of installing over a ten-day-old session on the AVD. A clean install
  of 0.5.0 writes `firebase:authUser:…` and survives the kill, and so does a real
  0.4.3 → 0.5.0 in-place upgrade. The lesson is the repo's own: an A/B whose two
  arms differ in more than the variable proves nothing, and the second test is
  what turned a blocker into a non-finding.

  **Not reached, and not claimed.** Staff-side device checks need Google sign-in
  on an `oursabeel.com` account, which this session had no credentials for; the
  offline outbox and the gesture and long-name rows need an incomplete grant,
  and the only open one available was already teacher-completed. Zoom import
  remains unverifiable end to end — still no institute credentials.

  Gate green on this machine before shipping: lint, typecheck, knip, **358 unit**,
  **383 emulator** (2 skipped via `it.runIf`), **1108/1108 sweep** at five widths.
  The first run failed typecheck on `@expo/vector-icons` — a dependency the
  release added and `npm install` had not yet fetched here, not a defect in the
  diff.

- 2026-08-15 — **v0.4.1: the switches, checked on both surfaces.** Web push was
  confirmed working in Faisal's own browser first, which closed the last open
  item from Phase 7. The switch itself was then looked at rather than reasoned
  about, on web AND on the AVD — the repo's own rule that web is not evidence
  about native applies squarely to a control built from a transform. Both states
  render in brand colours on both, and tapping the row (not just the pill) moves
  it. Live: sign-in reads `v0.4.1 · 505453c`, APK `versionName=0.4.1`
  `versionCode=22` with no dev panel, published manual reads 0.4.1,
  `smoke:prod` green.

- 2026-08-15 — **v0.4.0 shipped, and the migration verified in production.**
  Deploy order held: indexes → rules → storage → functions → migration →
  hosting. The migration backfilled the one null due date, touched all 84
  sessions, and the deployed triggers re-derived everything: **175 active grants
  became 43**, 133 rows kept as inactive history, and 1017 attendance
  projections written where there were none. Audited afterwards rather than
  trusted: all 43 surviving grants were checked against their session's
  attendance map and every one names a student really marked `excused` — zero
  exceptions — and no session is left with a null due date.

  Live checks: the deployed bundle carries `5fac5af` and `0.4.0`, contains
  "Notifications" and "My classes", contains "Browse all recordings" zero times,
  has no emulator flag, serves `firebase-messaging-sw.js` at the origin root as
  `text/javascript`, and returns `text/html` for a `.map`. `smoke:prod` green on
  all seven. The release APK on `tb_emu` reads `versionName=0.4.0`,
  `versionCode=21`, labels itself `v0.4.0 · 5fac5af`, and shows **no dev sign-in
  panel** — which is what proves it is a production build.

- 2026-08-15 — **A real notification arrived on a real device.** With the VAPID
  key in place, the app on `tb_emu` registered an FCM token, the Admin SDK sent
  to it against the LIVE project, and the notification appeared in the Android
  shade carrying the exact copy `recordingReadyMessage` produces. Admin SDK →
  FCM → Play Services → notification shade, the whole chain, with nothing
  stubbed. That is the step the plan said only a human could confirm.

  `npm run check:push` keeps the repeatable half: it validates the VAPID key is
  an uncompressed P-256 point and sends to a bogus token, whose
  `registration-token-not-registered` proves FCM authenticated us as this
  project — and pins `DEAD_TOKEN_CODES[0]` to a code FCM really returns rather
  than one read off documentation. It cannot mint a browser token: Playwright's
  Chromium ships without the Google API keys needed to reach FCM's push service,
  and branded Chrome under Playwright refuses too. Web delivery stays a human
  check.

- 2026-08-15 — **Two bugs in the web push seam, found by trying it.** Neither
  would have shown up in review. `serviceWorker.register()` resolves when the
  script is FETCHED, not when a worker is running it, so handing that
  registration to `getToken` fails with "Subscription failed - no active Service
  Worker" — on a first-ever visit only, which is exactly the visit that matters
  and the one no returning developer ever sees again. `serviceWorker.ready` is
  the right promise, and it is now raced against a timeout, because `ready` never
  REJECTS: a worker that fails to activate leaves it pending forever and the
  settings screen would sit on "checking" with no notice and no error.

- 2026-08-15 — **`check:queries` caught an index the emulator never would.** The
  morning sweep asks `sessions where attendanceSubmittedAt == null and
  date <= cutoff` — one equality and one inequality on different fields, which
  needs a composite index. The emulator builds indexes on demand and answers it
  happily; the scheduled function would have failed on its first real morning,
  in a job nobody is watching at 07:00. Added and deployed, and the probe now
  passes. This is the second time that script has paid for itself.

- 2026-08-15 — **The native push path proven on a device, short of delivery.**
  The debug APK on `tb_emu`: the app launches with `expo-notifications` linked
  and does not crash; opening **Notifications** raises the Android permission
  prompt (from a user gesture, which is the only kind browsers and Android
  respect); allowing it registers a real 142-character FCM token from Play
  Services at `notifications/{uid}/devices/{token}` with `platform: android`;
  and signing out deletes it, so a shared device cannot deliver one person's
  notification to the next. What remains unproven is only the send itself, which
  needs Cloud Messaging enabled on the real project.

- 2026-08-15 — **Notifications verified everywhere except delivery.** 23 tests:
  the `notifications` rules block mutation-tested (opening it turns all six
  denial assertions red, including a student pre-claiming their own `sent`
  marker to silence themselves), and 14 integration tests driving the three
  messages with the FCM sender stubbed — sent once however many times the
  reconcile runs, silent for an unpublished recording, silent for someone who
  finished in time, silent about a course that has ended, and a dead token
  pruned while a live one survives. The e2e drives the settings screen for both
  populations. Delivery itself has no test anywhere: there is no FCM emulator,
  and the transport is the one function a real device has to prove.

- 2026-08-15 — **The web service worker reaches the export.** `app/public/`
  is copied verbatim by `expo export`, confirmed against `dist-web` rather than
  the dev server — Hosting serves a matching real file before the `**` →
  `/index.html` rewrite, so it needs no rewrite exception, but a worker that
  never shipped would fail exactly as silently as one that did.

- 2026-08-14 — **Both new rule arms mutation-tested.** Opening the recordings
  student arm to any published recording turned four assertions red — the two
  new ones (never granted; grant withdrawn), the cross-course one, and the
  get-only list denial — proving the arm, not the ambient enrolment check, is
  what refuses. Opening `attendanceRecords` to any signed-in user turned five
  red, including a student reading a classmate's mark and a student dropping the
  `studentUid` filter to read the class. Restored, both files green: 34 tests.

- 2026-08-14 — **The policy proven through the real triggers, end to end.** In
  `npm run test:e2e`: marking the late student ABSENT grants them nothing (the
  same action that used to create an obligation), then marking them EXCUSED
  grants them, via the deployed `onSessionWritten`. The student's own mark
  renders on their class page — out of a session document they can never read,
  so it can only have come from the projection.

- 2026-08-14 — **The deadline proven at the boundary, not just in the UI.** A
  past due date planted out of band (no callable will write one) flows through
  the real trigger to every grant; `getPlaybackUrl` then answers
  `403 PERMISSION_DENIED "The due date for this recording has passed."` — asserted
  against the callable directly rather than through the screen, because the
  screen refuses first and would hide a server that had quietly stopped checking.
  A recording completed in time stays Completed rather than being recast.

- 2026-08-14 — **The screenshot caught what the exit code could not.** With every
  check green, `24-past-due-player.png` showed the player still drawing a full
  transport — play, skip, speed, scrubber — over a recording the server had
  already refused, and the line "Available to listen until 2020-01-01" for a date
  two years gone. Both fixed: the player now gates on the deadline the same way
  it gates on an archived course, and states the closure. Correct logic survives
  right up until you look at the rendered screen.

- 2026-08-13 — **Both Sentry denials reproduced from their URLs, then fixed.**
  The events carried `source` tags (`session`, `myAssignments`) and request URLs
  (`/courses/<id>/sessions/<id>` and `/`). Driving those exact URLs under the
  wrong role reproduced both labels verbatim: a student signing in on the staff
  session URL logged `session listener permission-denied` and rendered the staff
  screen; a manager on `/my-recordings` logged `myAssignments` and rendered the
  student one. After the role split, both land on their own home with no denial.
  Mutation-tested: reverting `App.tsx` alone turns all four role-boundary checks
  plus the global live-data check red, and does so **with the expected-denial
  guard in place** — which is the proof that the guard suppresses only the
  sessions that cannot read, not real denials.
  The `/` event is the one piece that is reasoned rather than reproduced: a
  student's own assignments query is permitted, so a denial there means the token
  had already lost its claims, and the Sign out button is on that very screen.
  The sign-out race does not reproduce on a fast local machine — React unmounts
  before the server's refusal returns — so the guard for it is argued from the
  URL and label, not demonstrated.

- 2026-08-13 — **The e2e now counts refused subscriptions, not just errors.**
  `reportListenerError` logs a console WARNING, and the harness only collected
  console ERRORS — so three separate denials shipped while the suite stayed
  green. Each renders as an ordinary empty state, and the banner sits above the
  fold on screens the checks never read. Every page now feeds a run-wide list and
  the suite fails on any unmarked entry.

- 2026-08-13 — **The absent-enrollment denial, mutation-tested at both layers.**
  Rules: a new `rules.structure.test.ts` case asserts a manager's get on an
  ABSENT enrollment fails while the equivalent one-course-one-student list
  succeeds; opening the rule with `resource == null && isStaff()` turned it red,
  and restoring it green. E2E: the existing manager check ("a student in none of
  their courses says so") passed **both before and after the fix** — a refused
  read and a genuine absence both leave the row unrendered, so the visible
  outcome was identical and the denial was invisible to it. The added assertion
  is the absence of the live-data banner, and reverting the two client files
  turned exactly that check red with everything else still green. That pair is
  why this shipped in v0.3.0 and why it cannot ship again.

- 2026-07-22 — **Phase 5 proven in PRODUCTION (multi-role).** Temp admin + two
  managers (each scoped to one class) + two students, deleted after: publish
  fanned out the assignment; the deployed `overrideCompletion` wrote the override
  doc with its reason and recorded it in the audit log; and the scoped reads held
  against the real rules — the class's manager reads the override, ANOTHER class's
  manager gets 403, a student reads their own but not another's, and no client
  (even a manager) can write an override directly. All temp data cleaned up.

- 2026-07-22 — **Phase 5c + 5d: ledger UI, library, audit, CSV.** Contextual
  staff views, all client-side live joins over the 5b reads, computing with the
  pure `ledger.ts`: a **recording ledger** (accountable roster, action-first
  Not-complete/Overdue chips, per-row effective status + listened% + override
  form) opened from `RecordingsScreen`; a **student ledger** from the ClassDetail
  roster; **class-level incomplete/overdue counts** on ClassDetail; the
  cross-cohort **recording library** with status counts (Phase-3-deferred) from
  Home; and a scoped **audit view** (per-class + admin-global). CSV export is a
  pure `toCsv` (7 unit tests) behind a web/native seam (Blob download / share
  sheet, `expo-sharing`+`expo-file-system`). e2e drove it end to end: the ledger
  renders the roster, a staff override (with reason) writes the override doc and
  shows Complete (override), the **CSV mirrors the ledger row-for-row** (the
  brief's exit criterion), and the audit view shows the override with its reason.
  Screens looked at — on-brand. No new indexes (recordingId reads are
  pure-equality). 76 shared + 42 functions unit.

- 2026-07-22 — **Phase 5b: staff ledger reads + completion override.** Opened
  staff-scoped reads (via a new `staffManagesClass(classId)` rules helper) on
  `completions`, `completionEvents`, `listeningProgress`, plus the new
  server-only `completionOverrides` (student reads their own; staff scoped). The
  `overrideCompletion` callable writes a SEPARATE override doc a student cannot
  clobber, with a REQUIRED reason (empty rejected) that lands in the audit
  detail; `clearCompletionOverride` removes it. Pure `ledger.ts`
  (`effectiveCompletion` = override ?? student, `rollup`, `ledgerBucket`) — 8
  unit tests at the day boundary. 172 emulator tests (was 151). Mutation:
  widening `staffManagesClass` reddened exactly the 8 cross-class ledger tests.
  `check:queries` needed exactly ONE new composite — `auditLog (classId, at
  desc)` for the ordered manager audit view — now built and servable in prod;
  every ledger read is pure-equality.

- 2026-07-22 — **Phase 5a: audit spine.** `auditedCall(action, handler)` extends
  `reportedCall` so all 16 mutating callables write one `auditLog` entry per
  successful call automatically (reads like `getPlaybackUrl` stay `reportedCall`);
  the auth trigger audits its provision/reject decisions. Class-scoped handlers
  set `audit.classId` so a manager can read their-class entries; class-less
  actions (cohort/staff/student-directory) are admin-only. The audit write is
  best-effort — a failed audit never undoes or fails a completed mutation. New
  `auditLog` rule mutation-tested (widening manager scope reddened exactly the
  three scope tests; opening writes reddened the write test). e2e proved it end
  to end: after a full run the log held all 13 distinct staff actions, class
  entries carrying classId, cohort entries null. 151 emulator tests (was 144).

- 2026-07-22 — **Phase 4 proven in PRODUCTION, end to end.** Driven through the
  real callables with temporary accounts (deleted after): the deployed
  `onRecordingWritten` trigger fanned out an assignment (`source:publish`,
  active) — the first time the real trigger has been exercised in prod, and it
  survived the Eventarc first-deploy retry; a student's completion write was
  accepted by the self-only rule (`completed=true`); and a non-enrolled student's
  forge attempt was refused 403. Doubles as a happy-path check that the
  Sentry-instrumented functions still work after redeploy.

- 2026-07-22 — **Sentry live on all three surfaces.** Web reporting deployed;
  the functions `SENTRY_DSN` secret set in Secret Manager and the functions
  redeployed, so server reporting is active — the secret is bound to all 19
  functions (verified by name: callables via `reportedCall`, the fan-out trigger,
  and the gen-1 auth trigger). `@sentry/react-native` proven to autolink into the
  committed `android/` build and run on the AVD. Reporting is gated OFF in
  dev/debug bundles, so events come only from deployed surfaces. Source-map
  upload deferred (needs a Sentry auth token + prebuild). No DSN value is in git.

- 2026-07-22 — **Phase 4d: catch-up staff UI, end to end.** A published
  recording's card now offers "Assign as catch-up", listing enrolled students who
  are NOT already accountable (normal publishing covered the rest) with an
  optional due date. e2e proves the whole scenario: a recording driven past-due,
  a genuinely late student enrolled (and confirmed NOT auto-assigned it), then
  staff assigning it as catch-up with its own due date — one `source:'catchup'`
  assignment created, and the candidate list correctly emptied afterward
  (screenshot looked at, on-brand). The callable itself was already integration-
  tested in 4b (scope, enrolment, published-only, due-date protection).

- 2026-07-22 — **Phase 4c native durability spike, PROVEN on the tb_emu AVD.**
  The deferred 4a question is resolved with a real force-kill test, not an
  assumption. On native the JS SDK has only a memory cache, so a completion
  marked offline is lost across an app kill — confirmed: after marking complete
  with wifi off and force-stopping the app, Firestore held **0 completions**. A
  native-only AsyncStorage outbox (`completionOutbox.ts`, a no-op on web where the
  persistent cache suffices) closes the gap: on relaunch with the network back,
  `drainCompletionOutbox` replayed the queued write and it synced
  (`completed=true`), with the home showing Completed and the session still
  signed in (AsyncStorage auth survived the kill too — the same durability
  substrate the outbox relies on). Every player control rendered correctly on
  native (screenshots looked at). The web e2e re-run green through the seam.

- 2026-07-22 — **Phase 4c (part): student home, completion, unassigned labels.**
  A student's landing is now a task-ordered home (Overdue → Due soon → Upcoming →
  No due date → Completed), built from their own live `assignments` + `completions`
  joined to recording/class details. Completion is a direct client Firestore
  write (`completions` state doc + append-only `completionEvents`), offline-capable
  via the persistent cache, with the never-played gate enforced in the player.
  `useLiveQuery` gained an opt-in `includeMetadataChanges` so the Pending-sync
  badge clears when a queued write lands. The class archive labels
  accessible-but-unassigned recordings "Not required". e2e extended and green:
  publish → the item appears as required on the home → mark complete writes the
  doc + event → the player shows Completed/Unmark → the home moves it to
  Completed (screenshots looked at: on-brand, correct grouping). **Still pending
  in 4c:** the native app-kill durability spike on the AVD (deferred from 4a) and
  its AsyncStorage backstop if the queued write is lost across a force-kill.

- 2026-07-22 — **Phase 4b: assignment model, fan-out, rules.** Pure due-date
  maths in `@sabeel/shared` (`todayInZone`/`isOverdue`/`dueBucket`) — 16 unit
  tests incl. the Houston day boundary (due-today is *due*, next day *overdue*)
  and a DST case. Fan-out logic (`applyRecordingFanout` + helpers) integration-
  tested against the emulator: publish creates one active assignment per active
  enrollment and is **idempotent** (re-publish stays at 2, not 4); unpublish
  deactivates but keeps rows; a due-date edit moves `publish` assignments while a
  `catchup` keeps its own date; a class move reassigns to the new roster; late
  enrollment assigns only not-yet-due published recordings; unenroll deactivates.
  New rules (`assignments` read-scoped like `/enrollments`; `completions`
  self-only; `completionEvents` append-only) mutation-tested — flipping the
  completionEvents immutability guard and the completions self-only guard each
  reddened exactly one assertion, restored clean. 144 emulator tests (was 119).
  **check:queries confirmed zero new composite indexes are needed** — every
  Phase 4 query is pure equality, served by single-field zigzag joins. The e2e
  now proves the REAL `onRecordingWritten` trigger fires: after publishing, the
  enrolled student's assignment appears.

- 2026-07-22 — **Phase 4a: Firestore persistence seam.** `app/src/firestoreInit.ts`
  / `.web.ts` mirror the existing auth seam: web gets `persistentLocalCache`
  (IndexedDB) so offline writes survive a page close and surface as
  `hasPendingWrites`; native keeps the memory cache, because the JS SDK has no
  IndexedDB on React Native (the same reason auth is wired to AsyncStorage). Full
  e2e re-run green with persistence on, including the Phase 3 resume-across-reload
  test. **Deliberately split from the plan's 4a:** the native app-kill durability
  check needs the completion write path to exist, so it moves to 4c on the AVD,
  where the memory-cache gap is closed by an AsyncStorage backstop over the same
  direct-write path if the test confirms it is lost across a kill.

- 2026-07-22 — **Phase 3 proven end to end against the REAL project.** Driven
  through the actual callables with real ID tokens: createCohort → createClass →
  createStudent+enrollment → createRecording → upload through the Storage REST
  API with a staff token (so `storage.rules` was genuinely exercised, not
  bypassed by the Admin SDK) → finalize read back the exact 509,121 bytes →
  publish → a student signed in, `getPlaybackUrl` returned a **real V4 signed
  URL** (`X-Goog-Signature` present, ~12 h), it streamed the exact file, range
  requests answered 206, a second upload was refused 403 (write-once), and a
  NON-enrolled student was refused playback. All temporary data and accounts
  deleted afterwards; the walkthrough script is deliberately NOT committed,
  because it mints an account with admin claims and a known password.
- 2026-07-22 — **`createStudent` rejected the very first student**, before any
  class existed, with "classId must be a class id." The callable client
  serializes an explicitly-`undefined` property as **null**, so the UI's
  `classId: classId ?? undefined` arrived as `classId: null` and a guard testing
  only `!== undefined` treated it as a bad value. Fixed on both sides (server
  treats null as absent; client omits the key) and verified in production with
  the exact failing payload. The walkthrough above had missed it by always
  passing a classId — a reminder that a happy-path script is not coverage.

- 2026-07-22 — **`firestore.indexes.json` was EMPTY, and no test could have told
  us.** The Staff and Students screens both showed
  `Live data error (decidedStaff): failed-precondition` on the first real use.
  The Firestore **emulator builds indexes on demand and never returns
  FAILED_PRECONDITION**, so all 119 emulator tests and every e2e check passed
  against an index file containing nothing at all. Four composite indexes were
  needed (staffUsers status+createdAt, staffUsers status+displayName, classes
  cohortId+createdAt, recordings classId+createdAt) and are now deployed.
  `npm run check:queries` (new, committed) runs all twelve query shapes the app
  issues against the REAL project and fails on any that needs a missing index —
  the only check that can catch this, since shape rather than data determines it.
  Note the two staffUsers indexes reported "currently building" for ~2 minutes
  AFTER `gcloud` reported them READY.

- 2026-07-22 — **First admin bootstrapped in production, and the endpoint
  removed.** `onUserCreate` provisioned the real Google sign-in as
  `role: manager, status: pending` — domain membership granting nothing, as
  designed. `bootstrapAdmin` then promoted it to `admin/active`, refused a replay
  with 409, and was deleted (URL 404s).
  It is now exported ONLY against the demo project: it cannot be deleted from the
  repo because the e2e uses it for the same bootstrap problem in miniature, and
  leaving it in the export list would silently recreate an unauthenticated
  admin-granting endpoint on the next deploy. Verified by loading the built
  bundle under each project id — 17 functions and ABSENT for the real project,
  18 and PRESENT for demo — and then by a full `deploy --only functions` that
  left the URL 404ing.
- 2026-07-22 — **The first-admin address was duplicated and drifted.** The
  callable hardcoded a guessed local part while the dev sign-in row hardcoded
  another; correcting the callable to the real address made the e2e bootstrap a
  user the callable would not promote, and it failed at the first authenticated
  screen. Now one `FIRST_ADMIN_EMAIL` in `@sabeel/shared`, consumed by both.

- 2026-07-22 — **Self-signup is deleted by the trigger, proven in both
  directions.** The first version of this e2e check was VACUOUS: it polled the
  Auth emulator's `/emulator/v1/projects/*/accounts` endpoint, which is
  DELETE-only, so the GET returned `Method GET not allowed`, `userInfo` was
  undefined and the check passed unconditionally. It survived a deliberate
  mutation of the very rule it protects, which is the only reason it was caught.
  Rewritten to assert on *using* the credential — mutation in place: FAIL
  ("sign-in still succeeded"); mutation removed: ok (`EMAIL_NOT_FOUND`).
- 2026-07-22 — **`disabledUserSignup` is unusable, discovered on the first real
  sign-in.** Google sign-in returned `auth/admin-restricted-operation`; the live
  project showed **0 users** and `onUserCreate` had **0 log entries**, so the
  block happens before the trigger. Creating a staff member's account IS a
  sign-up, so that console setting and staff self-onboarding are mutually
  exclusive. The guard moved into `provision.ts`, which can distinguish the two
  populations: a real student has NO provider at creation (created without a
  password), so a `password` provider at creation can only be a client sign-up.

- 2026-07-22 — **First production deploy: rules, indexes, 18 functions, Hosting.**
  The Firestore database did not exist and was created by the rules deploy.
  `npm run smoke:prod` (new, committed) then verified the *deployed* artefact
  rather than the local one, which is the only place these can be checked:
  Hosting serves `/__/auth/handler` (200), the bundle contacts **no** emulator
  host, the dev sign-in row does not render, and the console is clean. Auth
  config read back from the live Identity Toolkit API:
  `disabledUserSignup: true`, email/password on, email-link off, anonymous off,
  `authorizedDomains` covering both hosting domains. `authDomain` flipped to
  `…web.app` and `WEB_CLIENT_ID` filled in from the created OAuth client.
  **`onUserCreate` domain enforcement is now live** — before this deploy it
  existed only in the repo, so a stray Google sign-in would have persisted.
- 2026-07-22 — **Signing proven against the real project**, which no emulator
  test can do. A V4 URL signed by the compute service account streamed the exact
  3,049,585 bytes, answered a range request with 206, and a deliberately
  10-second URL was then refused with `ExpiredToken`. The probe function and its
  object were deleted immediately after.
- 2026-07-22 — **Phase 3c end to end.** The committed e2e now covers upload →
  publish → a student playing: audio advances (0:06 after six seconds), progress
  is persisted, and playback **resumes at 0:36 after a reload**. 119 emulator
  tests. Three mutations on the progress rules; the third initially caught
  nothing, which exposed a missing list-coverage test — now added and verified
  to fail under the same mutation.

- 2026-07-22 — **Phase 3b end to end on the web dev server.** A real 12-minute
  32 kbps M4A uploaded through the UI: duration 720 s read client-side, size
  3,049,585 bytes read server-side from Storage (matching the file), then
  published with `publishedAt` stamped. 111 emulator tests. Five rule mutations
  each caught by the right tests: recordings' student `published` check, its
  enrolment check, its staff `managerUids` check, Storage write-once, and
  Storage staff-only upload.

- 2026-07-22 — **Phase 3a spike, on the AVD.** `expo-audio` background playback
  survives backgrounding and 60 s of screen-off (position advanced 0:00 → 1:57,
  matching wall-clock); a media3 `MediaSession` registers and media transport
  controls appear in the shade; seek to 10:00 into a 12-minute file works over
  HTTP range requests (6 GETs observed); 2x playback rate applies with no
  buffering stall; duration is read correctly from a remote URL. Signed-URL
  streaming is the one spike item still unproven — it needs the real project.
  Spike code deleted; the `app.json` and manifest fixes it produced are kept.

- 2026-07-22 — **Phase 1b/1c verified end to end.** `npm run test:e2e` (new,
  committed) drives 17 checks on the web dev server: pending on first sign-in,
  live un-gating via bootstrap and via admin approval, off-domain deletion,
  cohort and class creation, manager scoping, student created-and-enrolled in one
  step, roster, set-password link redeemed and used to sign in, and the full
  archive cascade round-trip read back from Firestore. Android parity confirmed
  on the `tb_emu` AVD (`versionName=0.1.0` confirmed installed).
- 2026-07-22 — **Six rule mutations, each caught by the right tests.** Class
  manager-scoping removed; enrollment student arm widened; enrollment staff arm
  widened; the student class-read enrolment check dropped; cohorts opened to any
  signed-in user; enrollments made client-writable. Restored and green after each.
- 2026-07-22 — **The e2e harness was itself mutation-tested, and a gap found.**
  Widening the manager-scope rule did NOT fail the e2e, because `useMyClasses`
  filters via `array-contains` in the query — the check was testing the query,
  not the boundary. The check names were corrected to say what they actually
  prove, and the harness header now states it is a flow suite, not a security
  suite. A check whose name overstates its coverage makes a suite look stronger
  than it is.

- 2026-07-21 — **Phase 1a, end to end on both surfaces.** First staff sign-in
  lands pending; `bootstrapAdmin` promotes and the gate lifts **live with no
  sign-out**; a second call to it 409s; an admin approves a pending manager and
  *their* gate lifts live; an off-domain sign-in has its auth user deleted and
  lands back at sign-in; a student is created, sets a password from the emulator's
  emailed link, and signs in. Verified on the web dev server and on the `tb_emu`
  AVD (`versionName=0.1.0` confirmed installed).
- 2026-07-21 — **Identity rules mutation-tested, three ways.** `isActive()`
  ignoring status → the pending and disabled tests went red. `isStaff()` widened
  to any active user → the student-isolation tests went red. `staffUsers` given a
  self-write → the no-write test went red. Restored and green each time.
- 2026-07-21 — **Dev sign-in row confirmed absent from a production render.**
  Note that grepping the exported bundle is NOT a valid check: the strings
  survive minification because the component is still referenced from a branch
  the minifier cannot prove dead. See `docs/DEV-TOOLING.md`.

- 2026-07-21 — **Rules suite mutation-tested.** `assertFails` passes when an
  operation fails for *any* reason, so a deny-all suite can pass while testing
  nothing. Flipped both `firestore.rules` and `storage.rules` to
  `allow read, write: if true`; all 6 tests went red; restored and they went
  green. The suite genuinely exercises both rule files.
- 2026-07-21 — **knip proven to fail.** Added a throwaway unused export, knip
  exited 1; removed it, knip exited 0. The CI step is not decorative.
- 2026-07-21 — **esbuild bundling verified.** `@sabeel/shared` is inlined into
  `functions/lib/index.js` (zero `require("@sabeel/shared")`) while
  `firebase-functions` stays external — the shape Cloud Build needs.
