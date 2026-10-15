/**
 * How a title too long for its line slides: the one definition both sliders
 * (`components/SlidingText.tsx` and its web sibling) draw from.
 */

/** How fast a title too long for its line slides, and how long it rests at each end. */
const PX_PER_SECOND = 35;
export const REST_MS = 1600;

/** How long one slide from end to end takes. */
export const slideMs = (overflow: number): number => (overflow / PX_PER_SECOND) * 1000;

/*
 * WHERE THE TITLE RESTS IS WHERE IT BEGINS. The text sits left-anchored in a
 * window narrower than it, so at no offset the window shows its LEFT end: the
 * beginning of an English title, but the END of an Arabic one, cut mid-word,
 * with its beginning in view only after a slide of half a minute.
 */
export function slideEnds(overflow: number, rightToLeft: boolean): { rest: number; far: number } {
  return rightToLeft ? { rest: -overflow, far: 0 } : { rest: 0, far: -overflow };
}

// Letters of the right-to-left scripts: Hebrew, Arabic (not its digits, which
// take their direction from around them), Syriac, Thaana, N'Ko and their
// presentation forms.
const RTL = /[֐-׿؀-ٟ٪-ۯۺ-ࣿיִ-﷿ﹰ-ﻼ]/;
// Letters of the left-to-right scripts a title here is written in.
const LTR = /[A-Za-zÀ-ʯͰ-ϿЀ-ԯḀ-῿]/;

/**
 * Whether a title reads right to left: its first letter decides, as a browser
 * decides for `dir="auto"` and Android for its text.
 */
export function readsRightToLeft(text: string): boolean {
  for (const ch of text) {
    if (RTL.test(ch)) return true;
    if (LTR.test(ch)) return false;
  }
  return false;
}
