#!/usr/bin/env bash
set -euo pipefail

# The Firebase emulators require JDK 21+. Locally we keep JDK 17 as the default (for the
# Android/Gradle build) and point only the emulators at a user-local JDK 21.
# Resolution order: explicit SR_JDK21_HOME → user-local ~/opt/jdk-21 → whatever java is
# already on PATH (CI provides JDK 21 via setup-java).
if [ -n "${SR_JDK21_HOME:-}" ]; then
  export JAVA_HOME="$SR_JDK21_HOME"
elif [ -d "$HOME/opt/jdk-21" ]; then
  export JAVA_HOME="$HOME/opt/jdk-21"
fi

if [ -n "${JAVA_HOME:-}" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

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
