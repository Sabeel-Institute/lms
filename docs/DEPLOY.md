# Deploy

**`oursabeel-lms` was first deployed on 2026-10-12** (Worker, rules,
indexes, functions, hosting) after a copy of the legacy data
([plans/SWITCHOVER.md](plans/SWITCHOVER.md)); `npm run smoke:prod` passed and
a real playback and Zoom import were checked against it. It records the order, the traps, and
the versioned release cycle so a deploy is never improvised. (The Android build
ships separately — see "Cutting a release".)

**Function parameters** (not secrets) are in `functions/.env.<projectId>`, which
`firebase deploy` reads for that project. `NOTIFY_AUDIENCE` decides who push
notifications go to: empty (nobody) while the live site is bug-hunted, then
`staff` (optionally with test accounts' email addresses) until switchover day,
`everyone` after it. Empty or absent means nobody.

## The device pass, before any of it

**Mandatory, and it comes first** — `CLAUDE.md` requires a real Android pass
before every release, and it is the only thing in this project that can. The web
suites cover layout, flows, rules, data and copy; they cannot reach the seams
below, and this app leans on them harder than its siblings because its whole
subject is long audio.

### It takes TWO builds, and conflating them costs you seams

**The release APK proves the artifact.** Only it can show that what ships is a
production build — `versionName`, the `v<version> · <commit>` label, and the
**absent** dev sign-in panel — and only it, pointed at production, can exercise
signed-URL minting, real FCM delivery and the deployed rules. There is no FCM in
an emulator.

**And it is the worst possible build for everything else.** It has no dev
sign-in row, so staff are a Google identity you must hold real credentials for;
and it can only show you the data production happens to hold that day, which may
be no open grant at all — and therefore no playable audio, on the release of an
audio app.

**A debug build against the emulator suite reaches all of that.**
`app/src/auth/devSignIn.ts` mints staff identities straight through the Auth
emulator, and `scripts/lib/seed-world.mjs` hands you an admin, a manager, a
disabled student, deliberately long names and an **open, incomplete** assignment
on demand. The rows below are Yoga, the IME, gestures and the offline outbox:
native behaviours that do not care whether the backend is production or an
emulator.

So: run the release APK for the rows marked **release**, and a debug build for
the rest. "Do the device pass on the release APK" means *prove the shipped
artifact with the shipped artifact*. It has never meant that the release APK is
the only build allowed on the device, and reading it that way silently converts
every seam it cannot reach into a seam nobody checks — which is exactly what
happened on 2026-09-07, and is how the course header below reached production.

**Never bend production to reach a seam.** Re-seeding the live project or moving
a real due date to open a grant is a production write standing in for a build you
could have run for free.

| Seam | Build | What to actually do |
|---|---|---|
| **Build identity** | release | `versionName` matches `app.json`, the sign-in label reads `v<version> · <commit>`, and the dev sign-in panel is **absent** |
| **Push** | release | Confirm a notification arrives, carries the app's own icon under the `sabeel-alerts` channel rather than "Miscellaneous", and opens the right screen |
| **Playback reaches the audio** | release | A signed URL is minted against production and the recording actually plays |
| **Background audio** | either | Start a recording, leave the app, confirm it keeps playing and the notification shows the right title |
| **Lock screen** | either | Pause, resume, and seek from the lock-screen controls |
| **Seek and rate** | either | Scrub a long recording; change the rate; confirm the position survives both |
| **Resume** | either | Kill the app mid-recording, reopen, confirm it resumes where it was |
| **Offline** | debug | Turn the network off: mark a recording complete, confirm "Pending sync", restore the network, confirm it clears — needs an **incomplete** grant, which the seeded world has and production may not |
| **Staff screens** | debug | Today's queue, the not-recorded control, the notification switches, the attendance report — staff sign-in needs the dev row |
| **Keyboard** | debug | Every text field: the field stays visible above the keyboard |
| **Gestures** | debug | Long-press and swipe paths |
| **Safe area** | either | Notch and gesture bar (the app is `screenOrientation="portrait"`, so there is only one orientation to check) |
| **Institute clock on Hermes** | either | The audit log shows an afternoon entry as `13:05`, not `01:05`, and the Zoom import picker gives each card the right AM/PM; typing in the picker's search box does not lag. Both read the same `Intl` parts (`wallClock` in `@sabeel/shared`), which only the device's engine can answer for. The picker needs the live Zoom account, so that half is **release** |
| **Flex/wrap** | debug | Long class and student names — Yoga defaults `flexShrink` to 0, and a real device is the only place that shows. The seeded world carries names chosen to break this |

A screenshot is not the check for any row above except the last two.

### Running the debug half

Two rules decide the shape of this, and both were learned by getting them wrong:

- **`EXPO_PUBLIC_USE_EMULATORS` is read from the environment that started
  METRO**, not from the APK.
- **Do NOT reach for `expo run:android --no-bundler`** to reuse a dev server you
  started yourself. The app builds, installs, signs in and looks completely
  healthy — and never picks up another source edit. Metro logs the rebuild, the
  served bundle contains the change, and the device goes on rendering the old
  one, so every "the fix did not work" reading is a lie. Let `expo run:android`
  start its own Metro.

The seed needs a web dev server (staff are Google identities the Admin SDK
cannot mint, so `seedWorld` drives the app's own dev sign-in row and lets
`onUserCreate` provision them). So seed first, stop that server, then hand the
port to `run:android`:

```sh
scripts/emulator.sh headless &                                  # the AVD
npm run emulators             # frees the ports, builds, starts the emulators + media store; leave running

( cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web --port 8081 --clear ) &
npm run seed:emulators        # prints the student's credentials and the fixture ids
kill %2                       # release 8081 (job 2: the AVD is job 1, the dev server job 2)

( cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo run:android )   # its own Metro
adb reverse tcp:61307 tcp:61307                                  # the audio, see below
```

The emulators bind loopback, which the AVD reaches as `10.0.2.2` — already wired
in `app/src/env.ts`. **Media is the exception:** playback and upload URLs are
signed for the local media store at `127.0.0.1:61307`, and the host is part of
the signature, so it cannot be rewritten to `10.0.2.2`; on the AVD that address
is the AVD itself. Without the `adb reverse`
above every recording fails with "Source error" the moment it is opened
(`ECONNREFUSED` in logcat), and the failure looks like the player's. `run:android`
adds the Metro mapping itself; this one is yours. And `adb root` drops every
`adb reverse` mapping, so avoid it while a debug build is attached, or restore
both afterwards.

## Cutting a release (versioned Android + web)

A release bumps one version and ships it to both surfaces. In order:

0. **Run the three production checks**, which nothing else runs — they
   authenticate against the live project, so neither CI nor the emulator suite
   can: `npm run check:queries` (every query shape the app sends, against the
   real indexes), `npm run check:documents` (every live document the app reads,
   against the fields its type requires — a failure is data to migrate before
   the release, not code to bend around it) and `npm run check:push` (FCM
   credentials and the VAPID key). This machine's Application Default
   Credentials belong to another Google account, so run them with the owner's
   token:
   ```sh
   export CHECK_ACCESS_TOKEN="$(gcloud auth print-access-token --account=faisal.shah@oursabeel.com)"
   npm run check:queries && npm run check:documents && npm run check:push
   ```
   Run `check:documents` again after any migration of live data. See
   `docs/DEV-TOOLING.md`.

1. **Bump the version in BOTH files, together:**
   - `app/app.json` → `expo.version` (drives the sign-in build label and the
     manual cover) **and** `expo.android.versionCode`.
   - `app/android/app/build.gradle` → `versionName` **and** `versionCode` — the
     code MUST increment or Android refuses the upgrade.
   - `app/app.json` → `expo.ios.buildNumber` — it must rise on every
     TestFlight upload, even of the same version.

   `functions/test/unit/appVersion.test.ts` fails if the two files disagree on
   either, so forgetting one is caught by `npm test` rather than on a device.
   Bump the line under the manual's title too (`docs/USER-MANUAL.md`):
   `render-manual.py` refuses to render while it disagrees with `app.json`,
   and a render chained to a copy step then ships the previous PDF.

   Commit the bump **first**, so the build carries that commit: the sign-in label
   is `v<version> · <commit>`, injected from `EXPO_PUBLIC_COMMIT` (the
   `web:export` / `android` npm scripts inject it; the release gradle build takes
   it from the environment — see below).

2. **Web:** `firebase deploy --only hosting`. The predeploy
   (`scripts/web-release.mjs`) exports the production bundle with the commit
   injected, uploads source maps to Sentry, and strips the `.map` files. It
   refuses to run with `EXPO_PUBLIC_USE_EMULATORS` set in the shell (that
   ships an emulator bundle), refuses a bundle that does not carry HEAD's
   commit, and refuses to finish with a `.map` still in the deploy dir. Then
   verify against the LIVE site (not "Deploy complete") with
   `npm run smoke:prod`, which asserts on the deployed page:
   - the sign-in label reads `v<version> · <commit>` for THIS checkout's
     `app.json` and HEAD (`SMOKE_EXPECT_COMMIT=<sha>` when checking a deploy
     made from elsewhere);
   - a provoked Auth request goes to Google and no emulator host is contacted
     — the emulator path is compiled out, so the dev sign-in rows cannot render;
   - the bundle's `.map` URL answers `text/html` (the SPA rewrite for a stripped
     file), not a served map — the CONTENT-TYPE, since the status is 200 either
     way.

   **Then read Sentry for what the release brought** — a crash on the live site
   reached Sentry within minutes once and nobody looked (2026-10-13). Search
   the three app projects (`sabeel-recording-web`, `-android`, `-functions`)
   for issues first seen since the deploy: `firstSeen:-1h is:unresolved`, or
   since the deploy time, in Sentry's Issues view or through the Sentry
   connector. Sentry also emails every new or returning issue in those
   projects (the alert "Every new or returning issue: Sabeel recordings and
   LMS"), but a release is not finished until someone has looked.

3. **Android:** from `app/android`,
   `EXPO_PUBLIC_COMMIT=$(git rev-parse --short HEAD) ./gradlew assembleRelease`
   — default **JDK 17** (not the emulator's JDK 21), and NO emulator flag (it must
   point at production). `BUILD SUCCESSFUL` is not proof: install
   `app-x86_64-release.apk` on the AVD, launch, and confirm `versionName`, the
   `v<version> · <commit>` label, and — crucially — that the dev sign-in panel is
   **absent** (which proves it is a production build, not an emulator one).

   **`EXPO_PUBLIC_COMMIT` is not a Gradle input.** A rebuild after a commit
   that changed no JS (a manifest fix, say) reports
   `createBundleReleaseJsAndAssets UP-TO-DATE` and ships the previous bundle
   with the previous commit in its label — an 11-second `BUILD SUCCESSFUL`
   is the tell. Rebuild with `--rerun-tasks`, and check the bundle before
   installing: `unzip -p app/build/outputs/apk/release/app-x86_64-release.apk
   assets/index.android.bundle | grep -ao "$(git rev-parse --short HEAD)"`.

4. **Publish the APKs to BOTH release homes** (never commit an APK — `*.apk` is
   gitignored; committed APKs bloated the sibling pages history and had to be
   rewritten out):
   - **This (source) repo — the versioned archive.** Tag the build commit and cut
     a matching GitHub Release, or the repo's own release history falls behind the
     shipped version (easy to forget, because the public download comes from the
     pages repo — do NOT skip it):
     ```bash
     git tag vX.Y.Z <build-commit> && git push origin vX.Y.Z   # tag first
     out=app/android/app/build/outputs/apk/release
     cp $out/app-arm64-v8a-release.apk /tmp/sabeel-institute-lms-arm64-v8a.apk
     cp $out/app-universal-release.apk /tmp/sabeel-institute-lms-universal.apk
     gh release create vX.Y.Z -R Sabeel-Institute/lms \
       --title "vX.Y.Z — Android" --notes-file NOTES.md --latest \
       /tmp/sabeel-institute-lms-arm64-v8a.apk /tmp/sabeel-institute-lms-universal.apk
     ```
     **This clone holds the old recording app's tags, `v0.1.0`–`v0.7.1`**,
     from the history it carries, and they are not this repo's: `git tag
     vX.Y.Z` fails with "already exists" for a version the old app used, or a
     local tag points at an old-app commit. Publishing a release whose tag does
     not exist on GitHub yet creates it there at the release's target; then
     `git fetch origin --tags --force` brings the local tags in line. The old
     app keeps its own copies in its own repository.
     **The latest release, never a pre-release.** The download page links
     through `releases/latest`, which skips a pre-release, so a build published
     as one answers its download link with a 404.
     **Copied under the published names, not labelled.** `gh`'s `file#label`
     sets only a display label: the asset keeps the file's own name, and the
     download URL is the name. The repo is public, so these assets ARE the
     public download: the unversioned names make
     `https://github.com/Sabeel-Institute/lms/releases/latest/download/sabeel-institute-lms-<abi>.apk`
     always the newest release. (`gh release create --target <sha>` on a
     not-yet-tagged release 422s; create and push the tag first, then the
     release.)

5. **Update the download page** in `faisal-shah.github.io/sabeel-institute-lms/`
   (`DOWNLOAD_PAGE_URL`) and push. The download links never change, but three
   things do:
   - the **version and publish date** in `index.html`;
   - the **What's new** list — a handful of plain-language lines, no jargon. This
     is the only release note most people ever read;
   - **`USER-MANUAL.pdf`**, copied from `docs/USER-MANUAL.pdf`. It is a SEPARATE
     COPY, not a link, so it does not follow the repo automatically. Skipping this
     is invisible — the page keeps serving an older manual quite happily, and it
     had drifted three versions behind before anyone looked:
     ```bash
     cp docs/USER-MANUAL.pdf ../faisal-shah/faisal-shah.github.io/sabeel-institute-lms/
     ```
     Verify the published copy, not the local one:
     `pdftotext -f 1 -l 1 USER-MANUAL.pdf - | grep -i version`

6. **Google Play, internal testing:** the same commit as an App Bundle, from
   `app/android`, then up to Play:
   ```bash
   EXPO_PUBLIC_COMMIT=$(git rev-parse --short HEAD) ./gradlew bundleRelease
   cd ../.. && npm run publish:play -- --check && npm run publish:play -- --internal
   ```
   Everyone on the "Sabeel staff" tester list gets it from Play; the join link
   never changes. `publish-play.mjs` refuses a debug-signed bundle, one that
   does not carry HEAD's commit (the same Gradle trap as step 3; it prints the
   40-second rebuild of the JS alone), and a versionCode Play reads differently
   from `build.gradle`. It never makes an app's first release: that one is
   made in Play Console, where the app's signing key is chosen (the LMS's own
   release key, uploaded with Google's PEPK tool). The bundle carries every
   ABI and Play cuts per-device APKs from it, so `build.gradle` turns the APK
   splits off for bundle tasks. The publishing key: `docs/SECRETS.md`.

7. **iPhone:** a TestFlight build of the release commit, from GitHub:
   `gh workflow run ios.yml --ref main -f testflight=true`
   (`docs/IOS-BUILD.md`, "Builds on GitHub"). Its TestFlight job stops before
   uploading if Apple already has the build number. The Mac's
   `npm run build:ios` does the same from a Mac. The Internal group gets it by
   itself. The App Store is not yet a release home: the app is in TestFlight
   only.

There is no `npm run release` script yet (the sibling time-tracker has one); this
is the manual recipe until one exists.

## Demo data in the live project

There is a pair of scripts for filling production with a realistic dataset to look
at the reports with, and for taking it out again:

```bash
node scripts/seed-demo-prod.mjs --yes        # 3 cohorts, 8 courses, 50 students, ~80 sessions
node scripts/seed-demo-coursework.mjs        # DRY RUN; --yes adds assignments, work and grades to every active course
node scripts/wipe-demo-prod.mjs              # DRY RUN — prints the plan, deletes nothing
node scripts/wipe-demo-prod.mjs --yes
```

`seed-demo-coursework.mjs` writes over REST as faisal.shah@oursabeel.com
through gcloud. The other two use the Admin SDK, so Application Default
Credentials must be that account (`gcloud auth application-default login`);
on this machine they belong to another account, and the wipe is refused.

**If you are asked to "clean up the demo data", that second command is the whole
job** — there is nothing else to undo. The seed changed no application code,
deployed no functions, and touched no rules; it wrote to Firestore and Auth with
the Admin SDK and to the R2 bucket with the write key from Secret Manager,
which needs no loosening of anything.

Read the header of `wipe-demo-prod.mjs` before running it with `--yes`. Four things
are easy to get wrong if you reimplement the cleanup by hand instead:

- **The `demoSeed` flag is not sufficient.** The fan-out assignments and
  attendance projections, any listening progress and audit rows generated by
  playing a demo recording, an enrolment made by hand, and anything *you* created
  inside a demo course carry no flag. The script also sweeps by reference: any
  document whose `recordingId`, `studentUid`, `courseId`, `sessionId`, `cohortId`
  or `targets.*` names a `demo-` id.
- **`notifications/{uid}` is a tree.** A demo account that turned notifications
  on has `devices` and `sent` subcollections under it, and Firestore never
  cascades a delete — the script uses `recursiveDelete`, and finds the parent
  through `listDocuments` because a device registration creates the
  subcollection without ever writing the parent document.
- **The demo leaked into real records.** Staff demoed with real classes open, so
  demo students were enrolled in real courses and marked on real registers, and
  demo staff were made managers of a real course. The script edits those real
  documents — demo uids out of a session's `attendance` map and a course's
  `managerUids`, each listed by name in the plan — because the ledger keeps marks
  for departed students on purpose, and a departed uid with no student behind it
  would sit on a real class's ledger for good.
- **Media is keyed on the recordings actually removed**, not on a path prefix —
  a recording added inside a demo course has an ordinary random id, and its audio
  would otherwise be stranded in the bucket, billable, forever.

After deleting, the script rescans every collection — including any it has never
heard of — for an id, key or value starting with `demo-`, and exits non-zero if
it finds one. That scan, not the plan, is what says the job is done.

## Order

Always: **Worker → indexes → rules → functions → hosting.** The Worker first,
because the Zoom import calls it; the bucket settings whenever
`cloudflare/media-bucket/` changes.

```bash
npm run deploy -w @sabeel/media-copier          # the Zoom copier (Cloudflare)
npm run bucket-config -w @sabeel/media-copier   # only when cors.json / lifecycle.json change
firebase deploy --only firestore:indexes
firebase deploy --only firestore:rules
firebase deploy --only functions --force        # --force is always needed: see below
firebase deploy --only hosting
```

### `accountExists` must be LIVE before an APK that calls it ships

The native Google door asks `accountExists` before it will exchange a credential,
so on a build that has the gate, a missing callable is not a degraded sign-in —
**it is no staff sign-in at all**. The order is therefore not just a deploy
convention:

1. `firebase deploy --only functions` (the callable),
2. *then* build and publish the APK.

The web app is unaffected either way — `google.web.ts` has no gate and creates
accounts as it always has — so a hosting deploy carries no such constraint. And
the reverse mistake is harmless: the callable can sit deployed and uncalled for
as long as you like, which is why it is worth deploying it early rather than in
the same rush as a release.

Functions ALWAYS need `--force`: `onAssignmentWritten` declares `retry: true`, and the CLI refuses to deploy
a function with a failure policy without it ("Pass the --force option to deploy
functions with a failure policy"). The same flag lets a deploy delete functions
after a rename, so read the plan it prints before confirming nothing is pruned
that should not be.

Indexes before rules and functions, because a query that needs a missing index
fails as a *listener error* — visible only as an empty screen and a console
warning. Rules before functions so a new function never runs against permissions
that have not landed.

## First-deploy traps

Three that come from the project living in a Google Cloud **organization**
created after mid-2024, which the legacy personal project was not. All were
hit on 2026-10-12 and all apply to any new project here (a test project too):

- **Every function fails to BUILD** ("missing permission on the build service
  account"; for the one gen-1 function, "Access to bucket gcf-sources-… denied").
  The org's default policy stops the Compute Engine default service account,
  which both builds and runs gen-2 functions, getting the Editor role it used to
  get automatically. Grant it only what the code needs:
  `roles/cloudbuild.builds.builder`, `roles/logging.logWriter`,
  `roles/datastore.user`, `roles/firebaseauth.admin`,
  `roles/firebasecloudmessaging.admin`; and the App Engine default account
  (`<project>@appspot.gserviceaccount.com`, which runs the gen-1
  `onUserCreate`) `roles/datastore.user`, `roles/firebaseauth.admin`,
  `roles/logging.logWriter`. A failed first create leaves every function as a
  `FAILED` stub: delete them all (`gcloud functions list`, then
  `firebase functions:delete … --force`) before redeploying.
- **Callables cannot be made public** ("Failed to set invoker function …": an
  organization policy restricts IAM members to the institute's own domain, and
  a callable needs `allUsers` as invoker; the code checks the caller). Fix for
  THIS project only: `iam.allowedPolicyMemberDomains` set to allow all on
  `projects/<number>` (`gcloud org-policies set-policy`; needs
  `roles/orgpolicy.policyAdmin` on the organization, which an organization
  admin can grant themselves). Done for `oursabeel-lms`; every other project
  in the organization keeps the restriction.
- **A redeploy does not set the invoker on unchanged functions**, so after
  fixing the policy grant it directly, once:
  `gcloud run services add-iam-policy-binding <service> --member=allUsers --role=roles/run.invoker --region=us-central1`
  for every callable (every function whose name does not start with `on`).
  It takes a few minutes to spread: until then a call carrying a Firebase ID
  token gets an HTML 401, "The access token could not be verified", from Cloud
  Run's front end rather than JSON from the function. `npm run smoke:prod`
  calls every callable signed out and fails on any such HTML answer: a new
  callable once shipped without the binding and broke every staff upload.

- **The Zoom copy queue (`copyZoomFile`) needs Cloud Tasks and three grants**,
  made once on 2026-10-13: the Cloud Tasks API enabled; the runtime account
  (`<number>-compute@developer.gserviceaccount.com`) given
  `roles/cloudtasks.enqueuer` and `roles/cloudtasks.viewer` on the project
  and `roles/iam.serviceAccountUser` on itself, so `importZoomFiles` can
  queue a task carrying its token. The queue calls the function with that
  token; the account's project-level `roles/run.invoker` lets it in, and the
  function itself is `invoker: 'private'` (its first deploy left it open to
  `allUsers`).
- **A deploy of `copyZoomFile` fails with "Unable to set the invoker" when the
  queue's IAM policy is empty.** firebase-tools 15.22.4 reads
  `existing.bindings.filter` and a fresh queue's policy has no `bindings`;
  the real error, "Cannot read properties of undefined (reading 'filter')",
  shows only under `--debug`. The CLI removes only the enqueuer role from the
  queue, so a viewer binding keeps the field present:
  `gcloud tasks queues add-iam-policy-binding copyZoomFile --location=us-central1 --member=serviceAccount:<runtime account> --role=roles/cloudtasks.viewer`.
  Done for `oursabeel-lms`; a new project's queue needs it after its first
  deploy.
- **Cloud Build 404 on `@sabeel/shared`.** `firebase deploy` ships only
  `functions/` to Cloud Build, so a private workspace package in its
  `package.json` makes `npm install` 404. Handled: `functions/esbuild.config.mjs`
  inlines `@sabeel/*` and leaves real npm deps external. Verify with
  `grep -c 'require("@sabeel/shared")' functions/lib/index.js` — it must be 0.
- **`functions/package-lock.json` is committed, and must stay in step.**
  Without it a cold Cloud Build cannot resolve this codebase's dependencies at
  all, and the failure is invisible until the first genuinely new function —
  see the `expo-firebase-stack` skill for the mechanism and the recovery. It is
  pinned to the versions the suite runs against, so regenerate it whenever a
  dependency in `functions/package.json` changes, and check
  `npm ci --dry-run --omit=dev` accepts the pair before deploying.
- **Eventarc permission denied** on the first deploy of a Firestore-trigger
  function. Propagation lag; retry after a few minutes.
- **Secret Manager 403** for every bound secret on first deploy — grant the
  runtime service account access, then redeploy.
- **Rules pass locally, queries fail in production.** Emulator rules evaluation
  is not identical; test the real queries after deploying rules.
- **Stale config baked into the web bundle.** `web:export` always passes
  `--clear`: Metro's transform cache can serve a bundle built under different
  `EXPO_PUBLIC_*` values, and an emulator-mode bundle must never ship.

## Hosting

`firebase.json` sets `no-cache` on everything except `/_expo/static/**`, which is
content-hashed and therefore immutable. The `predeploy` hook runs the web export,
so hosting always ships a fresh bundle.

`authDomain` in `firebase-config.ts` must be the **hosting** domain
(`<project>.web.app`), not `firebaseapp.com` — hosting serves `/__/auth/*`
itself, keeping the sign-in redirect same-origin. Without it, sign-in from a
chat-app in-app webview dies with `auth/missing-initial-state`, because those
webviews partition storage and the cross-origin handoff loses its state.
**Register the redirect URI on the OAuth client before flipping `authDomain`**,
or sign-in breaks for everyone in between.

## Sentry source maps

Web source-map upload is wired into the hosting deploy: the predeploy runs
`scripts/web-release.mjs`, which exports **with** source maps, injects Sentry
debug ids, uploads the maps to the `sabeel-recording-web` project, then
**deletes the `.map` files from the deploy dir** so Firebase never serves them
publicly. The shipped JS keeps its debug id, so production errors symbolicate
against the maps in Sentry. Debug ids mean no release/version coordination.

The upload needs the auth token in gitignored `app/android/sentry.properties`
(see `docs/SECRETS.md`); without it the script still builds and strips maps,
just skips the upload — so a fresh clone or CI can deploy, they just won't
upload maps. (CI does not deploy anyway.)

Note a `.map` URL on the live site returns **200 with `text/html`** — that is the
SPA `** → /index.html` rewrite catching a missing file, not a served map. Verify
the *content-type*, not the status, to confirm maps are not leaked.

**Native source maps are not uploaded.** Release APKs ship (`assembleRelease`,
signed with the release key in `~/.config/sabeel-lms/` — see
[SECRETS.md](SECRETS.md#android-release-signing-key)), but
the `@sentry/react-native` Gradle plugin is not active, and activating it means
a `prebuild` in this bare workflow. The token is already in place for when that
happens; Sentry reporting itself works on native today, with minified release
stack traces.

## Retiring old builds

Every Android build from v0.7.0 reads `config/app.minVersionCode` before sign-in
and shows an update screen — with the download page — when its own
`versionCode` is below it. After a release that older builds can no longer run
against (a rules change refusing a listener they still open is the case that
made this exist), raise the floor by hand:

```bash
node scripts/set-min-version.mjs 33     # the versionCode of the oldest build to keep
```

It is a decision, not a deploy step: nothing raises it for you. The floor is a
`versionCode` (`app/android/app/build.gradle`), not a version name, and a build
that predates the gate (anything before 0.7.0) cannot be reached by it —
those need a person.

## After deploying

"Deployed" is not "working." Load the production URL, sign in, and check the
console. For functions, check the logs for an actual invocation rather than
trusting that the deploy succeeded.

When a function's RUNTIME CONFIG changed — timeout, memory — logs prove nothing,
because a config that did not take looks identical until something runs long
enough to hit the old limit. Read it back instead (gcloud has no default project
here, so name it):

```bash
# The two whose limits matter: the Zoom copy (1800 s) and an upload's finish (300 s).
for f in copyZoomFile finalizeRecordingUpload; do
  gcloud functions describe "$f" --region=us-central1 --gen2 \
    --project=oursabeel-lms \
    --format="value(name,serviceConfig.timeoutSeconds,serviceConfig.availableMemory)"
done
```

That verifies the CONFIG, not the import. No suite moves a genuinely large file —
the fixtures are kilobytes — so the only end-to-end proof is importing a real
two-hour meeting.

## Android

No EAS. Local Gradle builds with a committed `android/` directory. The APK ships
as a **GitHub Release asset**, never committed to any repo — per-release APKs
bloated the sibling pages repo's history and had to be rewritten out.
