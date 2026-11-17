/**
 * Zone-aware calendar and wall-clock arithmetic for the server (Issue #29).
 *
 * This is the SAME algorithm as halotasks-client/src/utils/timeZone.ts (reading an instant in an IANA zone, and turning a
 * wall-clock reading into an instant with one daylight-saving policy), so a reminder the server decides to email and a
 * reminder the browser decides to show agree on the minute. It is a copy, not an import, because the two packages do not
 * share code; tests/emailReminderParity.test.ts pins both to the same vectors. Keep them in step.
 *
 * Daylight saving policy: a wall-clock time that does not exist (the skipped spring-forward hour) resolves to the
 * instant one hour later; one that occurs twice (the repeated fall-back hour) resolves to its FIRST occurrence.
 * Only the runtime's Intl data is used: no fixed offsets and no zone table of our own.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ── Reading an instant in a zone ──────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

const partsFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The calendar date and clock reading of `instant` (epoch ms) in `timeZone`. */
export const wallClockAt = (instant: number, timeZone: string): WallClock => {
  const read: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') read[part.type] = Number(part.value);
  }
  return {
    year: read.year,
    month: read.month,
    day: read.day,
    hour: read.hour === 24 ? 0 : read.hour,
    minute: read.minute,
    second: read.second,
  };
};

/** The zone's offset from UTC at `instant`, in ms (positive east of UTC). */
const offsetAt = (instant: number, timeZone: string): number => {
  const w = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
};

const pad = (value: number) => String(value).padStart(2, '0');

/** The calendar day (YYYY-MM-DD) of `instant` in `timeZone`. */
export const dateKeyInZone = (instant: number | Date, timeZone: string): string => {
  const w = wallClockAt(typeof instant === 'number' ? instant : instant.getTime(), timeZone);
  return `${String(w.year).padStart(4, '0')}-${pad(w.month)}-${pad(w.day)}`;
};

/** The calendar day `offsetDays` after (negative: before) the day `from` falls on in `timeZone`. Pure calendar arithmetic. */
export const dateKeyOffsetInZone = (
  offsetDays: number,
  from: number | Date = Date.now(),
  timeZone: string,
): string => {
  const [year, month, day] = dateKeyInZone(from, timeZone).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
};

/** "HH:mm" of `instant` in `timeZone`. */
export const timeOfDayInZone = (instant: number, timeZone: string): string => {
  const w = wallClockAt(instant, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
};

// ── Wall clock -> instant ─────────────────────────────────────────────────────

/**
 * The instant at which `timeZone`'s clocks first read the given calendar date and time. Applies the daylight-saving
 * policy in the file header. `month` is 1-12. The caller validates the date; an impossible one (month 13) is not
 * "fixed up" here, it simply yields NaN.
 */
export const zonedWallClockToInstant = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number => {
  // Strict: Date.UTC would roll month 13 or February 30 into the next period, which would move a deadline to another day.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59 ||
    probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day
  ) {
    return NaN;
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // A zone has at most one offset change inside a few days, so the offsets a day either side bound every offset that
  // can apply to this reading. A candidate offset is genuine only if the zone really is on it at the instant it gives.
  const before = offsetAt(asUtc - DAY_MS, timeZone);
  const after = offsetAt(asUtc + DAY_MS, timeZone);
  const candidates = new Set<number>();
  for (const offset of new Set([before, after])) {
    const instant = asUtc - offset;
    if (offsetAt(instant, timeZone) === offset) candidates.add(instant);
  }

  if (candidates.size > 0) return Math.min(...candidates); // two candidates = repeated hour: the first occurrence
  return asUtc - before; // skipped hour: read under the offset in force before the change (one hour later)
};
