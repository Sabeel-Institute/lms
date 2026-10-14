import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import { $createLinkNode, $isLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { BOLD_STAR, ITALIC_STAR, ORDERED_LIST, UNORDERED_LIST } from '@lexical/markdown';
import { $findMatchingParent } from '@lexical/utils';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  TextNode,
  type LexicalEditor,
} from 'lexical';
import { htmlToMarkdown, isSafeHref, markdownToHtml } from '@sabeel/shared';
import { NO_MARKS, RichToolbar, type RichCommands, type RichMarks } from './RichToolbar';
import { LinkSheet } from './LinkSheet';
import { inputLook } from './ui';
import { SYSTEM_FONT_STACK, getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * WEB (native sibling: RichEditor.tsx), ported from the Kanban app.
 *
 * Markdown in, markdown out, through the same `richtextHtml` seam as the
 * native half. `@lexical/markdown` drives the typing shortcuts only, never
 * the save: it escapes a different set of characters from ours, and one
 * converter only has to be proved once.
 *
 * Four things hold it to the five-element vocabulary, most trusted first:
 *  1. Only list and link nodes are registered, so a pasted heading or quote
 *     becomes a paragraph by construction.
 *  2. A TextNode transform clears every format bit but bold and italic —
 *     underline, strikethrough and code arrive as bits, not nodes.
 *  3. `htmlToMarkdown` on every change, which can emit only the five.
 *  4. No autolink: a typed address is stored as typed and made tappable when
 *     shown, so web and Android agree.
 *
 * Arabic: Lexical marks each paragraph's direction from its first strong
 * letter, so a right-to-left line sits right-aligned as it is typed.
 */

const TRANSFORMERS = [UNORDERED_LIST, ORDERED_LIST, BOLD_STAR, ITALIC_STAR];

const box = inputLook.box;
const PADDING = `${box.paddingVertical}px ${box.paddingHorizontal}px`;

type BridgeCommands = Omit<RichCommands, 'promptLink'> & {
  selectedText: () => string;
  applyLink: (href: string, text: string) => void;
};

function listTypeAtCaret(editor: LexicalEditor): string | null {
  let type: string | null = null;
  editor.getEditorState().read(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return;
    const l = $findMatchingParent(sel.anchor.getNode(), $isListNode);
    if ($isListNode(l)) type = l.getListType();
  });
  return type;
}

/** Loads the markdown, reports markdown and marks back, and exposes the commands. */
function Bridge({
  initialMarkdown,
  onChangeMarkdown,
  onMarks,
  registerCommands,
}: {
  initialMarkdown: string;
  onChangeMarkdown: (md: string) => void;
  onMarks: (m: RichMarks) => void;
  registerCommands: (c: BridgeCommands) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const seeded = useRef(false);

  // Seed ONCE: re-seeding a focused editor moves the caret and drops keys.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      if (initialMarkdown) {
        const dom = new DOMParser().parseFromString(markdownToHtml(initialMarkdown), 'text/html');
        root.append(...$generateNodesFromDOM(editor, dom));
      }
    });
  }, [editor, initialMarkdown]);

  useEffect(
    () =>
      editor.registerNodeTransform(TextNode, (node) => {
        for (const fmt of ['underline', 'strikethrough', 'code', 'subscript', 'superscript'] as const) {
          if (node.hasFormat(fmt)) node.toggleFormat(fmt);
        }
      }),
    [editor],
  );

  // Through refs, so the listener registers once rather than per render of
  // a caller that passes inline arrows.
  const onChangeRef = useRef(onChangeMarkdown);
  const onMarksRef = useRef(onMarks);
  onChangeRef.current = onChangeMarkdown;
  onMarksRef.current = onMarks;

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        editorState.read(() => {
          // Selection-only updates change no words; reporting them would
          // mark an untouched form as edited.
          if (dirtyElements.size > 0 || dirtyLeaves.size > 0) {
            onChangeRef.current(htmlToMarkdown($generateHtmlFromNodes(editor, null)));
          }
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) {
            onMarksRef.current(NO_MARKS);
            return;
          }
          const anchor = sel.anchor.getNode();
          const list = $findMatchingParent(anchor, $isListNode);
          onMarksRef.current({
            bold: sel.hasFormat('bold'),
            italic: sel.hasFormat('italic'),
            bullets: $isListNode(list) && list.getListType() === 'bullet',
            numbers: $isListNode(list) && list.getListType() === 'number',
            link: $findMatchingParent(anchor, $isLinkNode) !== null,
          });
        });
      }),
    [editor],
  );

  useEffect(() => {
    registerCommands({
      toggleBold: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'),
      toggleItalic: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'),
      toggleBullets: () =>
        editor.dispatchCommand(
          listTypeAtCaret(editor) === 'bullet' ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND,
          undefined,
        ),
      toggleNumbers: () =>
        editor.dispatchCommand(
          listTypeAtCaret(editor) === 'number' ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
          undefined,
        ),
      selectedText: () => {
        let text = '';
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) text = sel.getTextContent();
        });
        return text;
      },
      applyLink: (href, text) => {
        if (!isSafeHref(href)) return;
        let inserted = false;
        editor.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
          // NOTHING SELECTED: the words given become a link of their own, at
          // the caret. Typed and then toggled, they joined the run of text
          // the caret was in, and the whole run became the link.
          const linkNode = $createLinkNode(href);
          linkNode.append($createTextNode(text));
          sel.insertNodes([linkNode]);
          inserted = true;
        });
        if (!inserted) editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
      },
      removeLink: () => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null),
    });
  }, [editor, registerCommands]);

  return null;
}

/*
 * Node styling by CLASS: the editable is a raw DOM element, so react-native-
 * web styles do not reach its descendants. Every colour comes from the theme;
 * the colour lint cannot see inside a CSS string, so this is on trust.
 *
 * The font is set here because react-native-web puts it on each Text, never
 * on the body, and a raw element inherits the browser's serif.
 */
const CSS = `
  .lms-rt { outline: none; font-family: ${SYSTEM_FONT_STACK}; font-size: ${box.fontSize}px; line-height: 1.5; }
  .lms-rt:focus-visible { box-shadow: 0 0 0 2px ${t.accent.base}; }
  .lms-rt-p { margin: 0 0 ${spacing(2)}px; }
  .lms-rt-b { font-weight: 700; }
  .lms-rt-i { font-style: italic; }
  .lms-rt-a { color: ${t.text.accent}; text-decoration: underline; }
  .lms-rt-ul, .lms-rt-ol { margin: 0 0 ${spacing(2)}px; padding-inline-start: ${spacing(6)}px; }
  .lms-rt-li { margin: 0 0 ${spacing(1)}px; }
  .lms-rt > :last-child { margin-bottom: 0; }
`;

export function RichEditor({
  initialMarkdown,
  onChangeMarkdown,
  label,
  placeholder,
  testID,
  minHeight = 140,
}: {
  initialMarkdown: string;
  onChangeMarkdown: (md: string) => void;
  /** The field's accessible name. */
  label: string;
  placeholder?: string;
  /** A contenteditable has no placeholder to select on, so the e2e needs this. */
  testID?: string;
  minHeight?: number;
}) {
  const [marks, setMarks] = useState<RichMarks>(NO_MARKS);
  // The selected text CAPTURED when the sheet opens: once it takes focus the
  // editor's selection is gone, and a live read would answer "".
  const [link, setLink] = useState<{ open: boolean; text: string }>({ open: false, text: '' });
  const cmds = useRef<BridgeCommands | null>(null);
  const registerCommands = useCallback((c: BridgeCommands) => {
    cmds.current = c;
  }, []);

  const commands = useMemo<RichCommands>(
    () => ({
      toggleBold: () => cmds.current?.toggleBold(),
      toggleItalic: () => cmds.current?.toggleItalic(),
      toggleBullets: () => cmds.current?.toggleBullets(),
      toggleNumbers: () => cmds.current?.toggleNumbers(),
      promptLink: () => setLink({ open: true, text: cmds.current?.selectedText() ?? '' }),
      removeLink: () => cmds.current?.removeLink(),
    }),
    [],
  );

  const initialConfig = useMemo(
    () => ({
      namespace: 'lms-rich',
      nodes: [ListNode, ListItemNode, LinkNode],
      theme: {
        paragraph: 'lms-rt-p',
        text: { bold: 'lms-rt-b', italic: 'lms-rt-i' },
        link: 'lms-rt-a',
        list: { ul: 'lms-rt-ul', ol: 'lms-rt-ol', listitem: 'lms-rt-li' },
      },
      onError: (e: Error) => {
        throw e;
      },
    }),
    [],
  );

  // Into <head>, once for every editor: a <style> inside a View is invalid
  // nesting and React says so on every render.
  useEffect(() => {
    const id = 'lms-richtext-style';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);

  return (
    <View>
      {/* Pressing a button would take focus and collapse the selection before
          the command ran, formatting nothing. */}
      <div onMouseDown={(e) => e.preventDefault()}>
        <RichToolbar commands={commands} marks={marks} />
      </div>
      <LexicalComposer initialConfig={initialConfig}>
        {/* Positioned, so the absolutely placed placeholder lands in the box
            and not over the toolbar. */}
        <div style={{ position: 'relative' }}>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="lms-rt"
                data-testid={testID}
                aria-label={label}
                // CSS, not React Native style: a raw element knows nothing of
                // `paddingVertical`, and spreading the input's look here left
                // the words against the border.
                style={{
                  backgroundColor: box.backgroundColor,
                  color: box.color,
                  border: `${box.borderWidth}px solid ${box.borderColor}`,
                  borderRadius: box.borderRadius,
                  padding: PADDING,
                  minHeight,
                  boxSizing: 'border-box',
                }}
              />
            }
            placeholder={
              placeholder ? (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    pointerEvents: 'none',
                    padding: PADDING,
                    // Border width included, or the words sit 1px off the caret.
                    margin: box.borderWidth,
                    color: t.text.muted,
                    fontFamily: SYSTEM_FONT_STACK,
                    fontSize: box.fontSize,
                    lineHeight: 1.5,
                  }}
                >
                  {placeholder}
                </div>
              ) : null
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin validateUrl={isSafeHref} />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <Bridge
          initialMarkdown={initialMarkdown}
          onChangeMarkdown={onChangeMarkdown}
          onMarks={setMarks}
          registerCommands={registerCommands}
        />
      </LexicalComposer>
      <LinkSheet
        visible={link.open}
        initialText={link.text}
        onCancel={() => setLink({ open: false, text: '' })}
        onConfirm={(href, text) => {
          cmds.current?.applyLink(href, text);
          setLink({ open: false, text: '' });
        }}
      />
    </View>
  );
}
