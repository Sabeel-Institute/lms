import { SYSTEM_FONT_STACK, getTheme, spacing } from '../theme';

export type SelectOption = { value: string; label: string };

/**
 * Choose one of a list — WEB (native sibling: Select.tsx).
 *
 * A real `<select>`, for the same reason `DateField.web.tsx` is a real date
 * input: the browser's own control brings keyboard navigation, type-ahead and
 * a scrolling popup for free, all of which a hand-rolled popup would have to
 * reimplement and would get subtly wrong. react-native-web has no select, so
 * this drops to the DOM element; the value stays a plain string.
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
  testID?: string;
  disabled?: boolean;
}) {
  const t = getTheme();
  return (
    <select
      data-testid={testID}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: t.bg.inset,
        color: t.text.primary,
        border: `1px solid ${t.border.subtle}`,
        borderRadius: 8,
        padding: `${spacing(2)}px ${spacing(3)}px`,
        // As the native sibling: the margin `Button` carries, so the two sit
        // level in a shared row.
        marginTop: spacing(2),
        minHeight: 44,
        fontSize: 15,
        fontFamily: SYSTEM_FONT_STACK,
        // Sized to the CURRENT choice, not the widest option: a native <select>
        // otherwise reserves room for its longest option, so "All cohorts" sat
        // in a box wide enough for "Spring 2027 — Evening Intensive". Capped at
        // the container; a browser without `field-sizing` falls back to the
        // old sizing, which is wider and still correct.
        fieldSizing: 'content',
        maxWidth: '100%',
        // The app is light-only; pin the native control so the browser does
        // not tint the dropdown arrow to a dark scheme.
        colorScheme: 'light',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
