/**
 * The pure trend model for Insights (Issue #48, phase 48A).
 *
 * What this module is: deterministic arithmetic over a list of already-normalised days. What it is NOT: it does not fetch,
 * read storage, touch React, look at a clock, or decide what "today" is or which timezone a day belongs to. The history
 * reader (phase 48B) owns that: it resolves every day's local calendar date and says whether the day is `known`. This
 * module only receives `DayPoint[]` and computes. The last point of the series IS "today" for every calculation.
 *
 *   GET /api/history -> history reader (source, local date, coverage) -> DayPoint[] -> THIS MODULE -> Insights UI
 *
 * `known` is the one idea the model depends on:
 *   - known: true   the day is inside the account's recorded history. A day with no completions is a real ZERO.
 *   - known: false  nothing was recorded for this day (history had not begun, or the range reaches past what exists).
 *                   It is NOT a zero: it is left out of counts, active days, averages and comparisons, and a comparison
 *                   that would need it is reported as unavailable instead of being computed over a hole.
 * The model never turns an unknown day into a known one, and never turns a known day into an unknown one. (The values of an
 * unknown day are ignored, so a reader bug that attaches numbers to one cannot leak into a total.)
 *
 * Calendar arithmetic uses `Date.UTC` on the YYYY-MM-DD parts only: a date key is a calendar label, not an instant, so no
 * local timezone or DST rule can change a result. Nothing here is persisted; every number is recomputed from the series.
 *
 * Windows are ROLLING (decision D2): "the last N days" and "the N days before them", both measured back from the last point.
 * There are no calendar weeks or months in this version.
 */

// ─── Input ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One day, already resolved by the reader. `date` is the user's local calendar day, YYYY-MM-DD. */
export type DayPoint = {
  date: string;
  completed: number;
  minutes: number;
  known: boolean;
};

export const TREND_RANGES = [7, 30, 90] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** Weekday averages are only offered when every weekday has at least this many known days behind it (4 full weeks). */
export const MIN_SAMPLES_PER_WEEKDAY = 4;
/** A weekday must average at least this many completions to be called "best" (a day of 0.4 is not a habit). */
export const MIN_BEST_WEEKDAY_AVERAGE = 1;

// ─── Calendar arithmetic (no timezone involved) ──────────────────────────────────────────────────────────────────

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds since the epoch of the date's UTC midnight, or null when it is not a real calendar date in strict form. */
function dayNumber(date: string): number | null {
  const m = DATE_PATTERN.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const probe = new Date(t);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

const dateFromDayNumber = (n: number): string => {
  const d = new Date(n * 86_400_000);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
};

/** The calendar date `days` after `date` (negative: before). Throws only for a malformed `date`; callers validate first. */
export function addDays(date: string, days: number): string {
  const n = dayNumber(date);
  if (n === null) throw new RangeError(`not a calendar date: ${date}`);
  return dateFromDayNumber(n + days);
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date. */
export function weekdayOf(date: string): number {
  const n = dayNumber(date);
  if (n === null) throw new RangeError(`not a calendar date: ${date}`);
  return new Date(n * 86_400_000).getUTCDay();
}

// ─── Series validation ───────────────────────────────────────────────────────────────────────────────────────────

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isMinutes = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Why a series cannot be used, or null when it can. A usable series is oldest -> newest, one point per calendar day with no
 * gaps, no duplicates and no out-of-order points, with real dates and non-negative numbers. The model refuses a broken
 * series rather than guess: a chart over a gap or a swapped pair would be a silent lie.
 */
export function seriesProblem(points: readonly DayPoint[]): string | null {
  let previous: number | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (typeof p !== 'object' || p === null) return `point ${i} is not an object`;
    const n = typeof p.date === 'string' ? dayNumber(p.date) : null;
    if (n === null) return `point ${i} has an invalid date`;
    if (typeof p.known !== 'boolean') return `point ${i} has no known flag`;
    if (!isCount(p.completed)) return `point ${i} has an invalid completed count`;
    if (!isMinutes(p.minutes)) return `point ${i} has invalid minutes`;
    if (previous !== null && n !== previous + 1) return `point ${i} does not follow the previous day`;
    previous = n;
  }
  return null;
}

// ─── Summaries ───────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodSummary = {
  /** Points in the window (calendar days covered). */
  days: number;
  /** Days of the window inside recorded history. */
  knownDays: number;
  completed: number;
  minutes: number;
  /** Known days with at least one completion. */
  activeDays: number;
  /** The known day with the most completions (the most recent one on a tie); null when no known day has any. */
  bestDay: { date: string; completed: number } | null;
};

export function summarize(window: readonly DayPoint[]): PeriodSummary {
  let knownDays = 0;
  let completed = 0;
  let minutes = 0;
  let activeDays = 0;
  let bestDay: PeriodSummary['bestDay'] = null;

  for (const p of window) {
    if (!p.known) continue; // an unknown day contributes nothing, whatever numbers it carries
    knownDays += 1;
    completed += p.completed;
    minutes += p.minutes;
    if (p.completed > 0) {
      activeDays += 1;
      if (!bestDay || p.completed >= bestDay.completed) bestDay = { date: p.date, completed: p.completed };
    }
  }
  return { days: window.length, knownDays, completed, minutes, activeDays, bestDay };
}

// ─── Comparison ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ComparisonUnavailable =
  | 'previous-missing' // the series does not reach back a full second window
  | 'no-previous-history' // the previous window is entirely before recorded history
  | 'previous-incomplete' // recorded history begins inside the previous window
  | 'current-incomplete'; // the current window itself contains unknown days

export type Comparison =
  | { available: false; reason: ComparisonUnavailable }
  | {
      available: true;
      deltaCompleted: number;
      deltaMinutes: number;
      deltaActiveDays: number;
      /** Change in completions as a percentage of the previous period; null when the previous period had none (no infinite %). */
      percentCompleted: number | null;
    };

/**
 * `range` is the requested window length. The comparison is made only when BOTH windows are complete and fully known:
 * comparing a full period with a partial one would read as an improvement that is only missing data.
 */
export function comparePeriods(
  current: PeriodSummary,
  previous: PeriodSummary | null,
  range: number,
): Comparison {
  if (!previous || previous.days < range) return { available: false, reason: 'previous-missing' };
  if (current.days < range || current.knownDays < range) return { available: false, reason: 'current-incomplete' };
  if (previous.knownDays === 0) return { available: false, reason: 'no-previous-history' };
  if (previous.knownDays < range) return { available: false, reason: 'previous-incomplete' };

  const percentCompleted =
    previous.completed === 0 ? null : Math.round(((current.completed - previous.completed) / previous.completed) * 100);
  return {
    available: true,
    deltaCompleted: current.completed - previous.completed,
    deltaMinutes: current.minutes - previous.minutes,
    deltaActiveDays: current.activeDays - previous.activeDays,
    percentCompleted,
  };
}

// ─── Weekday pattern ─────────────────────────────────────────────────────────────────────────────────────────────

export type WeekdayAverages =
  | {
      status: 'insufficient';
      /** Smallest number of known days behind any weekday, against `MIN_SAMPLES_PER_WEEKDAY`. */
      fewestSamples: number;
    }
  | {
      status: 'ok';
      /** Index 0 = Sunday ... 6 = Saturday. Average completions per known day of that weekday. */
      averages: number[];
      /** Weekdays sharing the highest average, when it is at least `MIN_BEST_WEEKDAY_AVERAGE`; empty otherwise. */
      leaders: number[];
    };

/**
 * Average completions per weekday over KNOWN days only. Offered only when every weekday has at least
 * `MIN_SAMPLES_PER_WEEKDAY` known days; below that it says so instead of guessing from a handful of days.
 */
export function weekdayAverages(window: readonly DayPoint[]): WeekdayAverages {
  const totals = new Array<number>(7).fill(0);
  const samples = new Array<number>(7).fill(0);
  for (const p of window) {
    if (!p.known) continue;
    const dow = weekdayOf(p.date);
    totals[dow] += p.completed;
    samples[dow] += 1;
  }

  const fewest = Math.min(...samples);
  if (fewest < MIN_SAMPLES_PER_WEEKDAY) return { status: 'insufficient', fewestSamples: fewest };

  const averages = totals.map((total, dow) => total / samples[dow]);
  const top = Math.max(...averages);
  const leaders = top >= MIN_BEST_WEEKDAY_AVERAGE ? averages.flatMap((a, dow) => (a === top ? [dow] : [])) : [];
  return { status: 'ok', averages, leaders };
}

// ─── Weekly buckets (for the 90-day bars) ────────────────────────────────────────────────────────────────────────

export type WeekBucket = {
  startDate: string;
  endDate: string;
  days: number;
  knownDays: number;
  completed: number;
  minutes: number;
  /** Seven days, all known. A shorter or partly unknown bucket is drawn as such, never as a low week. */
  complete: boolean;
};

/**
 * Consecutive 7-day buckets aligned to the END of the window (the last bucket ends on the last day), so a rolling window
 * needs no calendar-week rule. When the length is not a multiple of 7 the OLDEST bucket is the short one.
 */
export function weekBuckets(window: readonly DayPoint[]): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  for (let end = window.length; end > 0; end -= 7) {
    const slice = window.slice(Math.max(0, end - 7), end);
    const s = summarize(slice);
    buckets.unshift({
      startDate: slice[0].date,
      endDate: slice[slice.length - 1].date,
      days: slice.length,
      knownDays: s.knownDays,
      completed: s.completed,
      minutes: s.minutes,
      complete: slice.length === 7 && s.knownDays === 7,
    });
  }
  return buckets;
}

// ─── The result ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How much of the requested window is usable. In order of precedence:
 *  - 'no-history'  no known day in the window (a new account, or a window before history began)
 *  - 'no-activity' known days exist but none has a completion
 *  - 'partial'     part of the window is unknown (history begins inside it) or the series is shorter than the range
 *  - 'complete'    every day of the window is known and the window is the full range
 */
export type TrendStatus = 'no-history' | 'no-activity' | 'partial' | 'complete';

export type TrendResult =
  | { status: 'invalid'; problem: string }
  | {
      status: TrendStatus;
      range: TrendRange;
      /** The last `range` points (fewer when the series is shorter). */
      window: DayPoint[];
      /** True when the series did not reach back `range` days (for example the 7 days available offline asked for 30). */
      truncated: boolean;
      /** First known date of the window, or null. Where "history starts" is drawn when it is inside the window. */
      historyStart: string | null;
      summary: PeriodSummary;
      /** The `range` days before the window, when the series reaches that far; null otherwise. */
      previous: PeriodSummary | null;
      comparison: Comparison;
      weeks: WeekBucket[];
      weekdays: WeekdayAverages;
    };

export function buildTrend(points: readonly DayPoint[], range: TrendRange): TrendResult {
  const problem = seriesProblem(points);
  if (problem) return { status: 'invalid', problem };

  const window = points.slice(Math.max(0, points.length - range));
  const previousSlice = points.slice(Math.max(0, points.length - 2 * range), Math.max(0, points.length - range));
  const summary = summarize(window);
  const previous = previousSlice.length > 0 ? summarize(previousSlice) : null;

  let status: TrendStatus;
  if (summary.knownDays === 0) status = 'no-history';
  else if (window.length < range || summary.knownDays < window.length) status = 'partial';
  else if (summary.completed === 0) status = 'no-activity';
  else status = 'complete';

  return {
    status,
    range,
    window: window.map((p) => ({ ...p })),
    truncated: window.length < range,
    historyStart: window.find((p) => p.known)?.date ?? null,
    summary,
    previous,
    comparison: comparePeriods(summary, previous, range),
    weeks: weekBuckets(window),
    weekdays: weekdayAverages(window),
  };
}
