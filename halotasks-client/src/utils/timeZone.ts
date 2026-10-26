/**
 * Time zone model (Issue #41).
 *
 * The user's preferred zone is an IANA identifier ("Asia/Kolkata"), saved on the server and mirrored here. Every
 * reading of a task's wall-clock time goes through one zone, `getEffectiveTimeZone()`:
 *
 *     effective zone = the saved preference, if there is one
 *                      otherwise the device's zone (a FALLBACK only: it is never saved or written back)
 *                      otherwise UTC (a runtime that cannot name its own zone)
 *
 * Only the Intl API (the runtime's own time zone data) is used: no fixed offsets, no zone table of our own.
 *
 * Wall clock <-> instant, and the daylight-saving policy (deterministic, never depends on the machine's zone):
 *   - a wall-clock time that does NOT exist (the hour skipped when clocks spring forward) resolves to the instant
 *     the same reading has under the offset in force just BEFORE the change, i.e. it moves one hour later
 *     (02:30 on a spring-forward day in Los Angeles is 03:30 PDT). It is never rejected and never silently shifted
 *     to a different day.
 *   - a wall-clock time that occurs TWICE (the hour repeated when clocks fall back) resolves to its FIRST occurrence
 *     (the earlier instant, still on daylight time).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The device's IANA zone, or null if the runtime does not report one. */
export const getDeviceTimeZone = (): string | null => {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && isUsableTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
};

const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** True for an identifier the runtime knows. Fixed offsets ("+05:30") are not IANA zones and are refused. */
export function isUsableTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ── The active zone ───────────────────────────────────────────────────────────

let preferredTimeZone: string | null = null;

/**
 * Records the saved preference (null when the account has none). The auth store calls this whenever the signed-in
 * user changes; nothing else should. An unusable value is treated as "no preference" rather than trusted.
 */
export const setPreferredTimeZone = (zone: string | null | undefined): void => {
  preferredTimeZone = zone && isUsableTimeZone(zone) ? zone : null;
};

export const getPreferredTimeZone = (): string | null => preferredTimeZone;

/** The zone every deadline, label and reminder is read in right now. */
export const getEffectiveTimeZone = (): string => preferredTimeZone ?? getDeviceTimeZone() ?? 'UTC';

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
export const dateKeyInZone = (instant: number | Date, timeZone: string = getEffectiveTimeZone()): string => {
  const w = wallClockAt(typeof instant === 'number' ? instant : instant.getTime(), timeZone);
  return `${String(w.year).padStart(4, '0')}-${pad(w.month)}-${pad(w.day)}`;
};

/** The calendar day `offsetDays` after (negative: before) the day `from` falls on in `timeZone`. Pure calendar arithmetic. */
export const dateKeyOffsetInZone = (
  offsetDays: number,
  from: number | Date = Date.now(),
  timeZone: string = getEffectiveTimeZone(),
): string => {
  const [year, month, day] = dateKeyInZone(from, timeZone).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
};

/** "HH:mm" of `instant` in `timeZone`. */
export const timeOfDayInZone = (instant: number, timeZone: string = getEffectiveTimeZone()): string => {
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

// ── Choosing a zone (Settings) ────────────────────────────────────────────────

/**
 * The identifiers this runtime supports, for the Settings selector. Comes from the runtime's own data
 * (Intl.supportedValuesOf), so there is no list to maintain; an older runtime without it returns an empty list and
 * the selector then offers only the zones it is already given (the saved one, the device's, UTC).
 */
export const listTimeZones = (): string[] => {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return supported ? supported('timeZone').filter(isUsableTimeZone) : [];
  } catch {
    return [];
  }
};

/** "UTC+05:30" / "UTC-07:00" / "UTC": the zone's offset at `at`, for display only (never stored or computed with). */
export const formatZoneOffset = (timeZone: string, at: number = Date.now()): string => {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!name) return '';
    const label = name.replace('GMT', 'UTC');
    return label === 'UTC' || label === 'UTC+00:00' ? 'UTC' : label;
  } catch {
    return '';
  }
};

/** "Asia/Kolkata (UTC+05:30)", with underscores read as spaces. */
export const describeTimeZone = (timeZone: string, at: number = Date.now()): string => {
  const offset = formatZoneOffset(timeZone, at);
  const name = timeZone.replace(/_/g, ' ');
  return offset ? `${name} (${offset})` : name;
};
