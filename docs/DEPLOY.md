# Deploy

Automatic platform builds and manual release controls are documented in
[GitHub Actions](GITHUB-ACTIONS.md).

Production uses Firebase project `oursabeel-lms`, owned by Sabeel Institute
under `oursabeel.com`, and repository `Sabeel-Institute/lms`. The local clone is
`/home/faisal/repos/Sabeel-Institute/lms`. Android testers use Play internal
testing; iPhone testers use TestFlight. Secret files are backed up in
`~/.config/secrets-vault/`.

**Function parameters** (not secrets) are in `functions/.env.<projectId>`, which
`firebase deploy` reads for that project. `NOTIFY_AUDIENCE` decides who push
notifications go to: empty (nobody) while the live site is bug-hunted, then
`staff` (optionally with test accounts' email addresses) until switchover day,
`everyone` after it. Empty or absent means nobody.

## Access a releaser needs

| Where | Access | For |
|---|---|---|
| GitHub `Sabeel-Institute/lms` | admin (organization owner) | tags and releases, Actions secrets, starting `ios.yml`, merging pull requests into `main` |
| Google Cloud `oursabeel-lms` | Owner, as an oursabeel.com account | deploys, Secret Manager, the production checks' token, IAM |
| Cloudflare account of `oursabeel-lms-media` | member with Workers and R2 | the copier Worker and the bucket settings |
| Sentry (the three `sabeel-recording-*` projects) | member | reading a release's issues (step 2) |
| Google Play Console | release to testing tracks, manage testers | the internal track and the "Sabeel staff" list (step 5) |
| App Store Connect | Admin or App Manager | TestFlight testers and the app record (`docs/IOS-BUILD.md`) |
| `~/.config/secrets-vault/` | a copy | the release keystore, the Play publishing key, the Apple files (`docs/SECRETS.md`) |

Builds need no Apple login: `ios.yml` signs and uploads with the secrets in
GitHub. The Mac is needed only for simulator checks (`docs/IOS-BUILD.md`,
"The Mac").

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
npx sabeel-ci emulator headless &                               # the AVD
npm run emulators             # frees the ports, builds, starts the emulators + media store; leave running

( cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo start --web --port 8081 --clear ) &
npm run seed:emulators        # prints the student's credentials and the fixture ids
kill %2                       # release 8081 (job 2: the AVD is job 1, the dev server job 2)

( cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo run:android )   # its own Metro
adb reverse tcp:61327 tcp:61327                                  # the audio, see below
```

The emulators bind loopback, which the AVD reaches as `10.0.2.2` — already wired
in `app/src/env.ts`. **Media is the exception:** playback and upload URLs are
signed for the local media store at `127.0.0.1:61327`, and the host is part of
the signature, so it cannot be rewritten to `10.0.2.2`; on the AVD that address
is the AVD itself. Without the `adb reverse`
above every recording fails with "Source error" the moment it is opened
(`ECONNREFUSED` in logcat), and the failure looks like the player's. `run:android`
adds the Metro mapping itself; this one is yours. And `adb root` drops every
`adb reverse` mapping, so avoid it while a debug build is attached, or restore
both afterwards.

## Cutting a release (Android, web and iPhone)

A release is one version on every surface, from one commit, through a pull
request. The version is written once, `expo.version` in `app/app.json`;
Android's versionCode and the iPhone build number both follow from it,
`major * 1000000 + minor * 1000 + patch` (0.2.2 is 2002), so each version
reaches Play and TestFlight once. The tool is ci-tools' `release`, the same in
every Sabeel app. In order:

0. **Run the three production checks**, which nothing else runs — they
   authenticate against the live project, so neither CI nor the emulator suite
   can: `npm run check:queries` (every query shape the app sends, against the
   real indexes), `npm run check:documents` (every live document the app reads,
   against the fields its type requires — a failure is data to migrate before
   the release, not code to bend around it) and `npm run check:push` (FCM and
   both of Apple's services accept a message from this project, and refuse a
   dead token with an answer the functions prune on). This machine's
   Application Default Credentials belong to another Google account, so run
   them with the owner's token:
   ```sh
   export CHECK_ACCESS_TOKEN="$(gcloud auth print-access-token --account=faisal.shah@oursabeel.com)"
   npm run check:queries && npm run check:documents && npm run check:push
   ```
   Run `check:documents` again after any migration of live data. See
   `docs/DEV-TOOLING.md`.

1. **Write the release notes**, for students and teachers, in a file, as the
   version's deploy-log entry: headed `### <YYYY-MM-DD> — <summary> — vX.Y.Z`,
   then the notes (`docs/PHASE_STATUS.md`, "Deploy log", has the earlier
   ones). The summary titles the pull request and the GitHub release, and the
   notes describe both.

2. **Open the release pull request:**
   ```sh
   npx sabeel-ci release X.Y.Z --notes <entry.md> --dry-run   # shows the change, leaves nothing behind
   npx sabeel-ci release X.Y.Z --notes <entry.md>
   ```
   It works from origin/main in a worktree of its own, leaving this checkout
   as it is: the version and the iOS build number in `app.json`, the line
   under the manual's title (`docs/USER-MANUAL.md`) and `docs/USER-MANUAL.pdf`
   rendered with it (`npx sabeel-ci render-manual`, which needs `uv` and
   `google-chrome`), and the entry added to the deploy log, committed as
   `chore(release): vX.Y.Z` on `release/vX.Y.Z`, pushed, and the pull request
   into main opened. It refuses a version that is not X.Y.Z, or whose code is
   not above main's and every released tag's: Android refuses an upgrade that
   does not increase, and Play takes each code once. Faisal merges it once its
   checks pass.

3. **Ship it from main**, on this machine, once merged:
   ```sh
   git switch main && git pull --ff-only
   npx sabeel-ci release --ship
   ```
   It refuses anything but a clean main that matches origin, and builds and
   signs nothing on this machine. Then:
   - waits for the Android workflow's run on that commit and refuses one that
     failed. That run built the signed Play bundle in the `release-build`
     environment (`sabeel-ci build-aab`: the version check, a deploy-log entry
     for the version, the native Sentry DSN, the Sentry token, the build
     stamp, `gradlew bundleRelease`, whose `sentry.gradle` uploads the
     bundle's source map to `ci-tools.json`'s native project) and cold-started
     it five times on an emulator;
   - has Publish Android check that bundle (provenance, checksum, signature,
     version, commit) and Play's permission without uploading;
   - has Publish Android put it on Play internal testing: the build goes up
     as a draft release no tester sees, Play generates its APKs, and the
     release completes only if they are signed with the LMS's own key
     (`release.appSigningCertificate` in `ci-tools.json`);
   - downloads the universal APK Play generated, signed exactly as Play
     installs it (`sabeel-ci play-apk`, refusing any other signer, and an APK
     carrying Play's installer check: Play Console's automatic protection
     stays off for this app, since a protected APK opens only when Play
     installed it), and cold-starts it five times on the AVD (`sabeel-ci check-release`, which
     boots `tb_emu` if nothing is attached: check who owns it first,
     `CLAUDE.md`): each start must reach the sign-in screen with the label
     `v<version> · <commit>` for this commit, no dev sign-in row, and no crash
     or ANR in the device log;
   - last, makes the GitHub release `vX.Y.Z` at that commit, titled and
     described by the deploy-log entry, with `sabeel-institute-lms-universal.apk`
     and the manual: a draft, then published, which creates the tag, which
     only Faisal may (the tag ruleset). The tag comes last, so a tagged
     release always holds its APK and manual and names a version testers
     have. If any step before it fails, nothing is tagged: fix the cause and
     run `npx sabeel-ci release --ship` again, which resumes (Play's held
     bundle is not uploaded twice, and a draft left behind is replaced).

   It needs the Play publishing key (`~/keys/sabeel-play-publisher.json`) and
   `gh` signed in as Faisal; no release keystore. It ends by printing the two
   runs that put the same commit on the web and on iPhones.

   **The first Play release was 0.2.0 (code 38),** completed by the publisher
   with no Play Console step. 0.1.2 (code 37), processed before the signing
   key changed and so signed with Google's key, never went out; its draft was
   removed from the internal track. Play Console gives every new app a
   Google-generated signing key when it is created; the LMS's was replaced
   with its own (App integrity, App signing, "Change key", "Export and upload
   a key from Java keystore", with Google's PEPK tool). The bundle carries every
   ABI and Play cuts per-device APKs from it, so `build.gradle` turns the APK
   splits off for bundle tasks; the GitHub release's APK is Play's own
   universal one.

   **Testers.** Play Console, Internal testing, Testers: the email list "Sabeel
   staff" (20 staff) is ticked. To add someone, edit that list there and add
   the address of their Google account. Each tester opens the join link once
   (`https://play.google.com/apps/internaltest/4701751467577150757`, also on
   `/get-app`; it never changes), accepts, and installs from Play. A Play
   install and the GitHub release's APK are both Play's, signed with the same
   key, so either updates the other.

4. **Web:** Deploy Web, with the Web workflow's build of the same commit, as
   `--ship` prints it:
   `gh workflow run web-deploy.yml -f build_run_id=<the Web run> -f deploy=true`
   (`docs/GITHUB-ACTIONS.md`). It uploads the build's source maps to Sentry
   first and publishes the site only once they are in; the site itself holds
   no map. Releases go this way, not through `firebase deploy --only hosting`
   from this machine: that one's predeploy (`npm run web:export -w
   @sabeel/app`) exports a bundle whose maps reach no one, so its crashes read
   minified, and it does not look for an `EXPO_PUBLIC_USE_EMULATORS` left in
   the shell or in `app/.env*`. Then verify against the LIVE site (not "Deploy
   complete") with `npm run smoke:prod`, which asserts on the deployed page:
   - the sign-in label reads `v<version> · <commit>` for THIS checkout's
     `app.json` and HEAD (`SMOKE_EXPECT_COMMIT=<sha>` when checking a deploy
     made from elsewhere);
   - a provoked Auth request goes to Google and no emulator host is contacted
     — the emulator path is compiled out, so the dev sign-in row cannot render;
   - the bundle's `.map` URL answers 404: no map is served (the single-page
     rewrite leaves `/_expo/` out, so a missing file there is a 404).

   **Then read Sentry for what the release brought** — a crash on the live site
   reached Sentry within minutes once and nobody looked (2026-10-13). Search
   the three app projects (`sabeel-recording-web`, `-android`, `-functions`)
   for issues first seen since the deploy: `firstSeen:-1h is:unresolved`, or
   since the deploy time, in Sentry's Issues view or through the Sentry
   connector. Sentry also emails every new or returning issue in those
   projects (the alert "Every new or returning issue: Sabeel recordings and
   LMS"), but a release is not finished until someone has looked.

5. **iPhone:** a TestFlight build of the release tag, from GitHub:
   `gh workflow run ios.yml --ref vX.Y.Z -f testflight=true`
   (`docs/IOS-BUILD.md`, "Builds on GitHub"). Its TestFlight job refuses a
   commit that is not the one tagged `vX.Y.Z` and a build number Apple has
   already taken. Nothing uploads from a Mac. The Internal group gets it by
   itself (`docs/IOS-BUILD.md`, "TestFlight testers"). The App Store is not
   yet a release home: the app is in TestFlight only.

   **Check it before and after the upload.** Before: the Mac session runs the
   simulator loop on the release commit (`docs/IOS-BUILD.md`): a student signs
   in, plays audio and video through Home and the lock, changes version and
   speed, and keeps a bookmark and the place across a kill. After: install
   the build from TestFlight on an iPhone and confirm the sign-in label reads
   `v<version> · <commit>`. The lock-screen controls and a notification tapped
   with the app closed have no simulator stand-in; they are checked on that
   phone.

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
```

Hosting last, through Deploy Web (step 4 of "Cutting a release"), which
uploads the source maps before it publishes.

Functions deploy from GitHub too, and that is the usual way: **Deploy
Functions** (`functions-deploy.yml`, `docs/GITHUB-ACTIONS.md`) deploys main
after CI has passed on it, refuses a deploy that would delete a live function,
and afterwards checks every callable and the error logs. It needs no local
Google login. The same guards run here:

```bash
export FIREBASE_PROJECT_ID=oursabeel-lms
npx sabeel-ci ci-functions require-ci && npx sabeel-ci ci-functions plan
firebase deploy --only functions --force
npx sabeel-ci ci-functions verify --since <the time the deploy started, ISO>
```

### The sign-in gates are registered with Identity Platform

`beforeSignUp` and `beforeSignIn` (`functions/src/signUpGate.ts`) are
blocking functions: Identity Platform calls them on every sign-up and
sign-in, and they do nothing until registered as the project's triggers. A
functions deploy that includes them registers them; check it afterwards
(read-only):

```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token --account faisal.shah@oursabeel.com)" \
  -H "x-goog-user-project: oursabeel-lms" \
  https://identitytoolkit.googleapis.com/admin/v2/projects/oursabeel-lms/config | jq .blockingFunctions
```

Both `beforeCreate` and `beforeSignIn` must name the deployed functions.
Without `beforeSignIn`, a password sign-in to a staff account (one that has
come to have a password) goes through. A blocking function has 7 seconds,
cold start included, and runs on every sign-in, Google ones too.

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

### Report a problem sends mail: a grant, the Gmail API, the index first

`reportProblem` emails each report from `apps-noreply@oursabeel.com` by
domain-wide delegation, with no password and no key (`functions/src/gmail.ts`):
the function's own credentials ask IAM to sign a `gmail.send` token as
`report-mailer@oursabeel-lms.iam.gserviceaccount.com` (the address is
`MAILER_SERVICE_ACCOUNT` in `functions/.env.oursabeel-lms`), and Gmail sends
it. What it needs in the project:

- **The Gmail API enabled** (it is, since 2026-10-16):
  `gcloud services list --enabled --project oursabeel-lms | grep gmail`.
- **The Functions runtime account may sign as `report-mailer@`**, once:

  ```bash
  gcloud iam service-accounts add-iam-policy-binding \
    report-mailer@oursabeel-lms.iam.gserviceaccount.com \
    --project oursabeel-lms \
    --member serviceAccount:226338267845-compute@developer.gserviceaccount.com \
    --role roles/iam.serviceAccountTokenCreator
  ```

  On the mailer account only, never project-wide. Without it every report
  is kept with `mail.status: 'failed'` and `signJwt refused (HTTP 403)` in
  Sentry, and the person is told the email did not go out.
- **The delegation in the Admin console** (Security → API controls →
  Domain-wide delegation: the mailer account's client id, scope
  `https://www.googleapis.com/auth/gmail.send`), set up on 2026-10-16 for
  each Sabeel project. A missing one fails at the token exchange
  (`unauthorized_client`).
- **The `reports (uid, createdAt)` index**, deployed with
  `firestore:indexes` before the functions (the order above): the hourly
  limit counts with it, and until it is built every report fails.

After the deploy, send one report from the live app as yourself: it arrives
at `apps-reports@oursabeel.com` with Reply-To set to you, and its document in
`reports` says `mail.status: 'sent'`.

**Password links use the same sender, grant and API.** The server makes each
link with the Admin SDK (`generatePasswordResetLink`, continue URL
`https://oursabeel-lms.web.app/`, an authorised domain) and mails it
(`functions/src/passwordLinks.ts`). `onPasswordLinkRequested` is a Firestore
trigger: its first deploy may meet the Eventarc permission trap below. Firebase's
password-reset template is not used any more and needs no setting. After the
deploy, as a test student, tap "Email me a password link" on the live sign-in
screen: the email arrives from Sabeel Apps No Reply, and its link sets the
password and offers Continue to the website.

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
- **Stale config baked into the web bundle.** `web:export` (`sabeel-ci
  build-web`) always passes `--clear`: Metro's transform cache can serve a
  bundle built under different `EXPO_PUBLIC_*` values, and an emulator-mode
  bundle must never ship.

## Hosting

`firebase.json` sets `no-cache` on everything except `/_expo/static/**` and
`/assets/**`, which are content-hashed and therefore immutable, and the security
headers on every page but Firebase's own `/__/` (`npx sabeel-ci check-app`
holds this shape). The single-page rewrite to `/index.html` leaves `/_expo/`
out, so a missing chunk is a 404 rather than the page served as JavaScript. The
`predeploy` hook runs the web export (`npm run web:export -w @sabeel/app`), so
a deploy from this machine always ships a fresh bundle; Deploy Web publishes
the Web workflow's build instead.

`authDomain` in `firebase-config.ts` must be the **hosting** domain
(`<project>.web.app`), not `firebaseapp.com` — hosting serves `/__/auth/*`
itself, keeping the sign-in redirect same-origin. Without it, sign-in from a
chat-app in-app webview dies with `auth/missing-initial-state`, because those
webviews partition storage and the cross-origin handoff loses its state.
**Register the redirect URI on the OAuth client before flipping `authDomain`**,
or sign-in breaks for everyone in between.

## Sentry source maps

Every release build sends Sentry what makes its crashes readable, and refuses
to build without it (`ci-tools` README, "Sentry"). The org and the projects are
in `ci-tools.json` (`sentry`); the token is `SENTRY_AUTH_TOKEN` in the build
machine's gitignored `app/.env.sentry-build-plugin` (`BUILD_ENV` in CI;
`docs/SECRETS.md`).

- **Web:** the Web workflow exports with source maps and keeps them beside the
  site, never in it; every script carries a debug id (`getSentryExpoConfig` in
  `app/metro.config.js`), which is how Sentry matches it to its map with no
  release name to keep in step. Deploy Web uploads the maps to
  `sabeel-recording-web` before it publishes. A `.map` URL on the live site is a
  404, which `npm run smoke:prod` checks.
- **Android:** `app/android/app/build.gradle` applies `sentry.gradle` when
  `app/.env.sentry-build-plugin` exists, and it uploads the bundle's source map
  to `sabeel-recording-android`. R8 shrinks the release build, and Sentry's
  Android Gradle plugin uploads its mapping file under the same gate, so Java
  and Kotlin frames read in full (ci-tools README, "Its Android build").
- **iOS:** Xcode's Sentry phase uploads the dSYMs and the source map to the
  same project (`docs/IOS-BUILD.md`).

## Retiring old builds

Every Android and iPhone build reads `config/app.minVersionCode` before sign-in
and shows an update screen — with the Play internal testing track — when its own
versionCode (its version's code; the iPhone build carries the same number) is
below it. On a Play or TestFlight install that screen opens Google Play; what a
store build should do is decided in `docs/STORE-RELEASE.md`. After a release
that older builds can no longer run against (a rules change refusing a
listener they still open is the case that made this exist), raise the floor by
hand:

```bash
node scripts/set-min-version.mjs <X.Y.Z>   # the oldest version to keep
```

It is a decision, not a deploy step: nothing raises it for you. The floor is
stored as the version's code, the number `build.gradle` computes. Builds made
before the version scheme (0.2.1 and earlier, codes up to 39) are below every
floor it writes. Every build of `com.sabeelinstitute.lms` has the gate.

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

No EAS. Local Gradle builds use the committed `android/` directory. APKs are
versioned GitHub Release assets in `Sabeel-Institute/lms`, never committed
binaries. Testers install and receive updates through Play internal testing.
