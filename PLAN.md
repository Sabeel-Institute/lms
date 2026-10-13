# Build Plan — Hikam Foundations Class Recordings

Phase-by-phase implementation plan derived from [`product-brief.md`](docs/PRODUCT_BRIEF.md)
and the three research docs. The brief is the *what*; this is the *order* and the
*exit criteria*. Live status will move to `docs/PHASE_STATUS.md` once Phase 0 lands.

> **Media storage below is superseded.** Everything here about Firebase Cloud
> Storage, `storage.rules`, V4 signed URLs and the signing grant describes the
> app as it was built on the legacy project. Media is now in Cloudflare R2:
> [`docs/plans/MEDIA-ON-CLOUDFLARE.md`](docs/plans/MEDIA-ON-CLOUDFLARE.md).

**Sequencing decision (2026-07-21):** Zoom import is deliberately **not** first,
against the risk register's recommended order. The Zoom account is a pending
external input, and the manual-upload path exercises every risky part of the media
pipeline except the Zoom API itself (Storage layout, protected playback, duration
extraction, draft→publish lifecycle, background audio, offline download). Zoom
import lands as Phase 6, gated only on credentials. Nothing in Phases 0–5 blocks
on Faisal.

---

## Guard rails

Two installed skills are authoritative and must not be copied into this repo:

- **`expo-firebase-stack`** (`~/.claude/skills/expo-firebase-stack/`) — the
  recurring traps of Expo + react-native-web + Firebase JS SDK. Its closing
  section, *"How this stack fools you"*, gets read **before** a debugging
  session, not during one. Directly relevant here: Google sign-in
  `DEVELOPER_ERROR` and in-webview popups (Phase 1), the no-admin-bootstrap
  chicken-and-egg (Phase 1), claim changes killing the live user listener
  (Phase 1), emulator `127.0.0.1` vs `localhost`, Cloud Build not resolving the
  private workspace package (first deploy), FCM device-token vs Expo-token and
  the two extra things web push needs (Phase 7), platform seams reading as dead
  code to knip, and silent no-op seeds/tests. Its verification traps govern every
  exit criterion below: a native **debug** build takes `EXPO_PUBLIC_*` from the
  environment that started *Metro*, not from the APK; `BUILD SUCCESSFUL` is not
  proof the APK installed (check `adb shell dumpsys package <id> | grep
  versionName`); and a screenshot of the sign-in screen is evidence about nothing
  else — authenticated screens need a `__DEV__`-only emulator sign-in row to reach.
- **`sabeel-brand`** — the Option 1 brand palette, its role proportions,
  the accessibility-driven text and gold cuts, and the **single light theme**
  rule. Applied in Phase 0 so no colour debt accrues; hardcoded colours become
  ESLint-banned in the same phase.

**Gap worth naming:** neither skill covers Firebase **Storage**, long-media
playback, background audio, or offline media. This app breaks that ground first.
Every non-obvious lesson there gets contributed back to `expo-firebase-stack` in
the same batch as the fix — that is the standing rule in the sibling repos, and
it is the main reason this project is worth more than its own feature list.

## Reference implementations

`sabeel-institute-time-tracker` and `sabeel-institute-kanban` share one proven
skeleton. Phase 0 forks it rather than inventing a new one:

- npm workspaces: `app` (Expo), `functions` (TS, nodejs22, us-central1),
  `packages/shared` (types + all date math).
- Firebase **JS SDK on all surfaces** — not react-native-firebase (no web).
- Android via local Gradle with committed `android/` (no EAS, no iOS builds);
  web via `expo export --platform web` → Firebase Hosting. Platform differences
  as `.web.ts(x)` siblings.
- Config-as-code: `firestore.rules`, `firestore.indexes.json`, and now
  `storage.rules` deploy from the repo, never console-edited.
- `scripts/`: `test-emulator.sh`, `free-emulator-ports.sh`, `web-e2e.mjs`
  (added in 1c), `check-text-sources.mjs`; `release.mjs` and `publish-apk.sh`
  arrive in Phase 9. CI = lint + typecheck + knip + unit + emulator tests, no
  deploys from CI.
- Live Firestore reads go through a `useLiveQuery`/`useLiveDoc` wrapper,
  lint-enforced. Hand-rolled `onSnapshot` state caused a week-long stale-data bug
  in the time tracker; that postmortem is inherited, not re-learned.

---

## Cross-cutting decisions to lock in Phase 0

| Decision | Recommendation | Why |
|---|---|---|
| Protected playback | Callable Function issues a **12-hour V4 signed URL**; client streams directly from GCS. App Check enforced on the callable | Threat model (Faisal, 2026-07-21): a leaked link must expire, but a determined user extracting audio from their own device is acceptable. That rules out `getDownloadURL()`, whose download token never expires — the one option that fails the requirement. It does *not* require download-then-play, so progressive streaming, instant start, and free seeking all stay. App Check stops the callable being scripted to harvest the whole catalogue. |
| Signed-URL refresh | Cache the URL with its expiry; re-mint whenever under an hour remains, **before** playback starts | Re-minting only after a 403 means a seek near the boundary fails audibly first. Accepted consequence: a URL already issued keeps working for up to 12 h after a student is disabled or unenrolled. Individual signed URLs cannot be revoked — only the signing key rotated, which kills all of them. |
| Audio never proxied through Functions | Stream direct from GCS, always | The 60-minute function timeout would kill playback of a 2-hour recording mid-session, and every seek re-invokes. A correctness limit, not a cost one: at this scale proxying would cost single-digit dollars. |
| Storage bucket | Modern `*.firebasestorage.app` bucket in `us-central1` | Only the modern-bucket rows get the 5 GB / 100 GB no-cost quotas, and only in three US regions. A legacy `appspot.com` bucket has worse rows. |
| Audio format | Store audio-only **M4A/AAC** only; reject video | Keeps the whole thing inside free quota even at 128 kbps. Video is the single biggest cost cliff. |
| Playback library | `expo-video` native, for audio and video (one engine, one lock-screen session; spike V0 in docs/plans/VIDEO-AND-MULTIPLE-MEDIA.md); an HTML5 `<video>` element on web, behind a seam | Background audio + lock-screen controls are first-class requirements, and `expo-av` is end-of-life. |
| Offline downloads | `expo-file-system` into app-private storage, native only; web streams only | Brief forbids external file export. App-private dirs are not user-browsable. |
| Progress writes | Throttled: every ~15 s of playback, plus on pause, on seek, and when the session ends. Conflict resolution = **max listened, latest position wins** | Naive per-second writes would blow past Firestore quotas and drain battery for zero accountability value. |
| Due-date timezone | One institute-wide timezone constant in `@sabeel/shared` | Due dates are date-only. Per-student timezones buy nothing here and complicate the overdue job. Contrast with the time tracker, where per-entry timezone is load-bearing. |
| Audit log | Written **server-side only** (Functions), never from the client | A client-writable audit log is not an audit log. |
| Roles | Firebase custom claims for `admin` / `manager`; class scopes in Firestore, read by rules | Claims are cheap in rules; scopes change too often to live in claims. |

---

## Phases

### Phase 0 — Scaffold, theme, CI green  ✅ complete

Fork the sibling skeleton; get a hello screen running on both surfaces.

- Monorepo, tsconfig, eslint, knip, Vitest, GitHub Actions.
- `CLAUDE.md` for this repo (skill-boundary rule, product invariants, division of
  labour, ports/AVD conventions).
- Reorganise docs to match siblings: `docs/PRODUCT_BRIEF.md` (the existing brief),
  `docs/PHASE_STATUS.md`, `docs/BRAND.md`, `docs/DEPLOY.md`, `docs/SECRETS.md`,
  `docs/STACK-GOTCHAS.md` (stub pointing at the skill), `TODO.md`.
- Theme from `sabeel-brand`: `app/src/theme/{palette,index}.ts`, semantic
  tokens, `useTheme()`, light-only, ESLint ban on hardcoded colours.
- Firebase project created, emulator suite wired (Auth, Firestore, Functions,
  **Storage**), `demo-` project id for tests.

**Exit:** lint + typecheck + knip + `npm test` + `npm run test:emulator` green in
CI; hello screen screenshotted on the `tb_emu` AVD *and* on a web export (not
just dev server — an exported bundle is the thing that ships).

### Phase 1 — Identity, authorization, and academic structure  ✅ complete

**Phases 1 and 2 were merged** (2026-07-21). Manager scopes are class-by-class
and student quick-create takes an enrolled class, so splitting them would have
meant writing the security rules twice — once in a shape that could not be
enforced, then again against real classes. The project is nine phases, not ten;
the later numbers are deliberately not renumbered.

Delivered in three commits:

- **1a — Identity.** Two auth populations: staff via Google restricted to
  `oursabeel.com` (enforced server-side; the client `hd` hint is UX only) and
  staff-created student email/password accounts. Roles as one claim
  (`admin` | `manager` | `student`) plus a status; claims are what rules trust.
  Admin approval queue, one-shot `bootstrapAdmin`, session polling so approval
  un-gates live without a sign-out.
- **1b — Academic structure.** Cohorts, classes, enrollments. `effectiveActive`
  derived once in `@sabeel/shared` and written by the callables. Manager scoping
  via `managerUids` on the class; enrollments at composite id
  `{studentUid}_{classId}` with `active` rather than deletion.
- **1c — Hardening.** `scripts/web-e2e.mjs` (17 checks), every new rule
  predicate mutation-tested, docs.

See `docs/PHASE_STATUS.md` for the full decision and verification logs — in
particular why a `list` rule must reference `resource.data`, and why a `get()`
resolved from document data is only affordable for single-parent queries.

### Phase 3 — Media spine (manual upload → protected playback)

Highest-risk phase. Split into a spike and a build.

**3a — Spike (throwaway, timeboxed).** Prove three things end to end before
committing to the design: a signed URL streams audio in the AVD *and* on web;
`expo-audio` keeps playing with the app backgrounded and shows lock-screen
controls; seek + speed + resume behave on both surfaces.

**3b — Build.**
- Resumable upload from staff web; validation (type, size, real audio sniff);
  duration extraction; drafts prefilled.
- `recordings` lifecycle state machine in shared: draft → published → archived /
  unpublished → draft, plus needs-attention. Required metadata gate before publish.
- Storage layout `recordings/{recordingId}/audio.m4a`; `storage.rules` deny-all,
  access exclusively via signed URLs.
- Player: streaming, resume, speed, background audio, mark-complete affordance.

**3c — Offline downloads.** In-app download, download management, storage-usage
display, playback from local file, manual delete. Native only.

**Exit:** staff uploads and publishes; student streams on AVD and web; background
playback verified by screenshot + adb after backgrounding; a downloaded recording
plays with the AVD in airplane mode.

### Phase 4 — Assignments, progress, completion

- Publishing fans out `assignments` to the enrolled roster via an **idempotent**
  Function trigger (re-publish must not duplicate).
- Late-enrollment default (accountable only for not-yet-due recordings) plus
  explicit catch-up assignment with optional new due date.
- `listeningProgress` under the throttle/conflict policy above; cross-device sync.
- `completionEvents`: mark complete (blocked with a clear message if never
  played), unmark, staff-visible either way.
- Offline completion queue with a **Pending sync** state that is visually
  unmistakable, and reports that treat unsynced completions as not final.
- Student home ordered overdue → due soon (7 d) → no due date → recent.

**Risks:** this is where a silent no-op hides best — an offline queue that never
drains looks identical to one that works. Test under injected latency and real
airplane mode, not localhost speed.

**Exit:** offline mark-complete → reconnect → server-confirmed, verified on the
AVD; rules tests preventing a student from writing another student's progress or
forging a completion timestamp.

### Phase 5 — Staff ledger, reporting, audit

- Recording ledger (roster × recording), student ledger, class-level counts with
  incomplete/overdue rollups.
- Complete sortable/filterable list views for recordings, students, classes,
  ledgers. No search in v1 — hierarchy and filters carry it.
- Staff completion override with a **required** reason, audit-logged.
- Reassignment semantics when cohort/class changes post-publish: new roster
  becomes accountable, old roster leaves current counts, old history stays
  attached for audit.
- CSV export mirroring on-screen filters exactly.
- `auditLog` written server-side for every staff mutation; scoped read UI.

**Exit:** aggregation integration tests; e2e CSV download on web whose contents
match the filtered screen row-for-row.

### Phase 6 — Zoom import *(gated on credentials)*

- Zoom Server-to-Server OAuth: account ID / client ID / secret in Secret Manager,
  never in the app. Token fetched per-need, cached in memory, no refresh flow.
- Recording picker: date range, title, duration, import-status filters; already
  imported rows link to the existing recording; dedupe on Zoom recording UUID.
- Import job: download audio-only M4A → GCS → draft recording, with
  needs-attention status, useful error detail, and retry.
- Scheduled sync in addition to manual pull.
- **Contingency:** if the account's recordings have no audio-only file, do not
  build server-side ffmpeg extraction on spec — surface the finding, and prefer
  switching the Zoom account to audio-only recording going forward.

**Exit:** fake-Zoom emulator tests for the whole job; one real import performed
against the live account with Faisal present.

### Phase 7 — Notifications

- FCM on Android + web push. Tokens as a **subcollection**, unregistered on
  sign-out, pruned on send failure.
- Three messages, each with its own per-person switch, defaulting on:
  student — a recording is ready for you (an assignment becomes active);
  student — last day to listen (morning of the due date, if not complete);
  staff — attendance still not taken (session date passed, never submitted).
- No day-after reminder. Once the deadline passes access has closed, so the
  message could only say "you missed it".
- The repo's **first scheduled function**, at 07:00 in the institute timezone.
  It reuses `isOverdue`/`todayInZone` rather than reimplementing the rollover.

**Exit:** emulator-verified trigger logic and preference gating, with the FCM
send behind a seam (there is no FCM emulator). Actual delivery to a real device
is a Faisal verification step — the skill is explicit that "functions logged
success" is not evidence of delivery.

### Phase 8 — Admin backend stats

- Storage total and per cohort/class, recording count and total duration, recent
  import failures, manual upload failures, background job status, notification
  error counts, user counts by role, bandwidth if the provider exposes it.
- Aggregated by a scheduled Function into `backendStats` — never computed by
  scanning Storage from the client.

**Exit:** stats reconcile against a seeded known-quantity dataset.

### Phase 9 — Deploy, manual, release

- Rules → indexes → functions → hosting deploy order; `docs/DEPLOY.md`.
- `USER-MANUAL.md` with generated screenshots + PDF, per the sibling convention
  that user-visible changes ship with their documentation.
- Release script bumping all version files; APK published as a **GitHub Release
  asset**, never committed.

---

## Open decisions needing Faisal

1. **Firebase/GCP project** — new project id, and who owns billing.
2. **Zoom** — Server-to-Server OAuth app creation and the three credentials
   (unblocks Phase 6; nothing before it).
3. **Brand assets** — logo, app icon, splash. Phase 0 can proceed with
   placeholders, but they must land before Phase 9.
4. **`oursabeel.com` Workspace access** — needed to test the domain restriction
   with a real staff account.
5. **Institute timezone** for due-date rollover.
6. **Android release keystore + SHA-1** — needed for Google sign-in on a release
   build (Phase 1 risk, Phase 9 blocker).
6b. **`roles/iam.serviceAccountTokenCreator`** on the Functions runtime service
   account, so it can sign URLs via the IAM Credentials API without a key file.
   A first-deploy 403 that the emulator cannot reproduce — Phase 3 blocker.
6c. **App Check registration** — Play Integrity (Android) and reCAPTCHA
   Enterprise (web), plus debug tokens for the AVD and local web, or App Check
   locks out your own dev builds.
7. **Retention policy** — the brief says "indefinitely by default"; a GCS
   lifecycle rule is cheap to add later but the policy decision is yours.

These land in `TODO.md` in Phase 0 and stay current there, matching the
convention in the other two repos.
