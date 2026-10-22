import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * AN OVERLAY'S WRAPPERS ARE NOT ACCESSIBILITY ELEMENTS.
 *
 * Every modal here is a tappable backdrop (it closes) around a panel that
 * absorbs taps (so a press inside does not close it), and both are Pressables.
 * A Pressable is an accessibility element by default, and on iOS an element
 * swallows everything under it: the accessibility tree held a whole sheet as
 * ONE element labelled with all its text, so VoiceOver had no row to move to
 * and Maestro could not tap one. Android and the web never showed it, and only
 * the iOS native flows would, on a macOS runner; this catches it everywhere.
 */
const src = new URL('../../../app/src/', import.meta.url);
const overlays = readdirSync(src, { recursive: true })
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => [f, readFileSync(new URL(f, src), 'utf8')])
  .filter(([, text]) => text.includes('<Modal'));

/** Each `<Pressable …>` opening tag, read to the `>` outside every `{…}`. */
function pressables(text) {
  const tags = [];
  for (const m of text.matchAll(/<Pressable[\s>]/g)) {
    let depth = 0;
    let end = m.index;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
      else if (text[end] === '>' && depth === 0) break;
    }
    tags.push(text.slice(m.index, end + 1));
  }
  return tags;
}

/** The backdrop names its style so; the absorber's press does nothing. */
const isWrapper = (tag) => /styles\.backdrop\b/.test(tag) || tag.includes('onPress={() => {}}');

describe('overlays', () => {
  const wrappers = overlays.flatMap(([file, text]) => pressables(text).filter(isWrapper).map((tag) => [file, tag]));

  it('are found, each with a backdrop and an absorber', () => {
    expect(overlays.length).toBeGreaterThan(0);
    for (const [file, text] of overlays) {
      const tags = pressables(text).filter(isWrapper);
      expect(tags.some((t) => /styles\.backdrop\b/.test(t)), `${file}: no backdrop`).toBe(true);
      expect(tags.some((t) => t.includes('onPress={() => {}}')), `${file}: no absorber`).toBe(true);
    }
  });

  it('leave the rows inside them to assistive technology', () => {
    const merged = wrappers.filter(([, tag]) => !tag.includes('accessible={false}')).map(([file]) => file);
    expect(merged, 'a backdrop or absorber without accessible={false}').toEqual([]);
  });
});
