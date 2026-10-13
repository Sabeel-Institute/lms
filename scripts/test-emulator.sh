#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib/jdk21.sh
source "$(dirname "$0")/lib/jdk21.sh"

bash "$(dirname "$0")/free-emulator-ports.sh"

# The Functions emulator loads the BUILT bundle (functions/lib, per `main`), not
# the TypeScript. Nothing else in this script builds it, so without this the
# triggers under test are whatever was last compiled — while the test bodies run
# fresh source through vitest. That gap is invisible: the suite still passes, it
# just proves yesterday's trigger. It cost a debugging session on 2026-08-14,
# when the excused-only fan-out was live in src and the emulator kept assigning
# absentees from a two-day-old lib.
npm run build -w @sabeel/shared
npm run build -w functions

# The media store (SeaweedFS, standing in for R2) runs around the emulators:
# the functions sign real URLs against it and the tests read what landed.
exec node scripts/with-media-store.mjs firebase emulators:exec \
  --project demo-sabeel-recordings \
  --only firestore,auth,functions \
  "npm run test:integration -w functions"
