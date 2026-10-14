# Sabeel Institute LMS — Working Rules for Claude

## What this project is

The learning management system for Sabeel Institute's adult classes:
attendance, class recordings, assignments and grades. Built today: attendance
registers, class recordings — audio and video, in parts and versions — that
students who missed a class play in the app, and an accountability ledger for
staff. Faisal is the
developer; the institute's staff are the admins/managers.

**This repo is the permanent home, and it is mid-move.** `Sabeel-Institute/lms`
on GitHub, Firebase project `oursabeel-lms` under the oursabeel.com account.
It carries the full history of `faisal-shah/sabeel-recording-app`, whose
Firebase project `sabeel-class-recordings` (gmail account) stays the live app
until switchover day. Never point a command from this checkout at
`sabeel-class-recordings`.

- **The project's identity has one source:** `FIREBASE_PROJECT_ID`, `APP_NAME`
  and `APP_SHORT_NAME` in `packages/shared/src/constants.ts`. Files that cannot
  import it restate it, and `functions/test/unit/projectIdentity.test.ts` holds
  them to it and fails if the legacy project id, its project number or the old
  Android package appears in any code or config.
- **Deploy nothing until Phase 0 of `docs/plans/SWITCHOVER.md` is done.** Media
  is on R2 and Zoom imports go through the copier Worker
  (`cloudflare/media-copier`, its own workspace with tests that run in workerd);
  what remains is listed in `docs/plans/MEDIA-ON-CLOUDFLARE.md`. The Worker
  deploys before the Functions that call it.
- **Push notifications reach only staff** (`NOTIFY_AUDIENCE=staff` in
  `functions/.env.oursabeel-lms`) until switchover day, when it becomes
  `everyone`. The project holds a copy of every real account while the live app
  still notifies them; without it a student would hear everything twice.

The plans:

- `docs/plans/SWITCHOVER.md` — accounts, Phase 0, seeding, switchover day.
- `docs/plans/MEDIA-ON-CLOUDFLARE.md` — all media on R2, Zoom copied by a
  Cloudflare Worker.
- `docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md` — video, parts and versions per
  session, the new Zoom picker and player.
- `docs/proposals/lms-assignments-proposal.html` — assignments and grades.

The rules below describe the app as it is today. Each plan lists the rules it
changes; change them in the same batch as the code.
Source of truth: `docs/PRODUCT_BRIEF.md` (product decisions & data model),
`PLAN.md` (the build order and locked architecture decisions),
`docs/PHASE_STATUS.md` (live status), `docs/DEV-TOOLING.md` (what each script
guards against, and which failures are environmental rather than yours).

## Stack knowledge lives in a shared skill, not here

Recurring traps of this stack (Expo, Metro, react-native-web, Firebase JS SDK,
Cloud Functions, FCM, emulator behaviour, build/export mechanics) live in the
**`expo-firebase-stack` skill** — source `faisal-shah/agent-skills`, installed at
`~/.claude/skills/expo-firebase-stack/`. Read its closing section, **"How this
stack fools you"**, *before* a debugging session, not during one.

**The boundary is one question: would this be true for a different company
building on the same stack?** Yes → the skill. No → this file (product
invariants, brand, ports/AVD conventions, phase process, division of labour,
anything naming this project).

**The skill repo is PUBLIC.** Nothing naming this project goes into it — no
project ids, internal domains, email addresses, AVD names, secrets or product
decisions. Generalise first, then grep for identifiers before pushing.

**Installation is a COPY, not a symlink.** Editing a skill changes nothing an
agent reads until `skills/<name>/install.sh --claude` runs again, and a stale
installed copy looks identical to a current one. Re-run after every pull.

**Never copy the skill's content into this repo.** `docs/STACK-GOTCHAS.md` is a
stub for that reason. A stub cannot drift.

**Contribute back in the same batch as the fix.** This app is the first Sabeel
project to use Cloud Storage, long-media playback, background audio and offline
media, so it is the one most likely to find something new. The skill has
**"Cloud Storage and long media"** (including background-audio setup and how to
verify it on an AVD with `dumpsys`) and, under **"Offline persistence"**, the
outbox pattern and why a write made with the screen locked does not leave the
device until the app comes back.

The skill also carries `tools/bootstrap-linux.sh`, which installs this whole
toolchain on a fresh machine under `$HOME` with no root. See
`docs/DEV-TOOLING.md`.

## Product invariants

Do not silently change any of these.

- **Audio and video, as the class made them, and nothing transcoded.** A
  recording holds media items: parts (stretches of class, played in order) and
  versions (formats of a part — slides and speaker, slides only, audio only),
  `packages/shared/src/media.ts`. Video is MP4 (H.264 + AAC). Video is where the
  storage goes (about 5x the audio for Zoom's slides and speaker), so the Zoom
  picker shows what a choice costs to keep before anything is copied, and
  "Audio only" is always one tap away in the player. Plan:
  `docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md`.
- **Being marked EXCUSED is the whole of a student's entitlement.** One
  `assignments` document both grants access to a recording and requires listening
  to it, and it lapses when the session's due date passes. Enrolment opens no
  recording (it does give a student the class's assignments, which have nothing
  to do with the register); `present` and `absent` open nothing at all. "Everyone must listen"
  is said by excusing everyone. Access and accountability were separate until
  2026-08-14 and are now deliberately one fact — see the decision log; do not
  re-split them.
- **A session's due date is required, and is never written in the past.** It is
  the day access closes, so a blank one would mean permanent access. It may
  BECOME past by the passage of time — that is how a recording closes — but no
  callable will write one that has already gone, and none will excuse a student
  for a session whose deadline has passed. Nothing is ever born expired.
- **The deadline is enforced at the AUDIO, not in the rules.** `firestore.rules`
  gates a recording's metadata on an active assignment; `getPlaybackUrl` gates the
  audio on the date. Comparing `request.time` to a `YYYY-MM-DD` string in the
  institute timezone would be a second copy of the maths in `@sabeel/shared`, free
  to drift. Enforced **at minting**, precisely: a URL issued late on the last day
  works for its full twelve hours and nothing revokes it — inside the threat
  model, and written down at `SIGNED_URL_TTL_MS`.
- **Students never read a session.** The attendance map holds the whole roster and
  Firestore has no field-level security, so each student's own mark is projected
  server-side onto `attendanceRecords/{uid}_{sessionId}`. The session stays
  canonical; the projection is derived from it, never the reverse.
- **Completion is student-attested.** Playback progress is audit evidence, not the
  gate. There is no listened-percentage threshold; the app only blocks completion
  if the student has never played the recording.
- **Playback URLs expire.** Media lives in a private Cloudflare R2 bucket; a
  student plays it through a 12-hour pre-signed URL minted by a callable that has
  already checked their grant (`functions/src/mediaStore.ts`). Never a public
  bucket, an `r2.dev` URL or any link that does not expire, which is the one
  thing the threat model rules out. Never proxy audio through a Function: the
  60-minute timeout kills a 2-hour session. Uploads are multipart: the client
  gets pre-signed URLs for the PARTS of one upload, the server joins them, and a
  finished upload takes no more parts, so no URL a client holds can replace a
  file (`functions/src/uploads.ts`). The help films (More → Help) live in
  the same bucket under `help/` and play on the same kind of link
  (`getHelpVideoUrl`), each person their own role's films only; they are
  recorded by `scripts/tutorials`, and a screen they show that changes means
  its film is recorded again (`docs/DEV-TOOLING.md`, "The help films").
- **Adult learner tone.** Required, listen by / watch by, missed, completed, pending
  sync. "Missed" rather than "overdue" once access has closed: overdue implies
  still doable. Never childish, punitive, or shaming language.
- **Two auth populations.** Staff sign in with Google and must be on
  `oursabeel.com` *and* approved by an admin — the domain check is server-side, the
  client `hd` hint is UX only. Students use email/password accounts created by
  staff. Managers are scoped **class by class**; cohort assignment grants nothing.
- **The Android app never creates an account, and must not learn how.** Both
  stores require in-app account DELETION only if an app supports account
  CREATION — and Play also triggers if the app merely *points* at a sign-up flow
  elsewhere. Satisfying neither trigger is what lets this app ship without a
  deletion flow that would have to decide what happens to a student's academic
  record. So: `CAN_CREATE_ACCOUNTS` keeps creation on web, `accountExists` gates
  `signInWithCredential`, and **no screen names the website as somewhere to get
  an account** — no link, no sentence, however helpful it would be. The refusal
  says "Contact your administrator." Decision record:
  `sabeel-institute-kanban/docs/STORE-RELEASE.md`.
- **Disable, archive, unpublish — don't delete.** Permanent deletion of anything
  carrying **listening history** is admin-only, needs strong confirmation, and is
  audited. Three deletions are deliberately a manager's: removing a completion
  override they set; removing a file from an unpublished draft so a bad one can
  be replaced; and deleting an assignment no student has started (once any
  student has a draft, a hand-in, a grade or a teacher's mark on it, only an
  admin may). A published recording's playable files are hidden, never removed;
  a file no student ever saw (still arriving, or failed) can be removed from any
  recording. None destroys history, all are audited, and all are ordinary
  corrections to their own class — see `docs/PRODUCT_BRIEF.md`.
- **BRAND COLORS ARE FIXED.** `docs/BRAND.md` and the shared `sabeel-brand`
  skill are the authority. Single light theme, **no dark mode**. Never hardcode a
  colour; the ESLint rule will reject it. `app/src/theme/palette.ts` is the only
  exception.

## Stack (locked)

- One Expo codebase (`app/`): Android (local Gradle builds, committed `android/`,
  **NO iOS builds yet, NO EAS**) + web via react-native-web
  (`expo export --platform web` → Firebase Hosting). Platform seams as `.web.ts(x)`
  siblings. Architecture must not block a later iOS build.
- Firebase **JS SDK on all surfaces** (not react-native-firebase — no web support).
- Backend: Cloud Functions (TS, nodejs22, us-central1) + Firestore. Media in
  **Cloudflare R2** (bucket `oursabeel-lms-media`), reached through the S3 API
  with two bucket-scoped keys: read signs playback, write uploads and deletes.
  No Firebase Storage bucket exists. Per-project settings (endpoint, bucket,
  who gets notifications) are in `functions/.env.<projectId>`.
- Monorepo (npm workspaces): `app`, `functions`, `packages/shared`. Shared types
  and constants live in `@sabeel/shared`.
- Config-as-code: `firestore.rules`, `firestore.indexes.json` and the R2 bucket's
  settings deploy from the repo, never console-edited.

## Dev & test loops

- Unit: `npm test` (Vitest: shared, functions **and app** — the app's node-only
  suite covers its pure logic, the playback session and the work queue).
- **This checkout owns emulator ports 61300-61306**, the local media store's
  61307 (S3) and 61320-61326 (its internals), and web dev-server ports
  61310 (sweep) / 61311 (`test:e2e`); the legacy `sabeel-recording-app` checkout
  owns 61100+, and the sibling repos own 61000+ and 61200+.
  Three projects share this machine and all three used to pin 8080/9099/5001/9199,
  so whichever suite started second killed the other's Firestore. Five files state
  the ports and `functions/test/unit/emulatorPorts.test.ts` asserts they agree and
  that the kill list reaches no further. Never widen `free-emulator-ports.sh` past
  this block. Details in `docs/DEV-TOOLING.md`.
- Rules/integration: `npm run test:emulator` — Firestore and Auth emulators plus
  the local media store (SeaweedFS standing in for R2, started by
  `scripts/with-media-store.mjs`). Needs JDK 21 and SeaweedFS
  (`docs/DEV-TOOLING.md`). The functions sign real URLs against SeaweedFS, which
  checks signatures and expiry like R2, so the production signing path runs
  locally.
- Browser e2e: `npm run test:e2e`. Needs a live Metro dev server **and** the
  emulator suite already running, and it resets Firestore and Auth on every run —
  which is why it is a local pre-commit check and deliberately **not** in CI.
- Layout sweep: `npm run test:screens`. Every screen of both populations at five
  widths straddling the content-column cap, **asserted**, not just photographed.
  It starts its own emulators and its own dev server, which is exactly why it
  **is** in CI where `test:e2e` cannot be. `SWEEP_WIDTHS=320` for a tight loop.
- Web: `npx expo start --web` in `app/`, or `npm run web:export -w @sabeel/app`
  for the bundle that actually ships.
- Android: `scripts/emulator.sh headless` (AVD `tb_emu`), then `npx expo
  run:android` in `app/`. Firebase emulators from the AVD = `10.0.2.2`; from web =
  the literal `127.0.0.1`, never `localhost` (the emulators bind IPv4-only and
  `localhost` can resolve to `::1` first). Media is the exception on the AVD:
  signed URLs name `127.0.0.1:61307` and the host is part of the signature, so
  run `adb reverse tcp:61307 tcp:61307` rather than rewriting the URL.
- Dead code: `npm run knip` (CI-enforced). It fails on unused files, exports and
  dependencies — which is why infrastructure is added **with its first consumer**,
  not ahead of it. Suppressing knip to keep unused scaffolding would make the audit
  lie, and an audit that reports nothing is worse than no audit.
- **CI is OFF** (2026-08-28, heavy development): `ci.yml` is `workflow_dispatch`
  only. The job runs about ten minutes and duplicates the local loop, so run that
  instead — `npm run lint && npm run typecheck && npm run knip && npm test &&
  npm run test:emulator && npm run test:screens`. Trigger CI by hand before a
  release or when something must hold on a clean machine
  (`gh workflow run ci.yml --ref <branch>`); the trigger block to restore is at
  the top of `ci.yml`. No deploys from CI.
- **If a suite fails, first ask whether it fails on stashed changes too.** A
  clean-HEAD repro means the cause is environmental — usually a leftover emulator
  (`npm run emulators:free`) — not your diff.

## Verification — what counts as evidence

**Look at the screenshot.** Correct hex values in `palette.ts` survive right up
until you look at the rendered screen; contrast misuse and layout gaps pass every
code-level check. Never claim a screen works because the code looks right.

**A check that cannot fail is a screenshot generator.** A tour wrapped in a
try/catch that logs and continues reports success either way.

### Test the promise, not the mechanism

**A test that asserts the wrong thing is worse than no test.** No test leaves a
gap somebody may still notice; a passing test that watches the wrong thing
certifies the defect, and every reader after that stops looking. Three fixes in
this repo shipped with tests that passed while the code was wrong, and each was
found by a reviewer reading the test rather than by the test failing.

So, before writing one, say what the code PROMISES a person — in their words —
and assert that:

- **Assert the observable the promise lives in.** Unenrolment promises "the
  student can no longer open the recording", so assert `playbackDenial`, which is
  what withholds the audio — not `assignment.active`, which is the flag it
  happens to read. The delete gate promises "a caller who may not delete destroys
  nothing", so drive the callable's core and assert the ledger rows are still
  there — not that a guard threw. Asserting the flag left "cascade first, check
  second" passing; asserting the promise fails it.
- **Choose the mutation from the intent.** Not "what line can I delete and see
  red", but "what wrong behaviour would a reader still ship with this green".
  Then check that mutation actually fails.
- **A fixture that cannot arise in production tests nothing.** A recording with
  no session, an active grant on a draft, a completion written where one already
  exists: each of those made a test pass for a reason the app can never produce.
- **When a property genuinely cannot be tested, say so in the test file** and
  assert what can be. A behavioural test that would pass either way is the thing
  this section exists to prevent.

### The browser is the default surface for verification

**Prove a change on the web app unless it touches a seam a browser cannot
reach.** `npm run test:e2e` drives the real web build and `npm run test:screens`
sweeps every screen of both populations at five widths — between them they cover
almost everything, and they are faster and far more repeatable than a human on an
emulator. That is the default for layout, flows, rules, data and copy.

**`npm run test:screens` is the sweep, and it is the one browser suite CI can
run** — `test:e2e` resets the emulators, so it cannot. With CI on
`workflow_dispatch` it runs when you run it; run it before every commit that
touches a screen. Every screen of both populations at five widths straddling
`CONTENT_MAX_WIDTH` — which it reads out of `app/src/theme/index.ts` rather than
restating — asserting that the
page never scrolls sideways, that nothing is clipped by the right edge, that no
two same-layer controls overlap, that every screen has a way out (Back on a
pushed screen, the bar on a tab root), and that the content column settles on one
of the declared maxima and centres. Targets under 44px are reported, never
failed. Screens with an editor OPEN are toured as their own screens, because the
rows a session editor or a ledger override adds exist in no other state and 320px
is where they run out of room.

It is not a substitute for looking: it says a layout is not broken, never that it
is good. Read `shots/screens/` after a change to a shared component or the theme
— CI uploads them on failure.

### The Android emulator is reserved for the seams a browser cannot reach

Not for routine layout work. Use it for:

| Seam | Why the browser cannot cover it |
|---|---|
| **Audio** | Background playback, the foreground service, lock-screen controls, seek and rate — the core of this product, and none of it is web-equivalent |
| **Offline** | The download store and the offline outbox |
| **Flex shrink / wrap / overflow** | Yoga ≠ CSS — Yoga defaults `flexShrink` to **0** |
| **Keyboard / IME** | Emulators misreport IME insets; edge-to-edge makes `Keyboard` events no-ops |
| **Gestures** | Long-press and swipe have no web path |
| **Native modules** | FCM/push, document picker, sharing |
| **Safe area / insets** | No browser equivalent |

Plus **before a release**, and whenever Faisal asks. That pre-release pass is
mandatory, not optional.

**Check who owns the AVD before booting it.** There is one `tb_emu` on this
machine and all three repos default to it, so a boot can walk into another
session's run:

```sh
ps -eo pid,args --no-headers | grep "[q]emu-system"   # empty = no AVD running
```

Use that, not `adb devices` — `adb devices` *starts* a daemon as a side effect,
and a live adb server does **not** mean an emulator is running. If one is already
running it belongs to someone else: ask before killing it or starting a second.
The box has 15 GiB of RAM and a 16 GiB swapfile, so a second AVD (~5 GB) will
swap rather than be killed outright — and an AVD that is swapping is slower than
the software renderer already is.

**Why this is safe, and exactly where it is not.** react-native-web resolves
flexbox through the browser's engine, so a narrow viewport tests *your layout
intent* but not *Yoga's behaviour*. This repo owns the documented proof: a button
shrank below its basis on a real device and **never reproduced under
react-native-web at any of 12 widths** — it is a Yoga behaviour
(`docs/PHASE_STATUS.md` 2026-07-24). The same run also caught a control sitting
outside its confirmation wrapper, invisible on web because that check ran in a
state where the button was not rendered: **a state-dependent control needs its
assertions in that state.**

Note this project's audio seam is unusually wide, so it leans on the emulator
more than its siblings do. That is a property of the product, not a licence to
skip the browser check.

**Two traps when you do run native:**

- **`BUILD SUCCESSFUL` is not proof the APK installed.** If the AVD drops during
  the run, yesterday's build stays on the device and every screenshot after it is
  a lie. Confirm with
  `adb shell dumpsys package com.sabeelinstitute.lms | grep versionName`
  against **`app/android/app/build.gradle`**, which is the file that produces it
  — `android/` is committed, not prebuilt, so `app.json` does not feed it.
  `functions/test/unit/appVersion.test.ts` asserts the two agree, so in practice
  either will do; the gradle file is the one that cannot be wrong.
- **A native debug build takes `EXPO_PUBLIC_*` from the environment that started
  METRO**, not from the APK. If a flag looks unset, restart Metro with `--clear`.

**The AVD needs hardware virtualization and a VM may not have it.**
`emulator -accel-check` is authoritative; without it the AVD still boots in
software at ~805 s and ~14 s per screenshot, which retires the screenshot loop
while leaving input usable. Builds are unaffected — Gradle needs no KVM.
`check-host.sh` in the skill's `tools/` gives the verdict.

**A rules test that only asserts denials must be shown to fail when the rules are
opened.** `assertFails` passes when an operation fails for *any* reason, including
a broken connection — so flip the rule to `if true`, watch the suite go red, and
flip it back. Done for the Phase 0 baseline; do it again whenever the rules change
shape.

## Secrets (zero tolerance)

NEVER ask for, accept, or echo real API keys/DSNs/tokens in chat; never hardcode
them. Server secrets: output the exact `firebase functions:secrets:set NAME`
command for Faisal to run. Client-side non-secrets (Firebase web config) are
committed by design — rules are enforced server-side. Client DSNs go in gitignored
`.env.local` (key names only in docs). **Zoom credentials live only in Secret
Manager, never in the app bundle.**

## Division of labor

- Agent: all code, rules, indexes, tests, emulator runs, CI, exact click-by-click
  console checklists, diagnosing pasted logs.
- Faisal only: third-party consoles (Firebase/GCP/Sentry/Zoom), OAuth/SHA-1
  registration, App Check registration, IAM grants, anything with production
  secrets. Everything Faisal must do himself is tracked in `TODO.md` — keep it
  current.

## Conventions

- **`main` takes changes by pull request only**, approved by the code owner
  (`.github/CODEOWNERS`: Faisal); force-push and deletion are blocked. The
  GitHub ruleset "main: pull requests only" lets admins (only Faisal) push
  directly, which is how the agent's commits, made with his account, land.
  Other collaborators branch and open a PR.
- **Commit at phase boundaries** (see `docs/PHASE_STATUS.md`); work autonomously
  within a phase. Before ANY significant install (global/system/major framework),
  ask first; routine project-local npm deps of the locked stack are fine.
- All repo artifacts (docs, plans, protocols) live in this repo.
- User-visible changes ship with their documentation, in the same batch as the
  code.
- **The ESLint rules that are not style**, and should not be relaxed: no hardcoded
  colours under `app/**` (exempting `app/src/theme/**`), and no `onSnapshot`
  import outside `app/src/liveQuery.ts`. Hand-rolled subscription state persists
  across dependency changes, showing the previous query's results under the new
  one on a slow connection — that cost the sibling time-tracker a week. Two files
  are exempt: `liveQuery.ts` itself, and `session.ts`, which subscribes inside
  `onAuthStateChanged` rather than a hook.
- **Behaviour under a hurried hand is a convention, not a per-screen choice.**
  Every action button runs through `useOneAtATime` (`app/src/oneAtATime.ts`): a
  `busy` state is a frame late, and a double tap created two assignments and
  showed refusals over writes that had worked. A screen holding unsaved or
  in-flight work uses `useLeaveGuard` (`components/LeaveGuard.tsx`), which sees
  Back, Android back, browser back and a tab press, and puts the address back
  when it holds a screen. Save-as-you-type goes through `createAutosave`
  (`app/src/autosave.ts`): ordered, flushed before moving on, never dropped on
  leaving. Parent links go UP (`up()` in `App.tsx`), never push a second copy.
- **A tapped notification opens its subject.** Each message carries a `path`
  built by `pushPaths` in `@sabeel/shared`, and `app/src/linkPaths.test.ts` holds
  every one to the route tables. Never name an FCM data key `body`: expo-
  notifications reads it as the whole payload.
- **Old data is migrated, never accommodated.** A document is read through
  `read()`/`readIfExists()` (`app/src/documents.ts`), typed by its collection,
  and ESLint allows `.data() as` nowhere else in the app. Every field of every
  document type the app reads is listed `required` or `optional` in
  `documentShapes` (`@sabeel/shared`) — a type and its list that disagree fail
  to compile — and `npm run check:documents` reads every live document against
  them: run it before a release and after a migration, and migrate whatever it
  reports instead of reading around it. A browser's persistent cache can still
  hold a document from before a migration for a moment (a recording without
  `media` blanked the live site that way), so every screen sits in
  `ScreenBoundary` (the stack's `screenLayout`): one that cannot be drawn says
  so, the bar works, and Try again draws the server's copy. The cache is never
  cleared to avoid this: on the web it is where unsent completions and
  listening progress wait.
- Never `git add` a binary. The APK ships as a GitHub Release asset; committing
  per-release APKs bloated the sibling pages repo's history and had to be
  rewritten out. `*.apk` is gitignored as the backstop.
