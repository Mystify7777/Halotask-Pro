import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../offline/history';
import type { ServerHistoryEntry } from '../services/historyService';
import { useAuthStore } from '../store/authStore';
import { addDays, buildTrend } from './trend';
import { TREND_CACHE_TTL_MS, TREND_FETCH_DAYS, invalidateTrendHistory, loadTrendHistory } from './trendHistory';

// Strict doubles: the reader may call getHistory and getWeekHistory and NOTHING else. Any write-side call is a failure.
const getHistory = vi.fn();
const upsertToday = vi.fn();
const upsertForDate = vi.fn();
const getWeekHistory = vi.fn();
const updateTodaySnapshot = vi.fn();
const requestHistoryReconcile = vi.fn();

vi.mock('../services/historyService', () => ({
  historyService: {
    getHistory: (...a: unknown[]) => getHistory(...a),
    upsertToday: (...a: unknown[]) => upsertToday(...a),
    upsertForDate: (...a: unknown[]) => upsertForDate(...a),
  },
}));
vi.mock('../offline/history', () => ({
  getWeekHistory: (...a: unknown[]) => getWeekHistory(...a),
  updateTodaySnapshot: (...a: unknown[]) => updateTodaySnapshot(...a),
  requestHistoryReconcile: (...a: unknown[]) => requestHistoryReconcile(...a),
}));

vi.mock('../offline/cache', () => ({ setCachedAuthUser: vi.fn(), clearCachedAuthUser: vi.fn() }));

// A fixed local day: noon, so no timezone moves it across midnight.
const NOON = new Date(2026, 10, 14, 12, 0, 0);
const TODAY = '2026-11-14';
const clock = (d: Date = NOON) => () => d;

const serverRows = (counts: (number | null)[]): ServerHistoryEntry[] =>
  counts.map((c, i) => ({
    source: c === null ? 'none' : 'canonical',
    exists: c !== null,
    entry: { date: addDays(TODAY, -(counts.length - 1 - i)), completedCount: c ?? 0, workDoneMinutes: (c ?? 0) * 10, completedTasks: [] },
  }));
const week = (counts: number[]): HistoryEntry[] =>
  counts.map((c, i) => ({
    date: addDays(TODAY, -(counts.length - 1 - i)),
    completedCount: c,
    workDoneMinutes: c * 10,
    completedTasks: Array.from({ length: c }, (_, k) => ({ id: `${i}-${k}`, title: 't', estimatedMinutes: 10 })),
  }));
const signIn = (id: string) => useAuthStore.setState({ user: { id, name: 'A', email: 'a@b.c' }, token: 't' });
const setOnline = (v: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(v);

beforeEach(() => {
  vi.restoreAllMocks();
  [getHistory, upsertToday, upsertForDate, getWeekHistory, updateTodaySnapshot, requestHistoryReconcile].forEach((m) => m.mockReset());
  invalidateTrendHistory();
  signIn('u1');
  setOnline(true);
  getHistory.mockResolvedValue(serverRows(Array.from({ length: 90 }, () => 1)));
  getWeekHistory.mockResolvedValue(week([0, 0, 0, 0, 0, 2, 1]));
});

describe('loadTrendHistory: online', () => {
  it('asks the existing endpoint once for the 90 days ending on the device\'s local today', async () => {
    const r = await loadTrendHistory(clock());
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(getHistory).toHaveBeenCalledWith(TREND_FETCH_DAYS, TODAY);
    expect(TREND_FETCH_DAYS).toBe(90);
    expect(r).toMatchObject({ coverage: 'full', today: TODAY });
    expect(r.points).toHaveLength(90);
    expect(r.points[89].date).toBe(TODAY);
  });

  it('is read-only: no PUT, no snapshot update, no reconcile, and the device store is not read when the server answers', async () => {
    await loadTrendHistory(clock());
    expect(upsertToday).not.toHaveBeenCalled();
    expect(upsertForDate).not.toHaveBeenCalled();
    expect(updateTodaySnapshot).not.toHaveBeenCalled();
    expect(requestHistoryReconcile).not.toHaveBeenCalled();
    expect(getWeekHistory).not.toHaveBeenCalled();
  });

  it('feeds the trend model: 30 days compare with the 30 before; 90 days have nothing earlier to compare with', async () => {
    const r = await loadTrendHistory(clock());
    expect(buildTrend(r.points, 30)).toMatchObject({ status: 'complete', comparison: { available: true } });
    expect(buildTrend(r.points, 7)).toMatchObject({ comparison: { available: true } });
    expect(buildTrend(r.points, 90)).toMatchObject({ status: 'complete', comparison: { available: false, reason: 'previous-missing' } });
  });

  it('the day boundary is the device\'s local day, not UTC', async () => {
    // 23:30 local: whatever UTC says, "today" is the local date.
    await loadTrendHistory(clock(new Date(2026, 10, 14, 23, 30, 0)));
    expect(getHistory).toHaveBeenLastCalledWith(90, '2026-11-14');
    invalidateTrendHistory();
    await loadTrendHistory(clock(new Date(2026, 10, 15, 0, 30, 0)));
    expect(getHistory).toHaveBeenLastCalledWith(90, '2026-11-15');
  });
});

describe('loadTrendHistory: cache and concurrency', () => {
  it('concurrent callers share one request', async () => {
    const [a, b, c] = await Promise.all([loadTrendHistory(clock()), loadTrendHistory(clock()), loadTrendHistory(clock())]);
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('serves a repeat call from memory inside the TTL, and asks again once it has passed', async () => {
    await loadTrendHistory(clock());
    await loadTrendHistory(() => new Date(NOON.getTime() + TREND_CACHE_TTL_MS - 1));
    expect(getHistory).toHaveBeenCalledTimes(1);
    await loadTrendHistory(() => new Date(NOON.getTime() + TREND_CACHE_TTL_MS));
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('a new local day is a new answer even inside the TTL', async () => {
    await loadTrendHistory(clock(new Date(2026, 10, 14, 23, 59, 30)));
    await loadTrendHistory(clock(new Date(2026, 10, 15, 0, 0, 10)));
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('invalidateTrendHistory forces the next call to ask again', async () => {
    await loadTrendHistory(clock());
    invalidateTrendHistory();
    await loadTrendHistory(clock());
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('a clock that moves backwards does not serve a cached answer from its future', async () => {
    await loadTrendHistory(() => new Date(NOON.getTime() + 30_000));
    await loadTrendHistory(clock());
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('never hands one account\'s history to another', async () => {
    const a = await loadTrendHistory(clock());
    signIn('u2');
    getHistory.mockResolvedValueOnce(serverRows(Array.from({ length: 90 }, () => 5)));
    const b = await loadTrendHistory(clock());
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(a.points[89]).toMatchObject({ completed: 1 });
    expect(b.points[89]).toMatchObject({ completed: 5 });
  });

  it('an answer that arrives after the account changed is dropped', async () => {
    let release: (v: ServerHistoryEntry[]) => void = () => {};
    getHistory.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = loadTrendHistory(clock());
    signIn('u2');
    release(serverRows(Array.from({ length: 90 }, () => 9)));
    expect(await pending).toEqual({ coverage: 'none', points: [] });
    // ...and it was not cached for the new account
    getHistory.mockResolvedValueOnce(serverRows(Array.from({ length: 90 }, () => 2)));
    expect((await loadTrendHistory(clock())).points[89]).toMatchObject({ completed: 2 });
  });

  it('nobody signed in: nothing is requested', async () => {
    useAuthStore.setState({ user: null, token: null });
    expect(await loadTrendHistory(clock())).toEqual({ coverage: 'none', points: [] });
    expect(getHistory).not.toHaveBeenCalled();
    expect(getWeekHistory).not.toHaveBeenCalled();
  });
});

describe('loadTrendHistory: falling back to the device (decision D4)', () => {
  it('the browser is offline: no request at all, the 7 device days, and the reason says why', async () => {
    setOnline(false);
    const r = await loadTrendHistory(clock());
    expect(getHistory).not.toHaveBeenCalled();
    expect(r).toMatchObject({ coverage: 'device-only', reason: 'browser-offline', today: TODAY });
    expect(r.points).toHaveLength(7);
    expect(r.points[6]).toMatchObject({ date: TODAY, completed: 1 });
  });

  it('the server cannot be reached (null answer): the 7 device days, reason "unavailable"', async () => {
    getHistory.mockResolvedValue(null);
    const r = await loadTrendHistory(clock());
    expect(r).toMatchObject({ coverage: 'device-only', reason: 'unavailable' });
    expect(r.points).toHaveLength(7);
  });

  it.each([
    ['a short answer', () => serverRows(Array.from({ length: 60 }, () => 1))],
    ['a window that does not end today', () => serverRows(Array.from({ length: 90 }, () => 1)).map((r) => ({ ...r, entry: { ...r.entry, date: addDays(r.entry.date, -1) } }))],
  ])('%s is not trusted: it falls back instead of drawing it', async (_n, make) => {
    getHistory.mockResolvedValue(make());
    const r = await loadTrendHistory(clock());
    expect(r.coverage).toBe('device-only');
    expect(getWeekHistory).toHaveBeenCalledTimes(1);
  });

  it('a fallback is not cached: the next call asks the server again', async () => {
    getHistory.mockResolvedValueOnce(null);
    await loadTrendHistory(clock());
    const again = await loadTrendHistory(clock());
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(again.coverage).toBe('full');
  });

  it('the device holds nothing usable: an empty series, never invented days', async () => {
    getHistory.mockResolvedValue(null);
    getWeekHistory.mockResolvedValue([]);
    expect(await loadTrendHistory(clock())).toMatchObject({ coverage: 'device-only', points: [] });
  });

  it('the device answer for another account is dropped', async () => {
    getHistory.mockResolvedValue(null);
    getWeekHistory.mockImplementation(async () => {
      signIn('u2');
      return week([1, 1, 1, 1, 1, 1, 1]);
    });
    expect(await loadTrendHistory(clock())).toEqual({ coverage: 'none', points: [] });
  });

  it('feeds the trend model honestly: 7 device days asked as 30 are "truncated", never padded', async () => {
    setOnline(false);
    const r = await loadTrendHistory(clock());
    const t = buildTrend(r.points, 30);
    expect(t).toMatchObject({ truncated: true });
    if (t.status === 'invalid') throw new Error('invalid');
    expect(t.window).toHaveLength(7);
    expect(t.comparison).toMatchObject({ available: false });
  });
});
