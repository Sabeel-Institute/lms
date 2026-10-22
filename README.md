# Sabeel Institute LMS

Automatic platform builds and manual release controls are documented in
[GitHub Actions](docs/GITHUB-ACTIONS.md).

The learning management system for Sabeel Institute's adult classes:
attendance, class recordings, assignments and grades. Built today: attendance
registers, class recordings (audio and video, in parts and versions) that
students who missed a class play in the app, assignments with grades, and an
accountability ledger for staff.

One Expo codebase targets **Android, iOS and web**. Backend is Firebase:
Firestore and Cloud Functions; media is in Cloudflare R2
(`docs/plans/MEDIA-ON-CLOUDFLARE.md`).

## Status

**In development, shipping to a real project.** Staff sign in with Google
(restricted to the org domain and admin-approved); students get staff-created
accounts and set their own password. Cohorts, courses, sessions and enrolments
exist, with managers scoped course by course. Recordings are uploaded or
imported, published, and opened to whoever was marked excused; students stream
them, mark their own completion, and staff read the accountability ledger and
export it. Everything consequential is audited.

Zoom recordings are imported through a Cloudflare Worker. Released: the web
app, Android APKs on this repo's GitHub releases, the iPhone app on TestFlight,
and Google Play internal testing. Not started: admin backend stats. See
[`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) for live status and
[`PLAN.md`](PLAN.md) for the build order.

## Documentation

| Doc | What it is |
|---|---|
| [Product brief](docs/PRODUCT_BRIEF.md) | Product decisions and the data model — the *what* |
| [Build plan](PLAN.md) | Phase order and locked architecture decisions — the *when* and *why* |
| [Phase status](docs/PHASE_STATUS.md) | Live build status, decision log, verification log |
| [Brand](docs/BRAND.md) | Option 1 palette, accessibility cuts, single light theme |
| [Dev tooling](docs/DEV-TOOLING.md) | What each script guards against; expected output |
| [Deploy](docs/DEPLOY.md) | Deploy order, the release recipe, first-deploy traps |
| [iOS build](docs/IOS-BUILD.md) | The iPhone app: GitHub builds, TestFlight, the Mac |
| [Store release](docs/STORE-RELEASE.md) | This app's App Store and Play answers, the review account, what is left before submitting |
| [Plans](docs/plans/) | Switchover, media on Cloudflare, video and parts |
| [Secrets](docs/SECRETS.md) | What is and is not a secret; key names only |
| [TODO](TODO.md) | Everything needing a human with console access |
| [User manual](docs/USER-MANUAL.md) | The app as students, staff and admins meet it |
| [Stack gotchas](docs/STACK-GOTCHAS.md) | Stub — the real content is a shared skill |

### Research

- [Zoom Server-to-Server OAuth](docs/research/zoom-server-to-server-oauth.md)
- [Firebase recording costs](docs/research/firebase-recording-costs.md)
- [Technical risk register](docs/research/technical-risk-register.md)

## Quick start

```bash
npm ci
npm run lint && npm run typecheck && npm run knip && npm test
npx sabeel-ci check-app      # what the shared CI tooling assumes of this repo
npm run test:emulator        # needs JDK 21 and SeaweedFS (docs/DEV-TOOLING.md)

# End-to-end flow walkthrough — starts its own emulators and dev server
npm run test:e2e

# Layout sweep: every screen, both populations, five widths — starts its own
# emulators and dev server, so it needs nothing running. Shots in shots/screens/.
npm run test:screens

# Web
npm run web:export -w @sabeel/app

# Android (AVD tb_emu)
npx sabeel-ci emulator headless
cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo run:android
```

## Layout

```
app/               Expo app (Android, iOS, and web via react-native-web)
functions/         Cloud Functions (TS, nodejs22, us-central1)
packages/shared/   Types and constants shared by app, functions and tests
firestore.rules    Scoped reads; every structural write goes through a callable
cloudflare/        The Zoom copier Worker and the R2 media bucket's settings
scripts/           Browser suites, seeds, migrations, the local media store
ci-tools.json      This app's settings for the shared CI, release and device
                   tooling (Sabeel-Institute/ci-tools, `npx sabeel-ci`)
```

Media lives in a private Cloudflare R2 bucket. Clients never hold a permanent
link: playback goes through a 12-hour pre-signed URL minted by a callable that
has already checked the student's active assignment and its listen-by date.
Enrolment is not consulted: being marked excused is the whole of the
entitlement, and an assignment already proves it. Staff uploads go straight to
the bucket on a write-once pre-signed URL, and Zoom recordings are copied in by
the Worker, so no media passes through a Function.
