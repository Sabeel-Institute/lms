# The LMS on the App Store and Google Play

This file is the LMS's own answers for both stores: how it keeps the
decisions every Sabeel app shares, its review account, what each store's
questionnaire gets, the review notes, and what stands between it and a
submission. The method and the shared reasoning are in the
[`sabeel-app-stores` skill](https://github.com/Sabeel-Institute/brand/blob/main/skills/sabeel-app-stores/SKILL.md),
whose numbered decisions this file follows. When the two disagree about a
shared decision, the skill wins and this file is the one to fix. How to build
and ship: [DEPLOY.md](DEPLOY.md) and [IOS-BUILD.md](IOS-BUILD.md).

## Where it stands (2026-10-16)

| | |
|---|---|
| **iPhone** | TestFlight only. Builds 1, 2 and 3 of v0.1.2 are VALID; the group **Internal** gets every build automatically (`IOS-BUILD.md`, "TestFlight testers"); 19 staff invited to App Store Connect, not yet accepted. Next `expo.ios.buildNumber`: 4. App Store Connect app 6823374038, SKU `sabeel-lms`, bundle id `com.sabeelinstitute.lms`. Nothing submitted for review |
| **Android, Play** | App `com.sabeelinstitute.lms`. Play signs it with the LMS's own release key since 2026-10-16. No Play release yet: 0.1.2 (code 37) was refused, because Play generated its APKs with Google's earlier key, and sits as a draft on the internal track. The next version is the first Play release. Testers: the email list "Sabeel staff", ticked on Internal testing → Testers on 2026-10-16 (`DEPLOY.md`, step 6); staff get the join link from that page once a release is there |
| **Android, APK** | v0.1.2 on this repo's GitHub releases, linked from the download page `https://faisal-shah.github.io/sabeel-institute-lms/` |
| **Web** | `https://oursabeel-lms.web.app`, v0.1.2. Where accounts are made |

**Destination** (Faisal, 2026-10-16; skill decision 9): the App Store,
**unlisted**, and Google Play **production**, a public listing, since Play has
no unlisted. Until then, TestFlight internal testing and Play internal
testing.

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
  Platform).

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
| Assignment | "Summary in your own words", posted to Sample Class; due date **2026-11-14** |
| Password | Only in the owner's vault, `~/.config/secrets-vault/sabeel/review/lms-app-review.txt`, and at submission in App Store Connect's App Review Information sign-in fields and Play Console's App access. Never in a repository, a chat or a log |

In production the documents have the ids `app-review` (cohort),
`app-review-class`, `app-review-s1` and `app-review-r1`.

**Before every submission, move both due dates into the future**, as an admin
on the web: Session 1's due date (the session editor) and the assignment's
(its pencil). The session's date closes the recording to the reviewer, and the
assignment's closes the hand-in. Then sign in as the reviewer and check the
recording plays and the assignment can be handed in. Apple requires a demo
account that does not expire, and every update is reviewed again.

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
or disabling the account. **Neither is built.** Both go in before the LMS's
first App Store submission or Play production release, whichever comes first.

Deliberately not: blocking between members (a student who blocked a teacher
would stop receiving assignments; an administrator disables an abusive
account instead, which signs it out and keeps it out), and no word filter or
automatic removal.

### 5. Adults only

Students and staff are adults; the LMS has no users under 13, and the privacy
policy says it is not offered to children under 13. The institute's rules,
when built, state no minimum age.

### 6. Privacy

- **Public pages**, served anonymously by Hosting ahead of the app
  (`firebase.json` rewrites; `functions/test/unit/hostingPages.test.ts` and
  `npm run smoke:prod` check them):
  - Privacy policy: `https://oursabeel-lms.web.app/privacy` (`PRIVACY_URL`,
    `app/public/privacy.html`)
  - Support: `https://oursabeel-lms.web.app/support` (`app/public/support.html`)
  - Get the app: `https://oursabeel-lms.web.app/get-app`

  The privacy page carries no navigation and no sign-in link.
- **In the app**: "Privacy policy" in the More sheet
  (`app/src/components/MoreSheet.tsx`). **Not yet on the sign-in screen**,
  where Apple 5.1.1(i) wants a reviewer who has not signed in to reach it.
  **Never the support page** in the app: it tells staff to sign in on the
  website first, which is the account-creation pointer decision 1 forbids. The
  support URL goes in the store listings only.
- **What the policy says the LMS collects**: name and email address;
  which recordings were played, how much and where playback stopped;
  attendance and completed listening; assignment work (written answers,
  documents, photos, audio); grades and teachers' comments; the class
  recordings, audio and video; whether a device may receive notifications, and
  its device token; crash and error diagnostics, which carry no name, email
  address or account identifier.
- **Third parties named**: Google (staff sign-in), Google Cloud and Firebase
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
other. `npm run publish:play` completes a release only when the APKs Play
generated carry that key's certificate, which is why 0.1.2 (code 37) stays a
draft.

### 10. Small things each store checks

`ios.config.usesNonExemptEncryption: false` in `app/app.json`; the privacy
manifest is `expo.ios.privacyManifests`, checked by `npm run check:ios`;
iPhone builds use Xcode 26 on GitHub's `macos-26` runners; Android targets API
36 (React Native's default, not overridden).

### The update screen sends store installs to the download page

`UpdateScreen` in `app/src/screens/GateScreens.tsx` opens `DOWNLOAD_PAGE_URL`,
the Android APK download page, on every native build when the institute
raises `config/app.minVersionCode` (`docs/DEPLOY.md`, "Retiring old builds").
On an iPhone that is an Android page (guideline 2.3.10); on a Play install it
is an update from outside Play, which Play's policy forbids. **Before
submission**: an iPhone build sends people to the App Store (TestFlight while
it is there), a Play install to its Play listing, and only an APK from the
download page to the download page. Not built; a code change.

## Store answers

**Apple App Privacy** (agrees with `expo.ios.privacyManifests` and the
privacy policy). Data linked to the user, none used for tracking, all for App
Functionality:

| Category | Types |
|---|---|
| Contact Info | Name, Email Address |
| User Content | Photos or Videos, Audio Data, Other User Content (written answers, files, a teacher's feedback) |
| Identifiers | User ID |
| Usage Data | Product Interaction (listening: what was played, how much, where it stopped) |
| Diagnostics | Crash Data (see Open: linked or not) |

**Apple age rating**: user-generated content Yes; messaging and chat Yes (a
teacher's feedback on work); social media No; advertising No; no web
browsing, gambling, mature or medical content. Keep the rating Apple
calculates.

**Play Data safety**: account creation **No**. Collected, not shared,
encrypted in transit, deletion on request: personal info (name, email
address, user IDs); photos; audio; files and documents; app activity (app
interactions: listening; other user-generated content: answers, feedback);
app info and performance (crash logs); device or other IDs (the notification
token). Must match the privacy policy.

**Play content rating (IARC)**: users interact Yes; no violence, sexual
content, gambling or purchases.

**Play target audience**: 18 and over only. **Ads**: none.

**Play App access**: all functionality needs sign-in. The review account and
its password, with: "Sign in under Students with this email and password."

**Distribution**: iPhone, the unlisted App Store for staff and students;
Android, Play production. Until then, TestFlight internal testing and Play
internal testing.

## Review notes

Paste into App Store Connect's App Review Information notes, and adapted into
Play's App access instructions. The password goes only in the sign-in fields.

```text
This app is for the staff and students of Sabeel Institute, a nonprofit
adult-education institute. Accounts are provisioned by the institute through
its web application; the app refuses any identity that does not already have
an account, and no account is created from the app. Guideline 5.1.1(v) is
therefore not engaged.

The sign-in screen has two separate paths. Staff sign in with the
institute's Google Workspace accounts (the education/enterprise exemption
under Guideline 4.8). Students sign in with first-party email and password
accounts that staff create; no third-party login is offered to students.

For review, sign in under Students with the account in the sign-in fields.
It is an ordinary student account made by an administrator, the only
student of a sample class. It can open Session 1's recording and play it as
video or as Audio only, mark it complete, and open and hand in the
assignment "Summary in your own words". Staff and administrator roles are
granted only to the institute's own Workspace accounts; staff take
attendance, upload or import recordings, post assignments and grade work.

All content is visible only to members an administrator has added to the
same class. Nothing is public, searchable or discoverable, and users cannot
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

## Before submitting

| | Item | Status |
|---|---|---|
| [ ] | The institute's rules screen and More → Report a problem (decision 4) | not built |
| [ ] | A privacy link on the sign-in screen (decision 6; the review notes promise it). Never a support link in the app | not built |
| [ ] | The update screen sends store installs to their store (above) | not built |
| [ ] | The reviewer's due dates moved into the future, and the reviewer signed in to check | session 2027-02-12, assignment 2026-11-14 |
| [ ] | The TestFlight build checked on an iPhone: lock-screen controls, a notification tapped with the app closed, a stranger's Google account refused (and no Auth record); the same refusal on the Android release APK | not done (`TODO.md`) |
| [ ] | App Store Connect: App Privacy (above) | not entered |
| [ ] | App Store Connect: age rating (above) | not entered |
| [ ] | Listing: description, keywords, category, screenshots at the required sizes, support URL and privacy policy URL | not written |
| [ ] | App Review Information: contact, sign-in required, the review account, the notes above | not entered |
| [ ] | Version release: manual | not set |
| [ ] | After submitting, the Account Holder files Apple's unlisted request | not filed |
| [ ] | Play Console App content: privacy policy URL, App access, ads, content rating, target audience, Data safety, and the foreground-service declaration (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`, for playback with the screen off) | not entered |
| [ ] | Play store listing, then a production release | not done |
| [ ] | `privacy@oursabeel.com` exists, a Workspace group with two admins | not confirmed |
| [ ] | Someone who did not write it reads the privacy policy | not done |
| [ ] | Texas SB 2420 (skill decision 5): a lawyer's answer before the first public listing, which Play production is | not asked |

## Open

- **Crash data, linked or not.** `expo.ios.privacyManifests` declares
  CrashData as linked; the privacy policy says crash reports carry no name,
  email address or account identifier. App Privacy must agree with the
  manifest, so settle one answer: Not Linked in both, or Linked in both.
- **The reviewer's password on recreation.** Adding a student emails a
  set-password link to `apps-reviewer@oursabeel.com`, which is not a Workspace
  user. Confirm where that address's mail is delivered before switchover day.
- **The get-app page** (`app/public/get-app.html`) offers the Android APK and
  says the App Store is "Not yet available". It gets the App Store link and
  the Play listing when each exists.
- Listing copy, screenshots and category.
