# Secrets

**Key names only. No values, ever — not here, not in chat, not in a commit.**

## What is and is not a secret

| Thing | Secret? | Where it lives |
|---|---|---|
| Firebase web config (apiKey, appId, …) | **No** | Committed in `app/src/firebase-config.ts` — it ships in every client bundle |
| `google-services.json`, `GoogleService-Info.plist` | No, but not committed | Regenerated from Firebase; gitignored because they are per-project and carry OAuth client ids |
| Sentry **client** DSNs (web, android) | No, but not committed | Gitignored `app/.env.local` as `EXPO_PUBLIC_SENTRY_DSN_WEB` and `EXPO_PUBLIC_SENTRY_DSN_ANDROID`. Send-only, and they ship in the bundle anyway; kept out of git so they can rotate per environment |
| Sentry **functions** DSN | **Yes** | Secret Manager as `SENTRY_DSN` (server-side, never shipped to a client) |
| Sentry **auth token** (source-map upload) | **Yes** | Gitignored `app/android/sentry.properties` (`auth.token=`). An **org** token (org `devnull-ke`), shared across all the Sabeel Sentry projects; the web pipeline reads it via `SENTRY_PROPERTIES`, overriding the project to `sabeel-recording-web` |
| Zoom account id / client id / client secret | **Yes** | Secret Manager, via `firebase functions:secrets:set` |
| Service account keys | **Yes** | One exists, Play's publishing account — see below |
| Android **release signing key** and its password | **Yes** | `~/.config/sabeel-lms/release.keystore` and `keystore.properties`, outside the repo, mode 600 — see below |
| R2 API keys (`R2_READ_*`, `R2_WRITE_*`) | **Yes** | Secret Manager |
| Apple **Distribution certificate** for GitHub builds (`.p12`, its password, the App Store profiles) | **Yes** | `~/.config/sabeel-lms/ios-distribution/`, mode 600, and GitHub secrets `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD`, `IOS_PROFILE` here and in the Kanban repo (`docs/IOS-BUILD.md`, "Builds on GitHub"). Expires 2027-10-16 |
| Apple **push key** (APNs, `AuthKey_X5R8FL94BC.p8`) | **Yes** | Secret Manager as `APNS_KEY`, which the functions that send a notification bind (`functions/src/messaging.ts`); the file in `~/.config/sabeel-lms/`, mode 600. Its id and the team id are not secret and are in `functions/.env.oursabeel-lms` |

The Firebase "apiKey" is not a credential. It identifies the project; access is
controlled by security rules and App Check. Treating it as a secret leads people
to hide it and then commit something that genuinely matters.

Secret scanners flag it anyway (GitGuardian did on 2026-10-12, on this public
repo). The answer is in the key's restrictions, not in hiding it: the
"Browser key (auto created by Firebase)" may call only Firebase's own APIs
(27 of them; no Maps, no AI, nothing billable outside Firebase), checked with
`gcloud services api-keys list --project=oursabeel-lms`. It deliberately has
no website-address (referrer) restriction: the Android app uses this same key
through the JS SDK, and its requests carry no referrer, so that restriction
would lock the phone app out. Mark such alerts as false positives.

## Setting a server secret

Never through chat. When the value is in a file on this machine, the agent
sets it with `--data-file` and never prints it (as `APNS_KEY` was); a value
only Faisal has, he sets himself:

```bash
firebase functions:secrets:set SENTRY_DSN        # paste the FUNCTIONS DSN when prompted
firebase functions:secrets:set ZOOM_ACCOUNT_ID
firebase functions:secrets:set ZOOM_CLIENT_ID
firebase functions:secrets:set ZOOM_CLIENT_SECRET
firebase functions:secrets:set APNS_KEY --data-file ~/.config/sabeel-lms/AuthKey_X5R8FL94BC.p8 --project oursabeel-lms
```

Then bind them in the function definition, and redeploy — a secret that is set
but not bound is not available at runtime. `SENTRY_DSN` is already bound on every
entry point: audited callables via `auditedCall`, the rest via `reportedCall`,
the auth trigger, the two assignment triggers, and the notification trigger and
its daily schedule. So once it is set, the next functions deploy turns on server
error reporting. Until then the binding is inert
and the functions run normally. Locally, `functions/.secret.local` (gitignored)
holds `SENTRY_DSN=disabled` and placeholder `R2_*` values so the emulator does
not probe Secret Manager; reporting stays off in tests, and the media store uses
the local SeaweedFS keys instead (`docs/DEV-TOOLING.md`).

## One service account key file: Play publishing

A key file in a repo or a CI variable is a permanent credential with no
rotation story, so there is one, and only on this machine:
`~/keys/sabeel-play-publisher.json`, the key of
`sabeel-play-publisher@sabeel-institute-kanban.iam.gserviceaccount.com`. Google
Play's publishing API takes nothing else. One account publishes every Sabeel
app; Play Console gives it "Release apps to testing tracks" app by app, and
`scripts/publish-play.mjs` reads it (or the path in `PLAY_KEY`). If it leaks or
is lost, delete that key in the Google Cloud console (project
`sabeel-institute-kanban`, IAM, Service Accounts) and make a new JSON key
there.

## The R2 keys

Media URLs are signed with R2 API keys, not a Google identity: R2 has no
equivalent of signing as a service account. Two Cloudflare account API tokens,
each scoped to the `oursabeel-lms-media` bucket, are the deliberate exception
to "no long-lived keys":

| Secrets | Permission | Bound to |
|---|---|---|
| `R2_READ_KEY_ID`, `R2_READ_SECRET` | Object Read | `getPlaybackUrl` |
| `R2_WRITE_KEY_ID`, `R2_WRITE_SECRET` | Object Read & Write | upload, finalize, remove-audio, delete and Zoom import callables |

Each pair is bound only to the functions that need it
(`MEDIA_READ_SECRETS` / `MEDIA_WRITE_SECRETS` in `functions/src/mediaStore.ts`).
Pre-signed URLs are bearer tokens: one cannot be revoked by itself, but
**rotating a key invalidates every URL it signed**. To rotate: create a new
token in the Cloudflare dashboard (R2 → Manage API tokens, scoped to the
bucket), `firebase functions:secrets:set R2_READ_KEY_ID` and `R2_READ_SECRET`
(or the write pair), redeploy the functions bound to them, then delete the old
token.

## Android release signing key

Every release APK of `com.sabeelinstitute.lms` is signed with one key, created
2026-10-12:

| | |
|---|---|
| Keystore | `~/.config/sabeel-lms/release.keystore` (PKCS12, RSA 4096, valid to 2054) |
| Alias | `sabeel-lms` |
| Password | in `~/.config/sabeel-lms/keystore.properties` (store and key share it) |
| SHA-1 | `F6:F1:F1:17:15:2C:32:BF:4D:B0:B5:16:F8:8C:3F:AB:E2:AB:C4:D2` |
| SHA-256 | `E8:C3:7E:B6:5E:BA:D0:C9:DF:57:D4:58:68:58:D4:59:F9:7F:A4:7E:FB:5D:28:D3:06:0A:79:E9:11:00:FF:D5` |

The fingerprints are public (they are in every APK); the keystore and its
password are not. `app/android/app/build.gradle` reads `keystore.properties`
from that path, or from the path in `SABEEL_LMS_KEYSTORE_PROPERTIES`. Without
it a release build fails; it never falls back to the debug key, which is public
and would let anyone build an APK that installs over the real app.

Both SHA-1s, this one and the debug key's, are registered on the Firebase
Android app, which is what Google sign-in on the phone checks.

**Losing the key means the app can never be updated again**: Android refuses an
update signed with a different key, so every phone would have to uninstall and
reinstall. Keep two copies off this machine: the password in a password
manager, and the keystore file in that password manager as an attachment or on
other storage.

## The collected copy: `~/.config/secrets-vault/`

Every secret file of Faisal's projects, from this machine and the Mac,
copied into one folder (mode 700) for him to keep in a password manager.
`sabeel/` holds `apple/`, `google-play/`, and one folder per app (`lms/`,
`kanban/`, `time-tracker/`, `recording-app/`), each with `android/` (signing
keys) and `env/` (build and runtime settings); `personal/` holds the SSH keys
and his other projects. Its `README.md` says what each file is,
which are irreplaceable, and how to replace the rest. The tools keep reading
their own live copies; `sources.tsv` names each one, and
`bash ~/.config/secrets-vault/vault.sh verify` proves the folder still matches
them (`collect` refreshes it). A new secret file is added to `sources.tsv`
the day it is made.

## What on this machine has no other copy

Everything else here can be cloned, reinstalled or regenerated. These cannot,
or only with effort:

| File | Holds | If lost |
|---|---|---|
| `~/.config/sabeel-lms/release.keystore` + `keystore.properties` | Android release key and password | **No updates to the app, ever.** Back up both. |
| `app/.env.local` | Sentry client DSNs | Copy again from Sentry project settings |
| `app/android/sentry.properties` | Sentry org auth token | Create a new token in Sentry |
| `~/.config/sabeel-lms/AuthKey_X5R8FL94BC.p8` | Apple push key (also in Secret Manager as `APNS_KEY`) | Apple never lets it be downloaded again. Make a new key in the developer portal, set `APNS_KEY` to it and `APNS_KEY_ID` to its id, redeploy the functions. Back it up |
| `functions/.secret.local` | `SENTRY_DSN=disabled`, `R2_*` and `APNS_KEY` placeholders for the emulator | Recreate from this file |
| `app/google-services.json`, `app/android/app/google-services.json` | Firebase Android config | `firebase apps:sdkconfig ANDROID 1:226338267845:android:a85d5935fb8f4555cac6ac` |
| `app/GoogleService-Info.plist` | Firebase iOS config | `firebase apps:sdkconfig IOS 1:226338267845:ios:13ce4f7992ecd4decac6ac --out app/GoogleService-Info.plist` |
| `~/.config/.wrangler/config/default.toml` | Cloudflare login | Log in again (`docs/DEV-TOOLING.md`) |
| `~/keys/sabeel-play-publisher.json` | Play publishing key (all Sabeel apps) | Make a new key for the same service account (above) |

Server secrets live in Secret Manager and are not on this machine.

## Zoom credentials

Never reach the mobile or web bundle. The backend fetches from Zoom and copies
only the audio file into the media bucket; students never see a Zoom token, a Zoom
download URL, or a `play_url`.

## If a secret leaks

Rotate first, investigate second. For Zoom, regenerate the client secret in the
Marketplace developer portal and re-set it. For signed URLs, note that individual
URLs cannot be revoked — rotating the R2 read key (above) invalidates **all**
outstanding playback URLs at once, which is the blunt instrument available.
