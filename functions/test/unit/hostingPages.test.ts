import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOWNLOAD_PAGE_URL, PRIVACY_URL } from '@sabeel/shared';

/**
 * The three pages a store reviewer reads, and the two ways they break silently.
 *
 * `npm run smoke:prod` is what actually proves they answer, because it fetches
 * the deployed site the way a reviewer does. This runs in the ordinary suite and
 * catches the same two faults before a deploy rather than after:
 *
 *  1. **A rewrite behind the catch-all.** `**` sends everything to the SPA, so a
 *     `/privacy` listed after it answers 200 with the app shell — a reviewer
 *     finds no policy, and nothing looks broken from here.
 *  2. **A rewrite pointing at a file nobody wrote.** Same 200, same shell.
 *
 * And the link in the app has to agree with the rewrite: `PRIVACY_URL` is opened
 * from the More menu, and a policy that exists at a path the app does not name
 * satisfies nobody.
 */

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * The string literals in a source file, and the source with comments and
 * those literals blanked out — one pass, character by character, because a
 * regex cannot tell a quote inside a comment from a quote around a string,
 * and the files that explain the store rule quote the phrases it forbids.
 */
function tokenize(src: string): { strings: string[]; code: string } {
  const strings: string[] = [];
  let code = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          text += src[j + 1] ?? '';
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      strings.push(text);
      code += `${c}${c}`;
      i = j + 1;
    } else {
      code += c;
      i += 1;
    }
  }
  return { strings, code };
}
const hosting = JSON.parse(readFileSync(resolve(ROOT, 'firebase.json'), 'utf8')).hosting as {
  rewrites: { source: string; destination: string }[];
};

/** The pages Apple and Play require, and the app or the listing points at. */
const STORE_PAGES = ['/privacy', '/support', '/get-app'];

describe('the static pages the stores need', () => {
  it('rewrites each one ahead of the SPA catch-all', () => {
    const catchAll = hosting.rewrites.findIndex((r) => r.source === '**');
    expect(catchAll, 'no `**` rewrite at all').toBeGreaterThan(-1);

    for (const page of STORE_PAGES) {
      const at = hosting.rewrites.findIndex((r) => r.source === page);
      expect(at, `${page} has no rewrite`).toBeGreaterThan(-1);
      expect(at, `${page} is behind \`**\`, so it serves the app shell`).toBeLessThan(catchAll);
    }
  });

  it('points each one at a file that exists', () => {
    for (const page of STORE_PAGES) {
      const rule = hosting.rewrites.find((r) => r.source === page);
      const file = resolve(ROOT, 'app', 'public', rule!.destination.replace(/^\//, ''));
      expect(existsSync(file), `${page} -> ${rule!.destination}, which is not in app/public`).toBe(
        true,
      );
    }
  });

  it('serves the privacy policy at the path the app actually opens', () => {
    // The More menu opens `PRIVACY_URL`. If that drifts from the rewrite, the
    // one link a reviewer is guaranteed to follow leads nowhere — which is the
    // state this app was in until 2026-09-07, pointing at a host attached to
    // nothing.
    expect(new URL(PRIVACY_URL).pathname).toBe('/privacy');
  });

  it('sends /get-app to the same download page the update screen opens', () => {
    // Two copies of one address: the update gate imports the constant, the
    // static page cannot. A stale one sends a person to the retired app.
    const getApp = readFileSync(resolve(ROOT, 'app', 'public', 'get-app.html'), 'utf8');
    const links = [...getApp.matchAll(/href="(https:\/\/[^"]*github\.io[^"]*)"/g)].map((m) => m[1]);
    expect(links).toEqual([DOWNLOAD_PAGE_URL]);
  });

  it('keeps the app from naming a way to get an account', () => {
    /*
     * THE STORE EXEMPTION, GUARDED WHERE IT IS EASIEST TO LOSE. Play triggers the
     * account-deletion requirement if an app "directs the user to an app account
     * creation flow outside of the app", so /get-app may link to the app but
     * nothing shipped IN the app may link to /get-app or name it. A helpful line
     * on the sign-in screen two years from now is the whole risk.
     */
    const getApp = readFileSync(resolve(ROOT, 'app', 'public', 'get-app.html'), 'utf8');
    expect(getApp).toContain('sign in on this website once');

    /*
     * EVERY FILE THAT SHIPS, not the three where a link seemed likeliest. The
     * words a person reads are string literals and JSX text; comments are
     * stripped first, because the files that explain this rule quote the very
     * phrases it forbids. Test files are not shipped and are skipped.
     */
    const shipped = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) return shipped(p);
        return /\.tsx?$/.test(entry) && !/\.test\./.test(entry) ? [p] : [];
      });
    const spoken = (src: string): string[] => {
      const { strings, code } = tokenize(src);
      // JSX text: a run between a tag or expression boundary on either side.
      // `{' '}` and `{name}` are boundaries too — a sentence broken around a
      // link is still a sentence a person reads.
      return [...strings, ...[...code.matchAll(/[>}]([^<>{}]+)[<{]/g)].map((m) => m[1])];
    };
    const files = shipped(resolve(ROOT, 'app', 'src'));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      for (const text of spoken(readFileSync(file, 'utf8'))) {
        expect(text, `${file} names /get-app`).not.toMatch(/get-app/);
        expect(text, `${file} tells someone to sign up on the website`).not.toMatch(
          /sign up|create an account|on the website/i,
        );
      }
    }
    // A guard on the scanner: the refusal's own words are a string it must read,
    // a sentence broken around a link is one it must read, and a comment quoting
    // the forbidden phrase is one it must not.
    expect(spoken(readFileSync(resolve(ROOT, 'app', 'src/auth/signInMessage.ts'), 'utf8')).join(' ')).toMatch(
      /administrator/i,
    );
    expect(spoken(`<Text>Need one? Sign up on the website at{' '}<Text>here</Text></Text>`)).toContain(
      'Need one? Sign up on the website at',
    );
    expect(spoken(`<Text>{name}, sign up on the website to continue.</Text>`)).toContain(
      ', sign up on the website to continue.',
    );
    expect(spoken(`return x; // never say "sign up"\n/* or 'create an account' */`)).toEqual([]);
  });
});
