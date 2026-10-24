import { describe, expect, it } from 'vitest';
import { iconProblems } from '@sabeel-institute/ci-tools/lib/icons.mjs';

/**
 * The font is generated and committed, so nothing at build time notices one
 * that lags `names.json`: the app would type-check against the list and draw a
 * blank for the missing glyph. ci-tools' README, "Icons".
 */
describe('icon font', () => {
  it('draws every name names.json lists, from files that match it', async () => {
    expect(await iconProblems(decodeURIComponent(new URL('../../..', import.meta.url).pathname))).toEqual([]);
  });
});
