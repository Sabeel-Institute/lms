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

# TWO PASSES, because one Functions emulator runs every trigger of the suite,
# one at a time. The rules files write and wipe thousands of documents that
# fire triggers nothing of theirs reads, about 40% of a run's 4,000, and
# a trigger still running when the next test wiped the database held its
# locks until the wipe timed out, while a test waiting for its own trigger
# waited behind the queue. So the rules run first, against Firestore and Auth
# alone, where a write fires nothing. Both passes run whatever the first
# says, and the script fails if either did.
rules=0
firebase emulators:exec \
  --project demo-sabeel-recordings \
  --only firestore,auth \
  "npm run test:rules -w functions" || rules=$?

# Then everything else, with the functions. The media store (SeaweedFS,
# standing in for R2) runs around the emulators: the functions sign real URLs
# against it and the tests read what landed.
bash "$(dirname "$0")/free-emulator-ports.sh"
rest=0
node scripts/with-media-store.mjs firebase emulators:exec \
  --project demo-sabeel-recordings \
  --only firestore,auth,functions \
  "npm run test:integration -w functions" || rest=$?

if [ "$rules" -ne 0 ] || [ "$rest" -ne 0 ]; then
  echo "test:emulator failed: rules pass exit $rules, functions pass exit $rest" >&2
  exit 1
fi
