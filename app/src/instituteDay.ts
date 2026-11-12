import { useEffect, useState } from 'react';
import { INSTITUTE_TIMEZONE, todayInZone, windowLastDay, type ListenWindow } from '@sabeel/shared';

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

const openLastDays = new Map<string, string>();

/**
 * The last day a student's window for a recording had WHILE IT WAS OPEN,
 * kept after it closes. `playsOn` compares it with the closed window's last
 * day: equal, the window closed because that day ended; different, its last
 * day shrank under it (a given date taken back), which is staff taking it away
 * and stops it at once.
 *
 * ONE MEMORY FOR THE APP, told by every reader of the window and read by
 * each. Kept per screen, a player opened after midnight had never seen the
 * window open, and drew "closed" over audio the docked bar was rightly letting
 * play on. The docked bar renders whenever something is loaded, so whatever
 * plays has been seen open by it.
 */
export function rememberedOpenDay(studentUid: string | null, recordingId: string | null, window: ListenWindow | null): string | null {
  if (!studentUid || !recordingId) return null;
  const key = `${studentUid} ${recordingId}`;
  const day = window?.state === 'open' ? windowLastDay(window) : null;
  if (day) openLastDays.set(key, day);
  return openLastDays.get(key) ?? null;
}
