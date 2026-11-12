import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRoomy } from '../useWidth';
import { getTheme, spacing } from '../theme';
import { pickerDate, toYmd } from './dateFieldValue';

const t = getTheme();

/**
 * Android side of the date seam (iOS: DateField.ios.tsx, web:
 * DateField.web.tsx). Android's picker is a dialog with OK and Cancel, so the
 * field shows it on press and hides it on its first answer.
 *
 * A calendar picker instead of a hand-typed `YYYY-MM-DD` — the value stays a
 * date-only string so nothing downstream changes. Optional: a Clear control
 * removes the date entirely (`''` → stored as null by the caller).
 */
interface DateFieldProps {
  label: string;
  value: string; // YYYY-MM-DD, or '' for none
  onChange: (v: string) => void;
}

export function DateField({ label, value, onChange }: DateFieldProps) {
  const roomy = useRoomy();
  const [show, setShow] = useState(false);

  /*
   * STABLE HANDLERS, or the open dialog resets itself.
   *
   * `DateTimePicker`'s Android effect lists `onValueChange` and `onDismiss` in
   * its dependencies and calls `DateTimePickerAndroid.open()` again when either
   * changes — and the library's own note says a presented dialog ignores every
   * updated prop EXCEPT `value`. So an inline arrow here meant any re-render of
   * the parent while the calendar was open re-opened it at `value`, throwing
   * away whatever month the person had navigated to. A screen with a request in
   * flight re-renders on its own; the Zoom import's mount-effect load is enough
   * to do it while its From picker is up.
   *
   * The ref is what keeps the identity constant regardless of what the PARENT
   * passes: `onChange` is an inline arrow at most call sites, so a `useCallback`
   * depending on it would be no more stable than the arrow it replaced.
   */
  const latestChange = useRef(onChange);
  latestChange.current = onChange;
  const handleValue = useCallback((_event: unknown, date?: Date) => {
    setShow(false);
    if (date) latestChange.current(toYmd(date));
  }, []);
  const handleDismiss = useCallback(() => setShow(false), []);
  /*
   * MEMOISED, because it is a dependency of the picker's own effect.
   *
   * `DateTimePicker`'s Android effect lists `valueTimestamp = value.getTime()`,
   * so a `new Date()` built fresh on every render is a NEW timestamp every
   * render, and the presented dialog is re-opened at "today" — discarding the
   * month the person had navigated to. Only reachable with no date set, which
   * is exactly the case a person is most likely to be browsing months in:
   * clear "Listen by", open the picker, and any ancestor re-render (a Firestore
   * snapshot on the screen's live queries) snaps it back.
   *
   * Parsed as LOCAL midnight so the picker opens on the stored day; a due date
   * is a plain calendar date, never a UTC instant.
   */
  const current = useMemo(() => pickerDate(value), [value]);

  return (
    // The same reading cap `Field` takes — a ten-character date has no business
    // running the full width of a card whose text fields are capped.
    <View style={[styles.field, roomy ? styles.fieldWide : null]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          testID="datefield-open"
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value || 'not set'}`}
          style={styles.input}
          onPress={() => setShow(true)}
        >
          <Text style={value ? styles.value : styles.placeholder}>{value || 'Set a date'}</Text>
        </Pressable>
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear the date"
            onPress={() => onChange('')}
          >
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      {show ? (
        <DateTimePicker
          value={current}
          mode="date"
          // onValueChange fires on OK with the chosen date; onDismiss on cancel.
          // (Replaces the deprecated single onChange.) Either way, unmount the
          // dialog by clearing `show`. Both are memoised — see above.
          onValueChange={handleValue}
          onDismiss={handleDismiss}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
});
