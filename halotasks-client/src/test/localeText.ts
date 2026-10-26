/**
 * Reading a rendered date/time label without depending on the runtime's locale.
 *
 * The app formats dates and times with the runtime's default locale (`toLocale*String(undefined, ...)`), as every
 * other screen does, so the same label is "Due today, 5:30 PM" in en-US, "Due today, 5:30 pm" in en-IN and
 * "Due today, 17:30" in en-GB/de-DE, and a day is "Oct 20" or "20 Oct". Day-period case, day/month order, the space
 * before the day period (an ordinary or a narrow no-break space) and 12h vs 24h are presentation, not product
 * contract. These helpers extract the VALUES a label must carry (the clock reading, the day number, the month) so a
 * test can still assert them exactly, in any locale, instead of pinning one locale's punctuation.
 */

// "5:30 pm", "5:30 PM", "05:30 p.m.", "17:30". The day-period is optional, so 24h locales read too.
const CLOCK = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)(?:\s*([AaPp])\.?\s?[Mm]\.?)?/;

/** The clock reading in a label as 24h "HH:mm" (5:30 pm -> "17:30", 12:05 am -> "00:05"), or null if it has none. */
export const clockOf = (text: string): string | null => {
  const match = CLOCK.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2];
  if (match[3]) {
    const pm = match[3].toLowerCase() === 'p';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  return `${String(hour).padStart(2, '0')}:${minute}`;
};

/** A label with its clock reading removed, so the date part can be read on its own. */
export const withoutClock = (text: string): string => text.replace(CLOCK, '');

/** The runtime's own short month name for month 1-12 (what `{ month: 'short' }` renders in this locale). */
export const shortMonth = (month: number): string =>
  new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, month - 1, 15)));

/**
 * True when the label's date part names exactly this day and month, in either order: the day number appears as a
 * whole number (20 is not 2 or 200) and the month appears as the runtime renders it.
 */
export const namesDay = (text: string, month: number, day: number): boolean => {
  const date = withoutClock(text);
  const dayRuns = date.match(/\d+/g) ?? [];
  return dayRuns.length === 1 && Number(dayRuns[0]) === day && date.includes(shortMonth(month));
};

/** True when the label names some month and day (any), with no clock: used where only "a date" is the point. */
export const namesSomeDay = (text: string): boolean => {
  const date = withoutClock(text);
  return (date.match(/\d+/g) ?? []).length === 1 && Array.from({ length: 12 }, (_, i) => shortMonth(i + 1)).some((m) => date.includes(m));
};
