import { EMULATOR_PROJECT_ID } from '@sabeel/shared';

/**
 * Whether this process is running against the demo project, i.e. the emulator
 * suite.
 *
 * Keyed off the running PROJECT ID rather than a bare env var on purpose: an
 * `EXPO_PUBLIC_USE_EMULATORS`-style flag can be left set in a shell that then
 * deploys, whereas the project id is whatever is actually being talked to. Two
 * things depend on getting this right — which keys the media store signs with
 * (`mediaStore.ts`), and which functions exist at all (`index.ts`).
 */
export function isEmulatorProject(): boolean {
  return (process.env.GCLOUD_PROJECT ?? '') === EMULATOR_PROJECT_ID;
}
