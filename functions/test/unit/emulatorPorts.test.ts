import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every place this checkout states an emulator or dev-server port agrees.
 *
 * Three Sabeel repos share one machine, and every one of them used to pin the
 * same ports — so whichever suite started second SIGTERMed the other's
 * Firestore, and both sessions spent real time diagnosing symptoms that belonged
 * to the other process. Each checkout now owns a disjoint block.
 *
 * The ports cannot live in one file. Five consumers need five representations:
 *
 *   firebase.json               JSON   what the emulators actually bind
 *   app/src/env.ts              TS     inlined into the client bundle
 *   scripts/lib/ports.mjs       ESM    read by scripts/*.mjs
 *   free-emulator-ports.sh      shell  the kill list
 *   e2e-stack.sh                shell  the browser suites' web dev-server ports
 *
 * So the goal is not one copy, it is copies that cannot drift. A mismatch is
 * otherwise silent until something connects to a port nobody is serving — or,
 * far worse, to a port a SIBLING REPO is serving, which reads and writes
 * happily and passes.
 *
 * Lives in `functions/test/unit` because that workspace is the only one here
 * with a runner wired up; it asserts about repo files, not about functions.
 * Same reasoning as `ciCoverage.test.ts` next door.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

/** `firebase.json` — what the emulator suite binds. */
function portsFromFirebaseJson(): Record<string, number> {
  const emulators = JSON.parse(read('firebase.json')).emulators as Record<
    string,
    { port?: number; websocketPort?: number }
  >;
  const out: Record<string, number> = {};
  for (const [service, cfg] of Object.entries(emulators)) {
    if (cfg && typeof cfg.port === 'number') out[service] = cfg.port;
    if (cfg && typeof cfg.websocketPort === 'number') {
      out.firestoreWebsocket = cfg.websocketPort;
    }
  }
  return out;
}

/**
 * The client's copy. Parsed rather than imported: `app/src/env.ts` imports
 * `react-native`, which will not load under the functions workspace's vitest.
 */
function portsFromClient(): Record<string, number> {
  const block = read('app/src/env.ts').match(/EMULATOR_PORTS\s*=\s*\{([^}]*)\}/)?.[1];
  if (!block) throw new Error('EMULATOR_PORTS not found in app/src/env.ts');
  return Object.fromEntries(
    [...block.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
}

/** The emulator project id, from the shared constant the app and functions read. */
function projectFromShared(): string {
  const m = read('packages/shared/src/constants.ts').match(
    /EMULATOR_PROJECT_ID\s*=\s*'([^']+)'/);
  if (!m) throw new Error('EMULATOR_PROJECT_ID not found in packages/shared/src/constants.ts');
  return m[1];
}

/** Every `--project` flag in the shell runners. */
function projectsFromShell(): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = [];
  for (const f of ['scripts/test-emulator.sh', 'scripts/e2e-stack.sh']) {
    for (const m of read(f).matchAll(/--project\s+(\S+)/g)) {
      out.push({ file: f, value: m[1] });
    }
  }
  return out;
}

/** The scripts' copy. */
async function portsFromScripts(): Promise<{
  emulator: Record<string, number>;
  mediaStore: Record<string, number>;
  web: Record<string, number>;
}> {
  const mod = await import(resolve(REPO, 'scripts/lib/ports.mjs'));
  return { emulator: mod.EMULATOR_PORTS, mediaStore: mod.MEDIA_STORE_PORTS, web: mod.WEB_PORTS };
}

/** `{a: 1}` → `{'prefix.a': 1}`, so two maps can be merged without a clash. */
function prefixed(prefix: string, ports: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(ports).map(([k, v]) => [`${prefix}.${k}`, v]));
}

/** The shell kill list — a flat set of numbers, not a service map. */
function portsFromShell(): number[] {
  const line = read('scripts/free-emulator-ports.sh').match(/^PORTS=\(([^)]*)\)/m)?.[1];
  if (!line) throw new Error('PORTS=(…) not found in scripts/free-emulator-ports.sh');
  return line.trim().split(/\s+/).map(Number);
}

/** The browser suites' web ports, set in shell before Node ever sees them. */
function webPortsFromShell(): { sweep: number; e2e: number } {
  const sh = read('scripts/e2e-stack.sh');
  const sweep = sh.match(/^\s*screens\) WEB_PORT="\$\{SWEEP_WEB_PORT:-(\d+)\}"/m);
  const e2e = sh.match(/^\s*web\) WEB_PORT=(\d+);/m);
  if (!sweep || !e2e) throw new Error('a WEB_PORT for screens or web not found in scripts/e2e-stack.sh');
  return { sweep: Number(sweep[1]), e2e: Number(e2e[1]) };
}

/**
 * This checkout's block. Bases are 100 apart, one per repo on this machine.
 *
 * 61300+ because the ephemeral range here is 32768-60999
 * (`/proc/sys/net/ipv4/ip_local_port_range`) so nothing above it is handed out
 * at random, and Firebase's own defaults top out at 9499
 * (`firebase-tools/lib/emulator/constants.js`) so the block collides with
 * nothing the CLI would choose for itself.
 */
const BLOCK_START = 61300;
const BLOCK_END = BLOCK_START + 99;

describe('emulator ports agree across every file that states them', () => {
  it('every port is inside this checkout\u2019s block', async () => {
    const { emulator, mediaStore, web } = await portsFromScripts();
    const all = { ...emulator, ...prefixed('mediaStore', mediaStore), ...web };
    expect(Object.keys(all).length).toBeGreaterThan(0);

    for (const [service, port] of Object.entries(all)) {
      expect(
        port >= BLOCK_START && port <= BLOCK_END,
        `${service}=${port} is outside ${BLOCK_START}-${BLOCK_END} — that is another checkout's territory`,
      ).toBe(true);
    }
  });

  it('no two services claim the same port', async () => {
    const { emulator, mediaStore, web } = await portsFromScripts();
    expect(Object.keys(emulator).length).toBeGreaterThan(0);
    expect(Object.keys(mediaStore).length).toBeGreaterThan(0);
    expect(Object.keys(web).length).toBeGreaterThan(0);

    const all = [...Object.values(emulator), ...Object.values(mediaStore), ...Object.values(web)];
    expect(new Set(all).size, 'two services claim the same port').toBe(all.length);
  });

  it('firebase.json matches scripts/lib/ports.mjs', async () => {
    const { emulator } = await portsFromScripts();
    const config = portsFromFirebaseJson();

    // Guard the guard: an empty parse would make every comparison below
    // trivially true, which is the failure mode this whole file exists to stop.
    expect(Object.keys(config).length).toBeGreaterThan(0);

    for (const [service, port] of Object.entries(config)) {
      expect(emulator[service], `firebase.json ${service}=${port}`).toBe(port);
    }
  });

  /*
   * EVERY EMULATOR THE SUITE STARTS, pinned, including the two it starts by
   * itself: the task queue (for `copyZoomFile`) and Eventarc (for the
   * Firestore triggers). Left at their defaults, 9499 and 9299, they are the
   * same ports every sibling repo's suite takes, and on 2026-10-16 this
   * checkout's suite would not start while a sibling's ran
   * ("EADDRINUSE 127.0.0.1:9499").
   */
  it('firebase.json pins every emulator the suite starts, the implicit ones too', () => {
    const config = portsFromFirebaseJson();
    for (const service of ['firestore', 'auth', 'functions', 'ui', 'hub', 'logging', 'tasks', 'eventarc']) {
      expect(config[service], `firebase.json has no port for ${service}`).toBeTypeOf('number');
    }
  });

  it('the client bundle uses the same ports as the scripts', async () => {
    const { emulator } = await portsFromScripts();
    const client = portsFromClient();
    expect(Object.keys(client).length).toBeGreaterThan(0);

    for (const [service, port] of Object.entries(client)) {
      expect(emulator[service], `app/src/env.ts ${service}=${port}`).toBe(port);
    }
  });

  it('free-emulator-ports.sh frees exactly the emulator and media store ports', async () => {
    const { emulator, mediaStore } = await portsFromScripts();
    const shell = portsFromShell();
    expect(shell.length).toBeGreaterThan(0);
    const bound = { ...emulator, ...prefixed('mediaStore', mediaStore) };

    // Every port we bind must be swept…
    for (const [service, port] of Object.entries(bound)) {
      expect(shell, `${service}=${port} is not in the PORTS array`).toContain(port);
    }
    // …and nothing else, or the sweep reaches into another checkout's block.
    // That is not hypothetical: on 2026-08-27 a port-based sweep killed a
    // sibling repo's running emulator.
    const owned = new Set(Object.values(bound));
    for (const port of shell) {
      expect(owned.has(port), `PORTS contains ${port}, which this checkout does not own`).toBe(
        true,
      );
    }
  });

  it('the suites and their runner agree on the web ports', async () => {
    const { web } = await portsFromScripts();
    const shell = webPortsFromShell();
    expect(shell.sweep, 'e2e-stack.sh screens WEB_PORT vs WEB_PORTS.sweep').toBe(web.sweep);
    expect(shell.e2e, 'e2e-stack.sh web WEB_PORT vs WEB_PORTS.e2e').toBe(web.e2e);
  });
});


/**
 * The emulator project id, which is a diagnostic as much as a config value.
 *
 * A sibling repo on this machine used the same id, so `ps` showed two identical
 * `--project` lines and there was no way to tell which checkout owned which
 * emulator — the exact check that failed when one session killed another's.
 *
 * It is also load-bearing: `isEmulatorProject()` in `functions/src/env.ts`
 * compares `GCLOUD_PROJECT` against the shared constant, and a mismatch makes
 * the media store reach for the production R2 keys instead of the local ones. So the shell runners' `--project`, the shared constant and the
 * scripts' copy must agree.
 */
describe('the emulator project id agrees everywhere it is stated', () => {
  it('scripts/lib/project.mjs matches the shared constant', async () => {
    const mod = await import(resolve(REPO, 'scripts/lib/project.mjs'));
    expect(mod.EMULATOR_PROJECT_ID).toBe(projectFromShared());
  });

  it('every shell --project flag matches the shared constant', () => {
    const shared = projectFromShared();
    const flags = projectsFromShell();
    expect(flags.length, 'no --project flags found — the parse is broken').toBeGreaterThan(0);
    for (const { file, value } of flags) {
      expect(value, `${file} passes --project ${value}`).toBe(shared);
    }
  });

  it('is not the id a sibling checkout uses', () => {
    // Distinctness is the whole point: a shared id makes `ps` useless for
    // telling two running emulators apart.
    expect(projectFromShared()).not.toBe('demo-sabeel');
  });
});

/**
 * No script still points at a port this checkout gave up.
 *
 * The port move updated firebase.json, the client, ports.mjs and the sweep
 * lists — and in the sibling kanban repo it MISSED `dev.sh`'s readiness waits,
 * which are live code, plus the copy-paste instructions at the top of eleven
 * operator scripts. Nothing caught it, because no suite runs `dev.sh` and a
 * comment cannot fail a test. This is the guard that would have.
 *
 * Matching `host:port` rather than the bare number on purpose: 4000 and 8000
 * also appear as millisecond timeouts, and a check that cries wolf gets deleted.
 */
const ABANDONED_PORTS = [8080, 9099, 5001, 9199, 9150, 4000, 4400, 4500, 8086, 8083];

function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(REPO, rel)).isDirectory()) out.push(...scriptFiles(rel));
    else if (/\.(mjs|sh|js|ts)$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('no script points at a port this checkout gave up', () => {
  it('scripts/ mentions no abandoned host:port', () => {
    const files = scriptFiles('scripts');
    expect(files.length, 'found no scripts to scan — the walk is broken').toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const port of ABANDONED_PORTS) {
        const re = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`);
        if (re.test(text)) offenders.push(`${file} -> :${port}`);
      }
    }
    expect(offenders, `stale port references:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
