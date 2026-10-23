import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The hand-maintained web HTML shell.
 *
 * `app/public/index.html` overrides Expo's generated template, and it carries
 * two things nothing else can express: the app root sized in `dvh`, and the
 * canvas colour painted on html/body. Both fix what a phone browser shows with
 * Expo's own template: a white band below the app as the address bar
 * collapses, and controls pinned to the bottom pushed off a screen that cannot
 * scroll (the sibling Kanban app filmed both).
 *
 * Neither is protected by the type system or the ESLint colour rule (which only
 * looks at TS), and the file is a copy of a vendor template that somebody will
 * eventually re-sync by hand. So the load-bearing parts are asserted here, in
 * `functions/test/unit` because that workspace runs the repo's tests about
 * files outside any one workspace.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const html = readFileSync(resolve(ROOT, 'app/public/index.html'), 'utf8');
/** The theme's canvas colour, as `app/src/theme/palette.ts` states it. */
const canvas = /canvas:\s*'(#[0-9A-Fa-f]{6})'/.exec(readFileSync(resolve(ROOT, 'app/src/theme/palette.ts'), 'utf8'))?.[1];

describe('the web HTML shell', () => {
  it('sizes #root to the dynamic viewport', () => {
    // Without it the app root does not track a mobile browser's address bar: a
    // bare white strip appears below the app, and pinned controls fall off the
    // bottom of a page that cannot scroll (body is overflow:hidden).
    expect(html).toMatch(/#root[^}]*height:\s*100dvh/s);
  });

  it("paints html and body the theme's canvas colour", () => {
    // palette.ts is the source of truth; this file is the copy, so the copy
    // must agree. Update the HTML to match the theme.
    const painted = html.match(/background-color:\s*(#[0-9A-Fa-f]{6})/)?.[1];
    expect(canvas, 'palette.ts states no canvas colour').toBeTruthy();
    expect(painted?.toUpperCase()).toBe(canvas?.toUpperCase());
  });
});
