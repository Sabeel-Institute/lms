// Refuse to start if port 8081 belongs to a DIFFERENT project's Metro.
//
// The Android emulator reaches Metro at 10.0.2.2:8081 — the host machine, port
// 8081, directly. `adb reverse` does not intercept that, and Metro's port cannot
// simply be moved without also rebuilding the native app. So whoever holds 8081
// serves our app.
//
// This machine has several React Native projects (kanban, time-tracker, PineTimeCompanion).
// A leftover Metro from one of them on 8081 serves ITS bundle to this app: the
// Gradle build succeeds, the install succeeds, and the app boots showing a red
// screen full of another repo's module paths. Easy to misread as a bug in this
// project. Fail loudly instead. (Observed in the kanban repo on 2026-07-19,
// which is where this guard was written; copied here 2026-08-28 because the
// port is shared and the guard was not.)
import { execSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 8081;
// Real path: on macOS the checkout is reachable both as /Users/… and through
// /Volumes/<disk>/Users/…, and lsof reports a cwd by its real path.
const APP_DIR = realpathSync(resolve(import.meta.dirname, '..', 'app'));
const MAC = process.platform === 'darwin';

function pidsOnPort(port) {
  // macOS has no `ss` (and no /proc), so there the answer comes from lsof,
  // which exits 1 when nothing listens. Without this branch `ss` failed to
  // start, the catch read that as "nothing listening", and the guard passed
  // on the Mac whatever held the port.
  if (MAC) {
    try {
      return execSync(`lsof -nP -ti TCP:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split('\n')
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
    } catch {
      return []; // nothing listening
    }
  }
  try {
    // `ss`, not `lsof`. This guard protects the ONE port that cannot be moved
    // into a per-repo block (Metro 8081, which the Android emulator reaches
    // directly at 10.0.2.2:8081), and `lsof` is not on PATH in a
    // non-interactive shell without the toolchain env sourced — so the catch
    // below turned the whole guard into a no-op that always said "free",
    // exactly where it mattered most. `ss` is in /usr/bin and always present.
    return execSync(`ss -lptn 'sport = :${port}'`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .flatMap((line) => line.match(/pid=(\d+)/)?.[1] ?? [])
      .filter((v, i, a) => a.indexOf(v) === i);
  } catch {
    return []; // nothing listening
  }
}

function cwdOf(pid) {
  try {
    if (MAC) {
      const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
    }
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/*
 * FAILS CLOSED. `cwdOf` returns null when `/proc/<pid>/cwd` cannot be read —
 * which on this machine is exactly the case of a process belonging to ANOTHER
 * USER, so `cwd &&` dropped precisely the processes most likely to be foreign.
 * That is the same shape as the `lsof` bug this file's own header describes: a
 * guard whose failure mode is "all clear".
 */
const foreign = pidsOnPort(PORT)
  .map((pid) => ({ pid, cwd: cwdOf(pid) }))
  .filter(({ cwd }) => cwd === null || !cwd.startsWith(APP_DIR));

if (foreign.length > 0) {
  console.error(`\n✖ Port ${PORT} is held by a Metro from another project:\n`);
  for (const { pid, cwd } of foreign) {
    console.error(`    pid ${pid}  ${cwd ?? '(cwd unreadable — another user’s process)'}`);
  }
  console.error(
    `\n  The Android emulator reaches Metro at 10.0.2.2:${PORT}, so that server would\n` +
      `  serve ITS bundle to this app — the red screen you'd get is misleading.\n\n` +
      `  Stop it first (in that project's terminal), or:  kill ${foreign.map((f) => f.pid).join(' ')}\n`,
  );
  process.exit(1);
}
