import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildLabel, crashLines, devRowShown, labelProblem, screenTexts } from '../../../scripts/check-release.mjs';

const workflow = readFileSync(new URL('../../../.github/workflows/android.yml', import.meta.url), 'utf8');
const sha = 'f66ae31c8d1fb8099fa9e351cc925dca631ace2d';

describe('the release build check', () => {
  it('reads the build label from the sign-in screen', () => {
    expect(buildLabel(['Sign in with Google', 'v0.2.1 · f66ae31'])).toEqual({ version: '0.2.1', commit: 'f66ae31', dirty: false });
    expect(buildLabel(['v0.29.1 · ba63147+'])).toEqual({ version: '0.29.1', commit: 'ba63147', dirty: true });
    expect(buildLabel(['Sabeel Institute LMS · v0.2.0 · dev'])).toBeNull();
    expect(buildLabel(['Sign in with Google'])).toBeNull();
  });

  it('accepts only this version, this commit and a clean tree', () => {
    expect(labelProblem({ version: '0.2.1', commit: 'f66ae31', dirty: false }, '0.2.1', sha)).toBeNull();
    expect(labelProblem({ version: '0.2.0', commit: 'f66ae31', dirty: false }, '0.2.1', sha)).toMatch(/v0\.2\.0/);
    expect(labelProblem({ version: '0.2.1', commit: '7f1f5f5', dirty: false }, '0.2.1', sha)).toMatch(/7f1f5f5/);
    expect(labelProblem({ version: '0.2.1', commit: 'f66ae31', dirty: true }, '0.2.1', sha)).toMatch(/uncommitted/);
    expect(labelProblem(null, '0.2.1', sha)).toMatch(/no build label/);
  });

  it("sees each app's emulator-only sign-in row, and nothing else", () => {
    for (const row of ['Emulator sign-in (dev only)', 'Dev sign-in (emulator only)', 'Dev (emulator) sign-in', 'Dev: sign in']) {
      expect(devRowShown(['Sign in with Google', row]), row).toBe(true);
    }
    expect(devRowShown([
      'Sign in with Google', 'Sign in with email', 'Email me a password link',
      'Staff: sign in with your Sabeel Google account. An admin approves new accounts.',
      'New accounts need an administrator’s approval before you can use the boards.',
    ])).toBe(false);
  });

  it("finds this app's crashes and hangs in the device log, and no other app's", () => {
    const pkg = 'com.sabeelinstitute.kanban';
    const log = [
      '10-21 07:46:48.304  6122  6122 F DEBUG   : pid: 5981, tid: 6082, name: mqt_v_js  >>> com.sabeelinstitute.kanban <<<',
      '10-21 07:50:01.000  7001  7001 E AndroidRuntime: Process: com.sabeelinstitute.kanban, PID: 7001',
      '10-21 07:51:00.000   500   600 E ActivityManager: ANR in com.sabeelinstitute.kanban (com.sabeelinstitute.kanban/.MainActivity)',
      '10-21 07:52:00.000  7101  7101 E AndroidRuntime: Process: com.sabeelinstitute.kanban.debug, PID: 7101',
      '10-21 07:53:00.000  6122  6122 F DEBUG   : pid: 1, tid: 2, name: x  >>> com.google.android.gms <<<',
      '10-21 07:54:00.000  7001  7001 I ReactNativeJS: Running "main"',
    ].join('\n');
    expect(crashLines(log, pkg)).toHaveLength(3);
    expect(crashLines(log, 'com.sabeelinstitute.lms')).toEqual([]);
  });

  it('reads texts and content descriptions out of a uiautomator dump', () => {
    const xml = '<hierarchy><node text="Sign in with Google" content-desc="" /><node text="" content-desc="Privacy policy" />'
      + '<node text="Arabic I &amp; Qur&#10;anic" /></hierarchy>';
    expect(screenTexts(xml)).toEqual(['Sign in with Google', 'Privacy policy', 'Arabic I & Qur\nanic']);
  });
});

describe('the Android workflow', () => {
  it('checks the bundle it built on an emulator, so a failed check fails the run Publish Android needs', () => {
    expect(workflow).toMatch(/\n {2}device-check:\n {4}needs: build\n/);
    expect(workflow).toContain('name: android-aab-${{ github.sha }}\n          path: ${{ runner.temp }}/android-artifact');
    expect(workflow).toContain('bash scripts/ci-avd.sh');
    expect(workflow).toContain('node scripts/check-release.mjs "$RUNNER_TEMP/android-artifact/app-release.aab" --commit "$GITHUB_SHA"');
  });
});
