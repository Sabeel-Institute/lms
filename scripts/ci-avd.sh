#!/usr/bin/env bash
set -euo pipefail

# Boot an Android emulator on a GitHub-hosted Linux runner and wait for it:
# API 35, Google APIs, x86_64, a Pixel 6 screen, like this machine's tb_emu.
# Locally use scripts/emulator.sh; this one needs the runner's sudo and SDK.
#
#   bash scripts/ci-avd.sh

: "${ANDROID_HOME:?ANDROID_HOME is not set}"
if [ "${GITHUB_ACTIONS:-}" != true ]; then
  echo "ci-avd.sh boots an emulator on a GitHub runner; locally use scripts/emulator.sh" >&2
  exit 2
fi

IMAGE="system-images;android-35;google_apis;x86_64"
TOOLS="$ANDROID_HOME/cmdline-tools/latest/bin"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
echo "$ANDROID_HOME/platform-tools" >> "$GITHUB_PATH"
# One place for the AVD, named for avdmanager and the emulator alike: left to
# their defaults on a runner they disagree, and the emulator exits with
# "Unknown AVD name".
export ANDROID_AVD_HOME="$RUNNER_TEMP/avd"
mkdir -p "$ANDROID_AVD_HOME"

# The runners have KVM, but only root may open /dev/kvm until this rule.
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
  | sudo tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm

yes | "$TOOLS/sdkmanager" --licenses >/dev/null || true
"$TOOLS/sdkmanager" --install emulator platform-tools "$IMAGE" >/dev/null
echo no | "$TOOLS/avdmanager" create avd --name ci --package "$IMAGE" --device pixel_6 --force
emulator -list-avds | grep -qx ci || { echo "avdmanager made no AVD named ci in $ANDROID_AVD_HOME" >&2; exit 1; }

nohup emulator -avd ci -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on -memory 4096 -cores 2 \
  >"$RUNNER_TEMP/emulator.log" 2>&1 &
EMULATOR_PID=$!

# Bounded, and failing the moment the emulator dies: `adb wait-for-device`
# waits forever for an emulator that has already exited.
deadline=$((SECONDS + 600))
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo "The emulator exited before it booted" >&2
    tail -40 "$RUNNER_TEMP/emulator.log" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "The emulator did not finish booting in 10 minutes" >&2
    tail -40 "$RUNNER_TEMP/emulator.log" >&2
    exit 1
  fi
  sleep 5
done
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$setting" 0
done
adb shell input keyevent 82
echo "Emulator booted: $(adb shell getprop ro.build.version.release | tr -d '\r'), $(adb shell wm size | tr -d '\r')"
