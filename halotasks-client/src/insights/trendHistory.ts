import { getWeekHistory } from '../offline/history';
import { historyService } from '../services/historyService';
import { useAuthStore } from '../store/authStore';
import { toLocalDateKey } from '../utils/localDate';
import { pointsFromLocal, pointsFromServer } from './dayPoints';
import type { DayPoint } from './trend';

/**
 * The history reader for Insights (Issue #48, phase 48B): the one place that turns "what history does this account have"
 * into the normalised `DayPoint[]` the pure trend model takes. It owns what "today" is (the device's local calendar day) and
 * where the answer came from. It READS ONLY:
 *   - it calls the existing `GET /api/history` through `historyService.getHistory` and nothing else on the network (no PUT,
 *     no new endpoint);
 *   - it writes no IndexedDB state, queues nothing and does not touch the reconcile/outbox rules of `offline/history.ts`;
 *   - its only memory is a small in-process cache of the last answer.
 *
 * NO try/catch here, on purpose: `historyService.getHistory` never rejects (every transport or parsing failure is `null`, proven in
 * historyService.test.ts), so a rejection would be a programming error and must surface, not be disguised as "server unavailable".
 *
 * ONE REQUEST. The server answers at most 90 days and requires `endDate` to be the client's today, so a window cannot be
 * moved back. One request for the 90 days ending today therefore serves every range: 7 and 30 days (with the equal window
 * before them) and 90 days. A 90-day range has no earlier window to compare with from this endpoint (decision recorded in
 * the 48B notes); the trend model reports that as an unavailable comparison.
 *
 * WHERE THE ANSWER CAME FROM (`coverage`):
 *   'full'         the server answered: the whole window, canonical records first, legacy per day (the server's rule).
 *   'device-only'  the server could not be asked or did not answer usefully: the 7 days the device holds (decision D4:
 *                  older history needs a connection). The page must say so; it must never present 7 days as 90.
 *   'none'         nobody is signed in: nothing to show.
 */

export const TREND_FETCH_DAYS = 90; // = the server's HISTORY_DAYS_MAX
export const TREND_CACHE_TTL_MS = 60_000;

export type TrendFallbackReason = 'browser-offline' | 'unavailable';

export type TrendHistory =
  | { coverage: 'none'; points: [] }
  | { coverage: 'full'; points: DayPoint[]; today: string; fetchedAt: number }
  | { coverage: 'device-only'; points: DayPoint[]; today: string; reason: TrendFallbackReason; fetchedAt: number };

type CacheEntry = { userId: string; today: string; at: number; value: Extract<TrendHistory, { coverage: 'full' }> };

let cache: CacheEntry | null = null;
const inFlight = new Map<string, Promise<TrendHistory>>();

const currentUserId = (): string | null => useAuthStore.getState().user?.id || null;
const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/** For tests, and for the page to call after something it does changes completions (e.g. an Insights toggle). */
export function invalidateTrendHistory(): void {
  cache = null;
}

async function loadFresh(userId: string, today: string, now: () => number): Promise<TrendHistory> {
  let reason: TrendFallbackReason = 'unavailable';

  if (browserOnline()) {
    const rows = await historyService.getHistory(TREND_FETCH_DAYS, today);
    // The session may have changed while waiting: an answer for one account is never handed to another.
    // (Scoped to the ACCOUNT, not the session: signing out and back in as the same user while this waits is not detected.)
    if (currentUserId() !== userId) return { coverage: 'none', points: [] };
    const points = rows ? pointsFromServer(rows, today, TREND_FETCH_DAYS) : null;
    if (points) {
      const value = { coverage: 'full' as const, points, today, fetchedAt: now() };
      cache = { userId, today, at: now(), value };
      return value;
    }
  } else {
    reason = 'browser-offline';
  }

  // Fall back to what the device holds (the existing 7-day store, including changes not yet synced).
  const local = await getWeekHistory();
  if (currentUserId() !== userId) return { coverage: 'none', points: [] };
  const points = pointsFromLocal(local, today);
  return { coverage: 'device-only', points: points ?? [], today, reason, fetchedAt: now() };
}

/**
 * Loads the trend history. `now` is injectable so tests control both the day and the cache age; the day is the device's
 * local calendar day, the same basis as every other history request. Concurrent callers for the same account and day share
 * one request. A fallback answer is never cached (a retry should ask the server again).
 */
export async function loadTrendHistory(now: () => Date = () => new Date()): Promise<TrendHistory> {
  const userId = currentUserId();
  if (!userId) return { coverage: 'none', points: [] };

  const clock = now();
  const today = toLocalDateKey(clock);
  const at = clock.getTime();

  if (cache && cache.userId === userId && cache.today === today && at - cache.at < TREND_CACHE_TTL_MS && at >= cache.at) {
    return cache.value;
  }

  const key = `${userId}|${today}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = loadFresh(userId, today, () => at).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}
