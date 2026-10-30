# Faisal's TODO

Everything that needs a human with console access, a credit card, or a phone.
The agent cannot do any of these. Keep this current — it is the list Faisal
works from.

Phases 0 and 1 needed nothing from this list — `devSignIn` mints a
Google-provider identity in the Auth emulator, and the emulator handles password
resets. **Phase 3 is the first that genuinely blocks**, because signed URLs
cannot be minted against the emulator at all.

---

## The store consoles (open)

The forms no API reaches, for the LMS's first App Store and Play submission.
Every answer is in `docs/STORE-RELEASE.md`; the table each step names holds
it. The agent does everything else ("The way to submission" there).

**Play Console, Sabeel Institute LMS** (answers: "App content (console)"
and "Store settings and listing"):

- [ ] Policy → **App content** → Privacy policy: the URL → Save.
- [ ] App content → **App access** → "All or some functionality is
      restricted" → Add new instructions: name "Student account", the
      username, the password from
      `~/.config/secrets-vault/sabeel/review/lms-app-review.txt` (the
      `password=` line), the instructions text → Save.
- [ ] App content → **Ads** → No → Save.
- [ ] App content → **Content rating** → Start questionnaire: the email,
      the category, the answers → Save → Submit.
- [ ] App content → **Target audience and content** → 18 and over only →
      tick **Restrict minor access** → the listing does not appeal to
      children → Save.
- [ ] App content → **News apps** → No; **Government apps** → No;
      **Financial features** → none; **Health apps** → none;
      **Advertising ID** → No.
- [ ] App content → **Data safety**: the Data safety table, then the
      answers above it (encrypted in transit Yes, deletion on request Yes,
      the app does not let users create an account) → Save → Submit.
- [ ] Grow users → Store presence → **Store settings**: category Education;
      tags; **External marketing** off → Save.
- [ ] Settings → **Catalog settings** → opt out of distribution to
      third-party US stores.
- [ ] Upload the background playback video (the agent sent it,
      `play-background-playback.mp4`) unlisted to YouTube, or to Drive with
      "anyone with the link"; then App content → **Foreground service
      permissions** → Media playback, the description, the impact and that
      link.
- [ ] **Later**, at the production release: Test and release → Production →
      **Countries/regions** → United States only.

**App Store Connect:**

- [ ] **Later**, after the agent submits the version: the unlisted request
      at `https://developer.apple.com/contact/request/unlisted-app/`
      ("The unlisted request" in `docs/STORE-RELEASE.md`).

## The iPhone app (open)

- [ ] **Back up `~/.config/secrets-vault/`** into your password manager
      or other secure storage: every secret file of your projects, Sabeel
      and personal, from this machine. Its README marks the irreplaceable ones (the
      LMS and time-tracker release keys, both Apple keys). Run
      `bash ~/.config/secrets-vault/vault.sh verify` first; store it again
      whenever a secret changes.
- [ ] **TestFlight testers.** 19 staff were invited to App Store Connect;
      each is added to the Internal group once they accept
      (`docs/IOS-BUILD.md`, "TestFlight testers").
- [ ] **On your iPhone, from TestFlight:** install the current build, then
      check what the simulator cannot show: the lock-screen media controls,
      and a notification tapped with the app closed.

## oursabeel-lms (open)

The institute's project; its setup is Phase 0 of
[docs/plans/SWITCHOVER.md](docs/plans/SWITCHOVER.md), done 2026-10-12. The
sections marked DONE below record the setup of the legacy project,
`sabeel-class-recordings`.

- [ ] **Back up the release signing key.** Created 2026-10-12 in
      `~/.config/sabeel-lms/` on this machine; its SHA-1 is registered.
      Copy the password from `keystore.properties` into your password
      manager, and keep a copy of `release.keystore` there too (as an
      attachment) or on other storage. It is also Play's app signing and
      upload key; losing it ends updates. `docs/SECRETS.md` has the details
      and the list of everything else on this machine worth backing up.
- [ ] **Google sign-in consent screen**: Google Cloud console →
      `oursabeel-lms` → APIs & Services → OAuth consent screen. Check the app
      name reads "Sabeel Institute LMS" and the support email is an
      institute address.
- [ ] **Google sign-in on the new website: sign in once to confirm.**
      Google already accepts the site's sign-in address
      (`https://oursabeel-lms.web.app/__/auth/handler`): on 2026-10-13 the
      live site's "Sign in with Google" reached Google's account page, where
      an unregistered address stops with `redirect_uri_mismatch`. Sign in at
      <https://oursabeel-lms.web.app> with your oursabeel.com account and
      land on the staff home. If Google shows an error instead: Google Cloud
      console → `oursabeel-lms` → APIs & Services → Credentials → "Web client
      (auto created by Google Service)", with `https://oursabeel-lms.web.app`
      under Authorized JavaScript origins and the address above under
      Authorized redirect URIs.
- [ ] **DNS**: `firebase1._domainkey` CNAME is shown in NameSilo but was not
      published after two hours, while the other three records were. Delete
      and re-add it there.
- Notifications go to nobody while the live site is bug-hunted
  (`NOTIFY_AUDIENCE=` empty in `functions/.env.oursabeel-lms`), then to staff
  only (`staff`) until switchover day. Done: the Web Push key and the Android
  app registration (debug and release SHA-1s, `google-services.json` in
  place).
- `npm run check:queries` and `npm run check:push` take the oursabeel.com
  account's token through `CHECK_ACCESS_TOKEN` (`docs/DEPLOY.md`), because this
  machine's Application Default Credentials are the gmail account, which
  another repo relies on. Nothing for you to do.

---

## ✅ Phase 3 setup — DONE (2026-07-22)

Kept for the record, because the ordering trap in step 3 is easy to hit again.
Signing was proven against the real project on 2026-07-22: a V4 URL streamed the
file and a short-TTL one was refused with `ExpiredToken`.

### 1. Create the Firebase project  ✅ done

1. <https://console.firebase.google.com> → **Add project**.
2. Project id: **`sabeel-class-recordings`** (or tell me what you chose and I
   will update `.firebaserc`). Disable Google Analytics — nothing uses it.
3. **Upgrade to the Blaze plan.** Cloud Functions require it. Expected spend is
   $0/month at this scale — see `docs/research/firebase-recording-costs.md` —
   but set a **budget alert at $5** anyway (Google Cloud console → Billing →
   Budgets & alerts) so a mistake surfaces as an email, not a bill.
4. Project settings → **Your apps** → add a **Web app**. Copy the config object
   and paste it over the placeholders in `app/src/firebase-config.ts`. It is not
   a secret — it ships in every client bundle.

### 2. Create the Storage bucket — region matters  ✅ done

Build → **Storage** → Get started → **location `us-central1`** (or `us-west1` /
`us-east1`; **only those three** carry the no-cost quotas). Take the modern
`*.firebasestorage.app` bucket, not a legacy `*.appspot.com` one — the legacy
rows cap downloads at 1 GB/day instead of 100 GB/month.

**This choice is permanent.** A bucket's location cannot be changed afterwards.

### 3. Enable the APIs FIRST — this creates the account you grant to  ✅ done

The service account that runs gen-2 functions,
`977423479850-compute@developer.gserviceaccount.com`, **does not exist on a
fresh Firebase project.** It is created when the Compute Engine API is enabled.
Granting before that fails with `NOT_FOUND: Unknown service account`, which
reads like an authentication problem and is not one. (Learned the hard way,
2026-07-22 — an earlier version of this file had these two steps the wrong way
round.)

```bash
gcloud services enable \
  compute.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  eventarc.googleapis.com \
  iamcredentials.googleapis.com \
  --project=sabeel-class-recordings
```

Takes a minute or two. Confirm the account now exists before moving on:

```bash
gcloud iam service-accounts list --project=sabeel-class-recordings
```

### 4. Grant the signing permission  ✅ done

To sign a URL without a downloaded key file, the runtime service account has to
be allowed to **impersonate itself** through the IAM Credentials API
(`signBlob`). Gen-2 functions run as the **Compute Engine default** account, not
the App Engine `…@appspot.gserviceaccount.com` one most older tutorials name.

```bash
gcloud iam service-accounts add-iam-policy-binding \
  977423479850-compute@developer.gserviceaccount.com \
  --member="serviceAccount:977423479850-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=sabeel-class-recordings

# Confirm it took:
gcloud iam service-accounts get-iam-policy \
  977423479850-compute@developer.gserviceaccount.com \
  --project=sabeel-class-recordings
```

**This is the failure that looks like working code.** Without it, signing throws
only in production; every local test passes. It is why the plan front-loads a
real deploy instead of trusting the emulator.

### 5. Wire it up  ✅ done

`firebase-config.ts` and `.firebaserc` point at the project.

---

## ✅ Auth setup — DONE (2026-07-22)

The ordering trap is kept for the record, because it is the thing that made this
confusing: the Google Cloud OAuth page showed only "Get started" because
**Firebase Authentication had never been initialized**, and enabling Google
sign-in *in Firebase* is what creates the OAuth client and the consent-screen
entry. Nothing on the GCP side was configurable before that, and
`disabledUserSignup` did not exist yet either, because it is a field of the same
config that did not exist.

Verified against the live Identity Toolkit config after Faisal's console work:

| Setting | Value |
|---|---|
| `client.permissions.disabledUserSignup` | **must be `false`** — see below |
| Email/Password | enabled |
| Email link (passwordless) | disabled |
| Anonymous | disabled |
| `authorizedDomains` | `localhost`, `…firebaseapp.com`, `…web.app` |
| OAuth consent screen | External, **published** (not Testing) |

Redirect URIs and JavaScript origins registered for **both** `…web.app` and
`…firebaseapp.com`, so `authDomain` can be switched either way without further
console work. It now points at **`sabeel-class-recordings.web.app`**: Hosting
serves `/__/auth/*` itself, which keeps the sign-in redirect same-origin —
otherwise staff opening a link inside WhatsApp or Slack hit
`auth/missing-initial-state`, because those in-app webviews partition storage.

`WEB_CLIENT_ID` in `firebase-config.ts` is filled in from the created OAuth
client. It is not a secret; it ships in every client bundle.

### "Disable client-side sign-up" was WRONG advice — undo it

This file used to call that setting load-bearing. It is not usable at all, and
finding out cost a failed sign-in.

**`disabledUserSignup` blocks ALL client-side account creation — including a
staff member's first Google sign-in**, because creating their account *is* a
sign-up. It fails with `auth/admin-restricted-operation` before `onUserCreate`
ever runs; verified 2026-07-22, no user was created and the trigger logged
nothing. Staff self-onboarding and disabled sign-up are mutually exclusive, and
this app requires staff self-onboarding.

The protection it was meant to provide now lives in `provision.ts`, where it can
tell the two populations apart:

- A real student is created by `createStudent` **without a password**, so it has
  **no provider at all** when the trigger fires → left alone.
- Therefore anything that already has a `password` provider at creation came
  from the client SDK → **deleted**.

Proven both ways in `npm run test:e2e`: a self-signup's credential stops working
(`EMAIL_NOT_FOUND`), and reverting the rule makes that check fail.

---

## Still to do

### ✅ Phase 4 production walkthrough — DONE by the agent (2026-07-22)

Verified against the real project with temporary accounts (deleted after):
publish drove the **deployed `onRecordingWritten` trigger** to fan out an
assignment, a student marked complete (client write accepted, `completed=true`),
and a non-enrolled student's forge attempt was refused 403 — the self-only rule
holding in production. Nothing left for you here.

### ✅ 0–1 done (2026-07-22)

Sign-up re-enabled, you signed in, `onUserCreate` provisioned you as
`manager/pending`, `bootstrapAdmin` promoted you to `admin/active` and was then
**deleted** (URL 404s, and it can no longer be redeployed by accident — it is
exported only against the demo project).

You are the admin on <https://sabeel-class-recordings.web.app>.

### ✅ Sentry — DONE (2026-07-22)

Wired and live on all three surfaces. Web + native use the client DSNs in
gitignored `app/.env.local`; the **functions DSN was set as a Secret Manager
secret** (`SENTRY_DSN`) and the functions redeployed, so server reporting is now
active (secret bound to all 19 functions, verified by name). Reporting is off in
dev/debug bundles by design — events come only from deployed surfaces.

Source maps reach Sentry from every release: the Android build's
`sentry.gradle` and Xcode's Sentry phase upload them with the token in the
build machine's `app/.env.sentry-build-plugin` (`BUILD_ENV` in CI), and Deploy
Web uploads the web build's before it publishes.

### ✅ 2. Notifications — DONE except one browser check (2026-08-15)

Cloud Messaging was already on, you generated the Web Push key pair, and the
public key is in `app/src/firebase-config.ts`.

**Android delivery is verified end to end**: the app registered an FCM token,
the Admin SDK sent to it against the live project, and the notification appeared
in the shade with the real copy. `npm run check:push` re-checks the send path
any time (valid VAPID key + FCM authenticating us as this project).

Still yours, once the web build is deployed:

- [ ] **Open the deployed site in a normal browser** and sign in. A browser that
      has never been asked now shows **Enable notifications** — on the home
      screen and on the **Notifications** screen. That is the expected state, not
      a fault: the app no longer asks on arrival, because a browser only honours
      a permission request raised straight from a click.

      Press it, allow it, and confirm the Notifications screen then reports the
      device as enabled. Seeing "this device can't show notifications" AFTER
      allowing is the real failure — it means permission was granted but no token
      could be obtained.

      Web push cannot be driven from here — Playwright's Chromium has no FCM
      credentials and branded Chrome under it refuses — so this is the one path
      with no automated check behind it.

### ✅ 3. The password email — NOT NEEDED (2026-10-16)

The set-password and reset emails no longer come from Firebase's template:
the server sends them from `apps-noreply@oursabeel.com` with the institute's
own wording (`functions/src/passwordLinks.ts`). The template is unused.

### ✅ 4. Android app registered — DONE (2026-07-23)

Faisal registered the Android app (`com.sabeelinstitute.classrecordings`) with the
debug SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` and
downloaded `google-services.json`. It is wired in: the Google Services Gradle
plugin is applied, and the file lives at `app/android/app/google-services.json`
(and `app/google-services.json`), **gitignored** — regenerate it from the console
on a fresh clone or the Android build fails. A signed release APK was built,
verified against production (student sign-in + streaming) and shipped as a GitHub
Release. Staff Google sign-in on-device should now work; students already did.

For `com.sabeelinstitute.lms`, the release key and its SHA-1: done 2026-10-12
(`docs/SECRETS.md`).

### 5. Not blocking anything

- ✅ **Institute timezone** — set to `America/Chicago` (Houston) in Phase 4.
- **App Check**: Play Integrity (Android) + reCAPTCHA Enterprise (web), plus
  **debug tokens** for the `tb_emu` AVD and local web — without those it locks
  out our own dev builds. Wired but not enforced until then.
- **A known residual on shared devices, for you to be aware of rather than
  act on.** A push token carries no proof of who holds the device, and no rule
  can invent one — any signed-in account may register any token string under
  its own id. `onDeviceRegistered` makes a token belong to the most recent
  registration, which is what stops one student's notifications arriving on the
  next student's phone after a sign-out that failed to unregister. The cost is
  that somebody who has personally used a shared device, and so has seen its
  token on their own record, could re-register it later and quietly stop
  delivery to whoever holds it now. It needs deliberate effort, it only reaches
  devices they have used, and nothing is disclosed — but if a classroom tablet
  ever stops receiving notifications for no apparent reason, this is the thing
  to remember. App Check (above) raises the bar; only a token bound to the
  device by the platform would close it.

### Confirm one behaviour: what re-enrolling restores

Nothing is broken here — the app, the manual and the ledger now all say the same
thing, which they did not before. Worth one look because it is a policy choice
rather than a bug.

Unenrolling a student turns their obligations in that class off, and now STAYS
off: a later edit to any session in the course used to switch them back on days
afterwards, which is fixed. Re-enrolling them restores those obligations the
next time anything touches that session — which is exactly what the manual and
the recording ledger promise on screen ("re-enrolling them or republishing
restores it"). An internal comment used to claim the opposite; it has been
corrected to match.

**The choice:** restoring is friendlier to a student who left and came back
mid-term — their term's listening picks up where it was. The alternative reading
of "accountability starts at enrolment" is that a returning student should only
be accountable for sessions marked after their return. The app does the first.
If you want the second, say so and it changes in one place.

### 5b. The no-account-creation gate — DONE (2026-09-07)

Nothing owed here; recorded so the next reader does not re-litigate it. The
phone apps, Android and iOS, cannot bring an account into existence:
`accountExists` verifies the Google token and `app/src/auth/google.ts` refuses
before `signInWithCredential`, which is the line that would create one. That is what
keeps Apple 5.1.1(v) and Play's deletion requirement disengaged, and it is worth
knowing it is load-bearing before anyone "simplifies" the sign-in path.

Two consequences to expect rather than treat as bugs:

- **A new colleague cannot sign in on the phone until they have signed in on the
  web once.** That is the design, not a defect. The instruction goes in the
  onboarding email — it must NOT go in the app, because naming an external
  sign-up route is Play's second trigger word for word.
- The refusal says "This account isn't set up for the app yet. Contact your
  administrator." and names no website, deliberately.

- [ ] **FAISAL — the one check nobody has run, and the store claim rests on it.**
      Tests cover the callable and the ordering; only a device covers the round
      trip. On a phone, on a RELEASE build (production, not emulators): the
      Android release APK, then the TestFlight build:

      1. Tap **Sign in with Google** and pick a personal Google account that has
         no account in this project.
      2. Expect: *"This account isn't set up for the app yet. Contact your
         administrator."* — and no sign-in.
      3. Then the assertion that actually matters, checked in Firebase rather
         than inferred from the screen. **Ask about the exact address you used**
         — `auth/user-not-found` is the pass (Application Default Credentials
         of an `oursabeel-lms` owner):

         ```sh
         ADDR=you@gmail.com node -e "const a=require('firebase-admin');\
         a.initializeApp({projectId:'oursabeel-lms'});\
         a.auth().getUserByEmail(process.env.ADDR)\
         .then(u=>{console.log('FAIL — an account exists:',u.uid,u.providerData.map(p=>p.providerId));process.exit(1)})\
         .catch(e=>{console.log(e.code==='auth/user-not-found'?'PASS — no account was created':'unexpected: '+e.code);process.exit(0)})"
         ```

         Do NOT check this by counting accounts on non-institute domains, which
         is the obvious thing and is wrong here: **students sign in with personal
         addresses**, so production legitimately holds gmail.com accounts, all
         provider `password`. A stray Google sign-in would show up as an
         address carrying the **`google.com`** provider that is not on
         `oursabeel.com`.

      4. Then sign in with a Workspace account immediately afterwards and confirm
         it works — which also proves the Google account chooser was cleared, and
         that a person who picked the wrong account can still switch.

### 5c. KVM access can lapse without a reboot — one-time fix

`/dev/kvm` access on this machine comes from a login-session ACL, and on
2026-09-10 the device node was recreated without it: the ACL named only `sddm`,
the `kvm` group was empty, and the AVD refused hardware mode until a reboot
re-applied it. Make it not depend on the session:

- [x] `sudo gpasswd -a $USER kvm` (2026-10-12) — takes effect at the next
  login; until then the `setfacl` grant run the same day covers it.

### 6. The three static pages the stores need — BUILT (2026-09-07)

Done and tested; **one thing left, and it is yours.**

They live in `app/public/` (Expo copies that into the export verbatim) and
`firebase.json` rewrites `/privacy`, `/support` and `/get-app` to them **ahead of
the `**` catch-all** — behind it they would answer 200 with the app shell, which
is the silent way this breaks. `functions/test/unit/hostingPages.test.ts` guards
the ordering and that each destination exists; `npm run smoke:prod` fetches all
three from the deployed site anonymously and checks the body is the page rather
than the shell.

The host is the web app's own domain, `oursabeel-lms.web.app` (`WEB_APP_URL`).
`PRIVACY_URL` matches the rewrite, and a test asserts they agree.

- [ ] **FAISAL — create `privacy@oursabeel.com`.** All three pages name it as the
      address for deleting an account, asking what is held, and correcting it, and
      the policy promises a response within 30 days. It does not exist yet. Make
      it a Workspace group with **two** admins on it, so the policy does not go
      stale when one person changes role. This is the same address the sibling
      apps settled on (2026-08-18).
- [ ] **FAISAL — read the privacy policy.** It should be read by somebody who did
      not write it. It describes what this app actually does, but the claims about
      retention are the institute's to stand behind, not mine.

## Before Phase 6 (Zoom)

Design decisions (locked 2026-07-24): **one central Zoom user** hosts the class
recordings (not multiple hosts); **manual class mapping** (staff pick the target
class at import time — no auto-map by topic).

- [ ] **Create a Zoom Server-to-Server OAuth app** (internal/private, no
      Marketplace publication). Supply account id, client id, client secret — via
      `firebase functions:secrets:set ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` /
      `ZOOM_CLIENT_SECRET`, never pasted into chat or a file.
- [ ] **Grant exactly these granular scopes** (`:admin`, NOT `:master` — this is
      a single-account S2S app; `:master` is only for master/sub-account ISVs):
      - `cloud_recording:read:list_user_recordings:admin` — list the central
        user's cloud recordings (the import picker; response already carries each
        file's download_url, type, duration, start time).
      - `cloud_recording:read:list_recording_files:admin` — read one meeting's
        recording files (per-recording import + retry via
        `GET /meetings/{meetingId}/recordings`).
      - `user:read:user:admin` — *recommended*, resolve/validate the central user
        by email at runtime instead of hardcoding an id.
      (Not needed unless we later add more hosts:
      `cloud_recording:read:list_account_recordings:admin`. No write scopes — we
      never modify anything in Zoom. Source: developers.zoom.us granular scopes.)
- [ ] **Enable audio-only recording** on that user (Settings → Recording →
      "Record an audio-only file" ON) so recordings produce an **M4A**
      (`recording_type: audio_only`). If existing recordings are video-only with
      no M4A, switch to audio-only going forward rather than building server-side
      ffmpeg extraction.
- [ ] **One real cloud recording with an M4A** on the account — needed only for
      the final "one real import" check; the whole job is built + emulator-tested
      against a fake Zoom first.

## Before the store release

- [ ] **Retention policy** decision. The brief says recordings are kept
      indefinitely; an R2 lifecycle rule (`cloudflare/media-bucket/`) is cheap
      to add but the policy is yours. Audio is affordable at any plausible
      bitrate — five years at 128 kbps is roughly 96 GiB, about $2/month.

## Optional / whenever

### 7. A student is running the 0.3.0 APK, and nothing tells them to update

Sentry, 2026-09-08: `Missing or insufficient permissions` from
`studentRecordings` on a Samsung SM-S931U, release `0.3.0+19`, Katy TX. That
build lists a course's published recordings directly; the rules have refused
that to students since 2026-08-14, when a recording began opening on an active
assignment. The student sees an empty library and no reason, and the app has
no minimum-version check, so every rules change since has broken that phone
silently. Sentry attaches no identity by design, so the person cannot be named
from here.

- [ ] Tell students to install the current build through Play internal testing. The
      staff who last signed in on 2026-09-10 (Israa, Khadija, Rukaiya) can pass
      it on. Sentry saw the same phone (Galaxy S25, Houston) still on 0.3.0 on
      2026-09-16 (SABEEL-RECORDING-ANDROID-3); the gate below cannot reach a
      build that predates it, so this one is a message from a person.
- ✅ **The minimum build number — decided and built, 2026-09-17.** `config/app`
      carries `minVersionCode`, read by every Android and iPhone build before
      sign-in (`app/src/minVersion.ts`); a build below it shows the update screen with
      Google Play. Readable by anyone, written only by
      `scripts/set-min-version.mjs <X.Y.Z>`, which is yours to run after
      a release older builds can no longer work against — see DEPLOY.md.
- [ ] **The update screen on store builds** opens the Play internal testing track
      on every native build, a Play or TestFlight install included. What it
      should do there is decided in `docs/STORE-RELEASE.md`.

### 8. Decisions from the 2026-09-11 review

Three taken on 2026-09-11 and shipped: every call re-checks the account behind
the token (a disabled account is refused at once); an archived course's
recordings move into a quiet Archived group on the student home; a student's
progress and completion writes need an ACTIVE grant. The empty-state item that
was left open here is done too: every list screen waits for its first snapshot
before it says "No … yet".

### 9. Decisions from the 2026-09-11 second round

Fixed and shipped in v0.6.4 without a decision: a retried "recording ready"
push no longer trusts its stale payload; a disabled account's device
registrations go with its session; a register submission removes no stored
mark; "not recorded" and a recording can no longer both be true; a
needs-attention Zoom import is always retryable; a revoked session says "sign
in again"; a tapped web push opens the app; archived and unpublished
recordings keep their ledger, with the rows as they stood when it closed; a
grant on a course archived with listening off reads "Closed", not "Listen
by"; the gate-screen poll cannot be carried by a previous sign-in; Play no
longer raises the notification prompt; a withdrawn recording is not reported
as a fault; four crash-in-the-middle states repair themselves. Left for you:

- ✅ **Release signing — done 2026-10-12.** The app's own key, outside the
      repo, its SHA-1 registered; also Play's app signing key
      (`docs/SECRETS.md`).
- ✅ **An archived recording leaves the course totals — decided 2026-09-11.**
      Closing a term is archiving the COURSE, which keeps every count. Archiving
      or unpublishing one recording withdraws it from the course card, the
      attendance report and the per-student counts, as if it had never been
      required; its own ledger page keeps the rows. The manual says so in as
      many words (§2.6, §3.4), and no longer describes recording-archive as
      an end-of-term step.
- [ ] **Headphones unplugged keeps playing.** Android's convention is to pause
      when the output route disappears (`ACTION_AUDIO_BECOMING_NOISY`).
      The player (expo-video) does not handle it; it needs a small native receiver, i.e. a
      native change in `android/`. Decide whether it matters before the first
      real-phone complaint.
- [ ] **A push arriving while the app is open shows nothing.** FCM's own
      banner appears only in the background; a foreground handler would have
      to render the message itself. Decide whether an in-app banner is worth
      building, or whether background delivery is enough for three messages a
      term.
- [ ] **The work queue never lets a "no recording yet" row go.** A session
      whose attendance is in but whose audio never arrived sits on Today for
      the life of the course — and once its listen-by date has gone, the
      upload it prompts leads to a Publish the server refuses. Options: retire
      the row at the listen-by date like the publish reminder does, or keep it
      and say "past its date — move the date, or mark it not recorded".
- [ ] **A completion written after the deadline counts.** The rules gate a
      student's completion on an ACTIVE grant, not on the date (the date
      lives in `getPlaybackUrl`; comparing it in rules would be a second copy
      of the maths). So a hand-built write after midnight, or an offline
      completion syncing the next morning, reads as complete everywhere.
      The second is by design; the first needs the SDK. If it ever matters,
      flag `completedAt > dueDate` on the ledger rather than dating the rules.
- [ ] Not decisions, noted for a quieter week: the reconcile is read-then-
      write outside a transaction (a register correction racing an unenrol
      can leave a grant on until the next write); publish and Remove audio
      can interleave into a published recording with no object. Both need a
      collision nobody has produced.
