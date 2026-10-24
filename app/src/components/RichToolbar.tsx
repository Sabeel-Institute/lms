import { Icon, type IconName } from '../icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * The formatting toolbar, both surfaces (ported from the Kanban app). Which
 * five buttons exist, their order, icons and words live here; only the
 * COMMANDS differ per platform, and they arrive injected.
 *
 * Icons, each named on its accessibility label, in 44px targets: five worded
 * buttons would cost a row above the box on a form that is already long.
 */

/** What the toolbar can do. Implemented per platform; the list is fixed. */
export interface RichCommands {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleBullets: () => void;
  toggleNumbers: () => void;
  /** Opens the link sheet; the caller supplies the address once chosen. */
  promptLink: () => void;
  /** Takes the link off the words the caret is in. */
  removeLink: () => void;
}

/** Which marks are on at the caret, so each button can show it. */
export interface RichMarks {
  bold: boolean;
  italic: boolean;
  bullets: boolean;
  numbers: boolean;
  link: boolean;
}

export const NO_MARKS: RichMarks = { bold: false, italic: false, bullets: false, numbers: false, link: false };


const TOOLS: { key: keyof RichMarks; icon: IconName; label: string; run: (c: RichCommands, on: boolean) => void }[] = [
  { key: 'bold', icon: 'format-bold', label: 'Bold', run: (c) => c.toggleBold() },
  { key: 'italic', icon: 'format-italic', label: 'Italic', run: (c) => c.toggleItalic() },
  { key: 'bullets', icon: 'format-list-bulleted', label: 'Bullet list', run: (c) => c.toggleBullets() },
  { key: 'numbers', icon: 'format-list-numbered', label: 'Numbered list', run: (c) => c.toggleNumbers() },
  // A toggle like the rest: in a link it takes the link off, which nothing
  // else on the toolbar could.
  { key: 'link', icon: 'link', label: 'Link', run: (c, on) => (on ? c.removeLink() : c.promptLink()) },
];

export function RichToolbar({ commands, marks }: { commands: RichCommands; marks: RichMarks }) {
  return (
    <View style={styles.bar}>
      {TOOLS.map((tool) => (
        <Pressable
          key={tool.key}
          testID={`rich-${tool.key}`}
          accessibilityRole="button"
          accessibilityLabel={tool.key === 'link' && marks.link ? 'Remove link' : tool.label}
          accessibilityState={{ selected: marks[tool.key] }}
          // A toggle, so it says whether it is on. react-native-web maps no
          // ARIA from `accessibilityState.selected` on a button; `aria-pressed`
          // is the toggle's own attribute, and inert on Android.
          aria-pressed={marks[tool.key]}
          onPress={() => tool.run(commands, marks[tool.key])}
          style={({ pressed }) => [styles.tool, marks[tool.key] ? styles.on : null, pressed ? styles.pressed : null]}
        >
          {/* text.secondary, not muted: an icon that is a button's only label
              needs 3:1, and muted falls short on most surfaces. */}
          <Icon name={tool.icon} size={22} color={marks[tool.key] ? t.text.accent : t.text.secondary} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1), marginBottom: spacing(1) },
  tool: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  on: { backgroundColor: t.bg.accentSoft },
  pressed: { opacity: 0.6 },
});
