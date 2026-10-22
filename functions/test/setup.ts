// Vitest global setup for functions tests. Integration tests expect the Firebase
// emulators (`npm run test:emulator`); unit tests run standalone.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMULATOR_PROJECT_ID } from '@sabeel/shared';

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? EMULATOR_PROJECT_ID;

// The function parameters the functions emulator reads for the demo project,
// loaded the same way here so code under test in this process sees the values
// the emulated triggers see. One file, not a second copy.
const params = readFileSync(resolve(import.meta.dirname, '..', `.env.${EMULATOR_PROJECT_ID}`), 'utf8');
for (const line of params.split('\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2];
}
