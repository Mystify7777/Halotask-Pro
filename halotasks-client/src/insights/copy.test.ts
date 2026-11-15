import { describe, expect, it } from 'vitest';
import {
  comparisonText, coverageNote, dayLabel, formatDateKey, formatMinutes, headline, missingCompletionsNote, weekdayList,
} from './copy';
import { addDays, buildTrend, type DayPoint, type TrendRange, type TrendResult } from './trend';

const END = '2026-11-14';
const series = (counts: (number | null)[]): DayPoint[] =>
  counts.map((c, i) => ({ date: addDays(END, -(counts.length - 1 - i)), completed: c ?? 0, minutes: (c ?? 0) * 10, known: c !== null }));
const rep = (v: number | null, n: number) => Array.from({ length: n }, () => v);
const ok = (r: TrendResult) => { if (r.status === 'invalid') throw new Error('invalid'); return r; };
const trend = (counts: (number | null)[], range: TrendRange) => ok(buildTrend(series(counts), range));

describe('headline', () => {
  it('complete: counts the tasks, singular and plural', () => {
    expect(headline(trend([...rep(1, 29), 2], 30))).toBe('31 tasks in the last 30 days.');
    expect(headline(trend([...rep(0, 6), 1], 7))).toBe('1 task in the last 7 days.');
  });
  it('no history: invites the first task, no zeros', () => {
    expect(headline(trend(rep(null, 14), 7))).toBe('Nothing recorded yet. Finish a task and your history starts here.');
  });
  it('no activity: says so plainly', () => {
    expect(headline(trend(rep(0, 14), 7))).toBe('No tasks completed in the last 7 days.');
  });
  it('partial: names where history began', () => {
    const text = headline(trend([...rep(null, 20), ...rep(1, 10)], 30));
    expect(text).toContain('10 tasks since your history began on');
    expect(text).toContain(formatDateKey(addDays(END, -9)));
  });
  it('truncated (the 7 device days asked as 30): the days it really covers, not 30', () => {
    expect(headline(trend(rep(1, 7), 30))).toBe('7 tasks in the last 7 days.');
  });
});

describe('comparisonText', () => {
  const cmp = (cur: number, prev: number, range: TrendRange = 7) => {
    const r = trend([...rep(prev, range), ...rep(cur, range)], range);
    return comparisonText(r.comparison, range);
  };
  it('more, fewer and same, with a percentage when there is one', () => {
    expect(cmp(2, 1)).toBe('7 tasks more than the previous 7 days (+100%).');
    expect(cmp(1, 2)).toBe('7 tasks fewer than the previous 7 days (-50%).');
    expect(cmp(1, 1)).toBe('Same as the previous 7 days.');
  });
  it('a previous period with nothing has no percentage', () => {
    expect(cmp(1, 0)).toBe('7 tasks more than the previous 7 days.');
  });
  it('a single task is singular', () => {
    const r = trend([...rep(0, 6), 0, ...rep(0, 6), 1], 7);
    expect(comparisonText(r.comparison, 7)).toBe('1 task more than the previous 7 days.');
  });
  it('unavailable: says what is missing, in plain words', () => {
    expect(comparisonText(trend(rep(1, 90), 90).comparison, 90)).toBe('There is no earlier period to compare with.');
    expect(comparisonText(trend([...rep(null, 10), ...rep(1, 4)], 7).comparison, 7)).toMatch(/two full periods/);
  });
});

describe('small helpers', () => {
  it('formatMinutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h 0m');
    expect(formatMinutes(125.4)).toBe('2h 5m');
  });
  it('formatDateKey is the calendar date itself, whatever the timezone', () => {
    expect(formatDateKey('2026-11-14', { year: 'numeric', month: '2-digit', day: '2-digit' })).toMatch(/11.*14.*2026|2026.*11.*14|14.*11.*2026/);
    expect(formatDateKey('2026-03-08')).toBe(formatDateKey('2026-03-08'));
  });
  it('dayLabel says Today for today', () => {
    expect(dayLabel('2026-11-14', '2026-11-14')).toBe('Today');
    expect(dayLabel('2026-11-13', '2026-11-14')).not.toBe('Today');
  });
  it('weekdayList', () => {
    expect(weekdayList([4])).toBe('Thursdays');
    expect(weekdayList([1, 4])).toBe('Mondays and Thursdays');
    expect(weekdayList([1, 3, 5])).toBe('Mondays, Wednesdays and Fridays');
    expect(weekdayList([])).toBe('');
  });
  it('coverageNote tells offline from unreachable and always says older history needs a connection', () => {
    expect(coverageNote('browser-offline')).toMatch(/offline/i);
    expect(coverageNote('unavailable')).toMatch(/couldn't reach the server/i);
    expect(coverageNote('browser-offline')).toMatch(/older history needs a connection/);
    expect(coverageNote('unavailable')).toMatch(/older history needs a connection/);
  });
  it('missingCompletionsNote only when history holds more than the list (decision D5)', () => {
    expect(missingCompletionsNote(3, 3)).toBeNull();
    expect(missingCompletionsNote(2, 3)).toBeNull();
    expect(missingCompletionsNote(4, 3)).toBe('1 completed task is no longer in your list.');
    expect(missingCompletionsNote(5, 3)).toBe('2 completed tasks are no longer in your list.');
  });
});
