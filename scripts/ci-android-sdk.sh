#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Install the Android SDK packages the Gradle build would otherwise fetch for
# itself, with retries: the NDK and build tools at the versions React Native's
# version catalog names. Gradle fetches them once and fails the build on a bad
# download, and Google's SDK downloads arrived truncated ("Error on ZipFile
# unknown archive") three times on 2026-10-21. Run after `npm ci`.
#
#   bash scripts/ci-android-sdk.sh

: "${ANDROID_HOME:?ANDROID_HOME is not set}"
catalog=node_modules/react-native/gradle/libs.versions.toml
version() {
  local found
  found=$(sed -n "s/^$1 = \"\(.*\)\"$/\1/p" "$catalog")
  [ -n "$found" ] || { echo "ci-android-sdk.sh: no $1 in $catalog" >&2; exit 1; }
  echo "$found"
}
packages=("ndk;$(version ndkVersion)" "build-tools;$(version buildTools)")
sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

yes | "$sdkmanager" --licenses >/dev/null || true
for attempt in 1 2 3; do
  if "$sdkmanager" --install "${packages[@]}" >/dev/null; then
    echo "Installed ${packages[*]}"
    exit 0
  fi
  echo "SDK install failed (attempt $attempt); retrying" >&2
  sleep 10
done
echo "ci-android-sdk.sh: ${packages[*]} would not install" >&2
exit 1
