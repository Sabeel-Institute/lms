#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Runner for the browser suites: emulators + an Expo web dev server, both
# started here and both torn down on exit. CI runs exactly these commands.
#
#   bash scripts/e2e-stack.sh screens                   # the multi-width sweep
#   SWEEP_WIDTHS=320 bash scripts/e2e-stack.sh screens  # one width, tight loop
#   SWEEP_FULL=1 bash scripts/e2e-stack.sh screens      # + real device profiles
#   bash scripts/e2e-stack.sh web                       # the flow walkthrough
#   bash scripts/e2e-stack.sh push                      # every notification, tapped
#
# It owns both processes for the length of one run, so a suite composes with a
# fresh CI runner instead of fighting a developer's desk. The sweep seeds its
# own world under ids nobody else uses; the walkthrough wipes Firestore and Auth
# as it goes, which is harmless here because the emulators are this run's own.
# To drive the walkthrough against a stack you already started (`npm run
# emulators` and a dev server on the `web` port), run `node scripts/web-e2e.mjs`.
#
# Ports, the emulator project, the JDK and the functions' secret placeholders
# come from ci-tools (`npx sabeel-ci ports`, `ports --project`, `jdk21`,
# `emulator-secrets`); no port or project is stated here.

SUITE="${1:-}"
case "$SUITE" in
  screens) PORT_NAME=sweep; SUITE_SCRIPT=scripts/screens-e2e.mjs ;;
  web) PORT_NAME=web; SUITE_SCRIPT=scripts/web-e2e.mjs ;;
  push) PORT_NAME=web; SUITE_SCRIPT=scripts/push-e2e.mjs ;;
  *)
    echo "usage: bash scripts/e2e-stack.sh screens|web|push" >&2
    exit 2
    ;;
esac

# The sweep on the block's `sweep` port, the walkthrough and the push suite on
# its `web` port.
# Two suites that grab the same port cannot be run side by side, and the
# failure mode is not "port busy" — see the stale server note below.
WEB_PORT=$(npx --no sabeel-ci ports "$PORT_NAME")
if [ "$SUITE" = screens ] && [ -n "${SWEEP_WEB_PORT:-}" ]; then WEB_PORT=$SWEEP_WEB_PORT; fi
PROJECT=$(npx --no sabeel-ci ports --project)

# The Firebase emulators need JDK 21 or later; the Android build keeps 17 as
# the default `java`, so only this run is pointed at 21.
JAVA_HOME=$(npx --no sabeel-ci jdk21)
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"

# Repo-local, not /tmp. Three sibling checkouts share this machine and all three
# used the same generic /tmp log names, so a concurrent run overwrote the log
# this one is grepping for readiness — and the readiness grep below is what
# decides whether the suite proceeds against a stale server. `shots/` is
# gitignored and is where this run's output already goes.
# ABSOLUTE: the dev server is started from a subshell that cd's into app/,
# while the readiness grep below runs from the repo root. A relative path
# would mean two different files and a readiness check that never matches.
WEB_LOG="$PWD/shots/expo-${SUITE}-e2e.log"
mkdir -p "$(dirname "$WEB_LOG")"
: > "$WEB_LOG"
export E2E_BASE="http://127.0.0.1:${WEB_PORT}/" E2E_WEB="http://127.0.0.1:${WEB_PORT}/"

npx --no sabeel-ci free-emulator-ports

# The functions emulator loads the BUILT bundle (functions/lib, per `main`), not
# the TypeScript, and the tests would pass against yesterday's triggers without
# this. Every suite needs
# `getPlaybackUrl` for the player screen and `onUserCreate` to provision the
# staff accounts they sign in as, so a stale lib here is a screen that renders
# an error instead of a layout.
npm run build -w @sabeel/shared
npm run build -w functions
# The placeholders for the secrets the functions bind (ci.emulatorSecrets),
# without which the Functions emulator asks Secret Manager for each one.
npx --no sabeel-ci emulator-secrets

# Kill anything already on the web port. A LEFTOVER dev server is the nastiest
# failure here: the new `expo start` cannot bind, exits quietly, and the
# readiness poll below gets a cheerful 200 from the stale process — so the whole
# suite runs against OLD code and reports failures for a diff that never
# reached the browser. Kill by port, never `pkill -f "expo start"`: that pattern
# also matches the agent shell that spawned this and takes the caller with it.
# Owners of a port, by port. `ss`, not `lsof`: lsof is NOT on the default
# non-interactive PATH on this box, and both uses below silence stderr — so a
# missing lsof is indistinguishable from "no listener", and BOTH the stale-server
# kill and the cleanup trap become silent no-ops. That is the two safety
# mechanisms in this script switching off with nothing to show for it. Measured:
# `lsof -ti:<port> ... | wc -l` returns 0 without the toolchain env sourced
# while a server is demonstrably bound. `sabeel-ci free-emulator-ports` uses `ss`
# for this on Linux too.
pids_on_port() {
  ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u
}

for p in $(pids_on_port "$WEB_PORT"); do
  echo "killing stale dev server on ${WEB_PORT} (pid $p)"
  kill "$p" 2>/dev/null || true
done
sleep 2

cleanup() {
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  for p in $(pids_on_port "$WEB_PORT"); do
    kill "$p" 2>/dev/null || true
  done
  # Also on the way OUT, not just on the way in. A killed run leaves functions
  # runtime workers that hold no port, so nothing notices them and the next run
  # starts happily — then a later one dies partway with a connection refused
  # against its own dev server. Sweeping here means an interrupted run cleans up
  # after itself instead of taxing the next one.
  npx --no sabeel-ci free-emulator-ports >/dev/null 2>&1 || true
}
# EXIT alone, and NOT `EXIT INT TERM` — which is the opposite of the usual
# advice and was measured rather than reasoned. Bash defers a TRAPPED signal
# until the current foreground command finishes, and the foreground command here
# is `firebase emulators:exec`, which runs for minutes. Measured on this box with
# a 2s foreground command: `EXIT` cleaned up at 406ms, `EXIT INT TERM` at 2056ms
# — i.e. only once the foreground command ended. Untrapped, the shell dies at
# once on the signal and bash still runs the EXIT trap, which is what we want.
# (A Node harness is the reverse case: its handlers fire immediately, so there
# the explicit signal handlers ARE the fix.)
trap cleanup EXIT

# The web suite also drives the export as Hosting gets it, tree-shaken, pointed
# at the emulators (web-e2e.mjs, "The export"). Built first: the dev server
# below clears Metro's cache again anyway.
if [ "$SUITE" = web ]; then
  echo "Building the web export (sabeel-ci build-web --emulators)…"
  npx --no sabeel-ci build-web --emulators >/dev/null
fi

echo "Starting Expo web dev server on ${WEB_PORT}…"
# The DEV server, not an export: `expo export` sets __DEV__ false, which
# correctly strips the emulator dev sign-in row every suite drives to reach any
# authenticated screen at all. `--clear` because Metro will otherwise serve a
# bundle built under different EXPO_PUBLIC_* values.
( cd app && CI=1 EXPO_PUBLIC_USE_EMULATORS=1 \
    npx expo start --web --port "$WEB_PORT" --clear >"$WEB_LOG" 2>&1 ) &
WEB_PID=$!

ready=""
for _ in $(seq 1 120); do
  if grep -qi "is being used by another process" "$WEB_LOG" 2>/dev/null; then
    echo "Another process grabbed port ${WEB_PORT}; refusing to test stale code." >&2
    exit 1
  fi
  if curl -sf -o /dev/null "http://127.0.0.1:${WEB_PORT}/"; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "Expo web dev server never became ready — see $WEB_LOG" >&2
  tail -25 "$WEB_LOG" >&2 || true
  exit 1
fi

# NOT `exec`, deliberately. `exec` replaces this shell with firebase, so the EXIT
# trap above never runs and the dev server it started is orphaned — every run
# leaking one, indefinitely, while the script advertises that it cleans up. The
# leak self-heals only because the pre-run kill above catches the previous run's
# straggler, which is what kept it invisible. `set -e` still propagates the exit
# status, and now the trap actually fires. The reference implementation this was
# modelled on has the same bug.
node scripts/with-media-store.mjs firebase emulators:exec \
  --project "$PROJECT" \
  --only firestore,auth,functions \
  "node ${SUITE_SCRIPT}"
