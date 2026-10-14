import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

/**
 * The deployed bundle may require nothing Cloud Build will not install.
 *
 * `firebase deploy` ships `functions/` alone and runs `npm install` on THIS
 * package.json; `@sabeel/shared` is inlined by esbuild because it is not on
 * npm. The shared package also carries app-only code with its own dependency
 * (the .xlsx writer on `fflate`), and the first v0.7.0 deploy shipped a
 * `require("fflate")` the functions never call — every container failed its
 * start-up probe with "Cannot find module 'fflate'", and Cloud Run kept the
 * old revisions serving. Nothing local could see it: the emulator resolves
 * the hoisted workspace node_modules, where the module exists.
 *
 * So: build the real bundle with the real config, and hold every bare
 * `require()` in it to a dependency this package declares. A missing one is
 * either a dependency to add here, or — as with `fflate` — a module that
 * should not be in the bundle at all (see `esbuild.config.mjs`).
 */
const FUNCTIONS = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(FUNCTIONS, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const packageOf = (specifier: string) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

describe('the deployed functions bundle', () => {
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: FUNCTIONS, stdio: 'ignore' });
  const bundle = readFileSync(resolve(FUNCTIONS, 'lib/index.js'), 'utf8');
  const required = [...new Set([...bundle.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]))];

  /*
   * NOTHING AT START-UP THAT A COLD START DOES NOT NEED. @sentry/node was more
   * than half of a function's module load (about 300 of 560 ms), paid by every
   * cold start a person waits through; it is loaded at the first report.
   */
  it('does not load Sentry until something is reported', () => {
    const loaded = execFileSync(
      process.execPath,
      ['-e', "require('./lib/index.js'); process.stdout.write(String(Object.keys(require.cache).some((k) => k.includes('/@sentry/node/'))))"],
      { cwd: FUNCTIONS, encoding: 'utf8' },
    );
    expect(loaded).toBe('false');
  });

  it('requires only declared dependencies and node builtins', () => {
    const undeclared = required.filter((s) => !builtins.has(s) && !(packageOf(s) in pkg.dependencies));
    expect(undeclared).toEqual([]);
  });

  it('inlines the shared package rather than requiring it', () => {
    expect(required.some((s) => s.startsWith('@sabeel/'))).toBe(false);
    expect(bundle).toMatch(/packages\/shared\/src\/collections\.ts/);
  });

  it('leaves the app-only workbook writer out', () => {
    expect(bundle).not.toMatch(/fflate|packages\/shared\/src\/xlsx\.ts/);
  });
});
