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
| Firebase / GCP project | `sabeel-class-recordings` | `oursabeel-lms` |
| Web address | `sabeel-class-recordings.web.app` | `oursabeel-lms.web.app` (custom domain to decide) |
| Android package | `com.sabeelinstitute.classrecordings` | new ID, proposed `com.sabeelinstitute.lms` (confirm before the first Android build: it is permanent once published) |
| Media storage | Firebase Cloud Storage | Cloudflare R2 |
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
- A **new** Android package ID. The new app installs beside the old one; the
  old one is retired with a final update that points to the new one (below).
- Sentry: the existing projects for now. `app/.env.local`,
  `app/android/sentry.properties` and `functions/.secret.local` were copied
  from the legacy checkout. Both `google-services.json` files were **not**
  copied: they belong to the legacy project and would connect this repo to it.
- Everyone switches on one day. The legacy project is frozen, copied a last
  time, then retired.

## Phase 0: the project, and the code pointing at it

Nothing in this repo may be deployed until this phase is done. Until then the
code still names the legacy project in about twenty places.

### Faisal (consoles and credentials)

1. `gcloud auth login faisal.shah@oursabeel.com` and
   `npx firebase login --reauth` (both oursabeel.com logins had expired on
   2026-10-12).
2. Create the GCP project `oursabeel-lms` under the oursabeel.com
   organization, add Firebase, and link a billing account (Blaze: Functions
   need it).
3. Firestore: Native mode, location **`nam5`**, matching the legacy database.
   The location is permanent.
4. Authentication: enable Email/Password and Google. Add the hosting domain
   and any custom domain to the authorized domains. Configure the OAuth
   consent screen for internal (oursabeel.com) plus the student population.
5. Grant the Functions runtime service account
   `roles/iam.serviceAccountTokenCreator` on itself (the first-deploy blocker
   from `docs/SECRETS.md`; still needed while any signing uses Google).
6. Secrets in Secret Manager, set by Faisal: `ZOOM_ACCOUNT_ID`,
   `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `SENTRY_DSN`, then the R2 and
   Worker secrets in [MEDIA-ON-CLOUDFLARE.md](MEDIA-ON-CLOUDFLARE.md).
   The agent prints the exact `firebase functions:secrets:set` commands and
   never handles a value.
7. Register the web app; later the Android app with the new package ID and
   the signing key's SHA-1.
8. Cloudflare account for the institute (card on file, R2 enabled), and a
   `wrangler login`.

### Agent (code)

1. **One source for the project's identity.** Replace every literal
   `sabeel-class-recordings` with values derived from one place
   (`packages/shared` constants plus the generated web config), and add a
   test that fails if the legacy id appears anywhere outside `docs/` and the
   one-off migration scripts. Files that name it today include
   `.firebaserc`, `app/src/firebase-config.ts`, `app/app.json`,
   `app/public/firebase-messaging-sw.js`, `packages/shared/src/constants.ts`,
   `package.json` and the admin scripts under `scripts/`.
2. **New Android identity:** `applicationId`, `app.json` package, the
   Google web client id, the release signing key (the legacy build signs
   release APKs with the debug keystore; the new app should get its own
   release key, kept out of git like every other secret).
3. **Notifications go to testers only until switchover.** A server-side
   allowlist of uids. Without it, a real student who signs in to the new web
   app during development would get every reminder twice.
4. Docs: `CLAUDE.md`, `docs/DEPLOY.md`, `docs/SECRETS.md`, `TODO.md` and
   `docs/DEV-TOOLING.md` rewritten for the new accounts in the same batch.
5. First deploy of rules, indexes, functions and hosting to `oursabeel-lms`,
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
3. Final seed, count check, smoke test on the new address.
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

- Custom domain for the app (for example `app.oursabeel.com`), which would
  also become the auth domain.
- The app's display name now that it is more than recordings.
- The confirmed Android package ID.
- When to move Sentry to institute-owned projects.
