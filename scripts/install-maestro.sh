#!/usr/bin/env bash
set -euo pipefail

# Install the pinned Maestro CLI, checksum-verified, and print its bin directory.
#
#   export PATH="$(bash scripts/install-maestro.sh):$PATH"
#
# Cached under ~/.cache/sabeel-ci; in CI also added to the job's PATH.

VERSION=2.11.0
SHA256=5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a
HOME_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/sabeel-ci/maestro-$VERSION"

if [ ! -x "$HOME_DIR/maestro/bin/maestro" ]; then
  mkdir -p "$HOME_DIR"
  curl --fail --silent --show-error --location --retry 3 --output "$HOME_DIR/maestro.zip" \
    "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$VERSION/maestro.zip"
  actual=$( (sha256sum "$HOME_DIR/maestro.zip" 2>/dev/null || shasum -a 256 "$HOME_DIR/maestro.zip") | cut -d' ' -f1)
  if [ "$actual" != "$SHA256" ]; then
    rm -f "$HOME_DIR/maestro.zip"
    echo "install-maestro.sh: maestro.zip does not match its pinned checksum" >&2
    exit 1
  fi
  unzip -q -o "$HOME_DIR/maestro.zip" -d "$HOME_DIR"
  rm "$HOME_DIR/maestro.zip"
fi
if [ -n "${GITHUB_PATH:-}" ]; then echo "$HOME_DIR/maestro/bin" >> "$GITHUB_PATH"; fi
echo "$HOME_DIR/maestro/bin"
