import type { Comparison, TrendRange, TrendResult } from './trend';
import { weekdayOf } from './trend';
import type { TrendFallbackReason } from './trendHistory';

/**
 * The words of the Insights trend section (Issue #48, phase 48C), as pure functions of the trend result so every state's
 * wording is testable without rendering. Calm and plain: a quiet week is information, not a failure.
 */

type Ok = Exclude<TrendResult, { status: 'invalid' }>;

export const RANGE_LABEL: Record<TrendRange, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' };

export const formatMinutes = (mins: number): string => {
  const whole = Math.round(mins);
  return whole >= 60 ? `${Math.floor(whole / 60)}h ${whole % 60}m` : `${whole}m`;
};

const tasks = (n: number): string => `${n} ${n === 1 ? 'task' : 'tasks'}`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (dow: number): string => WEEKDAYS[dow] ?? '';

/** "Nov 14" for a calendar date key. Formatted in UTC on the date's own UTC midnight: the key is a label, not an instant. */
export function formatDateKey(date: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

export function comparisonText(comparison: Comparison, range: TrendRange): string {
  if (!comparison.available) {
    switch (comparison.reason) {
      case 'previous-missing':
        return 'There is no earlier period to compare with.';
      case 'no-previous-history':
      case 'previous-incomplete':
      case 'current-incomplete':
        return 'Comparison starts once your history covers two full periods.';
    }
  }
  const d = comparison.deltaCompleted;
  const pct = comparison.percentCompleted === null ? '' : ` (${d > 0 ? '+' : ''}${comparison.percentCompleted}%)`;
  if (d === 0) return `Same as the previous ${range} days.`;
  return `${tasks(Math.abs(d))} ${d > 0 ? 'more' : 'fewer'} than the previous ${range} days${pct}.`;
}

/** The one sentence that says what the section shows. */
export function headline(result: Ok): string {
  const { summary, range } = result;
  switch (result.status) {
    case 'no-history':
      return 'Nothing recorded yet. Finish a task and your history starts here.';
    case 'no-activity':
      return `No tasks completed in the last ${range} days.`;
    case 'partial':
      if (result.truncated) return `${tasks(summary.completed)} in the last ${summary.days} days.`;
      return `${tasks(summary.completed)} since your history began on ${formatDateKey(result.historyStart ?? '')}.`;
    case 'complete':
      return `${tasks(summary.completed)} in the last ${range} days.`;
  }
}

export function coverageNote(reason: TrendFallbackReason): string {
  return reason === 'browser-offline'
    ? "You're offline. Showing the last 7 days saved on this device; older history needs a connection."
    : "We couldn't reach the server. Showing the last 7 days saved on this device; older history needs a connection.";
}

/** "Thursdays", "Mondays and Thursdays", "Monday, Wednesday and Friday". */
export function weekdayList(dows: readonly number[]): string {
  const names = dows.map((d) => `${weekdayName(d)}s`);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The weekday pattern sentence. It always says how much history it rests on (a count of KNOWN days, not a calendar span): it is about the whole history read, not the chosen range. */
export const patternNote = (leaders: readonly number[], knownDays: number): string =>
  `You tend to complete the most tasks on ${weekdayList(leaders)}. Based on ${knownDays} known ${knownDays === 1 ? 'day' : 'days'} of history.`;

export const dayLabel = (date: string, today: string): string =>
  date === today ? 'Today' : formatDateKey(date, { weekday: 'long', month: 'short', day: 'numeric' });

export const shortWeekday = (date: string): string => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(date)];

/** How many completed tasks the live list no longer holds (deleted since): shown under "Completed today" (decision D5). */
export const missingCompletionsNote = (historyCount: number, listed: number): string | null => {
  const n = historyCount - listed;
  if (n <= 0) return null;
  return `${n} completed ${n === 1 ? 'task is' : 'tasks are'} no longer in your list.`;
};
