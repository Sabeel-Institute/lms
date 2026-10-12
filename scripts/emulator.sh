#!/usr/bin/env bash
# Sabeel Institute LMS Android emulator helper (same AVD as other projects).
# AVD: tb_emu — Pixel 6 (1080x2400), API 35, Google APIs (Play services, so Google
# Sign-In works).
#
#   scripts/emulator.sh headless   # no window (agent/CI automation, software GPU)
#   scripts/emulator.sh window     # visible window for interacting at the computer
#   scripts/emulator.sh list       # show running emulators
#   scripts/emulator.sh kill [serial]
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/opt/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
AVD="${SR_AVD:-tb_emu}"

case "${1:-help}" in
  headless)
    exec emulator -avd "$AVD" -no-window -no-boot-anim -gpu swiftshader_indirect -no-snapshot ;;
  window)
    exec emulator -avd "$AVD" -gpu host -no-snapshot ;;
  list)
    adb devices | grep -E 'emulator-|device$' || echo "no devices" ;;
  kill)
    adb -s "${2:-emulator-5554}" emu kill ;;
  *)
    echo "usage: scripts/emulator.sh {headless|window|list|kill [serial]}" ;;
esac
