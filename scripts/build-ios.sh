#!/usr/bin/env bash
# Build the iOS app for the App Store WITHOUT touching Xcode's UI.
#
#   bash scripts/build-ios.sh              # archive, export, upload to App Store Connect
#   bash scripts/build-ios.sh --check      # run every gate, build nothing
#   bash scripts/build-ios.sh --no-upload  # archive and export an .ipa, stop there
#
# Runs on the Mac, and on GitHub's macOS runners (.github/workflows/ios.yml).
# The build-machine values (Sentry, Apple team, App Store Connect key ids) come
# from the gitignored app/.env.sentry-build-plugin; nothing has to be exported
# by hand. docs/IOS-BUILD.md is the runbook.
#
# Signing is AUTOMATIC by default: Xcode fetches what it needs through the App
# Store Connect key, which suits a Mac that keeps its keychain. With
# IOS_PROFILE_NAME set it is MANUAL: the app target signs with the Apple
# Distribution identity already in the keychain and that App Store profile, and
# nothing is minted. A fresh CI machine needs that: automatic signing there
# creates a new certificate every run and throws its private key away, until
# Apple's certificate limit stops the builds.
#
# Command line rather than the Xcode GUI because Xcode runs build phases in a
# sanitised environment and, since Xcode 15, ignores the terminal that launched
# it — so a GUI archive cannot see the Sentry token and silently uploads no
# symbols. `xcodebuild` inherits this shell.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=false
UPLOAD=true
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --no-upload) UPLOAD=false ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

die() { echo "$@" >&2; exit 1; }

# ---------------------------------------------------------------- gates

[ "$(uname -s)" = "Darwin" ] || die "build-ios.sh needs macOS: iOS archives cannot be produced elsewhere."
command -v xcodebuild >/dev/null || die "xcodebuild not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
command -v pod >/dev/null || die "CocoaPods not found (pod)."

# A release bundle points at production. Metro inlines every EXPO_PUBLIC_* it
# finds in the environment, so a shell still carrying the dev loop's
# EXPO_PUBLIC_USE_EMULATORS=1 would ship an app that talks to 127.0.0.1, and
# nothing in the archive would say so. Same refusal as scripts/web-release.mjs.
[ -z "${EXPO_PUBLIC_USE_EMULATORS:-}" ] || die "EXPO_PUBLIC_USE_EMULATORS is set in this shell.
A release built from here would point at the local emulators. Unset it (or use a fresh terminal)."

# The build-machine values, loaded BEFORE check:ios so it does not warn about
# variables this script is about to supply.
# shellcheck source=scripts/load-build-env.sh
. scripts/load-build-env.sh

VERSION="$(node -p "require('./app/app.json').expo.version")"
BUILD_NUMBER="$(node -p "require('./app/app.json').expo.ios.buildNumber")"
BUNDLE_ID="$(node -p "require('./app/app.json').expo.ios.bundleIdentifier")"

# The iOS config: plist vs app.json, the Firebase project, the sign-in URL
# scheme, background audio, the version pair, the icon, the privacy manifest,
# the native Sentry DSN in app/.env.local.
npm run --silent check:ios

[ -n "${IOS_TEAM_ID:-}" ] || die "IOS_TEAM_ID is not set.
Put it in app/.env.sentry-build-plugin (developer.apple.com -> Membership details -> Team ID)."

missing_sentry=""
for v in SENTRY_ORG SENTRY_PROJECT SENTRY_AUTH_TOKEN; do
  [ -n "${!v:-}" ] || missing_sentry="${missing_sentry} ${v}"
done
if [ -n "$missing_sentry" ]; then
  echo "WARNING:${missing_sentry} not set — this build uploads no debug symbols," >&2
  echo "so iOS crashes will report raw addresses. Building anyway." >&2
fi

# The App Store Connect API key. Resolved for EVERY build, not only an
# uploading one: `-allowProvisioningUpdates` mints and downloads the
# distribution signing assets THROUGH it, so the archive needs it as much as the
# upload does. ASC_KEY_PATH defaults to where Apple's own tooling looks; `~` is
# expanded here because a dotenv value is a literal string.
if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_KEY_PATH:=${HOME}/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
  ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"
fi

if [ "$UPLOAD" = true ]; then
  [ -n "${ASC_KEY_ID:-}" ] || die "ASC_KEY_ID is not set (the App Store Connect API key id; NOT the APNs key).
Put it in app/.env.sentry-build-plugin with ASC_ISSUER_ID. Use --no-upload to skip uploading."
  [ -n "${ASC_ISSUER_ID:-}" ] || die "ASC_ISSUER_ID is not set (the Issuer ID above the key list; a UUID)."
  [ -f "${ASC_KEY_PATH}" ] || die "No App Store Connect key at:
  ${ASC_KEY_PATH}
Put AuthKey_${ASC_KEY_ID}.p8 in ~/.appstoreconnect/private_keys, or set ASC_KEY_PATH."
fi

# The signing keychain must be USABLE, and the only proof is signing something.
# Over ssh the login keychain is locked (it unlocks at GUI login), while
# `security find-identity` still lists valid identities — so the archive dies
# twenty minutes in, at its first framework, with errSecInternalComponent.
KEYCHAIN="$(security default-keychain -d user | tr -d ' "')"
UNLOCK_HELP="Unlock it, then re-run:

  security unlock-keychain ${KEYCHAIN}

Type the password at the prompt (not -p, which puts it in shell history), IN
THE SAME LOGIN SESSION that runs this script: macOS keeps the unlock per login,
so an unlock typed in another ssh session does not reach this one. A reboot
locks it again."

security show-keychain-info "$KEYCHAIN" >/dev/null 2>&1 || die "The signing keychain is locked:
  ${KEYCHAIN}

${UNLOCK_HELP}"

# No identity is not an error: -allowProvisioningUpdates mints one through the
# App Store Connect key. With one, sign a throwaway binary — the same mechanism
# the archive uses, in a second.
SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/^ *1\)/ {print $2}')"
if [ -n "${IOS_PROFILE_NAME:-}" ] && [ -z "$SIGN_ID" ]; then
  die "IOS_PROFILE_NAME is set (manual signing), but the keychain holds no signing identity.
Import the Apple Distribution .p12 first."
fi
if [ -n "$SIGN_ID" ]; then
  PROBE_DIR="$(mktemp -d)"
  cp /bin/echo "${PROBE_DIR}/probe"
  if ! codesign --force --sign "$SIGN_ID" "${PROBE_DIR}/probe" >/dev/null 2>&1; then
    rm -rf "$PROBE_DIR"
    die "The keychain is unlocked, but codesign cannot USE ${SIGN_ID}.
Usually the private key's ACL refuses a session with no window server:

  security set-key-partition-list -S apple-tool:,apple:,codesign: -s ${KEYCHAIN}

${UNLOCK_HELP}"
  fi
  rm -rf "$PROBE_DIR"
else
  echo "note: no codesigning identity in the keychain; cloud signing mints one during the archive." >&2
fi

# The commit on the sign-in screen. This repo stamps it through
# EXPO_PUBLIC_COMMIT, which Metro inlines when the archive's bundle phase runs
# (xcodebuild inherits this shell). `+` marks a dirty tree: a build that maps
# to no commit. Commit first, then build.
COMMIT="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  COMMIT="${COMMIT}+"
  echo "WARNING: uncommitted changes; this build is stamped ${COMMIT} and maps to no commit." >&2
fi

echo
echo "app          Sabeel Institute LMS (${BUNDLE_ID})"
echo "version      ${VERSION}  (build ${BUILD_NUMBER}, commit ${COMMIT})"
echo "team         ${IOS_TEAM_ID}"
echo "signing      $([ -n "${IOS_PROFILE_NAME:-}" ] && echo "manual, profile \"${IOS_PROFILE_NAME}\"" || echo "automatic")"
echo "symbols      ${SENTRY_PROJECT:-<none>}"
echo "upload       $([ "$UPLOAD" = true ] && echo "yes, to App Store Connect" || echo "no (--no-upload)")"
echo

if [ "$CHECK_ONLY" = true ]; then
  echo "--check: every gate passed; nothing was built."
  exit 0
fi

# ---------------------------------------------------------------- build

export EXPO_PUBLIC_COMMIT="$COMMIT"
# Sentry's build phase lists the npm modules a release contains, looking in
# app/node_modules by default; npm workspaces install them at the repo root,
# so without this the list was empty (the Mac) or missing (a runner).
export MODULES_PATHS="${PWD}/node_modules"

# Regenerate ios/. ALWAYS --platform ios: prebuild is clean by default, and a
# bare one would delete the committed, hand-edited app/android/.
(cd app && CI=1 npx expo prebuild --platform ios --no-install)
(cd app/ios && pod install)

WORKSPACE="$(find app/ios -maxdepth 1 -name '*.xcworkspace' | head -1)"
[ -n "$WORKSPACE" ] || die "no .xcworkspace under app/ios after prebuild + pod install."

# The scheme comes from the APP PROJECT, never the workspace: once pods are
# integrated the workspace has a scheme per pod, the first alphabetically is
# `AppAuth`, and archiving a pod SUCCEEDS with no app inside.
PROJECT="$(find app/ios -maxdepth 1 -name '*.xcodeproj' | head -1)"
[ -n "$PROJECT" ] || die "no .xcodeproj under app/ios after prebuild."
SCHEME="$(xcodebuild -project "$PROJECT" -list -json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const schemes = JSON.parse(s).project.schemes.filter((x) => !/Tests?$/.test(x));
    process.stdout.write(schemes[0] ?? "");
  });')"
[ -n "$SCHEME" ] || die "could not determine the Xcode scheme from $PROJECT."
echo "scheme       ${SCHEME}"

# Manual signing for the APP TARGET ONLY. Passed on the xcodebuild command
# line instead, PROVISIONING_PROFILE_SPECIFIER would reach every pod target too,
# and each fails with "does not support provisioning profiles". The xcodeproj
# gem ships with CocoaPods.
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ARGV[0])
    target = project.native_targets.find { |t| t.name == ARGV[1] } or abort("no target #{ARGV[1]} in #{ARGV[0]}")
    target.build_configurations.select { |c| c.name == "Release" }.each do |c|
      c.build_settings["CODE_SIGN_STYLE"] = "Manual"
      c.build_settings["CODE_SIGN_IDENTITY"] = "Apple Distribution"
      c.build_settings["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
      c.build_settings["PROVISIONING_PROFILE_SPECIFIER"] = ARGV[2]
      c.build_settings["DEVELOPMENT_TEAM"] = ARGV[3]
    end
    attributes = (project.root_object.attributes["TargetAttributes"] ||= {})
    (attributes[target.uuid] ||= {})["ProvisioningStyle"] = "Manual"
    project.save
  ' "$PROJECT" "$SCHEME" "$IOS_PROFILE_NAME" "$IOS_TEAM_ID"
fi

OUT="build-artifacts/ios"
ARCHIVE="${OUT}/${SCHEME}-${VERSION}-${BUILD_NUMBER}.xcarchive"
EXPORT_DIR="${OUT}/export"
rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$OUT"

# All three or none, and the file must exist. Manual signing fetches nothing,
# so it takes neither the key nor -allowProvisioningUpdates.
AUTH=()
PROVISIONING=()
if [ -z "${IOS_PROFILE_NAME:-}" ]; then
  PROVISIONING=(-allowProvisioningUpdates)
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] &&
    [ -n "${ASC_KEY_PATH:-}" ] && [ -f "${ASC_KEY_PATH}" ]; then
    AUTH=(-authenticationKeyPath "${ASC_KEY_PATH}"
          -authenticationKeyID "${ASC_KEY_ID}"
          -authenticationKeyIssuerID "${ASC_ISSUER_ID}")
  fi
fi
# `${AUTH[@]+"${AUTH[@]}"}`, not `"${AUTH[@]}"`: macOS ships bash 3.2, where an
# EMPTY array under `set -u` is an unbound variable.

xcodebuild -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  ${PROVISIONING[@]+"${PROVISIONING[@]}"} \
  ${AUTH[@]+"${AUTH[@]}"} \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" \
  archive

# An archive of a library target is a valid .xcarchive with no app in it, and
# the only downstream symptom is an export error about `method`.
[ -d "$ARCHIVE/Products/Applications" ] || die \
  "archive at $ARCHIVE contains no app — scheme '$SCHEME' is not the app's."

PLIST="${OUT}/ExportOptions.plist"
DESTINATION=$([ "$UPLOAD" = true ] && echo upload || echo export)
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  SIGNING="<key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${IOS_PROFILE_NAME}</string></dict>"
else
  SIGNING="<key>signingStyle</key><string>automatic</string>"
fi
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${DESTINATION}</string>
  <key>teamID</key><string>${IOS_TEAM_ID}</string>
  ${SIGNING}
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLISTEOF

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$PLIST" \
  ${PROVISIONING[@]+"${PROVISIONING[@]}"} \
  ${AUTH[@]+"${AUTH[@]}"}

echo
if [ "$UPLOAD" = true ]; then
  echo "Uploaded v${VERSION} build ${BUILD_NUMBER} to App Store Connect."
  echo "BUMP expo.ios.buildNumber before the next upload: Apple requires it to increase every time."
else
  echo "Exported to ${EXPORT_DIR} (not uploaded)."
fi
