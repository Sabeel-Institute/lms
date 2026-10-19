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
- Play publishing remains a separately authorized local
  `npm run publish:play -- --internal` operation. Android builds never upload
  to Play automatically.

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

The central vault is `~/.config/secrets-vault/`. Existing local keys and
secret files remain authoritative and must not be deleted without express
approval. CI does not generate replacement signing keys.

## Additional checks

Keep the existing integration and browser suites rather than duplicating them
in every platform build. Dependency-update automation and CodeQL are useful
next additions; broad production smoke tests and backend deployments should
remain separate, explicitly approved operations.
