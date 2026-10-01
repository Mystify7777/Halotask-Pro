/**
 * Local calendar-date helpers.
 *
 * Contract (shared with the server — see halotasks-server/src/utils/calendarDate.ts):
 * a History date is the user's LOCAL calendar day as YYYY-MM-DD, i.e. the calendar date of an
 * instant shifted by the user's UTC offset. The client owns that fact: it computes the date from
 * the device's local clock and declares the matching offset (`getUtcOffsetMinutes`) on EVERY history
 * request, so the server can validate "today" precisely. Never derive a user-facing date from
 * `toISOString()` (UTC), and never omit the offset — the server has no UTC fallback.
 */

export const toLocalDateKey = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/** Local calendar date `offsetDays` from `from` (negative = past). DST-safe (uses setDate). */
export const localDateKeyOffset = (offsetDays: number, from: Date = new Date()): string => {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + offsetDays);
  return toLocalDateKey(d);
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date in strict YYYY-MM-DD form. */
export const isValidDateKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
};

/**
 * The device's current UTC offset in minutes EAST of UTC (India +330, Los Angeles -420 in summer
 * and -480 in winter). Evaluated per request so DST changes are picked up automatically.
 */
export const getUtcOffsetMinutes = (at: Date = new Date()): number => {
  const offset = -at.getTimezoneOffset();
  return offset === 0 ? 0 : offset; // normalise -0
};
