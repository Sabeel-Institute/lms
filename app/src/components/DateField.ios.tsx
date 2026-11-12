import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRoomy } from '../useWidth';
import { getTheme, spacing } from '../theme';
import { Button } from './ui';
import { Sheet } from './Sheet';
import { pickerDate, toYmd } from './dateFieldValue';

const t = getTheme();

/**
 * iOS side of the date seam (Android: DateField.tsx, web: DateField.web.tsx).
 * The same field and the same `YYYY-MM-DD` value, so a screen never knows
 * which platform it is on.
 *
 * Android's picker is a dialog, which is why that sibling shows it on press.
 * On iOS the same component is an inline control, and shown that way it was a
 * compact pill under the field that needed a tap of its own before the
 * calendar opened: three taps to choose a day (seen on an iPhone, 2026-11-12;
 * the sibling time tracker met the same and solved it this way). Here the
 * field opens a sheet holding the whole calendar, and Done commits the day it
 * shows; Cancel, or a tap outside, leaves the field as it was.
 */
export function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string; // YYYY-MM-DD, or '' for none
  onChange: (v: string) => void;
}) {
  const roomy = useRoomy();
  // The day the calendar shows while the sheet is open; null when closed.
  const [draft, setDraft] = useState<Date | null>(null);
  const close = () => setDraft(null);

  return (
    <View style={[styles.field, roomy ? styles.fieldWide : null]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          testID="datefield-open"
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value || 'not set'}`}
          style={styles.input}
          onPress={() => setDraft(pickerDate(value))}
        >
          <Text style={value ? styles.value : styles.placeholder}>{value || 'Set a date'}</Text>
        </Pressable>
        {value ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear the date" onPress={() => onChange('')}>
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      {/* A sheet like every other in the app, so one opened from inside a
          sheet (the give list's) sits above it as its own. */}
      <Sheet visible={draft !== null} title={label} onClose={close} closeLabel="Cancel" closeTestID="datefield-cancel">
        {draft ? (
          <DateTimePicker
            testID="datefield-calendar"
            value={draft}
            mode="date"
            display="inline"
            accentColor={t.accent.base}
            textColor={t.text.primary}
            onValueChange={(_event, picked) => {
              if (picked) setDraft(picked);
            }}
            style={styles.calendar}
          />
        ) : null}
        <Button
          testID="datefield-done"
          label="Done"
          onPress={() => {
            if (draft) onChange(toYmd(draft));
            close();
          }}
          block
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  // The field's look, as on Android (DateField.tsx).
  field: { marginTop: spacing(3) },
  fieldWide: { maxWidth: 440 },
  label: { fontSize: 13, color: t.text.secondary, marginBottom: spacing(1) },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(3) },
  input: {
    flex: 1,
    backgroundColor: t.bg.inset,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.subtle,
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(3),
  },
  value: { fontSize: 16, color: t.text.primary },
  placeholder: { fontSize: 16, color: t.text.muted },
  clear: { fontSize: 14, color: t.text.secondary, fontWeight: '600' },
  calendar: { alignSelf: 'center', marginBottom: spacing(3) },
});
