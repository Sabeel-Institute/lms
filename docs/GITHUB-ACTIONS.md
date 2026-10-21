# GitHub Actions

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
  (`analyze`) on main, with up-to-date branches and no status-check bypasses.
  Green checks validate compilation and tested behavior, not every possible
  runtime behavior or a dependency vendor's privacy defaults.
- **CI** runs lint, type checks, unit tests, Firebase-emulator integration tests
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
  their scripts, and by hand: `bash scripts/native-e2e.sh`, as locally
  (`docs/DEV-TOOLING.md`). Its screens and logs are the `native-<sha>` artifact.
- **Android**, **Web** and **iOS** build automatically on main pushes and can
  also be started manually. They do not run on untrusted pull requests.
- Android uploads a signed AAB and build record; Web uploads checksummed static
  files and a build record; iOS uploads its signed IPA and build record.
  Artifacts are retained for 14 days. The AAB uses the existing release/upload
  key and is ready for a separately authorized Play upload.
- Build records identify the source commit and workflow run. Web artifacts
  contain neither source maps nor environment files.

## Who changes main

- Every change reaches `main` through a pull request; nobody pushes to it
  directly, admins included, and force-pushes and deletion are blocked.
- Only the organization owner (Faisal) can merge. The ruleset "main: only the
  owner merges" restricts updates to `main` and exempts the owner for pull
  requests only; "main: verified pre-merge builds" requires the three checks
  above on an up-to-date branch.

## Manual releases

- **Deploy Web** only runs manually from main. Supply a successful **Web** run
  ID. CI must have passed on that exact commit. The workflow verifies artifact
  provenance and checksums and uses short-lived Google credentials.
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
  scanners that GET every new revision. `scripts/ci-functions.mjs` runs the same
  checks from a terminal (`docs/DEPLOY.md`).
- **iOS** uploads to TestFlight only after a manual run with `testflight=true`.
  Automatic pushes never run its publishing job.
- **Publish Android** runs manually from main. Supply a successful **Android**
  run ID with passing CI on the same commit. It verifies the downloaded AAB's
  provenance, checksum, upload certificate, embedded commit, package and native
  version, then reuses the existing Play publisher without rebuilding.
- The default `publish=false` checks Play permissions by creating and discarding
  an edit; it uploads no bundle and changes no track. Select `publish=true` to
  release to internal testing only. There is no production-track input.
- New uploads require an unused Android versionCode. Bump the version and build
  a new AAB before publishing an update; uploading an already-used version is
  not a way to release new code. Existing draft-resume and Play-signing checks
  in the local publisher remain in force. Where draft resume is supported,
  Play's SHA-256 must match the selected AAB exactly.
- Dirty-marked AABs cannot be published. Permission-check mode may inspect one
  to validate credentials, but a clean Android build is required for release.
- The local `npm run publish:play -- --internal` command remains available.
  Android builds never upload to Play automatically.

## Credentials and trust

GitHub holds `APP_ENV_LOCAL`, the existing iOS signing secrets,
`ANDROID_KEYSTORE` and `ANDROID_KEYSTORE_PROPERTIES`. LMS also needs
`ANDROID_GOOGLE_SERVICES_JSON`. The certificate fingerprint is stored in
`ANDROID_SIGNING_CERT_SHA256`; builds verify it before uploading an AAB.

Hosting uses `FIREBASE_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER` and
`GCP_HOSTING_SERVICE_ACCOUNT` repository variables. Federation is limited to
this organization's numeric repository IDs, main, and manually invoked
`web-deploy.yml` workflows. Each deployment identity has Hosting permissions
only on its own project; there is no exported Google service-account key.
The production environment allows deployments only from main.

Functions deploy as their own identity, `GCP_FUNCTIONS_SERVICE_ACCOUNT`, through
the `github-functions` pool's provider (`GCP_FUNCTIONS_WORKLOAD_IDENTITY_PROVIDER`).
The provider accepts only this repository's `functions-deploy.yml` on main,
started by hand by the organization owner's GitHub account, so a collaborator
who can start the workflow still gets no credentials. The identity can deploy
and read functions, schedules, task queues, triggers and logs in this project,
and act as the functions' runtime accounts; it cannot change data, rules or
Hosting. The `functions` environment permits main only.

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
- Dependabot checks npm workspaces and GitHub Actions weekly. Minor/patch npm
  updates and security fixes are grouped separately; major upgrades require
  explicit review. Updates never auto-merge or deploy.
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
