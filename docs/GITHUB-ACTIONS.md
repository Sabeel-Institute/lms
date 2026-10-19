# GitHub Actions

## Checks and builds

- **CI** runs lint, type checks, unit tests, Firebase-emulator integration tests
  and browser regressions on main pushes and pull requests. New PR pushes cancel
  superseded CI runs. No production deployment credentials are used.
- **Android**, **Web** and **iOS** build automatically on main pushes and can
  also be started manually. They do not run on untrusted pull requests.
- Android uploads a signed AAB and build record; Web uploads checksummed static
  files and a build record; iOS uploads its signed IPA and build record.
  Artifacts are retained for 14 days. The AAB uses the existing release/upload
  key and is ready for a separately authorized Play upload.
- Build records identify the source commit and workflow run. Web artifacts
  contain neither source maps nor environment files.

## Manual releases

- **Deploy Web** only runs manually from main. Supply a successful **Web** run
  ID. CI must have passed on that exact commit. The workflow verifies artifact
  provenance and checksums and uses short-lived Google credentials.
- The default `deploy=false` checks Hosting access without publishing. Select
  `deploy=true` to publish the selected artifact to live Firebase Hosting.
  No rebuilding occurs during deployment; functions, rules, indexes and data
  are not deployed. Older successful artifacts can be selected for rollback
  while they remain available.
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
