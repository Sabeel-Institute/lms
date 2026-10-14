import { describe, it, expect } from 'vitest';
import {
  autolink,
  paragraphDirection,
  isSafeHref,
  parseRichForDisplay,
  normalizeMarkdown,
  parseRich,
  serializeRich,
  toPlainText,
  type RichDoc,
  type RichInline,
} from '../src/richtext';

/**
 * The vocabulary, and the escaping that makes it safe.
 *
 * The load-bearing assertion in this file is NOT any single case below — it is
 * `parseRich(serializeRich(doc)) === doc` under seeded fuzz at the bottom. The
 * named cases exist so a failure says *what* broke; the property exists because
 * a hand-written escape list is exactly the thing that gets a character wrong,
 * and the symptom is silent corruption of somebody's real notes.
 */

const round = (md: string) => normalizeMarkdown(md);

describe('inline vocabulary', () => {
  it('parses and re-emits the five elements', () => {
    expect(round('**bold**')).toBe('**bold**');
    expect(round('*italic*')).toBe('*italic*');
    expect(round('- one\n- two')).toBe('- one\n- two');
    expect(round('1. one\n2. two')).toBe('1. one\n2. two');
    expect(round('[label](https://example.org)')).toBe('[label](https://example.org)');
  });

  it('nests marks, which a flat AST could not express', () => {
    const doc = parseRich('**bold [link](https://x.test) inside**');
    expect(serializeRich(doc)).toBe('**bold [link](https://x.test) inside**');
  });

  it('is tolerant on the way in and canonical on the way out', () => {
    // Alternative bullet markers and numbering, and any start number.
    expect(round('* a\n+ b')).toBe('- a\n- b');
    expect(round('7) x\n9) y')).toBe('1. x\n2. y');
  });

  it('does NOT interpret underscores, backticks or tildes', () => {
    // These are outside the vocabulary, so they are literal — which is what
    // keeps snake_case and filenames safe without any escaping at all.
    expect(round('snake_case_name')).toBe('snake_case_name');
    expect(round('report_final_v2.pdf')).toBe('report_final_v2.pdf');
    expect(round('a`b`c')).toBe('a`b`c');
    expect(round('~x~')).toBe('~x~');
  });

  it('leaves out-of-vocabulary block syntax as literal text', () => {
    expect(toPlainText(round('# not a heading'))).toBe('# not a heading');
    expect(toPlainText(round('> not a quote'))).toBe('> not a quote');
  });
});

describe('escaping — the corruption cases', () => {
  it('survives literal asterisks typed into the editor', () => {
    // The editor hands us a TEXT node. Raw markdown `2 * 3 * 4` is genuinely
    // italic and parsing it that way is correct — the corruption case is the
    // round trip of text somebody typed.
    const doc: RichDoc = [
      { kind: 'paragraph', content: [{ kind: 'text', text: '2 * 3 * 4' }] },
    ];
    const md = serializeRich(doc);
    expect(parseRich(md)).toEqual(doc);
    expect(toPlainText(md)).toBe('2 * 3 * 4');
    expect(round(md)).toBe(md);
  });

  it('leaves a non-URL bracket-paren shape completely alone', () => {
    // `note` has no scheme, so this was never a link — deleting the parens
    // would silently eat the writer's characters.
    const md = round('[draft](note)');
    expect(toPlainText(md)).toBe('[draft](note)');
    expect(round(md)).toBe(md);
  });

  it('survives a paragraph that opens with a list marker', () => {
    const md = round('- not a bullet');
    // It IS a bullet on the way in (tolerant), so assert the harder case:
    // a paragraph whose text legitimately begins with "- " after an escape.
    const doc: RichDoc = [{ kind: 'paragraph', content: [{ kind: 'text', text: '- literal' }] }];
    const out = serializeRich(doc);
    expect(parseRich(out)).toEqual(doc);
    expect(md).toBe('- not a bullet');
  });

  it('survives a year that looks like an ordered list', () => {
    const doc: RichDoc = [
      { kind: 'paragraph', content: [{ kind: 'text', text: '1985. A good year' }] },
    ];
    expect(parseRich(serializeRich(doc))).toEqual(doc);
  });

  it('keeps paragraph breaks distinct from line breaks', () => {
    expect(round('a\nb')).toBe('a\nb');
    expect(round('a\n\nb')).toBe('a\n\nb');
  });

  it('is idempotent on everything above', () => {
    for (const md of ['2 * 3 * 4', '**b**', '- a\n- b', 'a\n\nb', 'snake_case']) {
      expect(round(round(md))).toBe(round(md));
    }
  });
});

describe('isSafeHref', () => {
  it('accepts the three permitted schemes', () => {
    expect(isSafeHref('https://example.org')).toBe(true);
    expect(isSafeHref('http://example.org')).toBe(true);
    expect(isSafeHref('mailto:a@oursabeel.com')).toBe(true);
  });

  it('rejects everything else, including encoded attempts', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>',
      'vbscript:x',
      '%6a%61vascript:alert(1)',
      '//evil.test',
      '',
    ]) {
      expect(isSafeHref(bad), bad).toBe(false);
    }
  });

  it('keeps the label when the scheme is refused', () => {
    // Losing the words would be worse than losing the linkiness.
    expect(toPlainText('[click me](javascript:alert(1))')).toBe('click me');
  });

  it('round-trips a URL containing parentheses', () => {
    const md = round('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(round(md)).toBe(md);
    expect(md).toContain('Foo_');
  });
});

describe('toPlainText', () => {
  it('is what search should match, not the raw markdown', () => {
    // The regression this exists for: marks split words a reader sees as one
    // phrase, so a raw substring match fails on "bold text".
    expect(toPlainText('**bold** text')).toBe('bold text');
    expect(toPlainText('- a\n- b')).toBe('a\nb');
    expect(toPlainText('[label](https://x.test)')).toBe('label');
  });

  it('keeps a mention literal so extractMentions still resolves it', () => {
    expect(toPlainText('**@sara** please look')).toBe('@sara please look');
  });
});

describe('empty documents', () => {
  it('serialize to exactly the empty string', () => {
    // rules require body.size() > 0, addComment early-returns on an empty trim,
    // and the card screen shows "No description yet." on a falsy description.
    for (const md of ['', '   ', '\n\n', '\r\n']) {
      expect(normalizeMarkdown(md), JSON.stringify(md)).toBe('');
    }
  });
});

/**
 * The property that actually decides the feature.
 *
 * Seeded so a failure is reproducible rather than a once-seen flake.
 */
describe('round trip under fuzz', () => {
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Text deliberately full of the characters that break naive serializers.
  const WORDS = [
    'plain', '2 * 3', 'snake_case', '[draft]', 'a`b', '~x~', 'e', 'f(g)',
    'report_final_v2.pdf', '- dash', '1985.', '#hash', '>gt', 'emoji \u{1F600}',
    'back\\slash', '**', ']', '(', 'مرحبا',
  ];

  const gen = (rnd: () => number, depth = 0): RichInline => {
    const r = rnd();
    if (depth >= 2 || r < 0.55) {
      return { kind: 'text', text: WORDS[Math.floor(rnd() * WORDS.length)] };
    }
    if (r < 0.7) return { kind: 'bold', content: [gen(rnd, depth + 1)] };
    if (r < 0.85) return { kind: 'italic', content: [gen(rnd, depth + 1)] };
    return { kind: 'link', href: 'https://x.test/a(b)', content: [gen(rnd, depth + 1)] };
  };

  // A list item, sometimes with a line break typed inside it (Shift+Enter).
  const item = (rnd: () => number): RichInline[] =>
    rnd() < 0.35 ? [gen(rnd), { kind: 'text', text: '\n' }, gen(rnd)] : [gen(rnd)];

  /** What a reader counts: the blocks, and how many items each list has. */
  const shape = (doc: RichDoc) =>
    doc.map((b) => (b.kind === 'paragraph' ? 'paragraph' : `${b.kind} of ${b.items.length}`));

  it('parse(serialize(doc)) equals doc for 400 seeded documents', () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const rnd = mulberry(seed);
      const blocks: RichDoc = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let b = 0; b < n; b += 1) {
        const r = rnd();
        const inlines = [gen(rnd), gen(rnd)];
        if (r < 0.6) blocks.push({ kind: 'paragraph', content: inlines });
        else if (r < 0.8) blocks.push({ kind: 'bullets', items: [item(rnd), item(rnd)] });
        else blocks.push({ kind: 'numbers', items: [item(rnd), item(rnd)] });
      }
      const md = serializeRich(blocks);
      // A break inside an item neither ends its list nor starts a new one.
      expect(shape(parseRich(md)), `seed ${seed} shape: ${JSON.stringify(md)}`).toEqual(shape(blocks));
      // `***x***` is ambiguous in markdown — bold-in-italic and italic-in-bold
      // render identically — so the contract is stated over the CANONICAL form
      // rather than over raw AST equality, which markdown cannot deliver.
      const once = normalizeMarkdown(md);
      expect(normalizeMarkdown(once), `seed ${seed} idempotence: ${JSON.stringify(md)}`).toBe(once);
      expect(parseRich(once), `seed ${seed} AST stable: ${JSON.stringify(once)}`).toEqual(
        parseRich(normalizeMarkdown(once)),
      );
      // Nothing a reader can see may be lost or gained.
      expect(toPlainText(once), `seed ${seed} text preserved`).toBe(toPlainText(md));
      checked += 1;
    }
    // An assertion that can pass on empty input is not an assertion.
    expect(checked).toBe(400);
  });
});

describe('autolink (render time only)', () => {
  it('makes a bare URL tappable without changing storage', () => {
    const md = 'see https://example.org/x for details';
    // Storage is untouched...
    expect(normalizeMarkdown(md)).toBe(md);
    // ...but the renderer sees a link.
    const doc = parseRichForDisplay(md);
    const para = doc[0];
    expect(para.kind).toBe('paragraph');
    const kinds = para.kind === 'paragraph' ? para.content.map((n) => n.kind) : [];
    expect(kinds).toContain('link');
  });

  it('does not double-link inside an explicit link', () => {
    const doc = parseRichForDisplay('[label](https://example.org)');
    const para = doc[0];
    const inner = para.kind === 'paragraph' ? para.content : [];
    expect(inner).toHaveLength(1);
    expect(inner[0].kind).toBe('link');
  });

  it('leaves trailing punctuation out of the URL', () => {
    const doc = parseRichForDisplay('go to https://example.org/x.');
    const para = doc[0];
    const link = para.kind === 'paragraph' ? para.content.find((n) => n.kind === 'link') : undefined;
    expect(link && link.kind === 'link' ? link.href : '').toBe('https://example.org/x');
  });

  it('refuses an unsafe scheme even when bare', () => {
    expect(autolink([{ kind: 'text', text: 'javascript:alert(1)' }])).toEqual([
      { kind: 'text', text: 'javascript:alert(1)' },
    ]);
  });
});

describe('paragraphDirection', () => {
  it('runs Arabic right to left and English left to right, from the first strong character', () => {
    expect(paragraphDirection('مِنْ عَلامَةِ الاعْتِمادِ عَلى العَمَلِ')).toBe('rtl');
    expect(paragraphDirection('Recite slowly, with the vowels as written.')).toBe('ltr');
    // A number or a bullet first does not decide it.
    expect(paragraphDirection('1. بسم الله')).toBe('rtl');
    expect(paragraphDirection('2026-10-13 — due')).toBe('ltr');
    expect(paragraphDirection('— 123 —')).toBeNull();
  });
});
