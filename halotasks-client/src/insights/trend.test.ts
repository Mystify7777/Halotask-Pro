import { describe, expect, it, vi } from 'vitest';
import {
  MIN_BEST_WEEKDAY_AVERAGE,
  MIN_SAMPLES_PER_WEEKDAY,
  addDays,
  buildTrend,
  comparePeriods,
  seriesProblem,
  summarize,
  weekBuckets,
  weekdayAverages,
  weekdayOf,
  type DayPoint,
  type TrendRange,
  type TrendResult,
} from './trend';
import trendSource from './trend.ts?raw';

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `counts` oldest -> newest, ending on `end`. `null` = a day before recorded history (unknown). */
function series(end: string, counts: (number | null)[], minutesPerTask = 10): DayPoint[] {
  return counts.map((c, i) => ({
    date: addDays(end, -(counts.length - 1 - i)),
    completed: c ?? 0,
    minutes: (c ?? 0) * minutesPerTask,
    known: c !== null,
  }));
}
const repeat = <T,>(v: T, n: number): T[] => Array.from({ length: n }, () => v);
const ok = (r: TrendResult) => {
  if (r.status === 'invalid') throw new Error(`invalid: ${r.problem}`);
  return r;
};

const END = '2026-11-14'; // a Saturday

// ─── calendar arithmetic ─────────────────────────────────────────────────────────────────────────────────────────

describe('calendar arithmetic (no timezone involved)', () => {
  it('adds and subtracts days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-11-14', 0)).toBe('2026-11-14');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01'); // not a leap year
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('is exact across DST changes in any timezone (a date key is a label, not an instant)', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // US spring forward
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // US fall back
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30'); // EU spring forward
    expect(addDays('2026-10-25', -1)).toBe('2026-10-24');
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01');
  });

  it('knows the weekday of a calendar date', () => {
    expect(weekdayOf('2026-11-14')).toBe(6); // Saturday
    expect(weekdayOf('2026-11-15')).toBe(0); // Sunday
    expect(weekdayOf('2028-02-29')).toBe(2); // Tuesday
  });

  it('rejects what is not a real calendar date', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('26-11-14', 1)).toThrow(RangeError);
    expect(() => weekdayOf('2026-13-01')).toThrow(RangeError);
  });
});

// ─── series validation ───────────────────────────────────────────────────────────────────────────────────────────

describe('seriesProblem', () => {
  it('accepts an empty series and a well-formed one', () => {
    expect(seriesProblem([])).toBeNull();
    expect(seriesProblem(series(END, [1, 0, 2]))).toBeNull();
  });

  it.each([
    ['a gap', (s: DayPoint[]) => [s[0], s[2]]],
    ['a duplicate day', (s: DayPoint[]) => [s[0], s[0], s[1]]],
    ['out of order', (s: DayPoint[]) => [s[1], s[0], s[2]]],
    ['a bad date', (s: DayPoint[]) => [{ ...s[0], date: '2026-02-30' }, s[1], s[2]]],
    ['a fractional count', (s: DayPoint[]) => [{ ...s[0], completed: 1.5 }, s[1], s[2]]],
    ['a negative count', (s: DayPoint[]) => [{ ...s[0], completed: -1 }, s[1], s[2]]],
    ['NaN minutes', (s: DayPoint[]) => [{ ...s[0], minutes: Number.NaN }, s[1], s[2]]],
    ['negative minutes', (s: DayPoint[]) => [{ ...s[0], minutes: -5 }, s[1], s[2]]],
    ['a missing known flag', (s: DayPoint[]) => [{ ...s[0], known: undefined as unknown as boolean }, s[1], s[2]]],
    ['a null point', (s: DayPoint[]) => [null as unknown as DayPoint, s[1], s[2]]],
  ])('refuses %s', (_name, mutate) => {
    expect(seriesProblem(mutate(series(END, [1, 2, 3])))).toEqual(expect.any(String));
  });

  it('buildTrend reports an invalid series instead of computing over it', () => {
    const broken = [series(END, [1, 2, 3])[0], series(END, [1, 2, 3])[2]];
    const r = buildTrend(broken, 7);
    expect(r.status).toBe('invalid');
    expect(r).toHaveProperty('problem');
    expect(r).not.toHaveProperty('summary');
  });
});

// ─── summarize ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('totals, active days and best day over known days', () => {
    const s = summarize(series(END, [0, 3, 0, 1, 3, 0, 2]));
    expect(s).toEqual({
      days: 7,
      knownDays: 7,
      completed: 9,
      minutes: 90,
      activeDays: 4,
      bestDay: { date: '2026-11-12', completed: 3 }, // two days tie at 3: the most recent wins
    });
  });

  it('a zero day inside history is a real zero: counted as a known day, not active', () => {
    const s = summarize(series(END, [0, 0, 0]));
    expect(s).toMatchObject({ days: 3, knownDays: 3, completed: 0, activeDays: 0, bestDay: null });
  });

  it('unknown days are not counted, not active and not a zero', () => {
    const s = summarize(series(END, [null, null, 2, 0]));
    expect(s).toMatchObject({ days: 4, knownDays: 2, completed: 2, activeDays: 1 });
  });

  it('ignores numbers attached to an unknown day', () => {
    const pts = series(END, [null, 1]);
    pts[0] = { ...pts[0], completed: 99, minutes: 999 };
    expect(summarize(pts)).toMatchObject({ completed: 1, minutes: 10, activeDays: 1, knownDays: 1, bestDay: { date: END, completed: 1 } });
  });

  it('an empty window is all zeros', () => {
    expect(summarize([])).toEqual({ days: 0, knownDays: 0, completed: 0, minutes: 0, activeDays: 0, bestDay: null });
  });

  it('minutes are summed as given (fractions of a minute are kept, not rounded)', () => {
    const pts = series(END, [1, 1]);
    pts[0].minutes = 12.5;
    pts[1].minutes = 7.25;
    expect(summarize(pts).minutes).toBe(19.75);
  });
});

// ─── comparePeriods ──────────────────────────────────────────────────────────────────────────────────────────────

describe('comparePeriods', () => {
  const full = (completed: number, active: number, minutes = completed * 10) => ({
    days: 7, knownDays: 7, completed, minutes, activeDays: active, bestDay: null,
  });

  it('computes deltas and a rounded percentage between two complete windows', () => {
    expect(comparePeriods(full(12, 5), full(8, 4), 7)).toEqual({
      available: true, deltaCompleted: 4, deltaMinutes: 40, deltaActiveDays: 1, percentCompleted: 50,
    });
    expect(comparePeriods(full(2, 2), full(3, 3), 7)).toMatchObject({ available: true, deltaCompleted: -1, percentCompleted: -33 });
    expect(comparePeriods(full(5, 3), full(5, 3), 7)).toMatchObject({ available: true, deltaCompleted: 0, percentCompleted: 0 });
  });

  it('never divides by zero: a previous period with no completions has no percentage', () => {
    const c = comparePeriods(full(4, 2), full(0, 0), 7);
    expect(c).toMatchObject({ available: true, deltaCompleted: 4, percentCompleted: null });
  });

  it('unavailable when there is no previous window, or it is shorter than the range', () => {
    expect(comparePeriods(full(1, 1), null, 7)).toEqual({ available: false, reason: 'previous-missing' });
    expect(comparePeriods(full(1, 1), { ...full(1, 1), days: 3, knownDays: 3 }, 7)).toEqual({ available: false, reason: 'previous-missing' });
  });

  it('unavailable when the previous window is entirely before history, or history starts inside it', () => {
    expect(comparePeriods(full(1, 1), { ...full(0, 0), knownDays: 0 }, 7)).toEqual({ available: false, reason: 'no-previous-history' });
    expect(comparePeriods(full(1, 1), { ...full(2, 1), knownDays: 4 }, 7)).toEqual({ available: false, reason: 'previous-incomplete' });
  });

  it('unavailable when the current window itself has unknown days or is short', () => {
    expect(comparePeriods({ ...full(1, 1), knownDays: 6 }, full(1, 1), 7)).toEqual({ available: false, reason: 'current-incomplete' });
    expect(comparePeriods({ ...full(1, 1), days: 5, knownDays: 5 }, full(1, 1), 7)).toEqual({ available: false, reason: 'current-incomplete' });
  });
});

// ─── weekday averages ────────────────────────────────────────────────────────────────────────────────────────────

describe('weekdayAverages', () => {
  // 28 days ending Saturday: exactly four of every weekday.
  const fourWeeks = (perWeek: number[]) => {
    const counts: number[] = [];
    // oldest day is a Sunday (END minus 27 days)
    for (let w = 0; w < 4; w += 1) counts.push(...perWeek);
    return series(END, counts);
  };

  it('is gated: fewer than the minimum samples for any weekday is "insufficient", with the smallest count', () => {
    const r = weekdayAverages(series(END, repeat(1, 27))); // 27 days: one weekday has 3
    expect(r).toEqual({ status: 'insufficient', fewestSamples: MIN_SAMPLES_PER_WEEKDAY - 1 });
    expect(weekdayAverages([])).toEqual({ status: 'insufficient', fewestSamples: 0 });
  });

  it('exactly the minimum is enough', () => {
    expect(weekdayAverages(series(END, repeat(1, 28))).status).toBe('ok');
  });

  it('averages per weekday (Sunday = 0) and names the leader', () => {
    // Sun..Sat per week
    const r = weekdayAverages(fourWeeks([0, 2, 0, 0, 6, 0, 0]));
    expect(r).toEqual({ status: 'ok', averages: [0, 2, 0, 0, 6, 0, 0], leaders: [4] }); // Thursday
  });

  it('reports every weekday that ties for the top', () => {
    const r = weekdayAverages(fourWeeks([0, 3, 0, 3, 1, 0, 0]));
    expect(r).toMatchObject({ status: 'ok', leaders: [1, 3] });
  });

  it('no leader when even the best weekday averages below the threshold', () => {
    const r = weekdayAverages(fourWeeks([0, 0, 0, 0, 0, 0, 0]));
    expect(r).toMatchObject({ status: 'ok', leaders: [] });
    // one completion over four Tuesdays = 0.25
    const sparse = series(END, repeat(0, 28));
    sparse.find((p) => weekdayOf(p.date) === 2)!.completed = 1;
    expect(weekdayAverages(sparse)).toMatchObject({ status: 'ok', leaders: [] });
    expect(MIN_BEST_WEEKDAY_AVERAGE).toBe(1);
  });

  it('an average of exactly the threshold counts as a leader', () => {
    const r = weekdayAverages(fourWeeks([0, 1, 0, 0, 0, 0, 0]));
    expect(r).toMatchObject({ status: 'ok', leaders: [1] });
  });

  it('unknown days are not samples: a long series whose known part is short stays insufficient', () => {
    const r = weekdayAverages(series(END, [...repeat(null, 20), ...repeat(1, 10)]));
    expect(r).toMatchObject({ status: 'insufficient' });
  });

  it('unknown days do not dilute an average', () => {
    const counts = [...repeat(null, 7), ...repeat(4, 28)];
    const r = weekdayAverages(series(END, counts));
    expect(r).toMatchObject({ status: 'ok', averages: repeat(4, 7) });
  });
});

// ─── weekly buckets ──────────────────────────────────────────────────────────────────────────────────────────────

describe('weekBuckets', () => {
  it('aligns to the END of the window: the last bucket ends on the last day', () => {
    const b = weekBuckets(series(END, repeat(1, 14)));
    expect(b).toHaveLength(2);
    expect(b[1]).toMatchObject({ startDate: '2026-11-08', endDate: END, days: 7, completed: 7, complete: true });
    expect(b[0]).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-07', complete: true });
  });

  it('90 days = twelve full buckets and a short, oldest one of six days', () => {
    const b = weekBuckets(series(END, repeat(1, 90)));
    expect(b).toHaveLength(13);
    expect(b[0]).toMatchObject({ days: 6, complete: false, completed: 6 });
    expect(b.slice(1).every((x) => x.days === 7 && x.complete)).toBe(true);
    expect(b.reduce((s, x) => s + x.completed, 0)).toBe(90);
  });

  it('a bucket with unknown days is marked incomplete and counts only the known ones', () => {
    const b = weekBuckets(series(END, [null, null, null, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1]));
    expect(b[0]).toMatchObject({ days: 7, knownDays: 4, completed: 8, complete: false });
    expect(b[1]).toMatchObject({ complete: true, completed: 7 });
  });

  it('an empty window has no buckets', () => {
    expect(weekBuckets([])).toEqual([]);
  });

  it('the bucket totals always add up to the window total', () => {
    const pts = series(END, [null, 1, 2, 3, 0, 0, 4, 5, 1, 0, 2, 2, 9]);
    expect(weekBuckets(pts).reduce((s, x) => s + x.completed, 0)).toBe(summarize(pts).completed);
  });
});

// ─── buildTrend: ranges, status, history boundaries ──────────────────────────────────────────────────────────────

describe.each([7, 30, 90] as TrendRange[])('buildTrend, range %i', (range) => {
  it('a full, fully known history is "complete" with a window of exactly the range and a comparison', () => {
    const r = ok(buildTrend(series(END, repeat(2, range * 2)), range));
    expect(r.status).toBe('complete');
    expect(r.window).toHaveLength(range);
    expect(r.window[r.window.length - 1].date).toBe(END);
    expect(r.truncated).toBe(false);
    expect(r.summary).toMatchObject({ days: range, knownDays: range, completed: range * 2, activeDays: range });
    expect(r.previous).toMatchObject({ days: range, completed: range * 2 });
    expect(r.comparison).toMatchObject({ available: true, deltaCompleted: 0, percentCompleted: 0 });
  });

  it('the window is the LAST `range` days and the previous window is the `range` days before it, with no overlap', () => {
    const counts = [...repeat(1, range), ...repeat(3, range)];
    const r = ok(buildTrend(series(END, counts), range));
    expect(r.summary.completed).toBe(3 * range);
    expect(r.previous?.completed).toBe(1 * range);
    expect(r.comparison).toMatchObject({ available: true, deltaCompleted: 2 * range, percentCompleted: 200 });
  });

  it('longer series than needed: only the last two windows matter', () => {
    const r = ok(buildTrend(series(END, [...repeat(50, 40), ...repeat(1, range * 2)]), range));
    expect(r.summary.completed).toBe(range);
    expect(r.previous?.completed).toBe(range);
  });

  it('history that begins inside the window is "partial", names where it starts, and compares nothing', () => {
    const r = ok(buildTrend(series(END, [...repeat(null, range * 2 - 3), 1, 1, 1]), range));
    expect(r.status).toBe('partial');
    expect(r.historyStart).toBe(addDays(END, -2));
    expect(r.summary).toMatchObject({ knownDays: 3, completed: 3 });
    expect(r.comparison).toEqual({ available: false, reason: 'current-incomplete' });
  });

  it('a series shorter than the range is "partial" and truncated, never padded', () => {
    const r = ok(buildTrend(series(END, repeat(1, 7)), range));
    if (range === 7) {
      expect(r.truncated).toBe(false);
      expect(r.previous).toBeNull();
      expect(r.comparison).toEqual({ available: false, reason: 'previous-missing' });
    } else {
      expect(r.status).toBe('partial');
      expect(r.truncated).toBe(true);
      expect(r.window).toHaveLength(7);
      expect(r.summary.days).toBe(7);
    }
  });

  it('no known day in the window is "no-history", with no start date', () => {
    const r = ok(buildTrend(series(END, repeat(null, range * 2)), range));
    expect(r.status).toBe('no-history');
    expect(r.historyStart).toBeNull();
    expect(r.summary).toMatchObject({ knownDays: 0, completed: 0 });
  });

  it('known days with no completions are "no-activity", not "no-history"', () => {
    const r = ok(buildTrend(series(END, repeat(0, range * 2)), range));
    expect(r.status).toBe('no-activity');
    expect(r.historyStart).toBe(addDays(END, -(range - 1)));
    expect(r.comparison).toMatchObject({ available: true, deltaCompleted: 0, percentCompleted: null });
  });
});

describe('buildTrend: boundaries and precedence', () => {
  it('an empty series is "no-history" for every range', () => {
    for (const range of [7, 30, 90] as const) {
      const r = ok(buildTrend([], range));
      expect(r).toMatchObject({ status: 'no-history', truncated: true, previous: null, weeks: [] });
      expect(r.summary).toMatchObject({ days: 0, completed: 0 });
    }
  });

  it('a one-day series works', () => {
    const r = ok(buildTrend(series(END, [3]), 7));
    expect(r.status).toBe('partial');
    expect(r.summary).toMatchObject({ days: 1, completed: 3, activeDays: 1 });
  });

  it('"no-history" outranks truncated, and "partial" outranks "no-activity"', () => {
    expect(ok(buildTrend(series(END, [null, null]), 30)).status).toBe('no-history');
    expect(ok(buildTrend(series(END, [null, 0, 0]), 7)).status).toBe('partial');
  });

  it('history starting exactly at the window start is complete; one day later is partial', () => {
    const exact = ok(buildTrend(series(END, [...repeat(null, 7), ...repeat(1, 7)]), 7));
    expect(exact.status).toBe('complete');
    expect(exact.comparison).toEqual({ available: false, reason: 'no-previous-history' });
    const later = ok(buildTrend(series(END, [...repeat(null, 8), ...repeat(1, 6)]), 7));
    expect(later.status).toBe('partial');
  });

  it('history starting inside the PREVIOUS window leaves the current complete but the comparison unavailable', () => {
    const r = ok(buildTrend(series(END, [...repeat(null, 3), ...repeat(1, 11)]), 7));
    expect(r.status).toBe('complete');
    expect(r.comparison).toEqual({ available: false, reason: 'previous-incomplete' });
  });

  it('a window that ends on a period boundary (month, year, leap day) is read by position, not by calendar', () => {
    const r = ok(buildTrend(series('2028-03-01', repeat(1, 60)), 30));
    expect(r.window[0].date).toBe('2028-02-01');
    expect(r.window).toHaveLength(30);
    expect(r.window.map((p) => p.date)).toContain('2028-02-29');
  });

  it('does not modify its input and returns a copy of the window', () => {
    const input = series(END, repeat(1, 14));
    const frozen = JSON.stringify(input);
    Object.freeze(input);
    input.forEach(Object.freeze);
    const r = ok(buildTrend(input, 7));
    expect(JSON.stringify(input)).toBe(frozen);
    r.window[0].completed = 99;
    expect(input[7].completed).toBe(1);
  });

  it('weeks and weekdays are computed over the window only', () => {
    const r = ok(buildTrend(series(END, [...repeat(9, 40), ...repeat(1, 28)]), 30));
    expect(r.weeks.reduce((s, w) => s + w.completed, 0)).toBe(r.summary.completed);
    expect(r.weekdays).toMatchObject({ status: 'ok' }); // 30 days: each weekday at least 4 times
  });
});

// ─── determinism and the module's boundary ───────────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('gives the same answer whatever the clock says', () => {
    const input = series(END, [0, 1, 2, 0, 3, 1, 1, 0, 2, 2, 0, 1, 4, 1]);
    const a = buildTrend(input, 7);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-12-31T23:59:59Z'));
    const b = buildTrend(input, 7);
    vi.setSystemTime(new Date('2090-06-01T00:00:00Z'));
    const c = buildTrend(input, 7);
    vi.useRealTimers();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('never reads the clock, randomness, the network, storage or React (source guard)', () => {
    const source = trendSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/Date\.now|new Date\(\s*\)|Math\.random|performance\.now/);
    expect(source).not.toMatch(/getTimezoneOffset|toLocale|Intl\.|getHours|getDate\(|getMonth\(|getFullYear\(|getDay\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|axios|React|useState/);
  });
});
