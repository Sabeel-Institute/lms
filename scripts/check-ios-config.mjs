// Guard the iOS config, which is spread across files that must agree.
//
// `app/GoogleService-Info.plist` is downloaded from the Firebase console,
// `app/app.json` is written by hand, and `app/ios/` is regenerated from the
// latter on every prebuild — so nothing but this script stops them drifting.
// Every failure below either surfaces only at upload or at runtime, long after
// the build that caused it succeeded, or is the product's core (background
// audio) failing quietly.
//
// Run: npm run check:ios   (scripts/build-ios.sh runs it as a gate)
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const problems = [];
const fail = (msg) => problems.push(msg);
/**
 * For what is only wrong ON THE BUILD MACHINE. This script runs from any
 * checkout, and the Sentry build variables only have to exist in the shell
 * that archives — but a missing token skips the symbol upload without failing
 * the build, so it cannot be silent either.
 */
const warnings = [];
const warn = (msg) => warnings.push(msg);

const app = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
const ios = app.ios ?? {};
const plugins = app.plugins ?? [];
const pluginOptions = (name) => plugins.find((p) => Array.isArray(p) && p[0] === name)?.[1];

/**
 * The project the app must talk to, from the one place it is stated
 * (`packages/shared/src/constants.ts`). Read as text so this script needs no
 * build of the shared package; `projectIdentity.test.ts` holds the constant
 * itself to everything else.
 */
const constants = readFileSync(resolve(root, 'packages/shared/src/constants.ts'), 'utf8');
const PROJECT_ID = /export const FIREBASE_PROJECT_ID = '([^']+)'/.exec(constants)?.[1];
if (!PROJECT_ID) fail('could not read FIREBASE_PROJECT_ID from packages/shared/src/constants.ts.');

/** <key>NAME</key><string>VALUE</string> pairs — the plist is a flat dictionary. */
function readPlist(path) {
  const out = {};
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (const m of readFileSync(path, 'utf8').matchAll(re)) out[m[1]] = m[2];
  return out;
}

// 1. The plist. Gitignored like google-services.json (it carries the iOS OAuth
//    client), so a fresh clone does not have it, and prebuild then fails late
//    with an error that names a path rather than the console step.
const plistPath = resolve(root, 'app/GoogleService-Info.plist');
if (!existsSync(plistPath)) {
  fail(
    'app/GoogleService-Info.plist is missing.\n' +
      '    Download it from the Firebase console: Project settings -> the iOS app\n' +
      '    (com.sabeelinstitute.lms). It is gitignored, so a fresh clone never has it.',
  );
} else {
  const plist = readPlist(plistPath);

  // 2. Bundle id, in the plist and in app.json. A mismatch makes sign-in fail
  //    in ways that look like a network or credential problem, and Firebase
  //    cannot rename a registration — the fix is a new iOS app and a new plist.
  if (!ios.bundleIdentifier) {
    fail('app.json has no expo.ios.bundleIdentifier.');
  } else if (plist.BUNDLE_ID !== ios.bundleIdentifier) {
    fail(
      `bundle id mismatch: app.json says "${ios.bundleIdentifier}", the plist says "${plist.BUNDLE_ID}".\n` +
        '    Register an iOS app on the right bundle id and download its plist.',
    );
  }

  // 3. The project. A plist from another project points the phone at another
  //    database with no error anywhere — this repo exists beside a live legacy
  //    app, so this is the mistake with the worst consequence.
  if (PROJECT_ID && plist.PROJECT_ID !== PROJECT_ID) {
    fail(
      `the plist is for Firebase project "${plist.PROJECT_ID}", not "${PROJECT_ID}"\n` +
        '    (FIREBASE_PROJECT_ID in packages/shared/src/constants.ts).',
    );
  }

  // 4. Google Sign-In's URL scheme. Missing, Safari opens, you pick an account,
  //    and the app never comes back — nothing is registered to take the
  //    callback. Registered BARE, the plugin derives the scheme from the
  //    plist's REVERSED_CLIENT_ID, so the value has one home; given options it
  //    demands a hand-copied `iosUrlScheme`, and validates it on EVERY
  //    platform, so a wrong one also breaks the web export.
  const SIGNIN = '@react-native-google-signin/google-signin';
  if (pluginOptions(SIGNIN) !== undefined) {
    fail(`"${SIGNIN}" has options. Register it bare, so the plist stays the only copy of the URL scheme.`);
  } else if (!plugins.includes(SIGNIN)) {
    fail(`app.json plugins is missing "${SIGNIN}".`);
  }
  if (!plist.REVERSED_CLIENT_ID) {
    fail('the plist has no REVERSED_CLIENT_ID; enable Google sign-in in Firebase Auth and re-download it.');
  }
}

// 5. Sentry, bare. Given options, the plugin writes them into
//    ios/sentry.properties; bare, it takes SENTRY_ORG / SENTRY_PROJECT /
//    SENTRY_AUTH_TOKEN from the build environment (scripts/load-build-env.sh).
//    `@sentry/react-native` and `@sentry/react-native/expo` are the same plugin.
const SENTRY = ['@sentry/react-native', '@sentry/react-native/expo'];
if (SENTRY.some((n) => pluginOptions(n) !== undefined)) {
  fail('the Sentry plugin has options. Register it bare; the build environment supplies org, project and token.');
} else if (!SENTRY.some((n) => plugins.includes(n))) {
  fail('app.json plugins has no Sentry plugin, so no dSYM upload is wired and iOS crashes arrive as addresses.');
}

// 6. Background audio — the product. expo-video writes UIBackgroundModes
//    `audio` from this option at prebuild; without it a lecture stops the
//    moment the phone locks, and the build is otherwise perfect.
if (pluginOptions('expo-video')?.supportsBackgroundPlayback !== true) {
  fail(
    'expo-video is not registered with supportsBackgroundPlayback: true.\n' +
      '    Without it prebuild writes no UIBackgroundModes audio, and playback stops when the phone locks.',
  );
}

// 7. Export compliance. Absent, every upload waits on a manual questionnaire.
if (ios.config?.usesNonExemptEncryption !== false) {
  fail('expo.ios.config.usesNonExemptEncryption must be explicitly false.');
}

// 8. ONE version. `ios.version` would override expo.version and give Apple a
//    number Android and web do not have.
if (ios.version) {
  fail(`expo.ios.version is set ("${ios.version}"); remove it — expo.version is the one version.`);
}

// 9. The version is store-legal and the same as the APK's. app.json and
//    app/android/app/build.gradle are the pair (android/ is committed, not
//    prebuilt, so neither feeds the other); appVersion.test.ts checks them in
//    the unit suite, and this repeats it where a build is about to be cut.
//    Apple's CFBundleShortVersionString is three integers, no suffix.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(app.version ?? '')) {
  fail(`expo.version "${app.version}" is not X.Y.Z (three integers, no leading zeros, no suffix).`);
}
const gradle = readFileSync(resolve(root, 'app/android/app/build.gradle'), 'utf8');
const gradleVersion = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
if (gradleVersion !== app.version) {
  fail(`app.json says version ${app.version}, app/android/app/build.gradle says ${gradleVersion}. Bump both.`);
}

// 10. buildNumber: an integer string, which Apple requires to increase on
//     every upload of a version.
if (!/^[1-9]\d*$/.test(ios.buildNumber ?? '')) {
  fail(`expo.ios.buildNumber must be a whole number as a string; got "${ios.buildNumber}".`);
}

// 11. The icon: 1024x1024 and NO alpha channel. Apple rejects transparency at
//     upload, after the archive is built and signed. Byte 25 of IHDR is the
//     PNG colour type; 4 and 6 carry alpha.
const iconPath = resolve(root, 'app', (app.icon ?? './assets/icon.png').replace(/^\.\//, ''));
if (!existsSync(iconPath)) {
  fail(`expo.icon points at ${iconPath}, which does not exist.`);
} else {
  const png = readFileSync(iconPath);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail(`${iconPath} is not a PNG.`);
  } else {
    if (png[25] === 4 || png[25] === 6) fail(`${iconPath} has an alpha channel; Apple rejects it at upload.`);
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (w !== 1024 || h !== 1024) fail(`${iconPath} is ${w}x${h}; the App Store icon must be 1024x1024.`);
  }
}

// 12. Crash reporting on. `app/src/sentry.ts` reads EXPO_PUBLIC_SENTRY_DSN_ANDROID
//     on every native platform (one React Native Sentry project), from the
//     gitignored app/.env.local. Missing, the build succeeds and reports nothing.
const envPath = resolve(root, 'app/.env.local');
const dsn = existsSync(envPath)
  ? /^\s*EXPO_PUBLIC_SENTRY_DSN_ANDROID\s*=\s*(\S+)/m.exec(readFileSync(envPath, 'utf8'))?.[1]
  : undefined;
if (!dsn) {
  fail(
    'app/.env.local has no EXPO_PUBLIC_SENTRY_DSN_ANDROID, so the build would ship with crash reporting OFF.\n' +
      '    It is gitignored; copy it from another machine.',
  );
} else if (!/^https:\/\/[^@]+@/.test(dsn)) {
  fail('EXPO_PUBLIC_SENTRY_DSN_ANDROID does not look like a Sentry DSN.');
}

// 13. The Sentry build variables, needed only where the archive is made.
const missingSentry = ['SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_AUTH_TOKEN'].filter((v) => !process.env[v]);
if (missingSentry.length) {
  warn(
    `${missingSentry.join(', ')} not set in this shell. Harmless except on the Mac that\n` +
      '    archives; there the build succeeds and uploads no dSYMs. scripts/build-ios.sh\n' +
      '    loads them from app/.env.sentry-build-plugin (docs/IOS-BUILD.md).',
  );
}

// 14. The privacy manifest. Expo writes ios/<App>/PrivacyInfo.xcprivacy from
//     this key at prebuild; absent, the archive builds and Apple rejects the
//     upload afterwards. What the app COLLECTS can only be declared here, and
//     App Store Connect's App Privacy answers must agree with it.
const pm = ios.privacyManifests;
if (!pm) {
  fail('app.json has no expo.ios.privacyManifests.');
} else {
  if (!Array.isArray(pm.NSPrivacyCollectedDataTypes) || pm.NSPrivacyCollectedDataTypes.length === 0) {
    fail('expo.ios.privacyManifests declares no NSPrivacyCollectedDataTypes.');
  }
  if (pm.NSPrivacyTracking !== false) {
    fail('expo.ios.privacyManifests.NSPrivacyTracking must be false; the app does not track.');
  }
  if ((pm.NSPrivacyCollectedDataTypes ?? []).some((t) => t.NSPrivacyCollectedDataTypeTracking !== false)) {
    fail('every collected data type must say NSPrivacyCollectedDataTypeTracking: false.');
  }
}

if (warnings.length > 0) {
  console.warn('\niOS config warnings (build-machine only)\n');
  for (const w of warnings) console.warn(`  ! ${w}\n`);
}
if (problems.length > 0) {
  console.error('\niOS config check FAILED\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log(`iOS config ok (${ios.bundleIdentifier}, v${app.version} build ${ios.buildNumber})`);
