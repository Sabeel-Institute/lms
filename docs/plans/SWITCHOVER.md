# Moving to the institute's accounts

This repo is the permanent home of the Sabeel class app. It began as a copy,
with full history, of `faisal-shah/sabeel-recording-app`, which runs on
Faisal's personal Firebase project `sabeel-class-recordings`. Development of
the LMS features (assignments and grades, video, media on Cloudflare) happens
here, against the institute's Firebase project `oursabeel-lms`. When it is
ready, everyone moves over on one planned day and the personal project is
retired. That day was 2026-11-26 (Switchover, below): this project has held
the institute's records since.

Related plans:
[MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md) ·
[VIDEO-AND-MULTIPLE-MEDIA.md](VIDEO-AND-MULTIPLE-MEDIA.md) ·
the assignments proposal, [../proposals/lms-assignments-proposal.html](../proposals/lms-assignments-proposal.html).

## Two sets of accounts

| | Legacy (live until switchover) | Permanent (this repo) |
|---|---|---|
| GitHub | `faisal-shah/sabeel-recording-app` | `Sabeel-Institute/lms` |
| Local checkout | `~/repos/faisal-shah/sabeel-recording-app` | `~/repos/Sabeel-Institute/lms` |
| Google account | faisal.shah@gmail.com | faisal.shah@oursabeel.com |
| Firebase / GCP project | `sabeel-class-recordings` | `oursabeel-lms` (number 226338267845) |
| Web address | `sabeel-class-recordings.web.app` | `oursabeel-lms.web.app` (no custom domain for now) |
| App name | Class Recordings | Sabeel Institute LMS; Android home-screen label "Sabeel LMS" (launchers cut names at about 12 characters) |
| Android package | `com.sabeelinstitute.classrecordings` | `com.sabeelinstitute.lms` |
| Media storage | Firebase Cloud Storage | Cloudflare R2 (no Firebase Storage bucket at all) |
| Billing | personal | `My Billing Account` (`014B85-39659A-255E25`), shared with `oursabeel-website` |
| Sentry | personal org, existing projects | same projects for now |

In this checkout, `git remote legacy` points at the old repo for fetching any
late fix made there. Pushing to it is disabled on purpose.

**Never cross the two.** A command run here must never reach
`sabeel-class-recordings`, and the legacy checkout must never reach
`oursabeel-lms`. The Firebase CLI pins an account per directory
(`~/.config/configstore/firebase-tools.json`, `activeAccounts`): this
directory uses the oursabeel.com account, which has no access to the legacy
project, and the legacy checkout uses the gmail account, which has no access
to this one. That separation is the backstop; `.firebaserc` and the code are
the first line.

## Decisions already made (2026-10-12)

- Repo `Sabeel-Institute/lms`, public, full history.
- Firebase project `oursabeel-lms` under oursabeel.com. No "preview",
  "staging" or "v2" in any permanent name.
- A **new** Android package ID, `com.sabeelinstitute.lms`. The new app
  installs beside the old one; the old one is retired with a final update
  that points to the new one (below).
- **No Firebase Storage bucket.** Media goes to R2 from the first deploy, so
  the R2 move ([MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md)) is part of
  Phase 0 rather than a later migration. Nothing else needs a default bucket:
  Functions deploys use their own `gcf-*` buckets, and the seeding export uses
  a bucket in the legacy project.
- Sentry: the existing projects for now (`sentry` in `ci-tools.json`).
  `app/.env.local` and the Sentry token were copied from the legacy checkout.
  Both `google-services.json` files were **not** copied: they belong to the
  legacy project and would connect this repo to it.
- Everyone switches on one day. The legacy project is frozen, copied a last
  time, then retired.

## Phase 0: the project, and the code pointing at it

Done on 2026-10-12, with the first deploy (Agent, item 6).

### Faisal (consoles and credentials)

Done on 2026-10-12: both oursabeel.com logins renewed; GCP project
`oursabeel-lms` (number 226338267845) created under the oursabeel.com
organization with Firebase added; billing linked; Firestore Native in
**`nam5`**, matching the legacy database; web app "Sabeel LMS web"
(`1:226338267845:web:2e285dbdf341e54bcac6ac`) registered; Email/Password and
Google sign-in enabled (authorized domains `localhost`,
`oursabeel-lms.firebaseapp.com`, `oursabeel-lms.web.app`); `ZOOM_ACCOUNT_ID`,
`ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and `SENTRY_DSN` copied into the new
Secret Manager from the legacy one, at Faisal's direction, by piping
`gcloud secrets versions access` into `gcloud secrets create` so no value was
displayed or written to disk (checked by comparing SHA-256 prefixes).
A $10/month Google Cloud budget, "oursabeel-lms monthly", alerts the billing
admins at 50%, 90% and 100% of actual spend and at 100% of forecast; it does
not stop anything.

Cloudflare, done the same day: account "Faisal.shah@oursabeel.com's Account"
(id `2695af9675357bbe44e188b0414b850f`), signed up with Google, card on file,
R2 enabled. `wrangler` is logged in here as faisal.shah@oursabeel.com. Bucket
`oursabeel-lms-media` created: location ENAM, Standard class, `r2.dev` access
disabled, no custom domain. Its CORS and lifecycle rules are applied from the
repo during the media work.

Also done: the two bucket-scoped R2 API tokens from
[MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md) (`R2_READ_*` Object Read,
`R2_WRITE_*` Object Read & Write), pasted by Faisal straight into Secret
Manager; and a Cloudflare budget alert at $10/month, which, like Google's,
alerts and never stops anything.

Also done: the Web Push key pair (public key in `firebase-config.ts`); the
Android app `com.sabeelinstitute.lms` registered by the agent from the CLI
(app id `1:226338267845:android:a85d5935fb8f4555cac6ac`) with the debug key's
SHA-1, its `google-services.json` in place (gitignored).

Also done: the release signing key (2026-10-12), its SHA-1 on the same
registration (`docs/SECRETS.md`). Workers need nothing: spike M1 showed the
Free plan is enough
([MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md#the-worker-cloudflaremedia-copier)).

### Agent (code)

1. **One source for the project's identity.** Done: `FIREBASE_PROJECT_ID`,
   `APP_NAME` and `APP_SHORT_NAME` in `packages/shared`; the web config, the
   Google web client id and the admin scripts derive from them, and
   `projectIdentity.test.ts` fails if the legacy project id, its project
   number or the old Android package appears in any code or config. The
   one-off migrations already run on the legacy data were deleted rather
   than retargeted: the seed copies data they have already fixed.
2. **New Android identity.** Done: package `com.sabeelinstitute.lms` in
   `app.json`, Gradle and the Kotlin sources, launcher label "Sabeel LMS",
   link scheme `sabeellms`. The download page is
   `faisal-shah.github.io/sabeel-institute-lms/` (pre-release until
   switchover), and the APKs are release assets on `Sabeel-Institute/lms`,
   signed with the app's own release key, kept out of git
   (`docs/SECRETS.md`).
3. **Notifications go to staff only until switchover.** Done:
   `NOTIFY_AUDIENCE=staff` in `functions/.env.oursabeel-lms`; empty or absent
   means nobody, which is its value while the live site is bug-hunted.
4. Docs: `CLAUDE.md`, `docs/DEPLOY.md`, `docs/SECRETS.md`, `TODO.md` and
   `docs/DEV-TOOLING.md` rewritten for the new accounts, with the R2 move's
   docs (M6), so they are rewritten once.
5. The media move to R2 and the Worker, per
   [MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md), before any deploy.
   `storage.rules` and the `storage` block in `firebase.json` are deleted;
   there is no `roles/iam.serviceAccountTokenCreator` grant to make, since
   URLs are signed with R2 keys.
6. First deploy of rules, indexes, functions and hosting to `oursabeel-lms`,
   then `npm run smoke:prod` against the new address. Done 2026-10-12, after
   the first copy of the legacy data: the copier Worker, then indexes, rules,
   33 functions and hosting. `smoke:prod` passed (13 checks), and a temporary
   admin then played a copied recording through an R2 URL and imported a
   53.7 MB Zoom file through the Worker (5.7 s), all removed afterwards. The
   organization-project traps it hit are in `docs/DEPLOY.md`.

## Seeding from the legacy project

`scripts/seed-from-legacy.mjs` copies chosen cohorts of the live app, so
teachers and students sign in here with what they already use. The copy that
made this project the institute's record ran on 2026-11-26 (below). Earlier
runs copied the whole live app as test data, the first on 2026-10-12 before
the first deploy.

```bash
node scripts/seed-from-legacy.mjs --from sabeel-class-recordings --from-account faisal.shah@gmail.com --plan <file>         # dry run
node scripts/seed-from-legacy.mjs --from sabeel-class-recordings --from-account faisal.shah@gmail.com --plan <file> --yes   # wipe here, copy
```

The legacy project is named only on the command line, and the script only
reads it (GETs and lists, with the gmail account's token; no export bucket, no
IAM change there).

**The plan file** (`scripts/lib/legacy-selection.mjs` documents its keys)
names the cohorts to copy, the students left out, a duplicate account folded
into the one its owner uses, sessions and recordings not carried, and the
cohorts and accounts of this project that survive the wipe. It holds account
ids, so it is kept out of this public repo. What comes, by one rule: every
staff account; every student with an enrolment, present or past, in a copied
class; and every document that names nothing left behind. A student left out
also has their mark taken out of each register, and a session whose
recording is dropped arrives with its register and no recording. The dry run
prints every person, class, session count, recording and register change it
would make, and what of this project it keeps and removes.

| What | How | Notes |
|---|---|---|
| Accounts | Identity Toolkit `accounts:batchGet` from legacy, `accounts:batchCreate` here with legacy's scrypt parameters (read from its Auth config into the process, never printed) | Same uids, same passwords, same Google links, same custom claims (`role`, `status`). A student who never set a password in the live app has none here either, and asks for a link from the sign-in screen. |
| Firestore | Every chosen document, recursively, through the REST API, field values passed through unchanged, except recordings, enrolments, classes and two audit actions | Same document ids, so every reference by uid or id stays intact. A folded duplicate's records are re-keyed to the account it folds into; its own student record and its creation entry stay behind. |
| Recordings | Converted on the way: the one audio file becomes the recording's single media item (Part 1, audio only) at the key it already has (`scripts/lib/legacy-media.mjs`) | The live app stores one file per recording; this project stores media items. |
| Enrolments and classes | Converted on the way: an enrolment's first joining and last leaving dates become every stretch the student spent in the class, and a class gains every stretch its recordings were closed to students, both rebuilt from the live app's audit log (`scripts/lib/stretches.mjs`) | A second removal erases the first in the live app's two dates, and an archive is known only while it lasts; the ledgers and workbooks here need each one. The dry run names any record whose log and stored fields disagree. |
| Audit entries | Renamed on the way where the live app's action name is retired: `clearRecordingAudio` becomes `removeRecordingMedia`, `importZoomRecording` becomes `importZoomFiles` (`scripts/lib/legacy-audit.mjs`). An entry with no target and no class is not copied: nothing shows it concerns the copied cohorts | The audit screen has words only for the actions written today, and `check:documents` fails on any other. |
| Media | The copied recordings' files under `recordings/` in the legacy bucket, streamed into R2 at the same key | Through this machine: pennies of Google egress at this size. |
| Push registrations | **Not copied** (`notifications/{uid}/devices`) | FCM tokens belong to the legacy project's sender and cannot deliver from here. Devices register again on first sign-in. |
| Zoom import markers | Each copied Zoom recording's file gets its `zoomImports/{fileId}` claim | So a recording imported in legacy is not offered again. |

Every run wipes this project first, but for what the plan keeps:
`config/app`, the kept cohorts with everything that names them, the kept
accounts with their own records (not their work in classes that go), the
media of kept recordings and assignments, and the help films (`help/` is
never touched). The source's password hashing is read before the wipe, so a
failure there leaves this project as it was.

The wipe's deletes and the copy's writes fire the triggers here
(`onRecordingWritten`, `onSessionWritten`, `onAssignmentWritten`). On copied
data they change nothing, but one from the WIPE that runs after the copy reads
a recording as gone and switches its grants off, and a past session's grant is
never revived. So after copying the seed waits for that burst to pass,
compares every copied and kept document field by field with what it should
hold, writes back any a trigger changed, and repeats until a pass finds none
(it fails after three). Then it counts documents per collection shape,
accounts, custom claims, and media objects and sizes, and fails on any
difference.

**Then it records the day** in `config/app.realDataSince`. From then on the
seed and both demo seeds refuse to run (`scripts/lib/before-switchover.mjs`,
which reads the marker from the project, so another checkout is refused too).
A copy that went wrong before anyone used it is replaced with `--replacing
<that day>`; nothing else passes.

## Switchover

Done on 2026-11-26. The live app's classes had finished, so the copy ran
without a freeze.

1. **Copied** with the plan: the cohorts "Hikam Year 3" and "Quran Immersion
   2026 Istiqlal" with their five classes, 42 sessions and 12 recordings
   (753.6 MB), every staff account and 27 students: 1,015 documents and 42
   accounts, counted on both sides. Left behind: the cohorts "C1" and "TEST COHORT" (its Board
   meetings class included), staff members' personal student accounts with
   no real attendance, test accounts, a duplicate account (folded into the
   one its owner signs in with), a test session in Tajweed QI 2026 and a
   failed Zoom import in Arabic QI 2026. Kept here: the App Review cohort and
   its reviewer (`docs/STORE-RELEASE.md`), the five test-alpha accounts, with
   no classes.
2. Then `node scripts/backfill-zoom-segments.mjs --yes` (the seed copies Zoom
   files without the segment start an import keys parts by, so the same
   class's video would otherwise land as a second part: 8 filled, 4 no
   longer listed by Zoom), `node scripts/migrate-listening-sittings.mjs
   --yes` (the live app's listening rows hold one total, not sittings: 10
   migrated), `npm run check:documents` (every document reads), `npm run
   smoke:prod` (passed), and the minimum version raised to 1.1.1. Every
   copied recording's file was fetched from R2 through a signed read link,
   and every copied account's password hash, Google link and claims compared
   equal with the live app's.
3. **The legacy project's reminders are paused** (the Cloud Scheduler job
   `firebase-schedule-onMorning-us-central1`, paused rather than deleted).
   Nothing else in it changed: the legacy Android app gets no final update
   and the legacy web address no redirect (Faisal's decision).
4. **Notifications here reach nobody** (`NOTIFY_AUDIENCE=` empty) until
   Faisal says to send them to everyone.
5. Keep the legacy project read-only for a set period (suggested 90 days),
   then export it to cold storage and shut it down.

## Open questions


- A custom domain later (for example `app.oursabeel.com`); it would also
  become the auth domain, and the OAuth redirect URIs change with it.
- When to move Sentry to institute-owned projects.
