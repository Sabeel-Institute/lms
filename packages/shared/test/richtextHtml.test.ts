import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from '../src/richtextHtml';
import { normalizeMarkdown, parseRich, toPlainText } from '../src/richtext';

/**
 * The seam both editors speak.
 *
 * The important assertions are the DEGRADATION table and the round trip —
 * `htmlToMarkdown` is the paste whitelist, so every row of "what happens to
 * something we do not speak" is a security and fidelity statement, not a
 * nicety.
 */

const trip = (md: string) => htmlToMarkdown(markdownToHtml(md));

describe('markdown to HTML and back', () => {
  it('round-trips each element', () => {
    for (const md of [
      '**bold**',
      '*italic*',
      '[label](https://example.org)',
      '- one\n- two',
      '1. one\n2. two',
      'plain text',
    ]) {
      expect(trip(md), md).toBe(md);
    }
  });

  it('round-trips nested marks and mixed blocks', () => {
    const md = '**bold with [link](https://x.test) inside**\n\n- *a*\n- **b**\n\n1. one';
    expect(trip(md)).toBe(md);
  });

  it('keeps a soft line break inside a paragraph', () => {
    expect(markdownToHtml('a\nb')).toContain('<br>');
    expect(trip('a\nb')).toBe('a\nb');
  });

  it('keeps paragraph breaks distinct from line breaks', () => {
    expect(trip('a\n\nb')).toBe('a\n\nb');
    expect(trip('a\nb')).toBe('a\nb');
  });

  it('escapes and restores literal markdown characters', () => {
    for (const md of [normalizeMarkdown('2 * 3'), 'snake_case_name', 'a`b', '~x~']) {
      expect(trip(md), md).toBe(md);
    }
  });

  it('escapes and restores HTML-significant characters', () => {
    // A legacy description containing <not a tag> must not be eaten.
    const md = 'compare <not a tag> & "quotes"';
    expect(toPlainText(trip(md))).toBe(md);
  });
});

describe('degradation — what happens to everything we do not speak', () => {
  const cases: [string, string, string][] = [
    ['heading becomes a paragraph', '<h1>Title</h1>', 'Title'],
    ['quote becomes a paragraph', '<blockquote>quoted</blockquote>', 'quoted'],
    ['underline keeps its text', '<u>under</u>', 'under'],
    ['strikethrough keeps its text', '<s>gone</s>', 'gone'],
    ['inline code keeps its text', '<code>x = 1</code>', 'x = 1'],
    ['code block keeps its text', '<pre>line</pre>', 'line'],
    ['checkbox list becomes a bullet list', '<ul data-type="checkbox"><li>a</li></ul>', '- a'],
    ['unknown tag is unwrapped', '<span class="x">kept</span>', 'kept'],
    ['mention flattens to its text', '<mention>@sara</mention>', '@sara'],
    ['image is dropped entirely', '<p>before<img src="x.png">after</p>', 'beforeafter'],
    ['script is dropped, content and all', '<p>a</p><script>alert(1)</script>', 'a'],
    ['style is dropped, content and all', '<style>p{color:red}</style><p>b</p>', 'b'],
  ];
  for (const [name, html, expected] of cases) {
    it(name, () => {
      expect(htmlToMarkdown(html)).toBe(expected);
    });
  }

  it('flattens a nested list to one level, losing no items', () => {
    const md = htmlToMarkdown('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>');
    expect(toPlainText(md).split('\n').sort()).toEqual(['a', 'b', 'c']);
  });

  it('drops a refused scheme but keeps the label', () => {
    expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlToMarkdown('<a href="https://ok.test">click</a>')).toBe(
      '[click](https://ok.test)',
    );
  });

  it('never emits a tag outside the vocabulary', () => {
    const html = markdownToHtml('**b** *i* [l](https://x.test)\n\n- a\n\n1. n');
    const tags = [...html.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
    expect([...new Set(tags)].sort()).toEqual(['a', 'b', 'i', 'li', 'ol', 'p', 'ul']);
  });
});

describe('both editor dialects', () => {
  it('collapses a doubled mark rather than nesting it', () => {
    // Lexical emits <b><strong>x</strong></b> for ONE bold run; nested that
    // serializes as ****x****, which is not even valid emphasis.
    expect(htmlToMarkdown('<b><strong>x</strong></b>')).toBe('**x**');
    expect(htmlToMarkdown('<i><em>y</em></i>')).toBe('*y*');
    expect(htmlToMarkdown('<b><i><b>z</b></i></b>')).toBe('***z***');
  });

  it('reads Lexical output', () => {
    // Lexical emits <strong>/<em>, wrapping spans, dir attributes and li value.
    const html =
      '<p dir="ltr"><span style="white-space: pre-wrap;"><strong>bold</strong> and <em>it</em></span></p>' +
      '<ol><li value="1"><span>one</span></li><li value="2"><span>two</span></li></ol>';
    expect(htmlToMarkdown(html)).toBe('**bold** and *it*\n\n1. one\n2. two');
  });

  it('reads enriched-html output', () => {
    const html = '<p><b>bold</b> and <i>it</i></p><ul><li>one</li></ul>';
    expect(htmlToMarkdown(html)).toBe('**bold** and *it*\n\n- one');
  });
});

describe('paste is safe without a paste handler', () => {
  it('reduces a rich paste to the vocabulary', () => {
    const pasted =
      '<h1>Heading</h1><p>Some <u>underlined</u> and <s>struck</s> text with ' +
      '<a href="https://ok.test">a link</a>.</p>' +
      '<table><tr><td>cell</td></tr></table>' +
      '<ul><li>item <code>code</code></li></ul>' +
      '<img src="x.png"><script>alert(1)</script>';
    const md = htmlToMarkdown(pasted);
    expect(md).not.toMatch(/[<>]/);
    expect(md).toContain('[a link](https://ok.test)');
    expect(toPlainText(md)).toContain('cell');
    expect(toPlainText(md)).not.toContain('alert(1)');
    // And it is already canonical, so the counter and the write agree.
    expect(normalizeMarkdown(md)).toBe(md);
  });
});

/**
 * Instructions are often half Arabic. The editors mark a right-to-left
 * paragraph with `dir`, which storage does not keep: the reader works the
 * direction out again from the words (`paragraphDirection`), so the text must
 * come through whole and in order, vowel marks included.
 */
describe('Arabic through the seam', () => {
  const line = 'مِنْ عَلَامَةِ الاعْتِمَادِ عَلَى العَمَلِ';

  it('keeps the words and their vowels, and drops only the direction', () => {
    expect(htmlToMarkdown(`<p dir="rtl"><span style="white-space: pre-wrap;">${line}</span></p>`)).toBe(line);
  });

  it('round-trips a mixed paragraph with marks', () => {
    const md = `**${line}**\n\nRecite it *slowly*.`;
    expect(trip(md)).toBe(md);
  });
});

/*
 * A LINE BREAK INSIDE A LIST ITEM STAYS IN IT. Lexical exports Shift+Enter in
 * an item as <br>; stored as a bare newline it ended the list, so a numbered
 * vocabulary list of a word and its meaning came back as three lists all
 * numbered 1, and opening the answer again saved that.
 */
describe('a list item with a line break', () => {
  const editorHtml =
    '<ol><li><span>كتاب</span><br><span>book</span></li><li><span>قلم</span><br><span>pen</span></li><li><span>باب</span><br><span>door</span></li></ol>';

  it('stays one numbered list of three items, stored and read back', () => {
    const stored = htmlToMarkdown(editorHtml);
    const doc = parseRich(stored);
    expect(doc.map((b) => b.kind)).toEqual(['numbers']);
    expect(doc[0].kind === 'numbers' && doc[0].items.length).toBe(3);
    expect(toPlainText(stored)).toContain('book');
  });

  it('is canonical as stored, and the editor draws it back as written', () => {
    const stored = htmlToMarkdown(editorHtml);
    expect(normalizeMarkdown(stored)).toBe(stored);
    expect(htmlToMarkdown(markdownToHtml(stored))).toBe(stored);
    expect(markdownToHtml(stored)).toMatch(/^<ol><li>[^<]*<br>book<\/li>/);
  });
});
