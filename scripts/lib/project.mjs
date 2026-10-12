/**
 * The emulator project id for this checkout — the one place `scripts/*.mjs`
 * read it.
 *
 * It used to be `demo-sabeel`, which a sibling Sabeel repo on this machine also
 * used. Nothing crossed between them (the emulator hub detects a live locator,
 * warns and skips), but every diagnostic went blind: `ps` showed two identical
 * `--project demo-sabeel` lines, so there was no way to tell which checkout
 * owned which emulator. That is precisely the check that failed when one session
 * killed another's emulator.
 *
 * Must stay in step with `packages/shared/src/constants.ts`, which the app and
 * the functions read, and with the `--project` flags in the shell runners.
 * `functions/test/unit/emulatorPorts.test.ts` asserts all of them agree —
 * `isEmulatorProject()` compares `GCLOUD_PROJECT` against the shared constant,
 * and a mismatch there makes the media store reach for the production R2 keys
 * instead of the local SeaweedFS ones.
 */
export const EMULATOR_PROJECT_ID = 'demo-sabeel-recordings';
