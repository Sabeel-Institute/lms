import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every end-to-end suite on disk is actually RUN by CI.
 *
 * A suite that is never invoked is not coverage, it is a file. It stays green on
 * a laptop, its checks never move the totals because they were never counted,
 * and nothing anywhere says so — the sibling kanban lost a 271-check suite to
 * exactly that for a full release, which is why it grew the test this one is
 * modelled on.
 *
 * CI lists its e2e steps one per line by design (each needs its own emulator
 * run), so the list cannot be globbed and has to be kept in step by hand. This
 * is what keeps it honest.
 *
 * Lives in `functions/test/unit` because that is this repo's workspace with a
 * test runner wired up, and beside `firestoreIndexes.test.ts`, which is likewise
 * a test that asserts about repo FILES rather than about the functions.
 */

/**
 * Suites CI cannot run, with the reason. Everything else must have a CI step;
 * see the test below. Empty: `scripts/e2e-stack.sh` starts the emulators and a
 * dev server for one run and owns them, so even the walkthrough, which wipes
 * Firestore and Auth as it goes, runs on a fresh runner.
 */
const LOCAL_ONLY = new Map<string, string>();

const repo = () => resolve(import.meta.dirname, '../../..');
const ciYaml = () => readFileSync(resolve(repo(), '.github/workflows/ci.yml'), 'utf8');
const suitesOnDisk = () =>
  readdirSync(resolve(repo(), 'scripts')).filter((f) => f.endsWith('-e2e.mjs'));

/** The suites `e2e-stack.sh` runs, by the name it is given: `web) … SUITE_SCRIPT=scripts/web-e2e.mjs`. */
function stackSuites(): Map<string, string> {
  const sh = readFileSync(resolve(repo(), 'scripts/e2e-stack.sh'), 'utf8');
  return new Map(
    [...sh.matchAll(/^\s*(\w+)\)[^\n]*SUITE_SCRIPT=scripts\/(\S+-e2e\.mjs)/gm)].map((m) => [m[1], m[2]]),
  );
}

/** The names CI's browser matrix hands `e2e-stack.sh`, or none if CI does not call it. */
function stackRunsInCi(ci: string): string[] {
  if (!ci.includes('bash scripts/e2e-stack.sh')) return [];
  const list = ci.match(/^\s*suite:\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * A suite counts as run if CI names the script, or hands its name to
 * `e2e-stack.sh`, which wraps the emulators and a dev server around it.
 * Demanding the literal `.mjs` path would fail a suite that CI genuinely runs,
 * and the cure for that is always to weaken the check.
 */
function runsInCi(ci: string, suite: string): boolean {
  const stack = stackSuites();
  return ci.includes(`scripts/${suite}`) || stackRunsInCi(ci).some((name) => stack.get(name) === suite);
}

describe('CI e2e coverage', () => {
  it('installs ffmpeg before unit tests generate media samples', () => {
    const ci = ciYaml();
    const install = ci.indexOf('name: Install ffmpeg');
    const tests = ci.indexOf('name: Unit tests');
    expect(install).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(install);
  });

  it('runs every scripts/*-e2e.mjs suite', () => {
    const ci = ciYaml();
    const onDisk = suitesOnDisk();

    // Guard the guard: if the glob ever matches nothing, "all of them are in CI"
    // is trivially true and this test would pass while proving nothing.
    expect(onDisk.length).toBeGreaterThan(0);

    const missing = onDisk
      .filter((f) => !LOCAL_ONLY.has(f))
      .filter((f) => !runsInCi(ci, f));
    expect(missing, `e2e suites on disk but not run by CI: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The exemption is itself checked, because an allowlist nobody verifies is how
   * "temporarily local-only" becomes permanent. If one of these ever DOES get a
   * CI step, this fails and the entry must be deleted — the list cannot quietly
   * outlive its reason.
   */
  it('keeps the local-only list honest', () => {
    const ci = ciYaml();
    const onDisk = new Set(suitesOnDisk());

    for (const [suite, reason] of LOCAL_ONLY) {
      expect(onDisk.has(suite), `${suite} is listed local-only but no longer exists`).toBe(true);
      expect(
        runsInCi(ci, suite),
        `${suite} is now run by CI — delete it from LOCAL_ONLY (was: ${reason})`,
      ).toBe(false);
    }
  });

  /**
   * The sweep specifically, by name.
   *
   * The test above would go quiet if `screens-e2e.mjs` were deleted rather than
   * dropped from CI — an empty obligation is satisfied by removing the thing
   * that created it. This one says out loud that the multi-width sweep is
   * something this repo runs, so losing it takes a deliberate edit here.
   */
  it('runs the multi-width screens sweep', () => {
    expect(suitesOnDisk()).toContain('screens-e2e.mjs');
    expect(runsInCi(ciYaml(), 'screens-e2e.mjs')).toBe(true);
  });

  /** The flow walkthrough, by name, for the same reason. */
  it('runs the flow walkthrough', () => {
    expect(suitesOnDisk()).toContain('web-e2e.mjs');
    expect(runsInCi(ciYaml(), 'web-e2e.mjs')).toBe(true);
  });
});
