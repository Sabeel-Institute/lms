# Sabeel Institute LMS

The learning management system for Sabeel Institute's adult classes:
attendance, class recordings, assignments and grades. Built today: attendance
registers, audio recordings that students who missed a class listen to, and an
accountability ledger for staff. Planned: video and several recordings per
session, and assignments with grades (`docs/plans/`, `docs/proposals/`).

One Expo codebase targets **Android and web**, with the architecture kept ready
for a later iOS build. Backend is Firebase: Firestore and Cloud Functions; media
moves to Cloudflare R2 (`docs/plans/MEDIA-ON-CLOUDFLARE.md`).

## Status

**In development, shipping to a real project.** Staff sign in with Google
(restricted to the org domain and admin-approved); students get staff-created
accounts and set their own password. Cohorts, courses, sessions and enrolments
exist, with managers scoped course by course. Recordings are uploaded or
imported, published, and opened to whoever was marked excused; students stream
them, mark their own completion, and staff read the accountability ledger and
export it. Everything consequential is audited.

Not started: admin backend stats and the release itself. Zoom import is built
and toured end to end, and is waiting on institute credentials and its first
live run. See [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) for live
status and [`PLAN.md`](PLAN.md) for the build order.

## Documentation

| Doc | What it is |
|---|---|
| [Product brief](docs/PRODUCT_BRIEF.md) | Product decisions and the data model — the *what* |
| [Build plan](PLAN.md) | Phase order and locked architecture decisions — the *when* and *why* |
| [Phase status](docs/PHASE_STATUS.md) | Live build status, decision log, verification log |
| [Brand](docs/BRAND.md) | Option 1 palette, accessibility cuts, single light theme |
| [Dev tooling](docs/DEV-TOOLING.md) | What each script guards against; expected output |
| [Deploy](docs/DEPLOY.md) | Deploy order and first-deploy traps |
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
npm run test:emulator        # needs JDK 21

# End-to-end (needs the emulators AND the web dev server running — see docs)
npm run test:e2e

# Layout sweep: every screen, both populations, five widths — starts its own
# emulators and dev server, so it needs nothing running. Shots in shots/screens/.
npm run test:screens

# Web
npm run web:export -w @sabeel/app

# Android (AVD tb_emu)
scripts/emulator.sh headless
cd app && EXPO_PUBLIC_USE_EMULATORS=1 npx expo run:android
```

## Layout

```
app/               Expo app (Android + web via react-native-web)
functions/         Cloud Functions (TS, nodejs22, us-central1)
packages/shared/   Types and constants shared by app, functions and tests
firestore.rules    Scoped reads; every structural write goes through a callable
storage.rules      Deny-all — and stays that way for reads
scripts/           Emulator, dead-code and text-integrity tooling
```

Clients never read audio through the Storage SDK: playback goes through a
12-hour signed URL minted by a callable that has already checked the student's
active assignment and its listen-by date. Enrolment is not consulted: being
marked excused is the whole of the entitlement, and an assignment already proves
it.
`storage.rules` denying reads is the intended end state, not a placeholder.
