import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { checksByShot, compare, parseShot } from '../../../scripts/screens-report.mjs';

const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

function png(width, height, paint = () => [255, 255, 255]) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      image.data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return PNG.sync.write(image);
}

describe('the screens report', () => {
  it('reads width and screen from a sweep file name, and nothing else', () => {
    expect(parseShot('1024px-manager-course.png')).toEqual({ file: '1024px-manager-course.png', width: 1024, screen: 'manager-course' });
    expect(parseShot('FAILED.png')).toBeNull();
    expect(parseShot('results.json')).toBeNull();
  });

  it('puts each check beside its screenshot, the longest screen name winning', () => {
    const files = ['320px-board.png', '320px-board-longname.png', '390px-board.png'];
    const results = [
      { name: '320px / board', ok: true },
      { name: '320px / board has a way out', ok: false, detail: 'no Back and no tab bar' },
      { name: '320px / board-longname content column', ok: true },
      { name: '390px / board', ok: true },
      { name: 'the squash check examined some fixed-format controls', ok: true },
      { name: '1440px / roster', ok: true },
    ];
    const { byShot, other } = checksByShot(files, results);
    expect(byShot.get('320px-board.png').map((r) => r.name)).toEqual(['320px / board', '320px / board has a way out']);
    expect(byShot.get('320px-board-longname.png').map((r) => r.name)).toEqual(['320px / board-longname content column']);
    expect(byShot.get('390px-board.png')).toHaveLength(1);
    expect(other.map((r) => r.name)).toEqual(['the squash check examined some fixed-format controls', '1440px / roster']);
  });

  it('reports identical screenshots as unchanged and draws what changed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'screens-report-'));
    const before = png(10, 10);
    expect(compare(before, Buffer.from(before), join(directory, 'same.png'))).toBeNull();
    expect(existsSync(join(directory, 'same.png'))).toBe(false);

    const after = png(10, 10, (x, y) => (x < 5 && y < 2 ? [0, 0, 0] : [255, 255, 255]));
    const change = compare(before, after, join(directory, 'diff.png'));
    expect(change.ratio).toBeCloseTo(0.1);
    expect(existsSync(join(directory, 'diff.png'))).toBe(true);

    expect(compare(before, png(10, 12), join(directory, 'taller.png'))).toEqual({ ratio: 1, note: 'size 10×10 → 10×12' });
  });

  it('runs on every CI sweep, pass or fail, and keeps the report', () => {
    expect(ci).toContain("if: always() && matrix.suite == 'screens'");
    expect(ci).toContain('node scripts/screens-report.mjs shots/screens --baseline-from-main');
    expect(ci).toMatch(/name: screens-report\n {10}path: \$\{\{ runner\.temp \}\}\/screens-report/);
  });
});
