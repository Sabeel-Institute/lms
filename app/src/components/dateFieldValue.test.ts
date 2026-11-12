import { describe, expect, it } from 'vitest';
import { pickerDate, toYmd } from './dateFieldValue';

/*
 * A STORED DATE IS A CALENDAR DAY. The picker opens on it and hands it back
 * unchanged, in any zone: a UTC reading moved it a day west of Greenwich.
 */
describe('the date field’s value', () => {
  it('opens the picker on the stored day and gives the same day back', () => {
    for (const day of ['2026-11-19', '2026-01-01', '2026-12-31', '2028-02-29']) {
      expect(toYmd(pickerDate(day))).toBe(day);
    }
  });
  it('opens on today when nothing is stored', () => {
    expect(toYmd(pickerDate(''))).toBe(toYmd(new Date()));
  });
});
