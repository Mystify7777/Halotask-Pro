/**
 * Calendar-date contract for History (the ONE convention used by client and server).
 *
 * A history "date" is the user's LOCAL calendar day, YYYY-MM-DD:
 *
 *     date = calendar date of an instant, shifted by the user's UTC offset
 *
 * The server does not know the user's timezone, so the client declares it explicitly on every
 * history request as `utcOffsetMinutes` (minutes EAST of UTC at that moment, e.g. India +330,
 * Los Angeles -420 in summer / -480 in winter, Kiritimati +840, Baker Island -720). The offset is
 * a per-request fact, so DST is handled by the client simply sending its current offset.
 *
 * The server then evaluates "today" with its own clock and that offset — never with its own
 * timezone and never in UTC — which yields EXACTLY ONE date, and `/today` and GET `endDate` accept
 * only that date. There is no clock-skew tolerance: yesterday and tomorrow are never "today", even a
 * second either side of local midnight. There is no default offset and no UTC fallback: a request
 * without a valid offset is rejected.
 *
 * A wrong declared offset can only misplace the caller's OWN entries; entries are always stored
 * per authenticated user.
 *
 * All arithmetic on YYYY-MM-DD strings is pure calendar arithmetic (done in UTC internally purely
 * so process timezone / DST rules cannot interfere).
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Real-world UTC offsets range from UTC-12:00 to UTC+14:00. */
export const MIN_UTC_OFFSET_MINUTES = -12 * 60;
export const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const MINUTE_MS = 60 * 1000;

/** True only for a real calendar date in strict YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** A declared offset: an integer number of minutes within the real-world range. */
export function isValidUtcOffsetMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_UTC_OFFSET_MINUTES &&
    value <= MAX_UTC_OFFSET_MINUTES
  );
}

/** Adds `days` (may be negative) to a valid YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The calendar date at `instant` for someone living at `utcOffsetMinutes` east of UTC. */
export function localDateAt(instant: Date, utcOffsetMinutes: number): string {
  return new Date(instant.getTime() + utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/**
 * THE current calendar date for a client at `utcOffsetMinutes`: the server's clock shifted by that
 * offset. Always exactly one date.
 */
export function getToday(utcOffsetMinutes: number, now: Date = new Date()): string {
  return localDateAt(now, utcOffsetMinutes);
}

/** Inclusive lexical range check (valid for zero-padded YYYY-MM-DD). */
export function isDateInRange(date: string, min: string, max: string): boolean {
  return date >= min && date <= max;
}
