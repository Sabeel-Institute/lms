# shellcheck shell=bash
# Source me. Exports the build-machine values from app/.env.sentry-build-plugin.
#
#   . scripts/load-build-env.sh
#
# The iOS archive needs values that must never be committed: the Sentry org,
# project and auth token (dSYM upload), the Apple team id, and the App Store
# Connect API key's ids. `xcodebuild` reads them from the process environment;
# app/.env.local is Expo's, for inlining EXPO_PUBLIC_* into the JS bundle, and
# nothing on the native side reads it. One gitignored file instead of shell
# exports keeps them out of shell history and alive across terminals.
#
# Parsed rather than `source`d: a dotenv file is not shell, and sourcing one
# executes whatever is in it. Values keep any `=` they contain; comments and
# blank lines are skipped. A BLANK value is not a value (the file may carry
# empty placeholders), and a variable already in the environment WINS, so
# `IOS_TEAM_ID=… bash scripts/build-ios.sh` overrides the file.
_sr_env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/app/.env.sentry-build-plugin"

if [ -f "$_sr_env_file" ]; then
  while IFS='=' read -r _sr_key _sr_val || [ -n "$_sr_key" ]; do
    _sr_key="${_sr_key#"${_sr_key%%[![:space:]]*}"}"   # ltrim
    case "$_sr_key" in '' | '#'*) continue ;; esac
    _sr_val="${_sr_val%$'\r'}"
    [ -n "$_sr_val" ] || continue
    [ -z "${!_sr_key:-}" ] || continue
    export "${_sr_key?}=$_sr_val"
  done < "$_sr_env_file"
  unset _sr_key _sr_val
fi
unset _sr_env_file
