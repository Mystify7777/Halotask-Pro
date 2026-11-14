import type { HistoryEntry } from '../offline/history';
import type { ServerHistoryEntry } from '../services/historyService';
import { addDays, seriesProblem, type DayPoint } from './trend';

/**
 * Turns what the history layer returned into the `DayPoint[]` the pure trend model takes (Issue #48, phase 48B). No I/O,
 * no clock: `today` is passed in, so the same input always gives the same series.
 *
 * THE RULE FOR `known` (the one decision in this file). A day is `known` once the account has any recorded history on or
 * before it:
 *   - the FIRST day with evidence of history starts the known span; every day from then on is known, so a day with no
 *     completions after that point is a real zero;
 *   - days before it are unknown: nothing was recorded, which is not the same as "zero completions";
 *   - a window with no evidence at all is entirely unknown.
 * "Evidence" for a server day is `source: 'canonical' | 'legacy'`, or (an older server that does not send `source`) a row
 * that exists. A canonical day whose records were all revoked is evidence too: its answer is an authoritative zero.
 *
 * LIMIT, stated rather than hidden: the rule can only see the window it was given. An account that was active long before
 * the window and idle for the whole stretch before its first recent activity looks, inside the window, like a new account,
 * so those leading idle days are reported unknown rather than zero. That fails toward "comparison unavailable", never
 * toward a made-up number. Removing it needs the account's start date from the server, which no endpoint offers today.
 */

/** Marks the days of `points` from the first one with evidence onward as known. `evidence[i]` belongs to `points[i]`. */
function applyKnownSpan(points: Omit<DayPoint, 'known'>[], evidence: boolean[]): DayPoint[] {
  const first = evidence.indexOf(true);
  return points.map((p, i) => ({ ...p, known: first !== -1 && i >= first }));
}

/** The dates `[today - (days - 1), ..., today]`, oldest first. */
const windowDates = (today: string, days: number): string[] =>
  Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i)));

/**
 * `GET /api/history` rows -> a series of exactly `days` points ending on `today`, or null when the answer cannot be
 * trusted as that window (wrong length, wrong dates, a gap, an out-of-order or duplicate row). The server contract is
 * exactly `days` consecutive days ending at the client's today; anything else is a broken answer, and a trend over it
 * would be a silent lie, so the caller falls back instead.
 */
export function pointsFromServer(rows: readonly ServerHistoryEntry[], today: string, days: number): DayPoint[] | null {
  if (rows.length !== days) return null;
  const expected = windowDates(today, days);
  for (let i = 0; i < days; i += 1) {
    if (rows[i].entry.date !== expected[i]) return null;
  }

  const base = rows.map(({ entry }) => ({
    date: entry.date,
    completed: entry.completedCount,
    minutes: entry.workDoneMinutes,
  }));
  const evidence = rows.map(({ source, exists }) => source === 'canonical' || source === 'legacy' || (source === null && exists));
  const points = applyKnownSpan(base, evidence);
  return seriesProblem(points) === null ? points : null;
}

/**
 * The device's own days (`getWeekHistory`: oldest first, placeholders for days with nothing) -> a series. A local entry has
 * no `source`, so the only evidence of history it carries is a completion; days before the first one are unknown.
 */
export function pointsFromLocal(entries: readonly HistoryEntry[], today: string): DayPoint[] | null {
  if (entries.length === 0) return null;
  const expected = windowDates(today, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].date !== expected[i]) return null;
  }

  const base = entries.map((e) => ({ date: e.date, completed: e.completedCount, minutes: e.workDoneMinutes }));
  const evidence = entries.map((e) => e.completedCount > 0 || e.completedTasks.length > 0);
  const points = applyKnownSpan(base, evidence);
  return seriesProblem(points) === null ? points : null;
}
