import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/native.yml');
const runner = read('scripts/native-e2e.sh');

/** Every flow file, top level and shared, with the app it drives. */
const flows = readdirSync(new URL('maestro/', root), { recursive: true })
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => `maestro/${f}`);

describe('the native flows', () => {
  it('run on every main push and release tag, all of them, and keep what they saw', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]/);
    expect(workflow).toContain('bash scripts/ci-avd.sh');
    expect(workflow).toMatch(/run: bash scripts\/native-e2e\.sh\n/);
    expect(workflow).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact/);
  });

  it('each drive the app the runner installs, on either platform', () => {
    // The Android debug build and the iOS build have different ids, so the
    // runner names the one it installed and every flow takes it from there.
    expect(runner).toMatch(/-e APP_ID="\$APP_ID"/);
    expect(runner).toMatch(/^\s*APP_ID=com\.sabeelinstitute\.[a-z.]+$/m);
    expect(runner).toContain("APP_ID=$(node -p \"require('./app/app.json').expo.ios.bundleIdentifier\")");
    expect(flows.filter((f) => !f.slice('maestro/'.length).includes('/')).length).toBeGreaterThan(0);
    for (const flow of flows) expect(read(flow).split('\n'), flow).toContain('appId: ${APP_ID}');
  });

  it('run on the iOS simulator for release tags', () => {
    expect(workflow).toMatch(/\n {2}ios:\n/);
    expect(workflow).toContain('runs-on: macos-');
    expect(workflow).toMatch(/run: bash scripts\/native-e2e\.sh --ios\n/);
  });
});
