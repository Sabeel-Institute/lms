# The LMS on the App Store and Google Play

This file is the LMS's own answers for both stores: how it keeps the
decisions every Sabeel app shares, its review account, what each store's
questionnaire gets, the review notes, and what stands between it and a
submission. The method and the shared reasoning are in the
[`sabeel-app-stores` skill](https://github.com/Sabeel-Institute/brand/blob/main/skills/sabeel-app-stores/SKILL.md),
whose numbered decisions this file follows. When the two disagree about a
shared decision, the skill wins and this file is the one to fix. How to build
and ship: [DEPLOY.md](DEPLOY.md) and [IOS-BUILD.md](IOS-BUILD.md).

## Where it stands (2026-10-29)

| | |
|---|---|
| **iPhone** | TestFlight internal testing: v1.0.0 (build 1000000) uploaded from the tag on 2026-10-29. App Store Connect app 6823374038, SKU `sabeel-lms`, bundle id `com.sabeelinstitute.lms`: version 1.0.0 in Prepare for Submission, with every field the API sets below (listing copy, age rating 4+, category, price, United States only, manual release, App Review information). Not yet: App Privacy, screenshots, the review attachment, the build attached to the version; nothing submitted. The build number is the version's code (1.0.0 is `"1000000"`), which `npx sabeel-ci release` writes with the version |
| **Android, Play** | App `com.sabeelinstitute.lms`, signed by Play with the LMS's own release key (§ 8). Internal testing: v1.0.0 (versionCode 1000000), shipped 2026-10-29; testers the email list "Sabeel staff". A **draft app** until its first production release is published. The listing (copy, contact details, icon, feature graphic, six screenshots) went up through the API on 2026-10-29, and Play sent it for review at once, as it does every change to a draft app. The service account's LMS permissions: release to production and testing tracks, tester lists, store presence, and "Edit and delete draft apps", without which a draft app's listing refuses it (403). No production release |
| **Android, APK** | v1.0.0 on this repo's GitHub releases (Play's universal APK) |
| **Web** | `https://oursabeel-lms.web.app`, where accounts are made |

**Destination** (Faisal, 2026-10-16; skill decision 9): the App Store,
**unlisted**, and Google Play **production**, a public listing in the United
States only, since Play has no unlisted. Play's nearest alternatives do not fit: a closed testing track
needs every student's Google account on a tester list, and a managed Google
Play private app installs only on devices the institute manages. Until then,
TestFlight internal testing and Play internal testing.

**Order** (Faisal, 2026-10-29): the LMS goes to both stores first and alone,
as version 1.0.0, because students, who are not institute staff, must be able
to install it. Kanban and the Time Tracker, staff-only with a set number of
accounts, stay on TestFlight and Play internal testing.

## How the LMS keeps the shared decisions

### 1. The phone apps never create an account

Shared reason: in-app account deletion is required only of an app that
supports account creation (Apple 5.1.1(v); Play, including pointing at a
sign-up flow elsewhere). Decided 2026-08-18 for every Sabeel app.

Here:

- **Students** are created by staff, on the web only: "Add a student" on
  `app/src/screens/StudentsScreen.tsx` exists only where `CAN_CREATE_ACCOUNTS`
  (`app/src/accountCreation.ts`) is true, which is the web. The student sets a
  password from an emailed link. The students' door is
  `signInWithEmailAndPassword`, which cannot create an account; no surface
  calls `createUserWithEmailAndPassword`.
- **Staff** sign in with Google. On the phone, `app/src/auth/google.ts` asks
  the `accountExists` callable (`functions/src/accountExists.ts`) before
  `signInWithCredential`, which is the line that would create an account. No
  account, no exchange. A colleague's first sign-in is on the web, where
  `onUserCreate` provisions them and an admin approves them.
- **The refusal names no website**: "This account isn't set up for the app
  yet. Contact your administrator." (`app/src/auth/signInMessage.ts`). The
  instruction to sign in on the web first goes in the onboarding email.
- **A client password sign-up is refused before any account exists**: the
  `beforeSignUp` blocking function (`functions/src/signUpGate.ts`, Identity
  Platform). Beside it, `beforeSignIn` refuses a password sign-in to any
  account that is not a student's, so the Students form is a door for
  students and the review account (a student) only.
- **Password emails** (set-password, resend, More → Change password, Email
  me a password link) come from `apps-noreply@oursabeel.com` with the
  institute's wording; they name the app and the website as where to sign in
  to the account that exists, never a way to get one.

Tests:

- `functions/test/integration/accountExists.integration.test.ts`, 7 tests;
  each asserts the Auth user count afterwards, not only the answer.
- `app/src/auth/googleGate.test.ts`, 5 tests; the load-bearing one is that
  `signInWithCredential` is never reached when no account exists.
- `functions/test/integration/signUpGate.integration.test.ts`: a password
  sign-up and an off-domain Google account are refused with no account made;
  a colleague's first Google sign-in still makes theirs.
- `npm run test:e2e`: a self sign-up against the Auth endpoint is refused at
  the door.

**Not yet verified on a device**, on Android or iPhone: a stranger's personal
Google account refused on a release build against production, with Auth
showing that no record was made. The steps are in `TODO.md` (5b); run them on
the release APK and on the TestFlight build before submitting.

### 2. Sign in with Apple is not required

Both clauses of guideline 4.8 apply: students use the institute's own
email-and-password accounts, and staff use the institute's Google Workspace
accounts. The sign-in screen (`app/src/screens/SignInScreen.tsx`) shows the
two doors apart: a **Students** section with email, password and Sign in,
then, below a divider, "Staff: sign in with your Sabeel Google account" and
**Sign in with Google**. Adding any third-party login to the students' door
would make Sign in with Apple mandatory.

### 3. The review account

Shared decisions (Faisal, 2026-10-15): the reviewer signs in through the email
door as an ordinary account, never an admin or manager, and its data comes
through the app's own screens: "That way there's no special code for app
reviewer." No reviewer code exists in this repo.

| | |
|---|---|
| Account | `apps-reviewer@oursabeel.com`, a **student**, display name "App Review", active. The address is reserved: never a Workspace user |
| Cohort | "App Review"; the reviewer is its only student |
| Class | "Sample Class", the reviewer enrolled |
| Session | "Session 1", the reviewer marked **excused**; due date **2027-02-12** |
| Recording | "Session 1 recording", published on Session 1: one part in two versions, a video version and Audio only |
| Assignment | "Summary in your own words", posted to Sample Class; due date **2027-02-12** |
| Password | Only in the owner's vault, `~/.config/secrets-vault/sabeel/review/lms-app-review.txt`, and at submission in App Store Connect's App Review Information sign-in fields and Play Console's App access. Never in a repository, a chat or a log |

In production the documents have the ids `app-review` (cohort),
`app-review-class`, `app-review-s1` and `app-review-r1`.

**Before every submission, move both due dates into the future**, as an admin
on the web: Session 1's due date (the session editor) and the assignment's
(its pencil). The session's date closes the recording to the reviewer, and the
assignment's closes the hand-in. Then sign in as the reviewer and check the
recording plays and the assignment can be handed in. Apple requires a demo
account that does not expire, and every update is reviewed again.

**The rules screen and the reviewer.** The first sign-in to the reviewer
account meets the institute's rules (decision 4) and **I agree** is recorded
on the account, so App Review sees the screen only if nobody has agreed on
that account first, the check above included. For the reviewer to meet it,
remove `rulesAcceptedAt` and `rulesVersion` from the reviewer's
`students/<uid>` record after the check (an Admin SDK update; no screen does
it). App Review meets the screen (skill, decision 3).

**It must survive switchover day.** The final seed wipes this project
(`docs/plans/SWITCHOVER.md`, switchover day, step 3). Recreate it afterwards,
as an admin on the web:

1. Cohorts: add "App Review"; in it, the class "Sample Class".
2. Students: add `apps-reviewer@oursabeel.com`, name "App Review"; set its
   password to the vault's from the set-password link.
3. Enrol the reviewer in Sample Class.
4. Add "Session 1" with a due date in the future, and mark the reviewer
   excused on its register.
5. Upload a recording to Session 1, with a video version and an Audio only
   version, and publish it.
6. Post the assignment "Summary in your own words" with a due date in the
   future.
7. Sign in as the reviewer on a phone: the recording plays, the assignment
   opens and can be handed in.

### 4. Content: rules and a report, no blocking

What people post here: teachers post assignments (title, rich-text
instructions, files), notes on a session, feedback and grades on a student's
work, and the attendance register; students hand in written answers, files,
photos and audio. Recordings are made by the institute, uploaded or imported
from its Zoom account. A student's work is seen only by that student, the
class's staff and the administrators, never by other students. There are no
direct messages and no @mentions (the rich text is ported from Kanban without
them).

Decided by Faisal on 2026-10-16 for every app: the institute's rules,
accepted once at first sign-in, and **Report a problem** under More, reaching
the LMS's administrators, who answer within 24 hours by removing the content
or disabling the account. **Both are live** (`acceptRules` and
`reportProblem` are deployed to `oursabeel-lms`):

- **The rules.** `RulesScreen` (`app/src/screens/GateScreens.tsx`), titled
  "Before you continue", with **I agree** and **Sign out**. `App.tsx` shows it
  in place of the whole navigator to any active account whose profile has not
  accepted the current `RULES_VERSION` (`packages/shared/src/conduct.ts`), after
  the pending and disabled gates and before any screen, so no screen and no
  URL is reachable until the account agrees. **I agree** calls `acceptRules`
  (`functions/src/conduct.ts`), which writes `rulesAcceptedAt` (server time)
  and `rulesVersion` on the caller's own `staffUsers` or `students` record;
  the rules deny clients any write there. The first acceptance stands, on
  every device. The words are the skill's, with "staff and students", "your
  class" and "in More", and state no minimum age.
- **Report a problem.** More → **Report a problem** for staff and students
  (`app/src/screens/ReportScreen.tsx`): a line of explanation, one field,
  **Send**; unsent text is held by the leave guard. `reportProblem` refuses an
  account that is not active, keeps `reports/{id}` (app, uid, name, email,
  role, text, time, platform, version), and emails it from
  `apps-noreply@oursabeel.com` to `apps-reports@oursabeel.com` with Reply-To
  the reporter, as plain text and plain HTML carrying the same facts (the
  person's words escaped in the HTML), then writes
  `mail: { status, messageId | error }` on the report. 1 to 2000
  characters; 5 per account per hour, counted from the stored reports. A
  failed email keeps the report, tells the person, and goes
  to Sentry; nothing retries. The email goes by domain-wide delegation with no
  key: `functions/src/mail.ts` composes it, `functions/src/gmail.ts` signs
  with IAM as `report-mailer@oursabeel-lms.iam.gserviceaccount.com` and
  sends through Gmail. No client reads or writes `reports`.

Tests:

- `functions/test/integration/conduct.integration.test.ts`, 14 tests: an
  inactive, disabled or signed-out caller keeps and sends nothing; an active
  one keeps exactly one report and sends exactly one email, To
  `apps-reports@`, Reply-To the reporter; the sixth report in an hour is
  refused with nothing kept or sent; a failed email keeps the report;
  acceptance is recorded once, on the account's own record.
- `functions/test/integration/rules.reports.test.ts` (no client reads or
  writes a report, admins included) and the "institute's rules, accepted"
  cases in `rules.identity.test.ts` (no client writes its acceptance), each
  shown red with its rule opened.
- `functions/test/unit/mail.test.ts`, `reportMail.test.ts`,
  `validateReport.test.ts`, and `gmail.test.ts`, which runs the real three
  requests against a local fake of Google.
- `npm run test:e2e`: each new account meets the rules first and cannot reach
  a screen by its address until it agrees; after **I agree** it is not asked
  again on reload, after signing out and in, or on a second browser; a
  student and an admin each send a report, and Back with unsent text asks
  first. `npm run test:screens` tours the rules screen and the report screen
  at every width.

**Before submission**: send one report from the live app and check it
arrives at `apps-reports@` with Reply-To set (step 11 of "The way to
submission").

Deliberately not: blocking between members (a student who blocked a teacher
would stop receiving assignments; an administrator disables an abusive
account instead, which signs it out and keeps it out), and no word filter or
automatic removal.

### 5. Adults only

Students and staff are adults; the LMS has no users under 13, and the privacy
policy says it is not offered to children under 13. The institute's rules
state no minimum age.

### 6. Privacy

- **Public pages**, served anonymously by Hosting ahead of the app
  (`firebase.json` rewrites; `functions/test/unit/hostingPages.test.ts` and
  `npm run smoke:prod` check them):
  - Privacy policy: `https://oursabeel-lms.web.app/privacy` (`PRIVACY_URL`,
    `app/public/privacy.html`)
  - Support: `https://oursabeel-lms.web.app/support` (`app/public/support.html`)
  - Get the app: `https://oursabeel-lms.web.app/get-app`

  The privacy page carries no navigation and no sign-in link.
- **In the app**: "Privacy policy" on the sign-in screen
  (`app/src/screens/SignInScreen.tsx`), where Apple 5.1.1(i) wants a
  reviewer who has not signed in to reach it, and in the More sheet
  (`app/src/components/MoreSheet.tsx`). **Never the support page** in the app: it tells staff to sign in on the
  website first, which is the account-creation pointer decision 1 forbids. The
  support URL goes in the store listings only.
- **What the policy says the LMS collects**: name and email address;
  which recordings were played, how much and where playback stopped;
  attendance and completed listening; assignment work (written answers,
  documents, photos, audio); grades and teachers' comments; the class
  recordings, audio and video; whether a device may receive notifications, and
  its device token; when the account agreed to the institute's rules; a
  report sent with Report a problem, with the reporter's name, email address
  and role, which is emailed to the administrators; crash and error
  diagnostics, which carry no name, email address or account identifier.
- **Third parties named**: Google (staff sign-in, and the Workspace email a
  report is delivered by), Google Cloud and Firebase
  (hosting and database, United States), Cloudflare (recordings and assignment
  files, R2, North America), Zoom (classes recorded there before import),
  Sentry (crash diagnostics), Apple (iPhone notifications and their device
  tokens).
- **Deletion** by email to `privacy@oursabeel.com`, acted on within 30 days.
  Sign-in, email address and notification settings go; the academic record,
  with the name, is kept as the institute's record, on institutional and
  contractual grounds (skill decision 7). An admin can also delete a disabled
  account on the website.

### 8. Play signs with the LMS's own key

Play's app signing key and upload key are both the LMS release key
(`docs/SECRETS.md`), set on 2026-10-16 with Change key → "Export and upload a
key from Java keystore" (PEPK). A Play install and the GitHub APK update each
other. `npx sabeel-ci publish-play` completes a release only when the APKs Play
generated carry that key's certificate, which is why 0.1.2 (code 37) stays a
draft.

### 10. Small things each store checks

`ios.config.usesNonExemptEncryption: false` in `app/app.json`; the privacy
manifest is `expo.ios.privacyManifests`, checked by `npm run check:ios`; the
only purpose string is the camera's (`expo-image-picker` adds photo library
and microphone strings by default, which `app.json` turns off: the app uses
neither, and a vague purpose string is a 5.1.1(ii) rejection);
iPhone builds use Xcode 26 on GitHub's `macos-26` runners; Android targets API
36 (React Native's default, not overridden).

### The update screen sends each phone to its own store

`UpdateScreen` (`app/src/screens/GateScreens.tsx`) opens `PLAY_STORE_URL`,
the app's Play listing, on Android, and `APP_STORE_URL`, its App Store page,
on an iPhone, when the institute raises `config/app.minVersionCode`
(`docs/DEPLOY.md`, "Retiring old builds"). Unlisted distribution keeps the
App Store address.

## App Store Connect, field by field

Every field the first submission asks for, the LMS's answer, and how it gets
there. **API** means the App Store Connect API key in the owner's vault sets
it (the agent does it); **web** means only a person signed in to App Store
Connect can. Limits are Apple's as of 2026-10-29.

### App Information

| Field | Answer | Set by |
|---|---|---|
| Name (30) | Sabeel Institute LMS | API |
| Subtitle (30) | Recordings and coursework | API |
| Primary category | Education; no secondary | API |
| Content rights | Does not use third-party content: recordings are the institute's own classes, and students' work is user content | API |
| Age rating | The questionnaire below | API |
| Privacy policy URL | `https://oursabeel-lms.web.app/privacy` | API |
| User privacy choices URL | none | |
| License agreement | Apple's standard | |
| EU Digital Services Act status | Required even with no EU distribution: "not a trader", with the app unavailable in the EU | web, Account Holder or Admin |

**Age rating questionnaire.** In-app controls: parental controls No, age
assurance No. Capabilities: unrestricted web access No (links open in the
phone's browser), user-generated content **Yes**, messaging and chat **Yes**
(a teacher's feedback on a student's work), advertising No, social media No.
Every content question (profanity, horror, alcohol and drugs, medical,
health or wellness, mature or sexual themes, violence, weapons, gambling,
simulated gambling, contests, loot boxes) None or No. Age category: Not
Applicable, no override. The rating Apple calculates is 4+; keep it.

### App Privacy (web)

Data linked to the user unless marked, none used for tracking, every purpose
App Functionality. It agrees with `expo.ios.privacyManifests` in `app.json`
and with the privacy policy.

| Category | Types |
|---|---|
| Contact Info | Name, Email Address |
| User Content | Photos or Videos, Audio Data, Other User Content (written answers, files, a teacher's feedback, Report a problem) |
| Identifiers | User ID, Device ID (the notification device token) |
| Usage Data | Product Interaction (listening: what was played, how much, where it stopped) |
| Diagnostics | Crash Data and Other Diagnostic Data, **not linked**: Sentry's reports carry no name, email address or account id |

### Pricing and Availability

| Field | Answer | Set by |
|---|---|---|
| Price | Free | API |
| Availability | United States only (Faisal, 2026-10-29): every student is in the US (§ 7). Canada would add no store requirement but would bring Canadian privacy law into the privacy policy's review | API |
| Distribution method | Public until Apple approves the unlisted request, then Unlisted (§ "The way to submission") | web, Account Holder's request |
| iPhone app on Mac (Apple silicon), on Apple Vision Pro | Off: neither is tested | web |

### The version (1.0.0)

| Field | Answer | Set by |
|---|---|---|
| Version | **1.0.0** (Faisal, 2026-10-29): Apple declines unlisted requests for an app "in a beta or prerelease state". The build carries the same version | API |
| Copyright | 2026 Sabeel Institute | API |
| Promotional text (170), description (4000), keywords (100 bytes) | Listing copy, below | API |
| Support URL | `https://oursabeel-lms.web.app/support` | API |
| Marketing URL | none | |
| Screenshots | 6.9-inch (1320 × 2868) and 6.3-inch (1206 × 2622), six each, PNG with no alpha channel. Apple's page names both as required in different places, so both go up | API |
| App previews | none | |
| Build | The 1.0.0 build from TestFlight | API |
| Export compliance | Answered by `ITSAppUsesNonExemptEncryption: false` (§ 10) | |
| Sign-in required, user name, password | Yes; `apps-reviewer@oursabeel.com` and the vault's password | API |
| Review contact | Faisal Shah, `faisal.shah@oursabeel.com`, phone in `+1…` form (Apple refuses any other) | API |
| Notes (4000 bytes) | Review notes, below | API |
| Attachment | The staff walkthrough video (`.mp4`, lowercase extension) | API |
| Version release | Manual: the app is held until the unlisted request is approved | API |
| Accessibility Nutrition Labels | Not yet: optional, and publishable only once a version is live | |

## Google Play Console, field by field

**API** means the Play publisher service account sets it (the agent does
it), once Play Console gives that account "Manage store presence" and
"Release to production" for the LMS; today it holds "Release apps to testing
tracks" only. **Console** means only a person signed in to Play Console can.

### App content (console)

| Declaration | Answer |
|---|---|
| Privacy policy | `https://oursabeel-lms.web.app/privacy` |
| App access | All or some functionality is restricted. One set: "Student account", `apps-reviewer@oursabeel.com`, the vault's password, and: "Sign in under Students with this email and password, then tap I agree on the institute's rules. The account is a student of a sample class: open Session 1's recording, play it as video or Audio only, and open the assignment Summary in your own words. Staff sign in with the institute's Google Workspace accounts only; there is no sign-up." |
| Ads | No |
| Content rating | Email `faisal.shah@oursabeel.com`; category Reference, News, or Educational (if the list offers it; otherwise All Other App Types). Users interact or exchange content: Yes. Fully moderated before others see it: No. Shares the user's location: No. Digital purchases: No. Web browser or search engine: No. Violence, sexual content, language, controlled substances, gambling: No |
| Target audience | 18 and over only; **Restrict minor access** on; the listing does not appeal to children |
| News app | No |
| Data safety | Below |
| Government apps | No |
| Financial features | My app doesn't provide any financial features |
| Health apps | My app doesn't provide any health features |
| Advertising ID | No. The v0.3.3 APK's merged manifest has no `AD_ID` permission (`aapt2 dump permissions`) |
| Foreground service | Media playback: "Plays a class recording the student started, with the screen locked or while they use another app, from the media notification's controls." Impact if deferred: "The recording stops mid-class." The background-playback video's link |
| Photo and video permissions | None needed: no `READ_MEDIA_*` in the merged manifest; files come through the document picker, photos from the camera |

**Data safety.** Collected, none shared (Firebase, Google Cloud, Cloudflare
and Sentry act for the institute), all encrypted in transit, deletion on
request by email to `privacy@oursabeel.com`. Account creation: the app does
not allow users to create an account (§ 1).

| Category | Type | Required or optional | Purposes |
|---|---|---|---|
| Personal info | Name, Email address, User IDs | Required | App functionality, Account management |
| Photos and videos | Photos | Optional | App functionality |
| Audio files | Voice or sound recordings | Optional | App functionality |
| Files and docs | Files and docs | Optional | App functionality |
| App activity | App interactions (listening); Other user-generated content (answers, feedback, reports) | Required | App functionality |
| App info and performance | Crash logs, Diagnostics | Required | Analytics |
| Device or other IDs | The notification device token | Optional | App functionality |

### Store settings and listing

| Field | Answer | Set by |
|---|---|---|
| Category | Education | console |
| Tags (up to 5) | Chosen from Play's list at the console | console |
| Contact email (public, required) | `privacy@oursabeel.com`, the address the support page gives (Open) | API |
| Website | `https://oursabeel-lms.web.app/support` | API |
| Phone | none | |
| External marketing | Off | console |
| Catalog settings (US third-party stores, on by default since 2026-07-22) | Opt out | console |
| App name (30), short description (80), full description (4000) | Listing copy, below | API |
| App icon | 512 × 512 PNG from `app/assets` | API |
| Feature graphic | 1024 × 500, no alpha, in the brand | API |
| Phone screenshots | Six at 1080 × 1920. Play refuses a long side more than twice the short one, so a 20:9 phone's 1080 × 2400 does not pass | API |
| Tablet screenshots, video | none | |
| Countries | United States only | console |

### The production release

The 1.0.0 bundle, already on internal testing, promoted to production with
the note "First release on Google Play." A first production release cannot be
staged or held by managed publishing; Play reviews it in up to seven days,
and a change sent while it waits restarts the clock. On a draft app the API
creates production releases as drafts only ("Only releases with status
draft may be created on draft app"): the agent creates the draft release,
and Faisal sends it for review from Publishing overview in the console.

## Listing copy

Both stores take the same description. Characters counted against each
store's limit.

- **Subtitle** (App Store, 25/30): Recordings and coursework
- **Promotional text** (App Store, 142/170): For the students and staff of
  Sabeel Institute: catch up on a class you missed, hand in your work and
  get it back graded, all from your phone.
- **Keywords** (App Store, 97/100 bytes):
  `sabeel,institute,class,recording,lecture,coursework,assignment,attendance,student,adult education`
- **Short description** (Play, 72/80): Class recordings, assignments and
  grades for Sabeel Institute's students

**Description:**

```text
Sabeel Institute LMS is the learning app for the students and staff of Sabeel Institute, a nonprofit adult-education institute. You sign in with the account the institute gives you.

For students
• Catch up on a class you were excused from: play its recording as video, or switch to Audio only and keep listening with the screen locked.
• Pick up where you stopped, change the playback speed, and mark the recording complete when you have listened.
• See everything you owe under To do, with each listen-by date.
• Open your class's assignments, write your answer or attach files and photos, and hand it in.
• Read your teacher's feedback and your grade when your work comes back.
• Get a notification when something new is posted for you.

For staff
• Keep the register for each session.
• Upload class recordings or import them from Zoom, and publish them to the students who need them.
• See who has listened and who still owes a recording.
• Post assignments, then grade and return what students hand in.

Your work is seen only by your teachers and the institute's administrators; nothing is public. Everyone agrees to the institute's rules before posting, and Report a problem, in More, reaches the administrators.

Accounts are provided by Sabeel Institute to its students and staff.
```

## Screenshots, graphics and videos

All made from the guide world (`scripts/seed-guide.mjs`) on the emulators,
the data the user manual's figures show; never production and never a real
student. Store screenshots show the app in use, not the sign-in screen
(Apple 2.3.3).

| Asset | Made where | Content |
|---|---|---|
| iPhone screenshots, 1320 × 2868 and 1206 × 2622 | The iPhone simulator on GitHub's macOS runner | 1 To do; 2 the player, playing, with Audio only and speed; 3 an assignment with an answer and attachments; 4 returned work with grade and feedback; 5 staff: the register; 6 staff: grading |
| Android screenshots, 1080 × 1920 | The AVD at that display size | The same six |
| Play icon and feature graphic | From the app icon and the brand (`sabeel-brand` skill) | |
| Staff walkthrough video, App Review attachment | `maestro/store/staff-walkthrough.yaml` on the AVD over the guide world, recorded from the host (`adb emu screenrecord`) from the moment the flow photographs `00-recording-starts`, so the dev sign-in row never shows | The register kept and submitted, an assignment posted, work graded and returned: about two minutes |
| Background playback video, Play's foreground-service declaration | The AVD | A student taps a recording, it plays, the screen locks, the media notification's controls pause and resume it |

The screenshots are Maestro flows, `maestro/store/student.yaml` (1 to 4) and
`staff.yaml` (5 and 6), run by `native-e2e` over the guide world under a clean
status bar (9:41, full signal and battery). Maestro runs only the flows
directly in the directory it is given, so the tests in `maestro/` never run
them. On the AVD, at a display size Play accepts:

```sh
adb shell wm size 1080x1920
npx sabeel-ci native-e2e --seed scripts/seed-guide.mjs --clean-status-bar maestro/store
adb shell wm size reset
```

On iPhones, Native started by hand on GitHub, once per model (the 6.9-inch
and the 6.3-inch):

```sh
gh workflow run native.yml --ref <branch> -f flows=maestro/store \
  -f seed=scripts/seed-guide.mjs -f ios-simulator="iPhone 17 Pro Max" \
  -f clean-status-bar=true
```

The PNGs are in `shots/native/` locally and in the run's `native-ios-<sha>`
artifact.

The background playback video needs a public address with no sign-in; it is
served from Hosting, under a path no page links to (Open).

## Review notes

Paste into App Store Connect's App Review Information notes, and adapted into
Play's App access instructions. The password goes only in the sign-in fields.
Under 4000 bytes, Apple's limit.

```text
This app is for the staff and students of Sabeel Institute, a nonprofit
adult-education institute in the United States, and is intended for
unlisted distribution: the Account Holder is requesting it for this app.

Accounts are provisioned by the institute through its web application; the
app refuses any identity that does not already have an account, and no
account is created from the app. Guideline 5.1.1(v) is therefore not
engaged.

The sign-in screen has two separate paths. Staff sign in with the
institute's Google Workspace accounts (the education/enterprise exemption
under Guideline 4.8). Students sign in with first-party email and password
accounts that staff create; no third-party login is offered to students.

For review, sign in under Students with the account in the sign-in fields.
It is an ordinary student account made by an administrator, the only
student of a sample class. It first shows the institute's rules: tap I
agree. It can then open Session 1's recording and play it as video or as
Audio only (playback continues with the screen locked), mark it complete,
and open and hand in the assignment "Summary in your own words". Staff and
administrator roles are granted only to the institute's own Workspace
accounts; the attached video shows the staff screens: keeping the register,
posting an assignment and grading the work handed in.

All content is visible only to members an administrator has added to the
same class, and a student's work only to that student and the class's
staff. Nothing is public, searchable or discoverable, and users cannot
contact strangers. Guideline 1.2:
- Terms: every user accepts the institute's rules, which prohibit
  objectionable content and abusive users, before they can post.
- Reporting: More > Report a problem. The report goes to the institute's
  administrators, who act on it within 24 hours by removing the content and
  disabling the author's account.
- Blocking abusive users from the service: administrators disable the
  account, which signs it out and stops it signing in. Blocking between
  members is not offered because the app carries required coursework: a
  student who blocked a teacher would stop receiving assignments.
- Contact: https://oursabeel-lms.web.app/support (the privacy policy, linked
  on the sign-in screen, gives the same address).

Account deletion is requested by email; the privacy policy (linked on the
sign-in screen) states the address, the process and what is retained.
```

### The unlisted request

Filed by the Account Holder at
`https://developer.apple.com/contact/request/unlisted-app/` once the version
is submitted (Apple declines a request for an app not yet submitted). Apple
does not publish the form's fields; these answers cover what developers
report it asks:

- **App:** Sabeel Institute LMS, Apple ID 6823374038.
- **What it does:** students of Sabeel Institute, a nonprofit adult-education
  institute, play the recordings of classes they were excused from, hand in
  assignments and get them back graded; staff keep the register, publish
  recordings and grade work.
- **Why unlisted:** only the institute's enrolled students and staff can use
  it; the institute issues every account and the app has no sign-up.
  Students use their own phones, which the institute does not manage, so
  private distribution through Apple Business or School Manager cannot reach
  them, and a public listing would show the app to people who can never sign
  in.
- **Audience:** the institute's students and staff, all adults, in the
  United States; about 40 people: 10 staff and 30 students (Faisal,
  2026-10-29).
- **Devices:** personal, unmanaged iPhones.

Developers report App Review sometimes rejects an organisation-only app under
3.2 while the request is pending. The answer is to reply in App Store Connect
that the unlisted request is filed, and keep the version on manual release
until Apple approves it; releasing earlier publishes the app publicly.

## The way to submission

In order. **Agent** steps run through the APIs, CI and the emulators; the
others need Faisal's console login, approval or judgment.

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Privacy link on the sign-in screen; the update screen opens each phone's store; no unused iOS purpose strings; privacy manifest matched to the policy | Agent | built (#74) |
| 2 | Merge #74 | Faisal | done |
| 3 | First and alone, 1.0.0, United States only; console forms by Faisal | Faisal | decided 2026-10-29 |
| 4 | Listing copy (above), approved | Faisal | drafted |
| 5 | Screenshots, icon, feature graphic, both videos | Agent | icon (#75) and feature graphic made; Android screenshots taken, a re-shoot for the status bar to come; iPhone after ci-tools#46 |
| 6 | The review account renewed: due dates moved on, the assignment posted again so the reviewer receives it (a direct write gave it no hand-in record) | Agent | done 2026-10-29, with the server's own code; both due dates 2027-02-12 |
| 7 | Release 1.0.0: the release pull request, Play internal testing, TestFlight | Agent opens it; Faisal merges and gives the go-ahead | done 2026-10-29: Play internal testing, GitHub release, web, TestFlight |
| 8 | Device pass on the Android release APK (AVD): the reviewer's path, background playback, the update screen | Agent | done 2026-10-29 on 1.0.0 (Play's APK), and the background playback video recorded; the update screen not yet |
| 9 | On an iPhone, from TestFlight: lock-screen controls, a notification tapped with the app closed, a personal Google account refused (and no Auth record) | Faisal, about 10 minutes | |
| 10 | The reviewer signed in to check, then `rulesAcceptedAt` and `rulesVersion` cleared on its record | Agent | done 2026-10-29: rules, recording, assignment checked; agreement and listening progress cleared |
| 11 | One live Report a problem, checked at `apps-reports@` with Reply-To set | Agent sends; Faisal confirms arrival | |
| 12 | App Store Connect: every API field above, screenshots, the attachment, the build | Agent | API fields done 2026-10-29 |
| 13 | App Store Connect web: App Privacy, DSA status, Mac and Vision Pro off (`TODO.md`, "The store consoles") | Faisal | |
| 14 | Play Console: the service account's permissions (with "Edit and delete draft apps"); App content; category, tags, external marketing, catalog opt-out; countries (`TODO.md`, "The store consoles") | Faisal | permissions granted 2026-10-29 |
| 15 | Play API: listing, graphics, contact details | Agent, once step 14 grants the permissions | done 2026-10-29 |
| 16 | A lawyer's answer on Texas SB 2420 (skill, decision 5), and someone who did not write it reads the privacy policy | Faisal | |
| 17 | Submit the App Store version | Agent, on Faisal's go-ahead | |
| 18 | The unlisted request | Faisal (Account Holder); answers above | |
| 19 | Play production release: the agent creates it as a draft; Faisal sends it for review from Publishing overview (a draft app's first release) | Agent, then Faisal, on Faisal's go-ahead | |
| 20 | Once Apple approves both: release the version; the get-app page and `DOWNLOAD_PAGE_URL` take the store links (a Hosting deploy) | Agent, on Faisal's go-ahead | |

## Open

- **Public contact address.** Play publishes a contact email on the listing;
  `privacy@oursabeel.com` is the one the support page already gives.
- **Where the background playback video lives.** Hosting, under an unlinked
  path, takes a Hosting deploy; the alternative is an unlisted YouTube video
  on an institute account.
- **The reviewer's password on recreation.** Adding a student emails a
  set-password link to `apps-reviewer@oursabeel.com`, a Workspace group;
  confirm the group's mail reaches someone before switchover day.
- **The get-app page** (`app/public/get-app.html`) offers the Android APK
  and says the App Store is "Not yet available". It gets the App Store link
  and the Play listing when each exists.
