import { StyleSheet, Text, View } from 'react-native';
import { useRoomy } from '../useWidth';
import { SYSTEM_FONT_STACK, getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Web side of the date seam (native sibling: DateField.tsx). A native
 * `<input type="date">` gives the browser's calendar, keyboard entry and a
 * built-in clear control for free — react-native-web has no date input, so this
 * drops to the DOM element. The value stays a `YYYY-MM-DD` string.
 */
interface DateFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
}

export function DateField({ label, value, onChange }: DateFieldProps) {
  const roomy = useRoomy();
  return (
    // The same reading cap `Field` takes. Without it a ten-character date ran
    // to 622px in a card whose free-text fields were capped at 440 — the field
    // that needed room was the constrained one.
    <View style={[styles.field, roomy ? styles.fieldWide : null]}>
      <Text style={styles.label}>{label}</Text>
      <input
        type="date"
        aria-label={label}
        value={value}
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
        style={{
          fontSize: 16,
          fontFamily: SYSTEM_FONT_STACK,
          color: t.text.primary,
          backgroundColor: t.bg.inset,
          border: `1px solid ${t.border.subtle}`,
          borderRadius: 8,
          padding: spacing(3),
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginTop: spacing(3) },
  fieldWide: { maxWidth: 440 },
  label: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
});
