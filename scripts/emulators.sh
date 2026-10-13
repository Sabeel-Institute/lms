#!/usr/bin/env bash
# The emulator suite and the local media store, left running for a device
# pass or a dev server (`npm run emulators`). Stop it with Ctrl-C or by
# killing its tmux session; the wrapper stops the media store with it.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/jdk21.sh
source scripts/lib/jdk21.sh

bash scripts/free-emulator-ports.sh
npm run build
exec node scripts/with-media-store.mjs \
  firebase emulators:start --project demo-sabeel-recordings --only firestore,auth,functions
