# GitHub Actions

The workflows are the three Sabeel apps' shared ones, rendered from
`Sabeel-Institute/ci-tools` into `.github/workflows/` by `npx sabeel-ci
workflows`, with this app's settings from `ci-tools.json`. Change one there,
not here: CI's `sabeel-ci check-app` fails on a workflow that differs from its
template. Every job first clones ci-tools at the commit `package-lock.json`
pins, refuses a commit that is not on ci-tools' `main`, and puts `sabeel-ci`
on the PATH; the release jobs take that pin from main, never from the build
they release.

## Checks and builds

- **Pre-merge Builds** runs on every main-targeting PR, including Dependabot,
  and can also be run manually. It checks Expo SDK dependency ranges; builds the
  backend bundle, installs its production dependencies from
  `functions/package-lock.json` alone in an empty directory, as Cloud Build
  does, and loads the bundle there; exports production web JavaScript,
  compiles an unsigned arm64 Android release AAB and archives an unsigned iOS
  device app in Release mode. Native builds use synthetic Firebase config and
  disable symbol uploads; no signing, publishing or deployment credentials are
  available. Test products are neither uploaded nor accepted as release artifacts.
- SDK recommendations permit same-minor native patch updates; supported caret
  ranges remain supported. Changing React/React Native families, unsupported
  SDK dependencies or pinned iOS pods fails validation rather than rewriting
  lockfiles. Native dependency PRs must include any intended Podfile.lock update.
- The required `premerge-builds` gate fails if any constituent job fails,
  skips or is cancelled. It is required alongside CI (`build-test`) and CodeQL
  (`analyze`) on main, with no status-check bypasses. A branch need not be up
  to date with main to merge: main's own CI runs on every merge, and no
  release workflow accepts a commit it has not passed.
  Green checks validate compilation and tested behavior, not every possible
  runtime behavior or a dependency vendor's privacy defaults.
- **CI** runs `sabeel-ci check-app` (what the shared tooling assumes of this
  repository: the rendered workflows, the version written once, the emulator
  ports, the release environment's secrets), lint, type checks, the dead-code
  audit, unit tests, Firebase-emulator integration tests
  and both browser suites (the flow walkthrough and the multi-width sweep,
  `npm run test:e2e` and `npm run test:screens`) on main pushes and pull
  requests. Every sweep, pass or fail, leaves a `screens-report` artifact: a
  page of every screen at every width with the failed checks beside them and
  what changed against main's latest sweep, before / after / difference. The
  run page's summary lists the failed checks and changed screens and the
  `gh run download` command for the page (`docs/DEV-TOOLING.md`). New PR pushes cancel
  superseded CI runs. No production deployment credentials are used.
- **Native** runs the Maestro flows (`maestro/`) on an Android emulator on the
  runner, against the debug build, the Firebase emulators and the local media
  store, on main pushes, release tags, pull requests that change the flows or
  their seed, and by hand: `npx sabeel-ci native-e2e`, as locally
  (`docs/DEV-TOOLING.md`). Its screens and logs are the `native-<sha>` artifact.
  Its `ios` job runs the same flows on an iPhone simulator on a macOS runner
  (`--ios`) for release tags, pull requests that change the flows, and by hand,
  as `native-ios-<sha>`.
- **Android**, **Web** and **iOS** build automatically on main pushes and can
  also be started manually. They do not run on untrusted pull requests.
- Every Android build (Android, the pre-merge build and Native) first installs
  the NDK and build tools React Native's version catalog names, retrying a bad
  download (`sabeel-ci ci-android-sdk`); Gradle would fetch them once and fail
  the build on a truncated file.
- Android uploads a signed AAB and build record; Web uploads checksummed static
  files and a build record; iOS uploads its signed IPA and build record.
- Android then checks that AAB on an emulator it boots on the runner
  (`device-check`, `sabeel-ci ci-avd`): `sabeel-ci check-release` installs a
  universal APK made from the bundle and cold-starts it five times. Each start
  must reach the sign-in screen and stay up, its label must read
  `v<version> · <commit>` for this commit, the emulator-only sign-in row must be
  absent, and the device log must hold no crash or ANR for the app. Screens and
  device logs are kept as the `release-check-<sha>` artifact, pass or fail. A
  failed check fails the Android run, and Publish Android accepts only a
  successful one.
  Artifacts are retained for 14 days. The AAB uses the existing release/upload
  key and is ready for a separately authorized Play upload.
- Build records identify the source commit and workflow run. The site in a
  Web artifact holds neither source maps nor environment files: the maps sit
  beside it, under `sourcemaps/`, and every script carries the debug id Sentry
  matches it to its map by. The Android build uploads its own map to Sentry
  (`sentry.gradle`), the iOS build its symbols and map.

## Who changes main

- Every change reaches `main` through a pull request; nobody pushes to it
  directly, admins included, and force-pushes and deletion are blocked.
- Only the organization owner (Faisal) can merge. The ruleset "main: only the
  owner merges" restricts updates to `main` and exempts the owner for pull
  requests only; "main: verified pre-merge builds" requires the three checks
  above.
- Release tags (`v*`) are created, moved and deleted by the owner alone (the
  tag ruleset "release tags: only the owner"): the signing environment
  below admits them.

## Manual releases

- **Deploy Web** only runs manually from main. Supply a successful **Web** run
  ID. CI must have passed on that exact commit. The workflow verifies artifact
  provenance and checksums and uses short-lived Google credentials. With
  `deploy=true` its `sourcemaps` job first uploads the build's source maps to
  Sentry (`sabeel-recording-web`, from `ci-tools.json`), in `release-build`
  after the owner check; the site is published only once they are in.
- The default `deploy=false` checks Hosting access without publishing. Select
  `deploy=true` to publish the selected artifact to live Firebase Hosting.
  No rebuilding occurs during deployment; functions, rules, indexes and data
  are not deployed. Older successful artifacts can be selected for rollback
  while they remain available.
- **Deploy Functions** only runs manually from main, on a commit CI has passed.
  The default `deploy=false` builds the bundle, checks the deploy identity and
  compares the bundle's functions with the live ones; `deploy=true` deploys
  them with `firebase deploy --only functions --force`. A deploy that would
  delete a live function stops before deploying anything: delete one by hand
  once nothing calls it. Afterwards every callable must answer an
  unauthenticated call with its own JSON error (not Cloud Run's 403), and the
  functions must have logged no errors since the deploy began, apart from the
  scanners that GET every new revision. `npx sabeel-ci ci-functions` runs the
  same checks from a terminal (`docs/DEPLOY.md`).
- **iOS** uploads to TestFlight only after a manual run with `testflight=true`
  on a release tag, `gh workflow run ios.yml --ref vX.Y.Z -f testflight=true`:
  the upload job refuses a commit that is not the one tagged `v<version>` on
  GitHub, and a build number Apple has already taken. Automatic pushes never
  run its publishing job.
- **Publish Android** runs manually from main. Supply a successful **Android**
  run ID with passing CI on the same commit. It verifies the downloaded AAB's
  provenance, checksum, upload certificate, embedded commit, package and native
  version, then reuses the existing Play publisher without rebuilding.
- The default `publish=false` checks Play permissions by creating and discarding
  an edit; it uploads no bundle and changes no track. Select `publish=true` to
  release to internal testing only. There is no production-track input.
- New uploads require an unused Android versionCode, which follows from the
  version (`docs/DEPLOY.md`, "Cutting a release"). Release a new version and
  build a new AAB before publishing an update; uploading an already-used
  version is not a way to release new code. Existing draft-resume and
  Play-signing checks
  in the local publisher remain in force. Where draft resume is supported,
  Play's SHA-256 must match the selected AAB exactly.
- Dirty-marked AABs cannot be published. Permission-check mode may inspect one
  to validate credentials, but a clean Android build is required for release.
- `npx sabeel-ci publish-play --internal` does the same from a terminal, and
  `npx sabeel-ci release --ship` runs it last. Android builds never upload to
  Play automatically.

## Credentials and trust

Every release workflow (Deploy Web, Deploy Functions, Publish Android and the
TestFlight upload) first checks that the organization owner started it and,
when it is re-run, re-ran it: the organization variables `RELEASE_OWNER_ID`
and `RELEASE_OWNER_LOGIN`, which only organization admins can change.

The `release-build` environment holds `APP_ENV_LOCAL` (the Sentry DSNs),
`BUILD_ENV` (`app/.env.sentry-build-plugin`: the Sentry auth token and the App
Store Connect ids), the existing iOS signing secrets (`IOS_DIST_P12`,
`IOS_DIST_P12_PASSWORD`, `IOS_PROFILE`, `ASC_KEY_P8`), `ANDROID_KEYSTORE` and
`ANDROID_KEYSTORE_PROPERTIES`. It admits main and `v*` tags only, and only the
jobs that build a release enter it (Android, Web, iOS and its TestFlight
upload, and Deploy Web's source-map upload), so a workflow on any other
branch reads none of them; repository secrets would reach a workflow on any
branch a collaborator pushes.
`sabeel-ci check-app` fails CI if a job reads one outside that environment,
or if a release job does not check its owner first. Set one again from the
vault with
`gh secret set NAME --env release-build -R <repo>`. The Firebase app config
files are committed, so no secret carries them. The certificate fingerprint is stored in
`ANDROID_SIGNING_CERT_SHA256`; builds verify it before uploading an AAB.

Hosting uses `FIREBASE_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER` and
`GCP_HOSTING_SERVICE_ACCOUNT` repository variables. Federation is limited to
this organization's numeric repository IDs, main, and manually invoked
`web-deploy.yml` workflows, started by the owner's GitHub account. Each
deployment identity has Hosting permissions only on its own project; there is no exported Google service-account key.
The production environment allows deployments only from main.

Functions deploy as their own identity, `GCP_FUNCTIONS_SERVICE_ACCOUNT`, through
the `github-functions` pool's provider (`GCP_FUNCTIONS_WORKLOAD_IDENTITY_PROVIDER`).
The provider accepts only this repository's `functions-deploy.yml` on main,
started by hand by the organization owner's GitHub account, so a collaborator
who can start the workflow still gets no credentials. The identity can deploy
and read functions, schedules, task queues, triggers and logs in this project,
and act as the functions' runtime accounts; it cannot change data, rules or
Hosting. It
also reads the Firestore database's metadata through a custom role,
`firestoreDatabaseMetadataViewer` (only `datastore.databases.getMetadata`, which
the deploy checks for its Firestore triggers; no document reads), and the list
of Firebase Extensions (`roles/firebaseextensions.viewer`). The `functions` environment permits main only.

The `play-internal` environment also permits main only and holds the encrypted
`PLAY_PUBLISHER_JSON` secret, a copy of the existing Play publisher credential.
`PLAY_PUBLISHER_ACCOUNT` identifies the expected account. This credential is
available only to the manual Play job, not ordinary builds or pull requests.
Its temporary runner copy is removed when the publisher finishes; original
local and vault credentials are unchanged.
The current main-branch release validators and publisher are retained when
checking out the selected build commit, so old artifacts use current safeguards.

The central vault is `~/.config/secrets-vault/`. Existing local keys and
secret files remain authoritative and must not be deleted without express
approval. CI does not generate replacement signing keys.

## Security and independent checks

- Secret scanning and push protection are enabled. Dependabot alerts and
  security-update pull requests are enabled.
- Dependabot checks npm workspaces weekly. Minor/patch npm updates and
  security fixes are grouped separately; major upgrades require explicit
  review. Updates never auto-merge or deploy. The workflows' actions move in
  ci-tools, whose Dependabot updates the templates, and arrive here with the
  next ci-tools pin.
- CodeQL scans JavaScript/TypeScript on main pushes, pull requests and weekly,
  without native builds or production credentials.
- CI has separate workflow-validation, quality/unit, emulator-integration and
  browser jobs. Failed jobs can be rerun without repeating successful jobs.
  The final `build-test` gate requires every CI job to succeed; releases still
  require the complete CI workflow to pass on the exact build commit.
- Workflow validation uses checksum-pinned actionlint with ShellCheck for
  embedded shell commands. It runs on the same pushes and PRs as CI.
- After an explicitly requested web deployment, read-only smoke checks compare
  the public home page, entry JavaScript/styles, privacy/support pages and
  optional push worker against the selected artifact's hashes. Requests use
  only unauthenticated GETs to this app's default `web.app` host. They do not
  sign in, call backend APIs or write data. Transient propagation failures are
  retried; a mismatch fails the workflow without automatically rolling back.
  Authentication-only runs do not perform post-deployment checks.

Dependency updates keep Expo-managed native packages in the current SDK family.
Dependabot proposes patches; native package updates must also keep the committed
iOS pod versions synchronized. SDK-family upgrades are coordinated separately.
All workspaces use the patched Vitest 4 test runner; grouped security updates do
not require a Vitest major upgrade.
The copier Worker's tests run in workerd through `@cloudflare/vitest-plugin`,
the maintained successor of `@cloudflare/vitest-pool-workers`. Its Miniflare
pins `sharp` and `undici` exactly, so keep the plugin and the Worker's
`wrangler` on the same release line: a mismatch installs a second toolchain.

Server-side Sentry explicitly retains restrictive data collection on v11.
Unit tests cover the initialization policy, disabled reporting, and exception flushing.

Metro retains hierarchical dependency lookup so each package resolves its own
compatible dependency version.

Date-driven emulator tests advance the Date constructor and Date.now together,
while keeping network timers real so RPC deadlines use a consistent clock.
