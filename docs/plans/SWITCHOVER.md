# Moving to the institute's accounts

This repo is the permanent home of the Sabeel class app. It began as a copy,
with full history, of `faisal-shah/sabeel-recording-app`, which runs on
Faisal's personal Firebase project `sabeel-class-recordings`. Development of
the LMS features (assignments and grades, video, media on Cloudflare) happens
here, against the institute's Firebase project `oursabeel-lms`. When it is
ready, everyone moves over on one planned day and the personal project is
retired.

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
- Sentry: the existing projects for now. `app/.env.local`,
  `app/android/sentry.properties` and `functions/.secret.local` were copied
  from the legacy checkout. Both `google-services.json` files were **not**
  copied: they belong to the legacy project and would connect this repo to it.
- Everyone switches on one day. The legacy project is frozen, copied a last
  time, then retired.

## Phase 0: the project, and the code pointing at it

Nothing in this repo may be deployed until this phase is done.

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

Still to do (steps in `TODO.md`):

1. The release signing key, whose SHA-1 joins the same registration.
2. Nothing for Workers: spike M1 showed the Free plan is enough
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
   switchover), and the APKs are release assets on `Sabeel-Institute/lms`.
   Still open: the release signing key (the legacy build signs release APKs
   with the debug keystore; the new app gets its own, kept out of git like
   every other secret).
3. **Notifications go to staff only until switchover.** Done:
   `NOTIFY_AUDIENCE=staff` in `functions/.env.oursabeel-lms`; empty or absent
   means nobody.
4. Docs: `CLAUDE.md`, `docs/DEPLOY.md`, `docs/SECRETS.md`, `TODO.md` and
   `docs/DEV-TOOLING.md` rewritten for the new accounts, with the R2 move's
   docs (M6), so they are rewritten once.
5. The media move to R2 and the Worker, per
   [MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md), before any deploy.
   `storage.rules` and the `storage` block in `firebase.json` are deleted;
   there is no `roles/iam.serviceAccountTokenCreator` grant to make, since
   URLs are signed with R2 keys.
6. First deploy of rules, indexes, functions and hosting to `oursabeel-lms`,
   then `npm run smoke:prod` against the new address.

## Seeding from the legacy project

A re-runnable script, run by Faisal (it touches both projects' credentials),
copies a snapshot so that teachers and students can sign in with what they
already use:

| What | How | Notes |
|---|---|---|
| Accounts | `firebase auth:export` from legacy, `firebase auth:import` into `oursabeel-lms` with the legacy project's scrypt hash parameters | Same uids, same passwords, same Google links, same custom claims (`role`, `status`). The hash parameters come from the legacy console and are treated as a secret. |
| Firestore | `gcloud firestore export` to a bucket, grant the new project's Firestore service agent read on it, `gcloud firestore import` | Same document ids, so every reference by uid or id stays intact. |
| Media | Copy each object from the legacy bucket into R2 at the same key | See [MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md); a few hundred MB today. |
| Push registrations | **Deleted** after import | FCM tokens belong to the legacy project's sender and cannot deliver from the new one. Devices re-register on first sign-in. |
| Zoom import markers | Kept | So a recording imported in legacy is not offered again. |

Re-seeding during development wipes the new project first. Anything entered
in `oursabeel-lms` before switchover is test data and is lost on the next
seed; staff trying features early are told so.

After every seed, a count check compares document counts per collection and
user counts between the two projects and fails loudly on any difference.

## Switchover day

1. Announce the date and the new app to staff and students a week ahead.
2. **Freeze legacy:** deploy a legacy release whose server refuses writes
   with a plain message, and whose app shows that the institute has moved.
3. Final seed, count check, smoke test on the new address. Set
   `NOTIFY_AUDIENCE=everyone` in `functions/.env.oursabeel-lms` and deploy
   functions, so the new app notifies everyone from here on. List
   `sabeel-institute-lms/` on Faisal's site index, make its buttons live, and
   point the legacy `sabeel-recording-app/` page at it.
4. **Retire the legacy Android app** with a final update whose only screen
   says the app has moved and links to the new one. This is allowed by the
   store rule in `CLAUDE.md`: it points to an app, not to a sign-up flow.
5. Redirect the legacy web address to the new one (Hosting redirect in the
   legacy project).
6. Scheduled functions in legacy are deleted so nothing more is sent from it.
7. Keep the legacy project read-only for a set period (suggested 90 days),
   then export it to cold storage and shut it down.

**Rollback** before step 4: unfreeze legacy; nothing in it was changed. After
step 4 the new project is the record.

## Open questions


- A custom domain later (for example `app.oursabeel.com`); it would also
  become the auth domain, and the OAuth redirect URIs change with it.
- When to move Sentry to institute-owned projects.
