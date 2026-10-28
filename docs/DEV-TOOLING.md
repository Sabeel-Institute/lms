# Dev tooling

What each script guards against, and which failures are environmental rather
than yours. Read this before debugging the harness.

The CI, release, emulator and device tooling is the Sabeel apps' shared
`@sabeel-institute/ci-tools`, pinned in `package-lock.json` and run as `npx
sabeel-ci <command>`; its README says what each command does, and
`ci-tools.json` holds this app's settings for it. `scripts/` holds this app's
own tools: the browser suites and their runner, the seeds, the media store,
migrations, the production checks and the help films.

**First question when a suite fails: does it also fail on stashed changes?** A
clean-HEAD repro means the cause is environmental — almost always a leftover
emulator — not your diff.

## Commands

| Command | What it does |
|---|---|
| `npm run lint` | ESLint, then `check:version` (`app.json`'s version is store-legal and Android's code follows from it) and `check:text` (no source file holds a byte that makes tools treat it as binary) |
| `npx sabeel-ci check-app` | What the shared tooling assumes of this repo: `ci-tools.json`, the rendered workflows, secrets read only in the release environment, `.gitignore`, the version written once with its deploy-log entry, the emulator ports and project, Sentry's setup, the Hosting site and Android's release signing and notification channel. CI runs it first |
| `npm run typecheck` | Builds `@sabeel/shared` first, then typechecks every workspace — **including the functions tests** (`functions/tsconfig.test.json`) |
| `npm test` | Vitest unit tests (shared, functions and app), no emulators needed |
| `npm run test:emulator` | `sabeel-ci test-emulator`. Two passes: the rules suites (`test:emulator:rules` in `functions/`) against Firestore + Auth alone, then the integration suites (`test:emulator:functions`) against Firestore + Auth + Functions and the local media store (SeaweedFS) |
| `npm run emulators` | `sabeel-ci emulators`: the same emulators and media store, long-running, for `node scripts/web-e2e.mjs`, `seed:emulators` and a device pass |
| `node scripts/with-media-store.mjs <cmd…>` | Runs a command with SeaweedFS up on the block's `s3` port (127.0.0.1:61327) and stops it after; every Functions emulator run goes through it (`emulators.functionsWrapper` in `ci-tools.json`) |
| `npm run knip` | Dead-code audit — fails on unused files, exports and dependencies |
| `npm run emulators:free` | `sabeel-ci free-emulator-ports`: stops this checkout's leftovers on its emulator ports |
| `npx sabeel-ci ports [<name>]` | This checkout's ports by name, or one of them (`npx sabeel-ci ports web`) |
| `npm run build` | Builds shared, then bundles functions with esbuild |
| `npm run test:e2e` | The Playwright flow walkthrough — starts its own emulators and dev server (see below) |
| `npm run test:screens` | The multi-width layout sweep — the same runner (see below) |
| `npm run test:e2e:push` | Every notification tapped on the web, in full Chromium — the same runner (see below) |
| `npm run web:export -w @sabeel/app` | The web bundle that actually ships |
| `npx sabeel-ci render-manual` | `docs/USER-MANUAL.md` to `docs/USER-MANUAL.pdf`, with the logo (`app/assets/logo.png`), `app.json`'s version and this month on the cover; needs `uv` and `google-chrome`. `sabeel-ci release` runs it |
| `npx sabeel-ci emulator headless` | Boots the `tb_emu` AVD (or `SABEEL_AVD`) with no window; refuses to boot it twice and names who runs it |
| `npm run check:queries` | **Against the REAL project.** Every query shape the app sends, checked for a missing composite index. With `CHECK_ACCESS_TOKEN` set it runs over REST as that user token instead of Application Default Credentials (see `docs/DEPLOY.md`) |
| `npm run check:documents` | **Against the REAL project, read-only.** Every live document the app reads, checked against the fields its type requires (`documentShapes` in `@sabeel/shared`), with the screens' helpers run on each. Fails on a document that lacks a required field (migrate it) or that a helper throws on, which includes an audit entry under an action the audit screen has no words for (`AUDIT_ACTION_LABELS`). Same `CHECK_ACCESS_TOKEN` as `check:queries` |
| `npm run check:push` | **Against the REAL project.** `sabeel-ci check-push`, through the functions' own `fcm.ts`, `apns.ts` and `testPush.ts`: FCM's credentials, and that the code FCM returns for a dead token is one the app prunes on (`DEAD_TOKEN_CODES`); then Apple's: that both its services accept the key Secret Manager holds as `APNS_KEY`, with the ids in `functions/.env.oursabeel-lms`, for this app (read with the active gcloud account). Takes `CHECK_ACCESS_TOKEN` too |
| `npm run check:web-push` | The exported web bundle (`app/dist-web`) carries the VAPID public key and the permission path; every CI web build runs it |
| `npm run smoke:prod` | **Against the LIVE site.** The auth handler, the three store pages, the build label for this checkout's version and commit, a provoked Auth request going to Google and not an emulator, no dev sign-in rows, and the bundle's `.map` not served |
| `npm run students:report [-- --email <address>]` | **Against the REAL project, read-only.** Every student's account: whether a password has ever been set and when, last sign-in, last activity. Test accounts and staff members' own student accounts are listed apart and left out of the counts. `--email` shows one record with its audited history and what its state means for the next set-password link. Start here when a student can't get in (see "A student can't set a password") |
| `npm run seed:emulators` | Seeds the sweep's world into an already-running emulator suite and leaves it there, for a device pass (`docs/DEPLOY.md`) |
| `node scripts/repro-stale-scope.mjs delete\|remove\|none` | The WEB-4 regression: a manager's cold load with a stale cached course list must render the work queue and report no listener refusal. Needs emulators + the e2e dev server; resets the emulators; exit 1 on a refusal |
| `node scripts/set-min-version.mjs <X.Y.Z>` | **Against the REAL project** (or the emulator with `CHECK_PROJECT` + `FIRESTORE_EMULATOR_HOST`). Sets the oldest app version allowed to run on a phone, stored as its versionCode |
| `node scripts/s3-conformance.mjs local\|r2` | The 18 S3 behaviours the media code relies on (signatures, expiry, write-once PUT, signed type, `Range`, multipart ETags, a completed upload taking no more parts, CORS, read key cannot write), against SeaweedFS or **against the REAL R2 bucket** with the real keys from Secret Manager. Writes and deletes a few objects under `conformance/`. Run after changing either |
| `npm run bucket-config -w @sabeel/media-copier` | **Against the REAL R2 bucket.** Applies `cloudflare/media-bucket/cors.json` and `lifecycle.json`; `wrangler r2 bucket cors list` / `lifecycle list` read them back |
| `npm test -w @sabeel/media-copier` | The copier Worker's tests, inside workerd with a local R2 |
| `node scripts/tutorials/lines.mjs` | The help films' narration, one line per step, as `tts.py` reads it (see "The help films") |
| `uv run scripts/tutorials/tts.py --model 1.7B --speaker aiden --lines <json> --out <dir>` | Renders the narration on this machine's CPU with Qwen3-TTS, a built-in voice; resumable, and renders a line again when its words change |
| `uv run scripts/tutorials/asr_check.py --lines <json> --wav <dir>` | Transcribes the rendered narration (Whisper) and flags a line that does not say what its script says |
| `node scripts/tutorials/record.mjs --wav <dir> --out <dir> [--only …] [--variant …]` | Records the help films against the guide world: MP4 + WebVTT per film and cut. Needs the emulators and the dev server on the `web` port |
| `node scripts/tutorials/publish.mjs --from <dir> [--only …]` | **Into the REAL media bucket**, under `help/`, through wrangler: every film and its captions, both cuts, or nothing |
| `npx sabeel-ci send-test-push <fcm-token> [path=<app path>]`, or `--apple <development\|production> <iphone-token> [path=<app path>]` | **Against the REAL services.** One real push to one device, built by the functions' own `testPush.ts`, `fcm.ts` and `apns.ts`; writes nothing. The device check for "a push is shown, and a tap opens `path`", with the app open and then closed — no emulator delivers a push. An iPhone's token goes to the Apple service it came from: `development` for a debug build (an Apple-silicon simulator receives these), `production` for TestFlight; the key is `APNS_KEY_FILE` or `~/.apns/AuthKey_<id>.p8`. The token is in the `devices` collection of whichever Firestore the device registered with |

The last two are **pre-release checks, not part of the loop**: both authenticate
against production with the Admin SDK, so neither can run in CI or against the
emulators. `check:queries` exists because the Firestore emulator builds indexes
on demand and never returns `FAILED_PRECONDITION` — every query passes locally
whether `firestore.indexes.json` contains anything at all, which is exactly how
this repo once shipped an empty index file and two admin screens that failed the
moment a real user opened them. Run both before a release, and `check:queries`
again whenever a `where` + `orderBy` pair changes.


**The functions tests are typechecked by a second config, and that is not
tidiness.** `functions/tsconfig.json` compiles `src` for deployment, so it
cannot include `test` — which meant nothing ever checked a fixture against the
document types. Three tests were seeding shapes the app cannot produce: sessions
with `dueDate: null`, which `createSession` refuses because "a blank one would
mean permanent access". A test built on data Firestore never holds proves
something about a system that does not exist, and reads exactly like one that
proves something real. `tsconfig.test.json` covers both trees and runs in the
same `npm run typecheck`.

## Setting up a machine

Node 22+, **two** JDKs — 21 for the Firebase emulators (they are Java), 17 as
the default `java` because the Android Gradle Plugin targets it — plus the
Android SDK and the `tb_emu` AVD.

Do not install these by hand. The `expo-firebase-stack` skill in
`../agent-skills/` carries a bootstrap that installs the lot under `$HOME` with
no root, and is idempotent:

```sh
../agent-skills/skills/expo-firebase-stack/tools/check-host.sh   # what is missing
../agent-skills/skills/expo-firebase-stack/tools/bootstrap-linux.sh \
    --jdk21-aliases SABEEL --repo "$PWD"
```

`--jdk21-aliases SABEEL` sets `SABEEL_JDK21_HOME`, the first place `npx
sabeel-ci jdk21` looks for JDK 21 for the emulators; the Gradle default stays
17.

**The Android emulator needs hardware virtualization, which a VM may not have.**
`emulator -accel-check` is authoritative — `accel: 3` means no KVM, and if
`/proc/cpuinfo` shows `hypervisor` with neither `vmx` nor `svm` then nested
virtualization is off at the host and nothing inside the machine, root
included, can enable it. The AVD still boots in software: measured at **805 s
to boot and ~14 s per `screencap`**, so screenshot-based verification stops
being practical while input events (~1.4 s) remain usable. **Builds are
unaffected** — Gradle needs no KVM. `check-host.sh` gives the verdict.

## The ESLint rules that are not style

Two rules encode real incidents and should not be relaxed:

- **No hardcoded colours** under `app/**`, exempting `app/src/theme/**`. Every
  colour goes through a semantic token, which is what made the sibling apps'
  Option-1 palette refresh a one-file change.
- **No `onSnapshot` import** outside `app/src/liveQuery.ts`. Hand-rolled
  subscription state persists across dependency changes, showing the previous
  query's results under the new one on a slow connection. That cost the sibling
  time-tracker a week
  (its `docs/POSTMORTEM-2026-07-16-stale-week.md`).

  Two files are exempt: `liveQuery.ts` is the choke point itself, and
  `session.ts` subscribes inside `onAuthStateChanged` rather than a hook — it
  cannot call one there, and it already does its own reset on every auth change.

## knip: expected output

Two **configuration hints** are expected until the first platform seam exists:

```
src/**/*.web.ts    Refine entry pattern (no matches)
src/**/*.web.tsx   Refine entry pattern (no matches)
```

They are hints, not errors — knip still exits 0. The patterns are there so that
Phase 1's first `.web.ts` seam is treated as an entry point rather than reported
as dead code, which is knip's most common false positive in this stack.

`ignoreDependencies` in the `app` workspace lists `expo-updates`,
`@expo/metro-runtime` and `expo-system-ui`: Expo's config references them
implicitly, so knip reports them as "unlisted" without it.

**knip is load-bearing, which is why infrastructure is added with its first
consumer rather than ahead of it.** Firestore/Storage/Auth initialisation,
`liveQuery.ts` and navigation were all deliberately left out of Phase 0 because
nothing used them. Suppressing knip to keep unused scaffolding would make the
audit lie, and an audit that reports nothing is worse than no audit.

## Emulators

- **JDK 21+ required.** `npx sabeel-ci jdk21` resolves `SABEEL_JDK21_HOME` →
  `~/opt/jdk-21` → `JAVA_HOME` → the `java` on PATH (then, on a Mac,
  `java_home -v 21` and Homebrew's openjdk@21), and only the emulator runs are
  pointed at it, so JDK 17 can stay the default for the Android/Gradle build.
- **A resident Gradle daemon holds about 3.7 GB** beside the emulators.
  `test:emulator` reports one and leaves it, because `gradlew --stop` stops
  every checkout's; `SABEEL_STOP_GRADLE=1 npm run test:emulator` stops it when
  memory is tight and nothing else is building.
- **ffmpeg, built with libx265.** The upload tests send REAL media through the
  server's probe — a buffer of zeros is rightly refused — so
  `functions/test/mediaSamples.ts` makes M4A, MP3, WAV, FLAC, H.264, HEVC and
  QuickTime samples on first use, in the system temp directory. The e2e makes
  its own the same way (`scripts/lib/media-fixtures.mjs`). HEVC needs libx265;
  a distribution ffmpeg has it.
> **This checkout owns ports 61300-61399**, the block ci-tools gives this app
> (`emulators.base` in `ci-tools.json`, laid out by ci-tools' `lib/ports.mjs`,
> the same offsets in every app's block): the emulators on **61300-61309**
> (Firestore and its websocket, Auth, Functions, the UI, the hub, logging, and
> the task queue and Eventarc, which the suite starts by itself), the web dev
> servers on **61310** (`web`: the walkthrough, the native seed, the help
> films) and **61311** (`sweep`), a throttling proxy on **61312** (`proxy`),
> and the local media store on **61320-61327** (SeaweedFS's own master, volume
> and filer servers, pinned so it binds nothing else, and its S3 API on
> 61327). `npx sabeel-ci ports` lists them by name. The legacy
> `sabeel-recording-app` checkout owns 61100+, and the sibling Sabeel repos own
> 61000+ and 61200+. Firebase's default ports (8080, 9099, 5001, 9199, …) are
> the same for every checkout on this machine, so two suites on them kill each
> other's Firestore. `61303` also reads as "this project, functions" at a
> glance — the diagnostic that was missing when one session killed another's
> emulator after misreading a truncated `ps` line.
>
> 61300+ specifically: the ephemeral range here is 32768-60999
> (`/proc/sys/net/ipv4/ip_local_port_range`) so nothing above it is handed out at
> random, and Firebase's own defaults top out at 9499
> (`firebase-tools/lib/emulator/constants.js`) so the block cannot collide with
> something the CLI picks for itself. Those defaults are taken by every
> sibling repo's suite, so every emulator this suite starts is pinned here,
> the implicit ones included: left at 9499, the task queue's port stopped this
> suite starting while a sibling's ran (2026-10-16).
>
> Scripts state no port, comments included: they read them from ci-tools
> (`npx sabeel-ci ports <name>` in shell; `ports(config(root))` from
> `@sabeel-institute/ci-tools/lib/ports.mjs` and `lib/config.mjs` in Node),
> and the emulator project, `demo-sabeel-lms`, from
> `emulatorProject(config(root))` (the same module) or `npx sabeel-ci ports
> --project`. Two files cannot, and state them: `firebase.json`, which the emulators bind, and
> `app/src/env.ts`, inlined into the bundle. `npx sabeel-ci check-app` holds
> both to the block, and fails on a port of the block, or a Firebase default,
> written anywhere in `scripts/` or `package.json`.
>
> Two are easy to move wrongly: `firestore.websocketPort` is a **nested** key
> defaulting to **9150** that is *not* derived from `firestore.port`, and left
> unset it silently **increments** on collision rather than erroring; and
> `ui`/`hub`/`logging` have `FIND_AVAILBLE_PORT_BY_DEFAULT = true`, so they drift
> silently until pinned. Metro's **8081** is not in the scheme and cannot be —
> the AVD reaches the host directly at `10.0.2.2:8081`, so concurrent *web* work
> is fine and concurrent *native* work stays one session at a time.

- **`sabeel-ci free-emulator-ports` runs first, every time** (`npm run
  emulators:free` by hand). A killed run leaves emulators squatting on this
  checkout's suite ports (`npx sabeel-ci ports --suite`: 61300-61309 and the
  media store's 61320-61327). The next run then talks to a half-dead emulator
  that answers on the port but has no functions registered, so every callable
  404s — and a 404 carries no CORS headers, so the browser reports "blocked by
  CORS policy" while the callable surfaces a bare `internal`. Every symptom
  points at the app rather than at the leftover process. It stops a process
  only when its working directory is inside this checkout; one from another
  checkout of this repo (the main clone, a worktree) is named with its pid and
  directory, nothing is stopped, and the run fails. Stop that one yourself.
- **Never `pkill -f firebase`.** The pattern matches the cleanup script's own
  command line and the shell that spawned it, so the "cleanup" kills the caller.
  The script looks up owners by port instead. The same trap catches
  `pkill -f "expo start"` / `pkill -f "expo run"` — it matches the agent's own
  tool process and the command exits **144** as its shell is killed mid-run.
  **Kill dev servers by port:** `ss -lptn "sport = :$(npx sabeel-ci ports web)" | grep -oP 'pid=\K[0-9]+' | xargs -r kill`
  (`lsof` is not on PATH in a non-interactive shell without the toolchain env
  sourced, and a missing `lsof` turns a port guard into a silent no-op)
  (or `npm run emulators:free` for the emulator suite). macOS is the other way
  round — no `ss`, no `/proc` — so `sabeel-ci free-emulator-ports` and
  `sabeel-ci preflight-metro` ask `lsof` there.
- **Waiting for the port is not waiting for readiness.** The functions emulator
  accepts connections before it has registered anything. Poll a known callable
  until it stops 404ing.
- **The rules run without the Functions emulator.** One Functions emulator
  runs every trigger of a run, one at a time, about 4,000 of them, and the
  rules files fired about 40% of those for nothing they read. Behind that queue a
  trigger was still holding its documents when the next test wiped the
  database, and the wipe failed with `Transaction lock timeout` (409,
  ABORTED); and a test waiting for its own trigger waited behind the queue
  and gave up. So `test:emulator` runs the `rules.*` files first against
  Firestore and Auth alone, where a write fires nothing, then the rest with
  the functions. Measured over ten full runs each: three failed before, none
  after. A rules test cannot depend on a trigger: the world it judges is
  exactly what it seeded.
- **A trigger can land after the test's next step.** A test's own seed writes
  fire the functions emulator's triggers asynchronously, and on a loaded
  machine one can arrive after the step it was meant to precede. A fixed wait
  only makes that rarer. Wait for what the trigger does instead, with
  `eventually` (`functions/test/integration/eventually.ts`): it reads every
  quarter second and returns as soon as the change lands, for up to 30 s, so
  a quiet run is no slower and a backed-up one gets the time. Where a test
  reconciles every step itself, switch the triggers off around it
  (`setBackgroundTriggers` in `functions/test`, through the emulator hub), as
  `assignments.integration`'s unenrolment tests do.

## The local media store (SeaweedFS)

Media lives in Cloudflare R2 in production. Locally, every suite that runs the
functions emulator also runs **SeaweedFS**, an S3-compatible server, through
`scripts/with-media-store.mjs` (`scripts/lib/media-store.mjs` does the work).
The functions sign URLs for it with the same code production uses
(`functions/src/mediaStore.ts`), and SeaweedFS checks SigV4 signatures, expiry,
`If-None-Match` and `Range` the way R2 does. Why SeaweedFS and not MinIO or a
test double: `docs/plans/MEDIA-ON-CLOUDFLARE.md`.

- **Install:** release 4.47, `linux_amd64.tar.gz` from GitHub, sha256
  `31fb804858885f9e7f18b6d3b1da09e824baac3e6a55b5a62c3c4c77e6ed6d7d`, unpacked
  to `~/opt/seaweedfs-4.47/weed`. `WEED_BIN` overrides the path; CI installs the
  same release and checks the digest. On the Mac it is `darwin_arm64.tar.gz`,
  sha256 `3ad466db33e83d0b103f90a06997feeb1cc42fd536e6cbdcdded975778f64fda`,
  unpacked to the same path.
- **`weed server`, not `weed mini`.** Mini also starts an admin server and a
  plugin worker that bind ports outside this checkout's block, one of them on
  every interface, and neither can be switched off. Every port is pinned, from
  the block's extras in `ci-tools.json`, and bound to 127.0.0.1.
- **Each run starts empty**, in a fresh temp directory removed on exit. The
  bucket is created and its CORS set (the dev servers' origins) at start.
- **It holds about 1 GB** (16 volumes of 64 MB), and its volumes are
  append-only: an object written again keeps its old copy until a vacuum.
  `putLocalObject` therefore skips a write when the same bytes are already
  stored (the ETag of a single-part put is their MD5). Before it did, the help
  films' forty reseeds filled the store, and every seed after that failed
  with "failed to find writable volumes" in the store's log. A store that
  fills anyway is cleared by restarting the emulators.
- **Keys:** three identities. An admin used only to create the bucket, and the
  read and write keys the functions use, with the same split as the two R2
  tokens. Their values, the endpoint and the bucket are in
  `functions/.env.demo-sabeel-lms`, the file the functions emulator reads,
  so the store and the code agree by construction.
- **`functions/.secret.local`** names every secret the functions bind, or the
  emulator would ask Secret Manager for the demo project's and log a 403.
  Nobody writes it by hand: ci-tools writes it from `ci.emulatorSecrets` in
  `ci-tools.json` (placeholders, unused under the emulator) on every
  `npm run emulators` and `npm run test:emulator`, and `scripts/e2e-stack.sh`
  runs `npx sabeel-ci emulator-secrets` before it starts its own.
- **Android:** signed URLs name `127.0.0.1:61327`, and the host is signed, so
  `10.0.2.2` cannot be substituted. `adb reverse tcp:61327 tcp:61327` lets the
  AVD reach it at the address the URL names; the native flows do it themselves
  (`native.reversePorts` in `ci-tools.json`).
- **Stopping it:** the wrapper stops SeaweedFS when its command exits or on
  SIGINT, SIGTERM or SIGHUP (so `tmux kill-session` works). A leftover is freed
  by `npm run emulators:free`, which covers its ports.

## The e2e harness

`npm run test:e2e` (`scripts/e2e-stack.sh web` → `scripts/web-e2e.mjs`) needs
nothing running: the runner frees the emulator ports, starts the emulators, the
media store and an Expo web dev server on **61310** (the block's `web` port),
runs the walkthrough and stops them all. CI's browser job runs the same
command. Its screenshots land in `shots/e2e/`, emptied as it starts.

`npm run test:e2e:push` (`scripts/e2e-stack.sh push` → `scripts/push-e2e.mjs`)
uses the same runner and port. It builds the sweep's world
(`scripts/lib/seed-world.mjs`), signs in a student and an administrator in full
Chromium (the headless shell refuses notification permission), and for every
message the server builds delivers the push to the real service worker over
DevTools, reads the banner back, dispatches its click inside the worker and
asserts the screen it lands on: with the app open, and at the address the
worker opens when no tab is.

For a tight loop against a stack you keep up, start the two yourself and run
the script directly:

```bash
npm run emulators      # Firestore, Auth, Functions and the local media store
cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web --port "$(npx sabeel-ci ports web)" --clear
node scripts/web-e2e.mjs
```

**`npm run test:emulator`, `test:e2e`, `test:e2e:push` and `test:screens` all
kill that emulator suite.** Each runs `sabeel-ci free-emulator-ports` first, by design — so after
one of them you must restart the long-lived suite before the direct run will
work. The symptom is every e2e check failing at once.

**Its media is generated, not committed.** `scripts/lib/media-fixtures.mjs`
makes the twelve-minute M4A, the same twelve minutes as a tiny MP4, and the
manual's slide videos with ffmpeg, once, under `.tmp/media/`. The e2e and
`seed-guide.mjs` both take them from there, so neither depends on the other
having run first.

**It resets Firestore and Auth on every run.** Leftover state silently SKIPS the
paths that matter: an early version left an admin behind, and every later run
then jumped straight past the pending screen while still reporting success.

**It is a FLOW suite, not a security suite.** Most screens only query what the
user is allowed to see, so a widened rule can leave every screen looking
correct — verified by widening the manager-scope rule and watching the e2e
checks stay green. Authorization lives in the rules tests below. The e2e check
names say "the manager's class list omits…" rather than "a manager cannot
see…" for exactly that reason.

Three more things that cost time here:

- **The run's first staff sign-in can stick on "Setting up your account"**,
  and the walkthrough then fails at its first gate check, "Waiting for
  approval". The account is right: `onUserCreate` sets the claims, then
  creates the `staffUsers` record. On a stack that has just started, the
  blocking functions are cold, so the sign-in takes a couple of seconds, and
  the trigger's claims can land before the gate's first poll. The app then
  listens to `staffUsers/{uid}` before the record exists, is told it does
  not exist, and never hears of its creation, however many times the poll
  refreshes the token and restarts the stream. When the first poll finds no
  role, it reads the record only after it exists, and the run passes.
  Measured on this machine: 5 of 10 first sign-ins on a fresh stack, none of
  23 on a warm one, never in CI. Run it again.
- **`page.goBack()` works, and is worth asserting.** The navigator has a
  `linking` config, so every screen has a URL and the stack IS browser history.
  Reloading a deep URL restores that screen rather than Home — `goto(WEB)` still
  lands on Home only because `/` is the Home path.
- **Text locators can resolve to hidden nodes.** React Navigation keeps the
  previous screen mounted, so `getByText('Managers')` can match a stale hidden
  element and hang until timeout. `innerText()` is safe for assertions because it
  returns only visible text.

  **`getByTestId` is not the cure.** A testID selector is plain CSS and matches
  inside a `display:none` subtree just as happily; only `.filter({ visible: true })`
  actually excludes the screen underneath. `screens-e2e.mjs` routes EVERY locator
  through helpers that carry the filter. `web-e2e.mjs` carries it in `tap()` and
  `sawText()`, which is where the waits are — but it also makes direct
  `page.getByTestId(...)` calls for assertions and one-off waits, and those do
  not. Prefer the helpers; when a direct locator is unavoidable, add the filter
  to it.

## The screens sweep

`npm run test:screens` (`scripts/e2e-stack.sh screens` →
`scripts/screens-e2e.mjs`) is the layout regression harness: every screen of
both populations at five widths, **asserted**, and it exits non-zero.

**A screen is checked once it has finished loading.** Before measuring or
photographing one, the sweep waits for every placeholder the app shows while it
reads ("Counting the work…", "Checking your courses…", "Loading…": a verb ending
in an ellipsis) to go, and fails `<screen> finished loading` if one is still
there after 15 s. It once photographed and measured the course screen with its
assignments still being counted.

**Four tours run at once**, each a population at one width in a browser
context of its own, the staff tours first since each is two thirds of a
width's time. They can run side by side because no tour writes: they open
editors and sheets but never save one, and play nothing. A tour that starts
saving would make the screens depend on which tour finished first.

**It needs nothing running.** The runner starts the emulator suite and its own
Expo web dev server on port **61311** (the block's `sweep`, not `test:e2e`'s
61310) and kills both on the way out, and it never touches a world somebody
else built.

```bash
npm run test:screens                    # the CI set: 320, 390, 720, 1024, 1440
SWEEP_WIDTHS=320 npm run test:screens   # one width, for a tight loop
SWEEP_FULL=1 npm run test:screens       # + iPhone SE / Pixel 7 / iPad Mini profiles
```

**Review a sweep in its report.** The sweep writes its screenshots and every
check (`results.json`) to `shots/screens/`, emptied at the start of each run;
`npx sabeel-ci screens-report` turns them into one page: every screen at every
width side by side, the failed checks beside the screenshot they are about,
and what changed against a baseline sweep as before / after / difference. A
filter narrows it to a screen or a width, or to what failed or changed.
`manifest.json` beside the page holds the same data for an agent.

```bash
npx sabeel-ci screens-report shots/screens --baseline-from-main   # → shots/screens-report/index.html
npx sabeel-ci screens-report shots/screens --baseline <dir of screenshots>
```

`--baseline-from-main` compares with the report of the latest successful CI
run on main (it needs `gh`). CI builds the report on every sweep, pass or
fail, and keeps it for 30 days as the run's `screens-report` artifact; the run
page's summary lists the failed checks and the changed screens and gives the
command that downloads the page: `gh run download <run id> -n screens-report`.

**CI runs on main pushes and non-draft pull requests.** The screens sweep is
part of CI. The full local equivalent is

```bash
npx sabeel-ci check-app && npm run lint && npm run typecheck && npm run knip \
  && npm test && npm run test:emulator && npm run test:screens
```

To run the job manually, use `gh workflow run ci.yml --ref <branch>`.
Platform artifacts and manual releases are documented in
[GitHub Actions](GITHUB-ACTIONS.md).

**Scale and cost, measured 2026-09-11:** 1168 checks over 5 viewports x 49
screens, **~7m wall clock** (including the shared/functions build, Metro's cold
bundle and emulator boot). The staff tour covers the work queue, all four
create sheets open, the People tab's staff half with its Disabled section open,
the library with a cohort chosen (the state its clear control exists in) and
the More sheet itself; the manager tour covers People and one student's page,
which render a different screen from an admin's rather than the same one with
rows removed; the student tour covers the docked now-playing bar, a row that
exists in no other state and eats the bottom of every screen under it; a
fourth tour signs in as the one seeded student who has not accepted the
institute's rules (`RULES_UNSEEN`) and measures the rules screen, a gate whose
way out is Sign out, without ever pressing I agree. Every other seeded account
has accepted, as accounts in use have. Both
student-page visits anchor on a seeded history row, so the page is measured
with its history listener answered rather than before. Every navigating visit
also asserts a testID only its destination renders, so a mis-landed tap fails
rather than photographing the wrong screen under the right name.
That is what the sweep adds to a CI run, and it is the reason the widths are
five deliberate ones rather than a comfortable-looking grid.

Shots land in `shots/screens/` (gitignored); CI uploads them as an artifact when
the sweep fails. **Look at them** — the sweep says a layout is not broken, never
that it is good.

- **The widths straddle `CONTENT_MAX_WIDTH`, which it READS from
  `app/src/theme/index.ts`,** along with the wider `list` maximum beside it. A
  sweep carrying its own copy of either would drift from the thing it checks;
  change a constant and the sweep follows. There is more than one legal answer
  now — a reading column and a card grid want opposite things from a wide window
  — so the check accepts any declared maximum and still fails a column that
  exceeds every one of them, or that fails to centre.
- **A screen with an editor open is a different screen.** The session editor, the
  ledger's override and a roster removal each add rows that exist in no other
  state, and 320px is where they run out of room. They are toured as their own
  entries rather than trusted because the screen underneath them measured fine.
- **The one absolute-width check: no fixed-format control squashed below its own
  widget.** Everything else in the sweep is relative, so a control can sit inside
  its container, overlap nothing, clip nothing, and still be too narrow to read.
  Scoped to `date`/`time`/`number` inputs and `select` — controls whose content
  **cannot be scrolled to**. A text field holding more than fits is ordinary and
  flagging it would fire on every long email address in the app, which is how a
  check gets deleted.

  **Measured against the control's own min-content width, by cloning it.** The
  obvious signal, `scrollWidth > clientWidth`, does not work and shipped an inert
  check for one run: Chromium draws a date input's widget in a UA shadow root
  with `overflow: hidden`, so a date field crushed from 166px to 38px reports
  `scrollWidth === clientWidth` and looks healthy. It *does* work for `select`,
  which is exactly enough plausibility to survive review. Min-content
  discriminates for both — 0px when healthy, 128px short for that same field.
- **The requested width is asserted, not assumed.** Every other check measures
  the DOM against the DOM, which makes them internally consistent and silent
  about *which* width they ran at — so a viewport option that failed to apply
  would leave every one of the sweep's checks green, every screenshot
  mislabelled, and the five-width claim hollow. One check per context, before
  the tour, naming both
  `documentElement.clientWidth` and `window.innerWidth` if they diverge. It is
  the file's own headline rule (a tour that cannot fail is a screenshot
  generator) applied to the tour's premise rather than to its steps.
- **Every screen is measured twice — at the top and scrolled to the end.**
  Overlap is judged on what is visible, so a check that only ever looks at the
  top of a page cannot see the bottom of a fourteen-row roster.
- **Every locator in the SWEEP says `.filter({ visible: true })`, and
  `.first()`/`.last()` are not a substitute.** (In `web-e2e.mjs` the filter is on
  `tap()` and `sawText()`, which is where the waits are; its direct
  `page.getByTestId(...)` calls — assertions and one-off waits — do not carry it.
  Prefer the helpers there, and add the filter to any direct locator that has to
  wait for something.) The stack keeps the screen underneath MOUNTED but hidden,
  so a locator that does not say "visible" can resolve to a node on that screen —
  one that will never become clickable. Playwright then retries for its whole
  timeout against an element that cannot change, and the run dies at a step with
  nothing wrong with it. `.first()`/`.last()` mean document order, not "the one
  on screen". `getByRole` happens to be immune because role selectors skip
  `display:none` subtrees the way a screen reader does; `getByTestId` is a plain
  CSS attribute selector and is **not**. Diagnosed in the sibling time-tracker's
  flow suite, at clean HEAD, failing about one run in two.
- **The header Back is an `<a>`, not a `<button>`.** `PlatformPressable` renders
  `role="link"` when it has an `href`, and the navigator gives it one because
  this app has a linking config. A query for buttons alone reports every pushed
  screen as a dead end — a check failing on its own selector rather than on the
  app.
- **Seeding creates students WITHOUT a password, then sets one.** A `password`
  provider *at creation* is what `onUserCreate` reads as a client-side sign-up,
  and it deletes the account — so passing `password` to `createUser` silently
  deletes every student moments after making them. `createStudent` makes a
  password-less account for exactly this reason.
- **The content column is measured against `clientWidth`, not the bounding rect
  — a choice of property, not a guard.** `clientWidth` and
  `getBoundingClientRect().width` cost the same to write, and the layout box is
  simply what a layout question is about; do not "simplify" it away. Measured
  2026-08-27: this headless Chromium uses OVERLAY scrollbars, inset **zero**, in
  both scrollbar modes (`--disable-features=OverlayScrollbar` does not flip it —
  don't burn time trying), so the naive form would pass identically here. Where a
  classic scrollbar IS in effect the two checks fail in opposite directions:
  centring gets a false positive, the sideways-bleed check a false NEGATIVE
  hiding up to ~15px of real overflow. The false negative is the one that
  matters, because it degrades quietly instead of going red.
- **Targets under 44px are printed, never failed.** Informational: this app has
  legitimate sub-44px controls (chips, tab pills), and a check that cries wolf
  gets deleted.
- **There is deliberately no "is any text truncated" check.** It fires on every
  intentional `numberOfLines` clamp and would drown the real signal.

**Port lookups in these scripts use `ss`, never `lsof`.** `lsof` is not on the
default non-interactive PATH on this box, and a lookup that silences stderr then
reports "no listener" for a missing binary — which silently disables both the
stale-server kill and the cleanup trap. `sabeel-ci free-emulator-ports` does
the same on Linux; follow it.

**Do not `exec` the emulator command, and do not add `INT TERM` to the trap.**
`exec` replaces the shell so the EXIT trap never runs (that leaked a dev server
on every run for a while, invisibly). And bash defers a *trapped* signal until
the foreground command returns, so trapping TERM around a minutes-long command
delays cleanup rather than ensuring it — measured at 406ms vs 2056ms. Node is the
opposite case; there, explicit handlers are the fix.

**A harness nobody has watched fail is not yet evidence.** The way this one was
proven, and the way to re-prove it after changing what it checks: add
`minWidth: 420` to the shared `card` style in `app/src/components/ui.tsx`, run
`SWEEP_WIDTHS=320 npm run test:screens`, and confirm it goes red naming the
screens and the exact controls carried past the right edge — 94/123 on
2026-08-27, across all three tours — then revert.

## Rules tests: the trap in the test itself

`assertFails` passes when an operation fails for **any** reason — including a
broken connection or a typo'd path. A deny-all suite can therefore pass while
testing nothing at all.

So whenever the rules change shape, **mutation-test the suite**: flip the rule to
`allow read, write: if true`, confirm the tests go red, and flip it back. Done
for Phase 0's baseline and again for every predicate added in Phase 1 (see
`PHASE_STATUS.md`), and it is the only thing that makes a suite of denials
meaningful.

**Assert the query the APP sends, not the one the rule was written for.** These
are not the same test, and the gap is invisible from either side. The ledger
rules were covered by `where('courseId','==',…)` on every collection — the shape
they were designed around — while `useRecordingLedger` sent `where('recordingId',
'==',…)`. Every one of its four listeners was denied for every manager, on every
recording, and `rules.ledger.test.ts` stayed green because it was asserting the
author's intent. Copy the query out of the hook, or the suite proves the rule
rather than the product.

Three specifics worth keeping in mind when editing `firestore.rules`:

- **A `list` rule that does not reference `resource.data` grants everything.**
  Referencing it is what forces the client's query to be constrained; a comment
  describing the expected query shape enforces nothing.
- **A `list` is judged on the query's CONSTRAINTS, not only on what it returns.**
  Whatever a rule's `get()` path is built from, the query must pin — otherwise
  the path cannot be resolved and the listen is refused. The tell is that it
  fails **with an empty result set too**: a query matching nothing is still
  denied, so the failure is total rather than data-dependent, and no amount of
  seeding will surface it if the shape is wrong. Test both, as
  `rules.ledger.test.ts` now does.
- **A `get()` resolved from document data costs one read per row** unless every
  row resolves the same path, in which case the result is cached and the query
  costs one (verified at 30 rows against the real engine). Firestore caps
  document-access calls per query, so keep such an arm behind a role guard that
  excludes any population whose queries span many parents, and size the test past
  the limit — `rules.structure.test.ts` uses 25 rows because at three it passes
  either way.

**An admin's run is not evidence about a manager's.** Every staff arm in this
app answers an admin from a zero-read branch that depends on no `resource.data`,
and a manager by resolving a course from the row. Only the second can fail
closed, so a screen exercised only as an admin is a screen whose rules are
untested — and the person who owns the app is the one who will never see the
failure. Both browser suites carry a manager's pass over the recording ledger
for exactly this reason.

Reading Firestore out of band (as the e2e does) needs
`Authorization: Bearer owner`; without it the rules apply and the read is
denied. Note the two different URL shapes: reads use
`/v1/projects/.../documents/...`, while the wipe endpoint is
`/emulator/v1/projects/.../documents`.

## Android

- AVD `tb_emu` (Pixel 6, API 35, Google APIs image) is shared with the sibling
  projects. Override with `SABEEL_AVD`. `npx sabeel-ci emulator headless` boots
  it, and refuses while another session runs it.
- Firebase emulators are reachable from the AVD at `10.0.2.2`; from web use the
  literal `127.0.0.1`, never `localhost` (the emulators bind IPv4 only, and
  `localhost` can resolve to `::1` first — which surfaces as a CORS error,
  because a failed connect produces no response to carry headers).
- **`EXPO_PUBLIC_*` in a debug build comes from the environment that started
  METRO**, not from the APK. If a flag looks unset on device, restart Metro with
  `--clear` and the variable set.
- **`BUILD SUCCESSFUL` is not proof the APK installed.** Confirm before trusting
  any screenshot:

  ```bash
  adb shell dumpsys package com.sabeelinstitute.lms.debug | grep versionName
  ```

  It must match `version` in `app/app.json`.

### Driving the app by adb (headless verification)

There is no device — the AVD `tb_emu` is a Pixel 6 at **1080×2400**. When a
screenshot is read back it is displayed at 900×2000, so **multiply the
coordinates you read off the image by 1.2** to get the real `adb shell input tap
X Y` target. Sign in headlessly with the emulator dev row
(`dev-signin-first-admin`), then `curl` the emulator's `bootstrapAdmin` to
promote (409 = already an admin, fine).

- **A pure-JS change needs a reload, not a rebuild.** After editing only JS,
  Metro fast-refreshes, but to be sure the running app has the new bundle,
  `adb shell am force-stop <pkg>` then relaunch — it refetches from Metro. Only a
  new *native* module (a new dependency) needs `expo run:android` again.
- **Uploads go through the Android SAF picker**, not the app. `adb push` a file
  to `/sdcard/Download`, tap the app's file button, then in the system picker:
  hamburger → Downloads → the file. The picker OPENING at all is already proof
  the native picker module is wired.
- The `Open debugger to view warnings` toast is dev-only LogBox noise; check
  `adb logcat -d | grep -i deprecated` for the actual warning rather than trusting
  the toast — and it never appears in a release build.

### Native flows: `npx sabeel-ci native-e2e`

`npx sabeel-ci native-e2e` runs the Maestro flows in `maestro/` against the
debug build: it stamps and builds the APK and installs it, starts the
emulators and the media store, seeds the world the device pass uses
(`scripts/seed-emulators.mjs`), maps the media store's
port into the emulator (`adb reverse tcp:61327`: `native.reversePorts`),
serves the JavaScript from Metro on 8081 with `EXPO_PUBLIC_USE_EMULATORS=1`,
and runs every flow, or the one you name (`npx sabeel-ci native-e2e
maestro/student.yaml`). It needs one booted emulator (`npx sabeel-ci emulator
headless`) and installs the pinned Maestro itself (`sabeel-ci
install-maestro`). Screenshots, Maestro's JUnit report and the emulator,
Metro and seed logs land in `shots/native/`, with the device's log when a flow
failed. It refuses a held 8081 or 61310. Given `--build <dir>`, it installs the
debug app `npx sabeel-ci native-build` made there instead of building one,
which is how CI runs it.

- **`maestro/student.yaml`**: a password sign-in, its email read back before it
  is sent, a recording that plays and whose clock moves at least 10 s while
  the app is behind Home for 15 s, Classes, and Change password reporting
  "Reset link sent".
- **`maestro/staff.yaml`**: the dev sign-in row, Today, a session's
  register, Courses, People and More.
- **A debug build's warning toast takes taps.** "Open debugger to view
  warnings" sits over the tab bar whenever the app logs a warning, so the
  runner starts Metro with `EXPO_PUBLIC_E2E=1` and `app/index.ts` then tells
  LogBox to ignore warnings; they still reach `logs/metro.log`.
- **A busy simulator drops taps.** The iPhone simulator holds a CI Mac's load
  average past 300, and a tap or a keystroke that lands before a screen takes
  it is lost. So every step that moves the app on goes through ci-tools'
  shared steps, `ci-tools/tap-until.yaml` (tap until the next screen shows) and
  `back-until.yaml` (Back until the screen being left is gone). Each takes a
  step again only while its screen is still showing, so a real failure still
  fails.
  `native-e2e` copies them, with `back.yaml` and `wait.yaml`, into
  `maestro/ci-tools/` for each run; Git ignores the copy, and Maestro runs no
  subfolder's file as a flow of its own.

They are the debug half of the device pass for the rows a script can reach;
the lock screen, a notification and the release-only rows stay with the pass
below. The **Native** workflow runs the same command on GitHub's emulator
(`sabeel-ci ci-avd`) on every main push, every release tag, every pull
request to main, and by hand, and keeps
`shots/native/` as the `native-<sha>` artifact. Its `ios` job runs `--ios` on a
macOS runner for release tags, pull requests and by hand, and keeps the same
folder as `native-ios-<sha>`.

**On the iOS simulator**: `npx sabeel-ci native-e2e --ios` (macOS) builds the
debug app for the simulator with `sabeel-ci native-build ios` (a prebuild
scoped to iOS, the committed `Podfile.lock`, `xcodebuild` for
`iphonesimulator`), boots the iPhone simulator it built for, installs the app
and runs the same flows. Each flow
takes the installed app's id as `${APP_ID}`, since the Android and iOS builds
differ. Two iOS differences shape the flows: a pressable card's texts are one
accessibility label on iOS, and Maestro matches a label whole, so texts inside
a card or a row are matched as part of one (`"Change password[\s\S]*"`); and
back is the edge swipe there.

**Two narrow retries**, each logged loudly: a debug build sometimes dies in
React Native's `MountingCoordinator::pullTransaction` as it loads from Metro
(never a release build), and Maestro's iOS driver sometimes loses an element it
is snapshotting and reports the device unreachable. When the device log or the
report shows exactly that, the flows run once more and the first try's log is
kept; any other failure stands. A failed run also keeps Maestro's view of the
screen (`logs/hierarchy-at-failure.json`), the labels to match against.

### The device pass on the AVD

Run it here before asking anyone to hold a phone; the stack skill's "Device
tests without a device" has the techniques and both tools, installed under
`~/.claude/skills/expo-firebase-stack/tools/`. This project's specifics:

- **A slow phone connection**: the emulator's own speed setting does nothing,
  so a proxy on **61312**, the block's `proxy` port, used by nothing else:

  ```bash
  node ~/.claude/skills/expo-firebase-stack/tools/slow-proxy.mjs 61312 1600 800
  adb shell settings put global http_proxy 10.0.2.2:61312   # :0 to undo
  ```

  1.6 Mbit/s is a slow 4G phone. "Video from Zoom" (3 h 7 min) on the live
  test course is the long recording to start: its index is 3.5 MB, 2.0 MB
  for Audio only. On a release build that points at production, sign in as
  one of Faisal's test students (he has their addresses).
- **The screen**: `avd-ui.py tap <testID>` and `type`; the player never goes
  idle while it plays or its ring turns, so read it from `screencap` then.
  With a 1080×2400 screenshot, the Play button's centre is a good pixel to
  sample for its pressed tint (85% of the accent).
- **What cannot run here**: a staff Google sign-in (Faisal's account) — do the
  staff steps in the browser suite — and anything about a real network's
  behaviour rather than its speed.

## Verifying the dev sign-in row is not shippable

`app/src/auth/devSignIn.ts` is gated on `IS_DEV && USE_EMULATORS` — two
independent conditions, because either alone could be got wrong (a release build
carrying a stale emulator env, or a dev build pointed at production).

**Do not verify this by grepping the exported bundle.** The strings survive
minification: the `DevRow` component is still referenced from a branch the
minifier cannot prove dead, so `grep "Dev sign-in" app/dist-web/` finds it
in a perfectly safe build. That check produces a false alarm and teaches you to
ignore it.

Verify what actually matters — that it does not **render**:

```bash
npm run web:export -w @sabeel/app     # no EXPO_PUBLIC_USE_EMULATORS set
npx serve -s app/dist-web -l 4601
# then load it and assert the row is absent from the DOM
```

Confirmed absent on 2026-07-21 against a production export.

## The help films

More → Help plays short narrated films of the app at work, one per thing a
student, a teacher or an administrator does, each made twice: at a phone's
390 px (touches drawn as ripples) and at a computer's 1440 px (the pointer
drawn as a dot that travels to what it clicks). The list is `HELP_VIDEOS` in
`@sabeel/shared`; `scripts/tutorials/tutorials.mjs` scripts each one — who it
signs in as, where it starts, and for every step the line said and what is
done while it is said — and `record.mjs` refuses to run if the two lists
disagree.

1. `node scripts/tutorials/lines.mjs > lines.json`, then render it with
   `tts.py` (Qwen3-TTS 1.7B CustomVoice, speaker Aiden, a calm instruction; a
   built-in voice, nothing cloned, nothing sent anywhere) and check it with
   `asr_check.py`: the model occasionally drops or garbles a phrase, and a
   line whose transcript strays from its script is rendered again (delete its
   WAV). Each WAV keeps the words it was rendered from beside it (`<id>.txt`):
   a reworded line is rendered again on the next run, and `record.mjs`
   refuses narration that is not its step's words. **Run the two one at a
   time, and not beside a recording**: the 1.7B model holds about 8 GB, the
   transcript model 2.6 GB, and with the emulators and a dev server up as
   well they ran a 15 GB machine out of memory — earlyoom stopped the
   Firestore emulator, and every emulator with it.
2. Start the emulators and a dev server for them on the `web` port, as the
   browser suite does: `EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web
   --port "$(npx sabeel-ci ports web)"` in `app/`. **Not an export.** A
   production export reports to the live Sentry project and draws no dev
   sign-in row for staff, and
   `record.mjs` refuses one. A development export (`--dev`) loads its split
   chunks through the dev server's hot-reload socket, which a static server
   cannot answer, so the first formatting editor a film opens reloads the
   page under it. Edit nothing under `app/` while it films: the dev server
   reloads the page on every change.
3. `record.mjs` seeds a fresh guide world before every film (`seed-guide.mjs`),
   so what one film changes is not in the next, and times every step to its
   line. A step marked `cut: 'phone'` is in the phone's cut alone, for what a
   computer's wider column never shows. **The phone cut is filmed from a
   browser launched at `--force-device-scale-factor=2`**: a context's own
   `deviceScaleFactor` sharpens screenshots, not video — Playwright films at
   CSS pixels, and the film came out as a 390 px page in the corner of a
   780 px frame. **Both are the browser itself, headless (`channel:
   'chromium'`)**, not Playwright's headless shell, which answers every
   notification permission "denied": the student's Notifications screen
   filmed as blocked. A failed step leaves `.failed-<film>-<cut>.png` beside
   the films.
4. `publish.mjs` puts them in the bucket under `help/`. They stay private; the
   app plays them on links `getHelpVideoUrl` signs: a student's films for a
   student, any film for staff.

Re-record a film whenever a screen it shows changes.

## A student can't set a password

Run `npm run students:report -- --email <address>` first, with the address
exactly as it appears on the student's page. It says whether a set-password link
has ever worked for that student (Auth's `passwordUpdatedAt`; an account
`createStudent` makes has no password until one does), whether they have signed
in since, whether the account is switched off, and their audited history. The
full list, `npm run students:report`, is how to tell one student's problem from
everyone's. It counts students only: a record named "Test…", on an institute
address, or carrying a staff member's name (the same first name as someone in
`staffUsers`, and the same surname to within one letter, or none on one side)
is listed apart with the reason. Staff open student accounts on personal
addresses, and counted with the class they can hide the answer.

What students report is the page Firebase Hosting serves at
`<project>.firebaseapp.com/__/auth/action`. It is not part of the
app, and its wording cannot be changed. Its reset handler renders **"Try
resetting your password again"** for every failure of `verifyPasswordResetCode`
(on load) or `confirmPasswordReset` (on Save) except a weak password; that is
read from the page's own `action.js`. Measured against production with
throwaway password-less accounts and Admin-generated links:

| Situation | What the link does |
|---|---|
| A newer link was issued: by `createStudent`, **Resend password link**, **Email me a password link** or **More → Change password** (all made by the server with the Admin SDK, `functions/src/passwordLinks.ts`) | Every earlier link fails at once (`INVALID_OOB_CODE`) |
| The link was used to set a password | Fails from then on (`INVALID_OOB_CODE`) |
| The code was cut off or altered in copying | Fails (`INVALID_OOB_CODE`) |
| The account is disabled | Opens the form; Save fails and no password is set |
| The link is more than an hour old | Fails (`EXPIRED_OOB_CODE`). Valid at 58 minutes, expired at 60 |
| The link was only opened | Still valid. Verifying does not consume it, so link previews and mail scanners do not burn it |

After a successful Save the page reads "Password changed" with a Continue
button to the website's sign-in: the server makes every link with the website
as its continue URL.

Where the sends are recorded: a link staff send (**Resend password link**, and
`createStudent`'s) is in the audit log, on the student's page as "Set-password
link sent", "Password reset link sent" or "Password link not sent: the email
failed". A link asked for from the sign-in screen or More is in the functions'
log by account (`password link requested for <uid>: sent`), never by address;
an address with no student account logs only that. A failed email goes to
Sentry. Cloud Monitoring's Identity Toolkit counts
(`serviceruntime.googleapis.com/api/request_count`, `resource.type="consumed_api"`,
`resource.labels.service="identitytoolkit.googleapis.com"`, by
`resource.labels.method` and `metric.labels.response_code`) still show the
link's use: `ResetPassword` 200 is a link opened or a password saved (one
successful set is two), 400 a link that no longer worked. Links the Admin SDK
makes do not appear under `GetOobCode`.
