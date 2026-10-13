/**
 * The HTML seam — the ONLY thing either editor speaks.
 *
 * This HTML is never rendered in a browser and never stored. It exists so that
 * Lexical (web) and `react-native-enriched-html` (Android) can hand documents
 * to us and take them back, while **markdown remains the single storage
 * format**. Both surfaces go through one converter, so the same keystrokes
 * produce byte-identical markdown from a phone and from a browser — which is
 * what makes the round-trip proof testable at all.
 *
 * `htmlToMarkdown` IS the paste whitelist. It cannot emit anything outside the
 * five-element vocabulary because it does not know anything else, so a pasted
 * heading, table or `<script>` is reduced without needing a paste handler.
 *
 * Hand-rolled rather than `DOMParser`: this module runs under Node for vitest
 * and under Hermes on the device, and two parsers for one job is exactly the
 * "two boxes doing the same thing" failure the repo already warns about.
 *
 * Ported from the institute's Kanban app, less its @-tagging of people: an
 * assignment's instructions tag nobody.
 */
import {
  isSafeHref,
  parseRich,
  serializeRich,
  type RichBlock,
  type RichDoc,
  type RichInline,
} from './richtext';

/** Tags whose CONTENT is dropped as well as the tag. */
const DROP_CONTENT = new Set(['script', 'style', 'head', 'title', 'img']);

/** Tags that become a paragraph boundary. Headings and quotes degrade here. */
const BLOCKISH = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article',
]);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const n = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (key.startsWith('#')) {
      const n = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return whole;
  });
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- markdown → HTML

function inlineToHtml(nodes: RichInline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
          // A newline inside a paragraph is a soft break the editors express as
          // <br>. Without this a two-line paragraph collapses to one line.
          return encodeEntities(n.text).split('\n').join('<br>');
        case 'bold':
          return `<b>${inlineToHtml(n.content)}</b>`;
        case 'italic':
          return `<i>${inlineToHtml(n.content)}</i>`;
        case 'link':
          return `<a href="${encodeEntities(n.href)}">${inlineToHtml(n.content)}</a>`;
      }
    })
    .join('');
}

export function markdownToHtml(markdown: string): string {
  return parseRich(markdown)
    .map((b) => {
      switch (b.kind) {
        case 'paragraph':
          return `<p>${inlineToHtml(b.content)}</p>`;
        case 'bullets':
          return `<ul>${b.items.map((i) => `<li>${inlineToHtml(i)}</li>`).join('')}</ul>`;
        case 'numbers':
          return `<ol>${b.items.map((i) => `<li>${inlineToHtml(i)}</li>`).join('')}</ol>`;
      }
    })
    .join('');
}

// ---------------------------------------------------------------- HTML → markdown

type Token =
  | { t: 'text'; text: string }
  | { t: 'open'; name: string; attrs: string }
  | { t: 'close'; name: string };

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push({ t: 'text', text: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ t: 'text', text: html.slice(i, lt) });
    const gt = html.indexOf('>', lt);
    if (gt < 0) {
      out.push({ t: 'text', text: html.slice(lt) });
      break;
    }
    const raw = html.slice(lt + 1, gt).trim();
    if (raw.startsWith('!')) {
      i = gt + 1;
      continue; // comment or doctype
    }
    if (raw.startsWith('/')) {
      out.push({ t: 'close', name: raw.slice(1).trim().toLowerCase() });
    } else {
      const sp = raw.search(/[\s/]/);
      const name = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
      out.push({ t: 'open', name, attrs: sp < 0 ? '' : raw.slice(sp) });
      // Self-closing or void: emit a matching close so the walker stays simple.
      if (raw.endsWith('/') || name === 'br' || name === 'img' || name === 'hr') {
        out.push({ t: 'close', name });
      }
    }
    i = gt + 1;
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

/**
 * Walk the token stream into blocks.
 *
 * Everything outside the vocabulary degrades here rather than being rejected:
 * an unknown tag is unwrapped (its text survives), a heading or quote becomes a
 * paragraph, and a nested list is flattened because the native editor does not
 * support nesting either.
 */
export function htmlToMarkdown(html: string): string {
  const tokens = tokenize(html);
  const blocks: RichDoc = [];

  // Inline state: a stack of open marks, and the run being built.
  let run: RichInline[] = [];
  const marks: { kind: 'bold' | 'italic' | 'link'; href?: string; content: RichInline[] }[] = [];
  let listKind: 'bullets' | 'numbers' | null = null;
  let listItems: RichInline[][] = [];
  let inItem = false;
  let dropDepth = 0;
  // Nesting depth of <ul>/<ol>. A nested list is FLATTENED into the outer
  // one (the native editor does not nest either), so the inner </ul> must
  // not end the list and strand every item after it.
  let listDepth = 0;
  // Depth per inline mark. Lexical emits <b><strong>x</strong></b> for ONE bold
  // run: the inner open must be collapsed AND its close ignored, or the close
  // ends the outer mark early and strands everything after it.
  const markDepth = { bold: 0, italic: 0 };

  const target = (): RichInline[] => (marks.length ? marks[marks.length - 1].content : run);

  const pushText = (text: string) => {
    if (!text) return;
    const arr = target();
    const last = arr[arr.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else arr.push({ kind: 'text', text });
  };

  const closeMark = (kind: 'bold' | 'italic' | 'link') => {
    for (let m = marks.length - 1; m >= 0; m -= 1) {
      if (marks[m].kind !== kind) continue;
      const done = marks.splice(m)[0];
      const arr = target();
      if (done.kind === 'link') {
        if (done.href && isSafeHref(done.href)) {
          arr.push({ kind: 'link', href: done.href, content: done.content });
        } else {
          // Refused scheme: keep the words, drop the link.
          arr.push(...done.content);
        }
      } else {
        arr.push({ kind: done.kind, content: done.content });
      }
      return;
    }
  };

  const flushRun = () => {
    while (marks.length) closeMark(marks[marks.length - 1].kind);
    const content = run;
    run = [];
    if (content.length === 0) return null;
    return content;
  };

  const endBlock = () => {
    const content = flushRun();
    if (content) blocks.push({ kind: 'paragraph', content });
  };

  const endList = () => {
    if (listKind && listItems.length) {
      blocks.push({ kind: listKind, items: listItems } as RichBlock);
    }
    listKind = null;
    listItems = [];
    inItem = false;
  };

  for (const tk of tokens) {
    if (dropDepth > 0) {
      if (tk.t === 'close' && DROP_CONTENT.has(tk.name)) dropDepth -= 1;
      else if (tk.t === 'open' && DROP_CONTENT.has(tk.name)) dropDepth += 1;
      continue;
    }

    if (tk.t === 'text') {
      const text = decodeEntities(tk.text);
      // Collapse the incidental whitespace editors emit between tags, but keep
      // a single space so words do not run together.
      if (text.trim() === '') {
        if (/[ \t\n]/.test(text) && target().length) pushText(' ');
        continue;
      }
      pushText(text.replace(/[\n\r\t]+/g, ' '));
      continue;
    }

    if (tk.t === 'open') {
      const n = tk.name;
      if (DROP_CONTENT.has(n)) {
        dropDepth += 1;
        continue;
      }
      const openMark = (kind: 'bold' | 'italic') => {
        markDepth[kind] += 1;
        if (markDepth[kind] === 1) marks.push({ kind, content: [] });
      };
      if (n === 'b' || n === 'strong') openMark('bold');
      else if (n === 'i' || n === 'em') openMark('italic');
      else if (n === 'a') marks.push({ kind: 'link', href: attr(tk.attrs, 'href'), content: [] });
      else if (n === 'br') pushText('\n');
      else if (n === 'ul' || n === 'ol') {
        if (listDepth === 0) {
          endBlock();
          listKind = n === 'ul' ? 'bullets' : 'numbers';
          listItems = [];
        }
        listDepth += 1;
      } else if (n === 'li') {
        if (inItem) {
          const c = flushRun();
          if (c) listItems.push(c);
        }
        inItem = true;
      } else if (BLOCKISH.has(n)) {
        if (listDepth === 0) endBlock();
      }
      continue;
    }

    // close
    const n = tk.name;
    const shutMark = (kind: 'bold' | 'italic') => {
      if (markDepth[kind] === 1) closeMark(kind);
      markDepth[kind] = Math.max(0, markDepth[kind] - 1);
    };
    if (n === 'b' || n === 'strong') shutMark('bold');
    else if (n === 'i' || n === 'em') shutMark('italic');
    else if (n === 'a') closeMark('link');
    else if (n === 'li') {
      const c = flushRun();
      if (c) listItems.push(c);
      inItem = false;
    } else if (n === 'ul' || n === 'ol') {
      if (inItem) {
        const c = flushRun();
        if (c) listItems.push(c);
        inItem = false;
      }
      listDepth = Math.max(0, listDepth - 1);
      if (listDepth === 0) endList();
    } else if (BLOCKISH.has(n)) {
      if (listDepth === 0) endBlock();
    }
  }

  if (inItem) {
    const c = flushRun();
    if (c) listItems.push(c);
  }
  endList();
  endBlock();

  return serializeRich(blocks);
}
