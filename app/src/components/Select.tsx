import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Sheet, SheetOption } from './Sheet';
import { getTheme, spacing } from '../theme';

const t = getTheme();

export type SelectOption = { value: string; label: string };

/**
 * Choose one of a list — NATIVE (web sibling: Select.web.tsx).
 *
 * React Native has no dropdown primitive, so this is a closed field that opens
 * the bounded, self-scrolling `Sheet` and lists the options as rows. Ported
 * from the sibling kanban app's Search filters. The property it shares with the
 * web `<select>` is the one that matters: it costs ONE LINE until it is opened.
 * A row of pills per option — the shape the create-student picker still uses —
 * is right for four courses and is most of a phone screen for twelve.
 *
 * The visible text is the CURRENT CHOICE, and the label is the accessible name
 * ("Cohort: Autumn 2026"), so a screen reader hears what the control is for and
 * what it is set to in one breath.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  testID,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  /** The field itself; each row in the open sheet gets `${testID}-option-${value}`. */
  testID?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? 'none'}`}
        aria-expanded={open}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.field, pressed ? styles.fieldPressed : null, disabled ? styles.fieldDisabled : null]}
      >
        <Text style={styles.value} numberOfLines={1}>
          {current?.label ?? '—'}
        </Text>
        {/* U+25BE, a text-presentation triangle — an emoji arrow renders as a
            colour glyph and ignores the text colour. */}
        <Text style={styles.caret}>▾</Text>
      </Pressable>

      <Sheet visible={open} title={label} onClose={() => setOpen(false)} closeAt="corner">
        {options.map((o) => (
          <SheetOption
            key={o.value}
            testID={testID ? `${testID}-option-${o.value}` : undefined}
            label={o.label}
            selected={o.value === value}
            onPress={() => {
              setOpen(false);
              onChange(o.value);
            }}
          />
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  // The text input's own box, so a dropdown beside a field reads as the same
  // family of control.
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    // The same top margin `Button` carries, for the same reason the filter
    // pills carry it: this shares a wrapping row with a button (the library's
    // Clear filters), and a centred row aligns margin boxes, so without it the
    // button sat four pixels below the dropdowns beside it.
    marginTop: spacing(2),
    backgroundColor: t.bg.inset,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    minHeight: 44,
    // Content-width, but never wider than the row it sits in: a long cohort
    // name then truncates (`value` shrinks) instead of running off the screen.
    maxWidth: '100%',
  },
  fieldPressed: { backgroundColor: t.bg.surface },
  fieldDisabled: { opacity: 0.5 },
  value: { flexShrink: 1, fontSize: 15, color: t.text.primary },
  caret: { fontSize: 13, color: t.text.secondary },
});
