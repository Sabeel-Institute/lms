/**
 * The rich-text vocabulary: markdown in, typed nodes out, and back again.
 *
 * Rich text (an assignment's instructions; ported from the institute's Kanban
 * app, which stores descriptions and comments the same way) is stored as
 * **markdown**, which nobody types and nobody sees — the editors are WYSIWYG on both surfaces and markdown is only
 * the storage format. This module is the single definition of what that format
 * may contain.
 *
 * FIVE ELEMENTS, and nothing else: bold, italic, bullet list, ordered list,
 * link. No headings, code, quotes, underline, strikethrough, tables or images
 * (attachments cover images). The vocabulary is small because that is what the
 * team's real content needs — measured, not guessed — and because a small
 * vocabulary is what makes the round trip provable.
 *
 * TWO ASYMMETRIES ARE DELIBERATE:
 *
 * 1. **Parse tolerantly, serialize canonically.** The parser accepts `-`/`*`/`+`
 *    bullets, `1.`/`1)` numbering and any start number; the serializer emits one
 *    form of each. `normalizeMarkdown` is therefore idempotent, and that is the
 *    contract the tests assert.
 *
 * 2. **The escape set equals the parse set.** We escape exactly what we
 *    interpret — `\`, `*`, `[`, and a line-leading `-`/`+`/`N.` — and nothing
 *    more. NOT `_`, backtick or `~`: those are not part of the vocabulary, so
 *    escaping them would store `snake\_case\_name`, which is noise in a field a
 *    backfill script or a raw-field glance will one day read.
 *
 * Escaping is the whole correctness story. Without it, typing `2 * 3 * 4` and
 * reopening gives `2 <i>3</i> 4` — silent corruption of someone's real notes.
 * The hand-written escape list is NOT the correctness criterion, though: the
 * criterion is `parseRich(serializeRich(doc))` deep-equalling `doc`, which the
 * round-trip suite enforces with seeded fuzz. Escape minimally and let the
 * property test find what the list missed.
 *
 * HTML is never produced or interpreted here. The parser emits typed nodes and
 * the renderer maps them to RN `Text`, so a description containing `<script>`
 * renders as literal characters — there is no sanitiser to get wrong.
 */

/** The five. Nothing outside this list exists anywhere in the pipeline. */
export const RICH_VOCABULARY = [
  'bold',
  'italic',
  'bullets',
  'numbers',
  'link',
] as const;

export type RichElement = (typeof RICH_VOCABULARY)[number];

export type RichInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; content: RichInline[] }
  | { kind: 'italic'; content: RichInline[] }
  | { kind: 'link'; href: string; content: RichInline[] };

export type RichBlock =
  | { kind: 'paragraph'; content: RichInline[] }
  | { kind: 'bullets'; items: RichInline[][] }
  | { kind: 'numbers'; items: RichInline[][] };

export type RichDoc = RichBlock[];

/**
 * Schemes a link may carry. Anything else keeps its text and loses its link —
 * a `javascript:` URL in a description must never become tappable.
 *
 * Deliberately a prefix allowlist rather than a blocklist: `%6a%61vascript:`
 * and friends fail it by not starting with something permitted, so there is no
 * decoding step to get wrong.
 */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (h.length === 0) return false;
  // Whitespace or a control character means the URL is either broken or is
  // trying to break out of the `[text](href)` shape.
  if (/\s/.test(h)) return false;
  for (let i = 0; i < h.length; i += 1) {
    if (h.charCodeAt(i) < 0x20) return false;
  }
  return /^(https?:\/\/|mailto:)/i.test(h);
}

/**
 * Characters a backslash may legitimately escape.
 *
 * Broader than what `escapeText` PRODUCES, on purpose: unescaping must tolerate
 * anything a previous version — or Lexical's own exporter, which also escapes
 * `_`, backtick and `~` — may have written, or that text would grow visible
 * backslashes on its way through us.
 */
const ESCAPABLE = new Set([
  '\\', '*', '[', ']', '(', ')', '-', '+', '.', '_', '`', '~', '#', '>',
]);

/** What we emit escapes for. See the header: the escape set is the parse set. */
function escapeText(text: string): string {
  const inline = text.replace(/([\\*[])/g, '\\$1');
  // A line that BEGINS with a list marker would re-parse as a list, so the
  // marker is escaped at the start of every line, not just the first.
  return inline
    .replace(/(^|\n)([ \t]*)([-+])(?=\s)/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]*\d+)([.)])(?=\s)/g, '$1$2\\$3');
}

function escapeHref(href: string): string {
  // BOTH parens, not just the closer. Escaping only `)` leaves an inner `(`
  // counted by the paren matcher with no closer to balance it, so a URL like
  // .../Foo_(bar) stops being a link on the second pass.
  return href.replace(/([\\()])/g, '\\$1');
}

function unescapeHref(href: string): string {
  return href.replace(/\\([\\()])/g, '$1');
}

/** Find `token` at or after `from`, skipping escaped characters. */
function findUnescaped(s: string, from: number, token: string): number {
  for (let i = from; i <= s.length - token.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s.startsWith(token, i)) return i;
  }
  return -1;
}

/**
 * The index of the `)` closing the `(` at `open`, counting nesting.
 *
 * A URL may contain balanced parentheses — `.../Foo_(bar)` is ordinary — so
 * stopping at the first `)` truncates real links and leaves a stray character
 * behind in the text.
 */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Does this look like it was MEANT to be a URL? `note` does not; `x:` does. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function pushText(out: RichInline[], buf: string): void {
  if (buf.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.kind === 'text') last.text += buf;
  else out.push({ kind: 'text', text: buf });
}

/**
 * One run of inline content.
 *
 * Order matters: `***` before `**` before `*`, or `**bold**` parses as two empty
 * italics and `***both***` parses as bold followed by a stray asterisk.
 *
 * `***x***` is genuinely ambiguous in markdown — bold-in-italic and
 * italic-in-bold render identically — so it is parsed to ONE canonical nesting
 * (bold outside). Both orders serialize to the same string and come back as the
 * canonical one, which is why the round-trip contract is stated over
 * `normalizeMarkdown` rather than over raw AST equality.
 */
export function parseInline(source: string): RichInline[] {
  const out: RichInline[] = [];
  let buf = '';
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === '\\' && i + 1 < source.length && ESCAPABLE.has(source[i + 1])) {
      buf += source[i + 1];
      i += 2;
      continue;
    }

    if (source.startsWith('***', i)) {
      const close = findUnescaped(source, i + 3, '***');
      if (close > i + 3) {
        pushText(out, buf);
        buf = '';
        out.push({
          kind: 'bold',
          content: [{ kind: 'italic', content: parseInline(source.slice(i + 3, close)) }],
        });
        i = close + 3;
        continue;
      }
    }

    if (source.startsWith('**', i)) {
      const close = findUnescaped(source, i + 2, '**');
      if (close > i + 2) {
        pushText(out, buf);
        buf = '';
        out.push({ kind: 'bold', content: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (c === '*') {
      const close = findUnescaped(source, i + 1, '*');
      if (close > i + 1) {
        pushText(out, buf);
        buf = '';
        out.push({ kind: 'italic', content: parseInline(source.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    if (c === '[') {
      const closeText = findUnescaped(source, i + 1, ']');
      if (closeText > i && source[closeText + 1] === '(') {
        const closeHref = matchingParen(source, closeText + 1);
        if (closeHref > closeText + 1) {
          const href = unescapeHref(source.slice(closeText + 2, closeHref));
          if (isSafeHref(href)) {
            pushText(out, buf);
            buf = '';
            out.push({
              kind: 'link',
              href,
              content: parseInline(source.slice(i + 1, closeText)),
            });
            i = closeHref + 1;
            continue;
          }
          if (HAS_SCHEME.test(href)) {
            // A link was clearly intended but the scheme is refused. Keep the
            // LABEL and drop the target: losing the words would be worse than
            // losing the linkiness, and a javascript: URL must never be tappable.
            pushText(out, buf);
            buf = '';
            out.push(...parseInline(source.slice(i + 1, closeText)));
            i = closeHref + 1;
            continue;
          }
          // Not a URL at all — `[draft](note)` is just text. Fall through so
          // every character survives.
        }
      }
    }

    buf += c;
    i += 1;
  }

  pushText(out, buf);
  return out;
}

export function serializeInline(nodes: RichInline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
          return escapeText(n.text);
        case 'bold':
          return `**${serializeInline(n.content)}**`;
        case 'italic':
          return `*${serializeInline(n.content)}*`;
        case 'link':
          // A URL may legitimately contain ')' — escape it, or the next
          // parse truncates the href at the first paren.
          return `[${serializeInline(n.content)}](${escapeHref(n.href)})`;
      }
    })
    .join('');
}

const BULLET = /^[ \t]*(?:[-*+])[ \t]+(.*)$/;
const NUMBER = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/** Is this line a list marker that has NOT been escaped away? */
function listMatch(line: string, re: RegExp): string | null {
  const m = line.match(re);
  return m ? m[1] : null;
}

/**
 * Markdown → typed blocks. Tolerant by design; see the header.
 *
 * Adjacent non-blank lines stay in ONE paragraph joined by a newline, and a
 * blank line starts a new one. That is what makes `"a\nb"` and `"a\n\nb"`
 * survive a round trip as different documents — collapsing them would silently
 * reflow someone's text.
 */
export function parseRich(markdown: string): RichDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: RichDoc = [];
  let para: string[] = [];
  let items: string[] | null = null;
  let itemsKind: 'bullets' | 'numbers' | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    out.push({ kind: 'paragraph', content: parseInline(para.join('\n')) });
    para = [];
  };
  const flushItems = () => {
    if (items === null || itemsKind === null) return;
    out.push({ kind: itemsKind, items: items.map((t) => parseInline(t)) });
    items = null;
    itemsKind = null;
  };

  for (const line of lines) {
    const bullet = listMatch(line, BULLET);
    const numbered = bullet === null ? listMatch(line, NUMBER) : null;

    if (bullet !== null || numbered !== null) {
      const kind = bullet !== null ? 'bullets' : 'numbers';
      const text = bullet !== null ? bullet : (numbered as string);
      flushPara();
      if (itemsKind !== null && itemsKind !== kind) flushItems();
      itemsKind = kind;
      items = items ?? [];
      items.push(text);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushItems();
      continue;
    }

    // A line indented under a list item is more of that item: a line break
    // typed inside it, as `serializeRich` writes one. Read as a paragraph, it
    // ended the list there, and the next item started again at 1.
    if (items !== null && /^[ \t]/.test(line)) {
      const list: string[] = items;
      list[list.length - 1] += `\n${line.replace(/^[ \t]+/, '')}`;
      continue;
    }

    flushItems();
    para.push(line);
  }
  flushPara();
  flushItems();
  return out;
}

/**
 * An item's line breaks as continuation lines, indented under its text, which
 * `parseRich` reads back into the item. A blank line cannot live inside an
 * item (it ends the list), so breaks in a row come out as one.
 */
const itemText = (item: RichInline[], indent: string) =>
  serializeInline(item).replace(/\n{2,}/g, '\n').split('\n').join(`\n${indent}`);

/** Typed blocks → canonical markdown. Ordered lists always renumber from 1. */
export function serializeRich(doc: RichDoc): string {
  return doc
    .map((b) => {
      switch (b.kind) {
        case 'paragraph':
          return serializeInline(b.content);
        case 'bullets':
          return b.items.map((i) => `- ${itemText(i, '  ')}`).join('\n');
        case 'numbers':
          return b.items.map((i, n) => `${n + 1}. ${itemText(i, '   ')}`).join('\n');
      }
    })
    .join('\n\n');
}

/**
 * The canonical form of any markdown we are handed.
 *
 * Idempotent: `normalizeMarkdown(normalizeMarkdown(x)) === normalizeMarkdown(x)`.
 * Everything written to Firestore goes through this, so the character counter
 * and the stored string can never disagree.
 *
 * An empty document serialises to exactly `''` — not `'\n'`, not a stray
 * paragraph. Three things depend on it: `firestore.rules` requires
 * `body.size() > 0`, `addComment` early-returns on an empty trim, and the card
 * screen shows "No description yet." on a falsy description.
 */
export function normalizeMarkdown(markdown: string): string {
  return serializeRich(parseRich(markdown));
}

/**
 * The words a reader sees, with every mark removed.
 *
 * Used for SEARCH — matching the raw markdown would make `**bold** text` fail a
 * search for "bold text", because the marks split words a human reads as
 * adjacent.
 *
 * Link TEXT survives; link targets do not. That is a deliberate, small
 * regression: URLs used to be searchable as description text.
 */
export function toPlainText(markdown: string): string {
  const flat = (nodes: RichInline[]): string =>
    nodes
      .map((n) => (n.kind === 'text' ? n.text : flat(n.content)))
      .join('');

  return parseRich(markdown)
    .map((b) =>
      b.kind === 'paragraph'
        ? flat(b.content)
        : b.items.map((i) => flat(i)).join('\n'),
    )
    .join('\n');
}

/**
 * Bare URLs, made tappable AT RENDER TIME ONLY.
 *
 * Deliberately not part of `parseRich`/`serializeRich`: storage keeps exactly
 * what the writer typed. If either editor rewrote a bare URL into `[url](url)`
 * we would get different stored markdown from a phone than from a browser for
 * the same keystrokes, which is why `linkRegex` is disabled on native and no
 * AutoLink plugin is registered on web.
 *
 * It matters because every URL in the team's existing content is bare — there
 * is not one `[text](target)` anywhere — so this is the only thing that makes
 * the links they already have clickable.
 */
const BARE_URL = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|mailto:[^\s<>()]+)/g;

export function autolink(nodes: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (const n of nodes) {
    if (n.kind === 'link') {
      // Never look inside an explicit link; its label is already spoken for.
      out.push(n);
      continue;
    }
    if (n.kind !== 'text') {
      out.push({ ...n, content: autolink(n.content) });
      continue;
    }
    let last = 0;
    for (const m of n.text.matchAll(BARE_URL)) {
      const href = m[0];
      if (!isSafeHref(href)) continue;
      if (m.index > last) out.push({ kind: 'text', text: n.text.slice(last, m.index) });
      out.push({ kind: 'link', href, content: [{ kind: 'text', text: href }] });
      last = m.index + href.length;
    }
    if (last < n.text.length) out.push({ kind: 'text', text: n.text.slice(last) });
  }
  return out;
}

/** What the RENDERER parses: the stored document, plus tappable bare URLs. */
export function parseRichForDisplay(markdown: string): RichDoc {
  return parseRich(markdown).map((b) =>
    b.kind === 'paragraph'
      ? { ...b, content: autolink(b.content) }
      : { ...b, items: b.items.map((i) => autolink(i)) },
  );
}

/**
 * The direction a paragraph runs: from its first strong character, so an
 * Arabic line reads right to left and an English one left to right, each on
 * its own, whatever the app's direction. `null` when nothing in it is strong
 * (digits, punctuation), which keeps the reader's default.
 */
export function paragraphDirection(text: string): 'rtl' | 'ltr' | null {
  for (const ch of text) {
    if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(ch)) return 'rtl';
    if (/\p{L}/u.test(ch)) return 'ltr';
  }
  return null;
}
