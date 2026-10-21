import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/native.yml');
const runner = read('scripts/native-e2e.sh');
const appId = /^APP_ID=(\S+)$/m.exec(runner)?.[1];

/** Every flow file, top level and shared, with the app it drives. */
const flows = ['maestro', 'maestro/common'].flatMap((dir) =>
  readdirSync(new URL(`${dir}/`, root)).filter((f) => f.endsWith('.yaml')).map((f) => `${dir}/${f}`));

describe('the native flows', () => {
  it('run on every main push and release tag, all of them, and keep what they saw', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]/);
    expect(workflow).toContain('bash scripts/ci-avd.sh');
    expect(workflow).toMatch(/run: bash scripts\/native-e2e\.sh\n/);
    expect(workflow).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact/);
  });

  it('each drive the app the runner installs', () => {
    expect(appId).toMatch(/^com\.sabeelinstitute\./);
    expect(flows.filter((f) => f.startsWith('maestro/') && !f.includes('/common/')).length).toBeGreaterThan(0);
    for (const flow of flows) expect(read(flow), flow).toMatch(new RegExp(`^appId: ${appId.replace(/\./g, '\\.')}$`, 'm'));
  });
});
