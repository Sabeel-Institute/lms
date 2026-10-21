#!/usr/bin/env node
/**
 * Run a command with the local media store (SeaweedFS) up, and take it down
 * after, whatever happens.
 *
 *     node scripts/with-media-store.mjs <command> [args…]
 *
 * Used by `test-emulator.sh`, `e2e-stack.sh` and `npm run emulators`, each of
 * which wraps `firebase emulators:exec|start` in it. The command's exit status
 * is this script's exit status.
 *
 * Signals are forwarded to the command and the store is stopped on the way out:
 * a store left running holds the S3 port, and the next run would then sign URLs
 * against a server whose data directory has already been deleted.
 */
import { spawn } from 'node:child_process';
import { startMediaStore } from './lib/media-store.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: with-media-store.mjs <command> [args…]');
  process.exit(2);
}

const store = await startMediaStore();
const child = spawn(cmd, args, { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
const code = await new Promise((resolve) => {
  child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  child.on('error', (e) => {
    console.error(`could not run ${cmd}: ${e.message}`);
    resolve(127);
  });
});
await store.stop();
process.exit(code);
