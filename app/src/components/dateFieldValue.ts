/**
 * The date field's value conversions, shared by its Android and iOS sides
 * (`DateField.tsx`, `DateField.ios.tsx`) so the two cannot drift. The stored
 * value is a plain calendar date, `YYYY-MM-DD`, never a UTC instant.
 */

/**
 * The picker's Date for a stored value: LOCAL midnight, so it opens on the
 * stored day; today when there is none.
 */
export function pickerDate(value: string): Date {
  return value ? new Date(`${value}T00:00:00`) : new Date();
}

/** Local calendar date → YYYY-MM-DD, without the UTC shift toISOString brings. */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
