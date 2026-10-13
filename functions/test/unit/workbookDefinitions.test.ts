import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORKBOOK_DEFINITIONS } from '@sabeel/shared';

/**
 * The workbook vocabulary, stated in two places, held to the same words.
 *
 * `WORKBOOK_DEFINITIONS` is printed into every exported file as its
 * Definitions tab; the manual's Section 2.13 prints the same table so a reader
 * can learn the terms before they open a file. Two copies of a definition are
 * two chances for "Missed deadline" to mean one thing in the workbook and
 * another on the page — so the manual's table must contain each definition
 * verbatim, and nothing the manual calls a workbook term may be missing from
 * the file. Edit the constant, then paste; this fails until you do.
 *
 * Lives in `functions/test/unit` because that workspace is the only one here
 * that reads repo files in tests — same reasoning as `appVersion.test.ts`.
 */
const REPO = resolve(import.meta.dirname, '../../..');
const manual = readFileSync(resolve(REPO, 'docs/USER-MANUAL.md'), 'utf8');

describe('the workbook definitions in the manual', () => {
  const section = manual.slice(manual.indexOf('## 2.13'), manual.indexOf('# Part 3'));
  const table = [...section.matchAll(/^\| \*\*(.+?)\*\* \| (.+?) \|$/gm)].map((m) => [m[1], m[2]] as const);

  it('are the section the file points at', () => {
    expect(section.length).toBeGreaterThan(0);
    expect(table.length).toBeGreaterThan(0);
  });

  it('are every term of the Definitions tab, in the same words', () => {
    expect(table).toEqual(WORKBOOK_DEFINITIONS.map(([term, def]) => [term, def]));
  });

  it('name each tab of both workbooks', () => {
    for (const tab of ['Summary', 'Students', 'Sessions', 'Register', 'Recordings', 'Detail', 'Courses', 'History', 'Definitions']) {
      expect(section).toMatch(new RegExp(`^- \\*\\*${tab}\\*\\* —`, 'm'));
    }
  });
});
