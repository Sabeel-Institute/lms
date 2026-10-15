import { useEffect, useState } from 'react';
import { INSTITUTE_TIMEZONE, todayInZone } from '@sabeel/shared';

/**
 * The institute's date, drawn again the moment it changes.
 *
 * A screen worked the date out when it last drew, and a paused player draws
 * nothing: at midnight it still offered Play on a recording whose last day had
 * ended, and Play started it again. Checked each second, which costs a short
 * string; working out when midnight falls in another zone would cost more.
 */
export function useInstituteDay(): string {
  const [day, setDay] = useState(() => todayInZone(INSTITUTE_TIMEZONE));
  useEffect(() => {
    const tick = setInterval(() => setDay(todayInZone(INSTITUTE_TIMEZONE)), 1000);
    return () => clearInterval(tick);
  }, []);
  return day;
}

/**
 * Whether a recording playing now has been playing since before its last day
 * ended: what lets it play on to the end of its part. One paused across
 * midnight and started again has not, and is closed.
 */
export function playingSinceItsDay(playingSince: number | null, dueDate: string): boolean {
  return playingSince !== null && todayInZone(INSTITUTE_TIMEZONE, playingSince) <= dueDate;
}
