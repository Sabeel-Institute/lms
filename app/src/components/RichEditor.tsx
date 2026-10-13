import { useRef, useState } from 'react';
import { View } from 'react-native';
import { EnrichedTextInput, type EnrichedTextInputInstance } from 'react-native-enriched-html';
import { htmlToMarkdown, markdownToHtml } from '@sabeel/shared';
import { NO_MARKS, RichToolbar, type RichCommands, type RichMarks } from './RichToolbar';
import { LinkSheet } from './LinkSheet';
import { inputLook } from './ui';
import { getTheme } from '../theme';

const t = getTheme();

/**
 * NATIVE (web sibling: RichEditor.web.tsx), ported from the Kanban app.
 *
 * `react-native-enriched-html` is a real native input, no WebView, so the
 * keyboard controller still sees a focused view and scrolls it clear of the
 * keyboard. Markdown in, markdown out, through the same `richtextHtml` seam
 * as the web half, so the same keystrokes store the same bytes on both.
 *
 * Three props correct the library's defaults:
 *  - `scrollEnabled={false}`: it defaults to its own scroll view, nested
 *    inside the screen's.
 *  - `linkRegex={null}`: autodetection would turn a typed address into a
 *    link on Android only. Bare addresses are made tappable when shown.
 *  - `textShortcuts` pinned to the two list triggers, so an upstream default
 *    cannot add a heading.
 *
 * Arabic: Android lays each paragraph out in the direction of its first
 * strong letter, as the reader (`paragraphDirection`) does.
 */

const TEXT_SHORTCUTS = [
  { trigger: '- ', style: 'unordered_list' as const },
  { trigger: '1. ', style: 'ordered_list' as const },
];

export function RichEditor({
  initialMarkdown,
  onChangeMarkdown,
  label,
  placeholder,
  minHeight = 140,
}: {
  initialMarkdown: string;
  onChangeMarkdown: (md: string) => void;
  /** The field's accessible name. */
  label: string;
  placeholder?: string;
  /** Web only: a contenteditable has no placeholder to select on. */
  testID?: string;
  minHeight?: number;
}) {
  const ref = useRef<EnrichedTextInputInstance>(null);
  /*
   * Seed ONCE. Callers pass back the state `onChangeMarkdown` updates, and a
   * fresh HTML string per keystroke made the input reapply it under the caret:
   * characters lost, the cursor snapping back.
   */
  const initialHtml = useRef<string | null>(null);
  /*
   * In `<html>`, the library's own envelope, or the box is born the wrong
   * height. Only an enveloped value goes to the library's parser everywhere;
   * a bare one is shown through its HTML normaliser, but its FIRST height
   * measurement (MeasurementStore.getInitialText) skips the normaliser and
   * measures the tags as plain text. The library measures again once the
   * view has parsed the value, and that correction did not reach layout:
   * on the AVD, from a cold start, the box came up one line short every time
   * (495 px for 542 px of text) with the last line of the instructions
   * hidden. Enveloped, it fits.
   */
  if (initialHtml.current === null) initialHtml.current = `<html>${markdownToHtml(initialMarkdown)}</html>`;
  const [marks, setMarks] = useState<RichMarks>(NO_MARKS);
  /*
   * The selection the link sheet was opened ON. `setLink` takes an explicit
   * range, and the selection keeps changing while the sheet is up, so it is
   * captured once, on the tap that asked for a link.
   */
  const sel = useRef({ start: 0, end: 0, text: '' });
  const [link, setLink] = useState<{ open: boolean; start: number; end: number; text: string }>({
    open: false,
    start: 0,
    end: 0,
    text: '',
  });
  const closeLink = () => setLink({ open: false, start: 0, end: 0, text: '' });

  const commands: RichCommands = {
    toggleBold: () => ref.current?.toggleBold(),
    toggleItalic: () => ref.current?.toggleItalic(),
    toggleBullets: () => ref.current?.toggleUnorderedList(),
    toggleNumbers: () => ref.current?.toggleOrderedList(),
    promptLink: () => setLink({ open: true, ...sel.current }),
  };

  return (
    <View>
      <RichToolbar commands={commands} marks={marks} />
      <EnrichedTextInput
        ref={ref}
        defaultValue={initialHtml.current}
        placeholder={placeholder}
        placeholderTextColor={t.text.muted}
        accessibilityLabel={label}
        scrollEnabled={false}
        linkRegex={null}
        textShortcuts={TEXT_SHORTCUTS}
        mentionIndicators={[]}
        onChangeHtml={(e) => onChangeMarkdown(htmlToMarkdown(e.nativeEvent.value))}
        onChangeState={(e) => {
          const s = e.nativeEvent;
          setMarks({
            bold: !!s.bold?.isActive,
            italic: !!s.italic?.isActive,
            bullets: !!s.unorderedList?.isActive,
            numbers: !!s.orderedList?.isActive,
            link: !!s.link?.isActive,
          });
        }}
        onChangeSelection={(e) => {
          sel.current = { start: e.nativeEvent.start, end: e.nativeEvent.end, text: e.nativeEvent.text ?? '' };
        }}
        style={{ ...inputLook.box, minHeight }}
        htmlStyle={{ a: { color: t.text.accent } }}
      />
      <LinkSheet
        visible={link.open}
        initialText={link.text}
        onCancel={closeLink}
        onConfirm={(href, text) => {
          ref.current?.setLink(link.start, link.end, text, href);
          closeLink();
        }}
      />
    </View>
  );
}
