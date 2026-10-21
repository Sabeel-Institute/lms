/**
 * This checkout's Firebase emulator and dev-server ports — the one place
 * `scripts/*.mjs` read them.
 *
 * Several files have to agree and cannot share a representation: this one (ESM),
 * `firebase.json` (JSON, what the emulators bind), `app/src/env.ts` (TS, inlined
 * into the client bundle at build time), the `PORTS=(…)` array in
 * `free-emulator-ports.sh` and the `WEB_PORT`s in `e2e-stack.sh`
 * (shell). The copies are unavoidable; the copies drifting is not.
 * `functions/test/unit/emulatorPorts.test.ts` asserts they agree, so a change to
 * one of them fails the unit suite in seconds rather than surfacing later as an
 * emulator that answers on a port nobody expected — or, far worse, as a SIBLING
 * repo's emulator answering, which reads and writes happily and passes.
 *
 * 61300+ because this machine's ephemeral range is 32768-60999
 * (`/proc/sys/net/ipv4/ip_local_port_range`), so nothing above it is handed out
 * at random, and Firebase's own defaults top out at 9499
 * (`firebase-tools/lib/emulator/constants.js`), so the block collides with
 * nothing the CLI would pick for itself. The bases are 100 apart, one per repo
 * on this machine, so `61303` reads as "this project, functions" at a glance —
 * the diagnostic that was missing when one session killed another's emulator
 * after misreading a truncated `ps` line.
 */
const PORT_BASE = 61300;

export const EMULATOR_PORTS = {
  firestore: PORT_BASE + 0,
  firestoreWebsocket: PORT_BASE + 1,
  auth: PORT_BASE + 2,
  functions: PORT_BASE + 3,
  ui: PORT_BASE + 4,
  hub: PORT_BASE + 5,
  logging: PORT_BASE + 6,
  // Started by the suite on its own, for `copyZoomFile`'s task queue and the
  // Firestore triggers; at their defaults (9499, 9299) they collided with a
  // sibling repo's suite, and whichever started second failed to start.
  tasks: PORT_BASE + 8,
  eventarc: PORT_BASE + 9,
};

/**
 * The local media store: SeaweedFS standing in for Cloudflare R2
 * (`scripts/lib/media-store.mjs`). `s3` is the only one anything talks to; the
 * rest are SeaweedFS's own master, volume and filer servers, pinned so that it
 * binds nothing outside this block, and all on 127.0.0.1.
 */
export const MEDIA_STORE_PORTS = {
  s3: PORT_BASE + 7,
  master: PORT_BASE + 20,
  masterGrpc: PORT_BASE + 21,
  volume: PORT_BASE + 22,
  volumeGrpc: PORT_BASE + 23,
  filer: PORT_BASE + 24,
  filerGrpc: PORT_BASE + 25,
  s3Grpc: PORT_BASE + 26,
};

/**
 * Expo web dev-server ports. Deliberately two, one per browser suite, so a
 * stale server left by one suite is never mistaken for the other's.
 */
export const WEB_PORTS = {
  sweep: PORT_BASE + 10,
  e2e: PORT_BASE + 11,
};
