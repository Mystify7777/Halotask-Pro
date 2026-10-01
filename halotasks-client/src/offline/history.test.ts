import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One shared in-memory "browser storage" — every account on the same browser sees the same store.
const idb = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./db', () => ({
  offlineDb: {
    get: vi.fn(async (key: string) => (idb.has(key) ? idb.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      idb.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      idb.delete(key);
    }),
  },
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../services/api', () => ({ apiClient: api }));

import { useAuthStore } from '../store/authStore';
import type { Task } from '../types/task';
import {
  getWeekHistory,
  MAX_COMPLETED_TASKS_PER_DAY,
  mergeDaySnapshots,
  resetHistoryState,
  updateTodaySnapshot,
} from './history';

// ── Helpers ────────────────────────────────────────────────────────────────

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };

const login = (u: typeof USER_A) => useAuthStore.getState().setAuth({ token: `token-${u.id}`, user: u });
const logout = () => useAuthStore.getState().clearAuth();
const currentUserId = () => useAuthStore.getState().user?.id ?? null;

const NOW = '2026-09-30T06:00:00Z';
// The client tsconfig has no Node types; reach `process.env` through a minimal typed view
// (changing TZ at runtime is how these tests move the "device" between timezones).
const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const setZone = (tz: string) => {
  nodeEnv.TZ = tz;
};
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const task = (id: string, completedAt: string, estimatedMinutes = 10, title = `Task ${id}`): Task => ({
  _id: id,
  userId: 'u',
  title,
  description: '',
  completed: true,
  priority: 'medium',
  tags: [],
  estimatedMinutes,
  reminderSent: false,
  createdAt: completedAt,
  updatedAt: completedAt,
  completedAt,
});

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// Independent ground truth for what calendar day it is somewhere: the platform timezone database.
const intlDate = (timeZone: string, iso: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** Let every queued promise / timer-0 chain finish (reconcile is a multi-step async chain). */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

// Fake server. Rows are keyed by whichever user's token is active when the request is made,
// exactly like the real API derives the user from the JWT.
type Row = { date: string; completedCount: number; workDoneMinutes: number; completedTasks: { taskId: string; title: string; estimatedMinutes: number }[]; updatedAt: string };
const serverRows = new Map<string, Map<string, Row>>();
const requests: { method: 'GET' | 'PUT'; url: string; userId: string | null; body?: any; params?: any }[] = [];
let serverOffline = false;
let rejectWith400 = false;
let holdPuts: { resolve: () => void }[] | null = null;

const rowsFor = (userId: string) => {
  if (!serverRows.has(userId)) serverRows.set(userId, new Map());
  return serverRows.get(userId)!;
};
const seedServer = (userId: string, date: string, tasks: { id: string; title?: string; est?: number }[]) => {
  const completedTasks = tasks.map((t) => ({ taskId: t.id, title: t.title ?? `Task ${t.id}`, estimatedMinutes: t.est ?? 10 }));
  rowsFor(userId).set(date, {
    date,
    completedCount: completedTasks.length,
    workDoneMinutes: completedTasks.reduce((s, t) => s + t.estimatedMinutes, 0),
    completedTasks,
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
};

// The fake server has its OWN clock so tests can model a device whose clock differs from the server's.
let serverSkewMs = 0;
const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -720 && v <= 840;
const dateAtOffset = (ms: number, offset: number) => new Date(ms + offset * 60_000).toISOString().slice(0, 10);
/** Exactly ONE date is "today": the server's clock shifted by the declared offset. No tolerance. */
const serverToday = (offset: number) => dateAtOffset(Date.now() + serverSkewMs, offset);

const networkError = () => new Error('Network Error');
const badRequest = (code?: string) =>
  new AxiosError('Bad Request', 'ERR_BAD_REQUEST', undefined, undefined, { status: 400, data: code ? { message: 'bad', code } : { message: 'bad' } } as never);

beforeEach(() => {
  idb.clear();
  serverRows.clear();
  requests.length = 0;
  serverOffline = false;
  rejectWith400 = false;
  holdPuts = null;
  serverSkewMs = 0;
  setZone('UTC');
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(NOW);
  resetHistoryState();
  logout();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);

  api.get.mockReset().mockImplementation(async (url: string, config: { params: { days: number; endDate: string; utcOffsetMinutes?: unknown } }) => {
    const userId = currentUserId();
    requests.push({ method: 'GET', url, userId, params: config.params });
    if (serverOffline) throw networkError();
    const { days, endDate, utcOffsetMinutes } = config.params;
    // Same contract as the real API: offset required, endDate must be "today" at that offset. No UTC fallback.
    if (!isOffset(utcOffsetMinutes)) throw badRequest();
    if (endDate !== serverToday(utcOffsetMinutes)) throw badRequest('DATE_NOT_TODAY');
    const rows = rowsFor(userId ?? 'anon');
    const history = Array.from({ length: days }, (_, i) => {
      const date = addDays(endDate, -(days - 1 - i));
      return rows.get(date) ?? { date, completedCount: 0, workDoneMinutes: 0, completedTasks: [], updatedAt: null };
    });
    return { data: { history } };
  });

  api.put.mockReset().mockImplementation(async (url: string, body: { date: string; utcOffsetMinutes?: unknown } & Partial<Row>) => {
    const userId = currentUserId();
    requests.push({ method: 'PUT', url, userId, body });
    if (holdPuts) await new Promise<void>((resolve) => holdPuts!.push({ resolve }));
    if (serverOffline) throw networkError();
    if (rejectWith400) throw badRequest();
    const isToday = url === '/api/history/today';
    const date = isToday ? body.date : url.split('/').pop()!;
    if (!isOffset(body.utcOffsetMinutes)) throw badRequest();
    const todayStr = serverToday(body.utcOffsetMinutes);
    const okDate = isToday ? date === todayStr : date >= addDays(todayStr, -6) && date <= todayStr;
    if (!okDate) throw badRequest(isToday ? 'DATE_NOT_TODAY' : 'DATE_OUT_OF_RANGE');
    // Replace semantics, exactly like the real API (the offset is validated, not stored).
    const { completedCount, workDoneMinutes, completedTasks } = body as Row;
    rowsFor(userId ?? 'anon').set(date, { date, completedCount, workDoneMinutes, completedTasks, updatedAt: new Date().toISOString() });
    return { data: { entry: body } };
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete nodeEnv.TZ;
  vi.restoreAllMocks();
});

const today = (week: Awaited<ReturnType<typeof getWeekHistory>>) => week[week.length - 1];
const puts = () => requests.filter((r) => r.method === 'PUT');
// setAuth also caches the auth user in this same store; only history keys matter here.
const historyKeys = () => [...idb.keys()].filter((k) => k.startsWith('task_history')).sort();

// ── Recovery ───────────────────────────────────────────────────────────────

describe('server recovery', () => {
  it('rebuilds the dashboard history from the server when local IndexedDB history is missing', async () => {
    login(USER_A);
    seedServer('user-a', '2026-09-28', [{ id: 't1', est: 20 }, { id: 't2', est: 15 }]);
    seedServer('user-a', '2026-09-30', [{ id: 't3', title: 'Write report', est: 30 }]);
    expect(historyKeys()).toEqual([]); // local history cleared

    const week = await getWeekHistory();

    expect(week).toHaveLength(7);
    expect(week.map((e) => e.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(week[4]).toMatchObject({ date: '2026-09-28', completedCount: 2, workDoneMinutes: 35 });
    expect(today(week)).toEqual({
      date: '2026-09-30',
      completedCount: 1,
      workDoneMinutes: 30,
      completedTasks: [{ id: 't3', title: 'Write report', estimatedMinutes: 30 }], // server taskId → client id
    });
    expect(week[0]).toEqual({ date: '2026-09-24', completedCount: 0, workDoneMinutes: 0, completedTasks: [] });
  });

  it('keeps the recovered history usable afterwards without the server', async () => {
    login(USER_A);
    seedServer('user-a', '2026-09-29', [{ id: 't1', est: 5 }]);
    await getWeekHistory();

    serverOffline = true;
    resetHistoryState(); // reload
    const week = await getWeekHistory();

    expect(week[5]).toMatchObject({ date: '2026-09-29', completedCount: 1 });
    expect(historyKeys()).toEqual(['task_history:user-a']);
  });

  it('asks the server for the window ending at the client-local today', async () => {
    login(USER_A);
    await getWeekHistory();

    const get = requests.find((r) => r.method === 'GET')!;
    expect(get.params).toEqual({ days: 7, endDate: '2026-09-30', utcOffsetMinutes: 0 }); // UTC device: offset is declared, not omitted
  });
});

// ── Offline-first ───────────────────────────────────────────────────────────

describe('local-only offline history', () => {
  it('records and shows work with no server, and never throws', async () => {
    serverOffline = true;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    login(USER_A);

    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 25), task('t2', '2026-09-30T05:30:00Z', 10)]);
    const week = await getWeekHistory();

    expect(today(week)).toMatchObject({ date: '2026-09-30', completedCount: 2, workDoneMinutes: 35 });
    expect((idb.get('task_history:user-a') as { pendingSync: boolean }[])[0].pendingSync).toBe(true);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(0); // offline: no pull attempted
  });
});

// ── Reconciliation & double counting ───────────────────────────────────────

describe('reconciliation', () => {
  it('syncs offline work after reconnect and does not double-count across a reload', async () => {
    const tasks = [task('t1', '2026-09-30T05:00:00Z', 25), task('t2', '2026-09-30T05:30:00Z', 10)];

    // Offline: work is recorded locally only.
    serverOffline = true;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    login(USER_A);
    await updateTodaySnapshot(tasks);
    await flush();
    expect(rowsFor('user-a').size).toBe(0);

    // Connectivity returns: next read reconciles and pushes.
    serverOffline = false;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    advance(20_000);
    const afterSync = await getWeekHistory();
    await flush();

    expect(today(afterSync)).toMatchObject({ completedCount: 2, workDoneMinutes: 35 });
    expect(rowsFor('user-a').get('2026-09-30')).toMatchObject({ completedCount: 2, workDoneMinutes: 35 });
    expect((idb.get('task_history:user-a') as { pendingSync: boolean }[])[0].pendingSync).toBe(false);

    // Reload (fresh module state): pulls from server; counts must not add up to 4.
    resetHistoryState();
    const afterReload = await getWeekHistory();
    expect(today(afterReload)).toMatchObject({ completedCount: 2, workDoneMinutes: 35 });
    expect(today(afterReload).completedTasks.map((t) => t.id)).toEqual(['t1', 't2']);

    // Re-sending the same snapshot again still yields the same single day.
    await updateTodaySnapshot(tasks);
    await flush();
    expect(rowsFor('user-a').get('2026-09-30')).toMatchObject({ completedCount: 2, workDoneMinutes: 35 });
    expect(rowsFor('user-a').size).toBe(1);
  });

  it('a local entry that is not pending never sums with the server copy of the same day', async () => {
    login(USER_A);
    seedServer('user-a', '2026-09-30', [{ id: 't1' }, { id: 't2' }]);
    await getWeekHistory(); // local now mirrors the server (2 tasks)

    resetHistoryState();
    const again = await getWeekHistory();

    expect(today(again).completedCount).toBe(2);
    expect(today(again).completedTasks).toHaveLength(2);
  });

  it('prefers the server when the local copy is not pending (another device updated it)', async () => {
    login(USER_A);
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await flush(); // synced, pending cleared

    seedServer('user-a', '2026-09-30', [{ id: 't1' }, { id: 't9', title: 'From phone' }]);
    resetHistoryState();
    const week = await getWeekHistory();

    expect(today(week).completedCount).toBe(2);
    expect(today(week).completedTasks.map((t) => t.title)).toContain('From phone');
  });

  it('merges a pending local snapshot into the server row by task id instead of replacing it', async () => {
    login(USER_A);
    seedServer('user-a', '2026-09-30', [{ id: 'old' }]);
    serverOffline = true;
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10), task('t2', '2026-09-30T05:10:00Z', 10)]);
    await flush();

    serverOffline = false;
    advance(20_000);
    const week = await getWeekHistory();
    await settle();

    // Neither side's work is lost: the server's 'old' (another device) AND this device's t1, t2.
    expect(today(week).completedTasks.map((t) => t.id).sort()).toEqual(['old', 't1', 't2']);
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId).sort()).toEqual(['old', 't1', 't2']);
    expect(today(week).completedCount).toBe(3);
  });

  it('heals a server that has no record for a day the device recorded', async () => {
    login(USER_A);
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await flush();
    serverRows.clear(); // server lost it

    resetHistoryState();
    await getWeekHistory();
    await flush();

    expect(rowsFor('user-a').get('2026-09-30')).toMatchObject({ completedCount: 1 });
  });

  it('pushes a snapshot from before midnight with the bounded backfill endpoint', async () => {
    serverOffline = true;
    login(USER_A);
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]); // Sep 30, offline
    await flush();

    setNow('2026-10-01T08:00:00Z'); // next day, back online
    serverOffline = false;
    await getWeekHistory();
    await flush();

    const backfill = puts().find((r) => r.url === '/api/history/2026-09-30');
    expect(backfill).toBeDefined();
    expect(rowsFor('user-a').get('2026-09-30')).toMatchObject({ completedCount: 1 });
  });

  it('keeps an edit made while a push was in flight pending, then delivers it', async () => {
    login(USER_A);
    holdPuts = []; // hold every PUT
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await settle();
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10), task('t2', '2026-09-30T05:10:00Z', 10)]);
    await settle();

    // Release only the FIRST push. Its acknowledgement is for the OLD revision and must not clear pending.
    const [first] = holdPuts;
    first.resolve();
    await settle();

    const stored = () => idb.get('task_history:user-a') as { completedCount: number; pendingSync: boolean }[];
    expect(stored()[0]).toMatchObject({ completedCount: 2, pendingSync: true });

    // The newer revision is then pushed (pull → merge → push) and finally acknowledged.
    const rest = holdPuts.splice(0);
    holdPuts = null;
    rest.forEach((h) => h.resolve());
    await settle();

    expect(stored()[0]).toMatchObject({ completedCount: 2, pendingSync: false });
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('stops retrying a snapshot the server rejects as invalid', async () => {
    login(USER_A);
    rejectWith400 = true;
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await flush();

    expect((idb.get('task_history:user-a') as { pendingSync: boolean }[])[0].pendingSync).toBe(false);
  });

  it('retries a transient failure instead of dropping it', async () => {
    login(USER_A);
    serverOffline = true;
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await flush();

    expect((idb.get('task_history:user-a') as { pendingSync: boolean }[])[0].pendingSync).toBe(true);
  });

  it('throttles reconcile attempts instead of hammering an unreachable server', async () => {
    login(USER_A);
    serverOffline = true;
    await getWeekHistory();
    await getWeekHistory();
    await getWeekHistory();

    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1);

    advance(20_000);
    await getWeekHistory();
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(2);
  });

  it('ignores malformed server rows instead of storing them', async () => {
    login(USER_A);
    api.get.mockResolvedValueOnce({
      data: {
        history: [
          { date: 'garbage', completedCount: 1, workDoneMinutes: 1, completedTasks: [], updatedAt: 'x' },
          { date: '2026-09-29', completedCount: -5, workDoneMinutes: 1, completedTasks: [], updatedAt: 'x' },
          { date: '2026-09-28', completedCount: 1, workDoneMinutes: 1, completedTasks: [{ taskId: 1 }], updatedAt: 'x' },
          { date: '2026-09-30', completedCount: 1, workDoneMinutes: 5, completedTasks: [{ taskId: 'ok', title: 'Fine', estimatedMinutes: 5 }], updatedAt: 'x' },
        ],
      },
    });

    const week = await getWeekHistory();

    expect(week[6]).toMatchObject({ date: '2026-09-30', completedCount: 1 });
    expect(week[5]).toMatchObject({ date: '2026-09-29', completedCount: 0 });
    expect(week[4]).toMatchObject({ date: '2026-09-28', completedCount: 0 });
  });
});

// ── User isolation ──────────────────────────────────────────────────────────

describe('two users sharing one browser', () => {
  it("never shows or merges user A's history for user B", async () => {
    login(USER_A);
    await updateTodaySnapshot([task('a1', '2026-09-30T05:00:00Z', 40)]);
    await flush();
    seedServer('user-b', '2026-09-30', [{ id: 'b1', est: 5 }]);

    logout();
    login(USER_B);
    const bWeek = await getWeekHistory();
    await flush();

    expect(today(bWeek)).toMatchObject({ completedCount: 1, workDoneMinutes: 5 });
    expect(today(bWeek).completedTasks.map((t) => t.id)).toEqual(['b1']);
    expect(rowsFor('user-b').get('2026-09-30')?.completedTasks.map((t) => t.taskId)).toEqual(['b1']);
    expect(requests.filter((r) => r.userId === 'user-b' && r.method === 'PUT')).toEqual([]);
    expect(historyKeys()).toEqual(['task_history:user-a', 'task_history:user-b']);
  });

  it("does not push A's pending snapshot under B's token, and A still has it after logging back in", async () => {
    serverOffline = true;
    login(USER_A);
    await updateTodaySnapshot([task('a1', '2026-09-30T05:00:00Z', 40)]);
    await flush();

    logout();
    login(USER_B);
    serverOffline = false;
    advance(20_000);
    await getWeekHistory();
    await flush();

    expect(puts().filter((r) => r.userId === 'user-b')).toEqual([]);
    expect(rowsFor('user-b').size).toBe(0);

    logout();
    login(USER_A);
    resetHistoryState();
    advance(20_000);
    const aWeek = await getWeekHistory();
    await flush();
    expect(today(aWeek).completedTasks.map((t) => t.id)).toEqual(['a1']);
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId)).toEqual(['a1']);
  });

  it('drops an in-flight push when the account changes before the request is sent', async () => {
    login(USER_A);
    const pending = updateTodaySnapshot([task('a1', '2026-09-30T05:00:00Z', 40)]);
    logout();
    login(USER_B);
    await pending;
    await flush();

    expect(puts().filter((r) => r.userId === 'user-b')).toEqual([]);
    expect(rowsFor('user-b').size).toBe(0);
  });

  it('answers nothing when nobody is logged in', async () => {
    expect(await getWeekHistory()).toEqual([]);
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z')]);
    expect(historyKeys()).toEqual([]);
    expect(requests).toEqual([]);
  });
});

// ── Legacy unscoped data ────────────────────────────────────────────────────

describe('legacy unscoped history', () => {
  const seedLegacy = () =>
    idb.set('task_history', [
      { date: '2026-09-30', completedCount: 9, workDoneMinutes: 999, completedTasks: [{ id: 'legacy', title: 'Legacy', estimatedMinutes: 999 }] },
    ]);

  it('is never shown to whoever logs in next, and is deleted', async () => {
    seedLegacy();
    login(USER_B);

    const week = await getWeekHistory();

    expect(today(week).completedCount).toBe(0);
    expect(idb.has('task_history')).toBe(false);
    expect(puts()).toEqual([]);
  });

  it('is never merged into or pushed for the next user; their own server history is what they see', async () => {
    seedLegacy();
    seedServer('user-b', '2026-09-30', [{ id: 'b1', est: 5 }]);
    login(USER_B);

    const week = await getWeekHistory();
    await settle();

    expect(today(week).completedTasks.map((t) => t.id)).toEqual(['b1']);
    expect(JSON.stringify(idb.get('task_history:user-b'))).not.toContain('legacy');
    expect(JSON.stringify([...serverRows.get('user-b')!.values()])).not.toContain('legacy');
    expect(puts()).toEqual([]);
    expect(idb.has('task_history')).toBe(false);
  });

  it('is not assigned to the next user even when that user has no server history at all', async () => {
    seedLegacy();
    login(USER_A);

    await updateTodaySnapshot([task('a1', '2026-09-30T05:00:00Z', 10)]);
    await settle();
    const week = await getWeekHistory();

    expect(today(week).completedTasks.map((t) => t.id)).toEqual(['a1']);
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId)).toEqual(['a1']);
    expect(idb.has('task_history')).toBe(false);
  });
});

// ── Calendar-date semantics ─────────────────────────────────────────────────

describe('calendar-date semantics (local day, not UTC)', () => {
  it('uses the local date when it is ahead of UTC (India, 01:30 on Oct 1 local = Sep 30 20:00Z)', async () => {
    setZone('Asia/Calcutta');
    expect(new Date('2026-09-30T20:00:00Z').getDate()).toBe(1); // guard: the zone switch really took effect
    setNow('2026-09-30T20:00:00Z');
    login(USER_A);

    await updateTodaySnapshot([
      task('late', '2026-09-30T20:00:00Z', 10), // 01:30 Oct 1 local → counts for "today"
      task('early', '2026-09-30T18:00:00Z', 10), // 23:30 Sep 30 local → yesterday
    ]);
    await flush();
    const week = await getWeekHistory();

    expect(today(week).date).toBe('2026-10-01');
    expect(today(week).completedTasks.map((t) => t.id)).toEqual(['late']);
    const put = puts()[0];
    expect(put.url).toBe('/api/history/today');
    expect(put.body.date).toBe('2026-10-01'); // UTC date would have been 2026-09-30
  });

  it('uses the local date when it is behind UTC (Los Angeles, evening of Sep 29 = Sep 30 02:00Z)', async () => {
    setZone('America/Los_Angeles');
    setNow('2026-09-30T02:00:00Z');
    login(USER_A);

    await updateTodaySnapshot([task('t1', '2026-09-30T01:00:00Z', 10)]); // 18:00 PDT on Sep 29
    await flush();
    const week = await getWeekHistory();

    expect(today(week).date).toBe('2026-09-29');
    expect(today(week).completedCount).toBe(1);
    expect(puts()[0].body.date).toBe('2026-09-29');
    expect(requests.find((r) => r.method === 'GET')!.params.endDate).toBe('2026-09-29');
  });

  it('builds a contiguous 7-day window across a DST change and a month boundary', async () => {
    setZone('America/Los_Angeles'); // DST ends 2026-11-01
    setNow('2026-11-03T12:00:00Z');
    login(USER_A);

    const week = await getWeekHistory();

    expect(week.map((e) => e.date)).toEqual([
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
    ]);
  });
});

// ── Snapshot bounds ─────────────────────────────────────────────────────────

describe('snapshot sanitising (snapshots the server will accept)', () => {
  it('bounds titles, minutes and the number of tasks', async () => {
    login(USER_A);
    const many = Array.from({ length: MAX_COMPLETED_TASKS_PER_DAY + 25 }, (_, i) =>
      task(`t${i}`, '2026-09-30T05:00:00Z', 1, i === 0 ? 'x'.repeat(500) : `T${i}`),
    );
    many[1] = task('neg', '2026-09-30T05:00:00Z', -5);
    many[2] = task('nan', '2026-09-30T05:00:00Z', Number.NaN);
    many[3] = task('blank', '2026-09-30T05:00:00Z', 1, '   ');

    await updateTodaySnapshot(many);
    await flush();

    const body = puts()[0].body;
    expect(body.completedTasks).toHaveLength(MAX_COMPLETED_TASKS_PER_DAY);
    expect(body.completedCount).toBe(MAX_COMPLETED_TASKS_PER_DAY);
    expect(body.completedTasks[0].title).toHaveLength(200);
    expect(body.completedTasks[1].estimatedMinutes).toBe(0);
    expect(body.completedTasks[2].estimatedMinutes).toBe(0);
    expect(body.completedTasks[3].title).toBe('(untitled)');
    expect(body.workDoneMinutes).toBe(
      body.completedTasks.reduce((s: number, t: { estimatedMinutes: number }) => s + t.estimatedMinutes, 0),
    );
    expect(Number.isFinite(body.workDoneMinutes)).toBe(true);
  });
});

// ── Concurrent full-snapshot reconciliation (merge by task id) ───────────────

describe('concurrent reconciliation merges by task id (no history loss)', () => {
  const done = (id: string, est = 10) => task(id, '2026-09-30T05:00:00Z', est);
  const ids = (tasks: { id?: string; taskId?: string }[]) => tasks.map((t) => t.id ?? t.taskId).sort();

  /** This device records `tasks` while offline; then connectivity returns. */
  const recordOffline = async (tasks: Task[]) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    serverOffline = true;
    await updateTodaySnapshot(tasks);
    await settle();
    expect(requests).toEqual([]); // fully offline: nothing was sent
  };
  const reconnect = () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    serverOffline = false;
    advance(20_000);
  };
  const serverToday = (userId = 'user-a') => rowsFor(userId).get('2026-09-30');
  const localToday = (userId = 'user-a') => (idb.get(`task_history:${userId}`) as { date: string; completedCount: number; workDoneMinutes: number; completedTasks: { id: string }[]; pendingSync: boolean }[]).find((e) => e.date === '2026-09-30')!;

  it('server has A,B,C and a pending local has A,B (device B reconnects): nothing is overwritten, nothing is pushed', async () => {
    login(USER_A);
    await recordOffline([done('A', 5), done('B', 7)]);
    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }, { id: 'C', est: 11 }]); // other device, meanwhile

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['A', 'B', 'C']);
    expect(today(week)).toMatchObject({ completedCount: 3, workDoneMinutes: 23 });
    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B', 'C']); // C survived
    expect(serverToday()).toMatchObject({ completedCount: 3, workDoneMinutes: 23 });
    expect(puts()).toEqual([]); // the merge equals the server row: nothing to send, so nothing can clobber it
    expect(localToday().pendingSync).toBe(false);
  });

  it('pending local has A,B,C and the server only has A,B (server behind): the missing task is added, A and B are not duplicated', async () => {
    login(USER_A);
    await recordOffline([done('A', 5), done('B', 7), done('C', 11)]);
    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }]);

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['A', 'B', 'C']);
    expect(today(week)).toMatchObject({ completedCount: 3, workDoneMinutes: 23 });
    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B', 'C']);
    expect(serverToday()).toMatchObject({ completedCount: 3, workDoneMinutes: 23 });
    expect(puts()).toHaveLength(1);
  });

  it('overlapping task ids on both sides are unioned once, with count and minutes recomputed from the merged set', async () => {
    login(USER_A);
    await recordOffline([done('B', 7), done('C', 11), done('D', 3)]);
    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }, { id: 'C', est: 11 }]);

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['A', 'B', 'C', 'D']);
    expect(today(week)).toMatchObject({ completedCount: 4, workDoneMinutes: 26 }); // 5+7+11+3, B and C counted once
    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B', 'C', 'D']);
    expect(serverToday()).toMatchObject({ completedCount: 4, workDoneMinutes: 26 });
  });

  it('is idempotent: repeating reconciliation (reloads, retries) changes nothing and sends nothing more', async () => {
    login(USER_A);
    await recordOffline([done('B', 7), done('C', 11), done('D', 3)]);
    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }, { id: 'C', est: 11 }]);
    reconnect();
    await getWeekHistory();
    await settle();

    const serverAfterFirst = JSON.stringify(serverToday());
    const localAfterFirst = JSON.stringify(localToday());
    const putsAfterFirst = puts().length;

    for (let i = 0; i < 4; i += 1) {
      resetHistoryState(); // a fresh session each time
      advance(20_000);
      const week = await getWeekHistory();
      await settle();
      expect(today(week)).toMatchObject({ completedCount: 4, workDoneMinutes: 26 });
    }

    expect(JSON.stringify(serverToday())).toBe(serverAfterFirst);
    expect(JSON.stringify(localToday())).toBe(localAfterFirst);
    expect(puts()).toHaveLength(putsAfterFirst);
  });

  it('two devices that each worked offline converge to the union, in either reconnect order', async () => {
    // Device 1 = this browser (user-a). Device 2 is simulated by writing its result straight to the server.
    login(USER_A);
    await recordOffline([done('A', 5), done('B', 7)]);
    seedServer('user-a', '2026-09-30', [{ id: 'C', est: 11 }, { id: 'D', est: 3 }]); // device 2 got there first

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['A', 'B', 'C', 'D']);
    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B', 'C', 'D']);

    // Device 2 now reconnects with its own (older) view; its server-wins path picks up A and B.
    resetHistoryState();
    advance(20_000);
    expect(ids(today(await getWeekHistory()).completedTasks)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('property: for every pair of task sets nothing is lost and nothing is double-counted', () => {
    const universe = ['A', 'B', 'C', 'D', 'E'];
    const subset = (mask: number) => universe.filter((_, i) => mask & (1 << i));
    const entryFor = (set: string[], titleSuffix: string) => ({
      date: '2026-09-30',
      completedCount: set.length,
      workDoneMinutes: set.length * 10,
      completedTasks: set.map((id) => ({ id, title: `${id}${titleSuffix}`, estimatedMinutes: 10 })),
    });

    for (let s = 0; s < 1 << universe.length; s += 1) {
      for (let l = 0; l < 1 << universe.length; l += 1) {
        const server = subset(s);
        const local = subset(l);
        const merged = mergeDaySnapshots(entryFor(server, '-server'), { entry: entryFor(local, '-local') });
        const expected = [...new Set([...server, ...local])].sort();

        expect(merged.completedTasks.map((t) => t.id).sort()).toEqual(expected); // nothing lost, nothing duplicated
        expect(merged.completedCount).toBe(expected.length);
        expect(merged.workDoneMinutes).toBe(expected.length * 10);

        // idempotent: merging the result with either input again changes nothing
        const again = mergeDaySnapshots(merged, { entry: entryFor(local, '-local') });
        expect(again).toEqual(merged);
        const again2 = mergeDaySnapshots(merged, { entry: merged });
        expect(again2).toEqual(merged);
      }
    }
  });

  it('a task present on both sides appears once (local metadata wins) and is counted once', () => {
    const server = { date: '2026-09-30', completedCount: 1, workDoneMinutes: 5, completedTasks: [{ id: 'A', title: 'old title', estimatedMinutes: 5 }] };
    const local = { date: '2026-09-30', completedCount: 1, workDoneMinutes: 9, completedTasks: [{ id: 'A', title: 'new title', estimatedMinutes: 9 }] };

    const merged = mergeDaySnapshots(server, { entry: local });

    expect(merged.completedTasks).toEqual([{ id: 'A', title: 'new title', estimatedMinutes: 9 }]);
    expect(merged).toMatchObject({ completedCount: 1, workDoneMinutes: 9 });
  });

  it('removes a task only when THIS device un-completed it; a task from another device is never treated as removed', async () => {
    login(USER_A);
    await updateTodaySnapshot([done('A', 5), done('B', 7)]); // online, synced
    await settle();
    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B']);

    // Another device completes C meanwhile.
    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }, { id: 'C', est: 11 }]);

    // This device un-checks B.
    await updateTodaySnapshot([done('A', 5)]);
    await settle();

    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'C']); // B gone (we removed it), C kept (we never knew it)
    expect(serverToday()).toMatchObject({ completedCount: 2, workDoneMinutes: 16 });
    expect(localToday().pendingSync).toBe(false);
  });

  it("a task already pulled in from another device is NOT removed when this device later changes something unrelated", async () => {
    login(USER_A);
    await updateTodaySnapshot([done('A', 5), done('B', 7)]); // synced
    await settle();

    seedServer('user-a', '2026-09-30', [{ id: 'A', est: 5 }, { id: 'B', est: 7 }, { id: 'C', est: 11 }]); // other device adds C
    resetHistoryState();
    advance(20_000);
    const pulled = await getWeekHistory(); // acknowledged local copy: the server wins, so local now holds C too
    await settle();
    expect(ids(today(pulled).completedTasks)).toEqual(['A', 'B', 'C']);
    expect(localToday().completedTasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C']);

    // This device never completed C. Un-checking B here must remove B only.
    await updateTodaySnapshot([done('A', 5)]);
    await settle();

    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'C']);
    expect(ids(today(await getWeekHistory()).completedTasks)).toEqual(['A', 'C']);
  });

  it('single-device offline flow is unchanged: the stored history is exactly what the task list says', async () => {
    login(USER_A);

    await recordOffline([done('A', 5)]);
    await updateTodaySnapshot([done('A', 5), done('B', 7)]);
    await updateTodaySnapshot([done('B', 7)]); // A un-checked
    await settle();
    expect(today(await getWeekHistory())).toMatchObject({ completedCount: 1, workDoneMinutes: 7 });
    expect(ids(localToday().completedTasks as { id: string }[])).toEqual(['B']);
    expect(localToday().pendingSync).toBe(true);

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['B']);
    expect(today(week)).toMatchObject({ completedCount: 1, workDoneMinutes: 7 });
    expect(ids(serverToday()!.completedTasks)).toEqual(['B']);
    expect(serverToday()).toMatchObject({ completedCount: 1, workDoneMinutes: 7 });
    expect(localToday().pendingSync).toBe(false);
    expect(puts().every((r) => r.url === '/api/history/today')).toBe(true);
  });

  it('single-device online flow: every change reaches the server through pull → merge → push', async () => {
    login(USER_A);

    await updateTodaySnapshot([done('A', 5)]);
    await settle();
    await updateTodaySnapshot([done('A', 5), done('B', 7)]);
    await settle();

    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B']);
    expect(serverToday()).toMatchObject({ completedCount: 2, workDoneMinutes: 12 });
    // every PUT was preceded by a GET (the pull happens before each push)
    const sequence = requests.map((r) => r.method);
    sequence.forEach((m, i) => {
      if (m === 'PUT') expect(sequence.slice(0, i)).toContain('GET');
    });
  });

  it('a burst of rapid edits coalesces and ends with every task on the server', async () => {
    login(USER_A);

    await Promise.all([
      updateTodaySnapshot([done('A', 5)]),
      updateTodaySnapshot([done('A', 5), done('B', 7)]),
      updateTodaySnapshot([done('A', 5), done('B', 7), done('C', 11)]),
    ]);
    await settle(12);

    expect(ids(serverToday()!.completedTasks)).toEqual(['A', 'B', 'C']);
    expect(serverToday()).toMatchObject({ completedCount: 3, workDoneMinutes: 23 });
    expect(localToday().pendingSync).toBe(false);
  });

  it("another user's tasks can never enter this user's merge", async () => {
    login(USER_A);
    await recordOffline([done('A', 5)]);
    seedServer('user-b', '2026-09-30', [{ id: 'B1', est: 9 }]);
    seedServer('user-a', '2026-09-30', [{ id: 'A2', est: 4 }]);

    reconnect();
    const week = await getWeekHistory();
    await settle();

    expect(ids(today(week).completedTasks)).toEqual(['A', 'A2']);
    expect(ids(serverToday('user-a')!.completedTasks)).toEqual(['A', 'A2']);
    expect(ids(serverToday('user-b')!.completedTasks)).toEqual(['B1']); // untouched
  });
});

// ── The client declares ONE calendar convention: local date + matching UTC offset ──

describe('client date + declared UTC offset across timezones', () => {
  // [label, zone, expected offset minutes, instant]
  const cases: [string, string, number, string][] = [
    ['UTC+14 just before local midnight', 'Pacific/Kiritimati', 840, '2026-09-30T09:59:59Z'],
    ['UTC+14 at local midnight', 'Pacific/Kiritimati', 840, '2026-09-30T10:00:00Z'],
    ['UTC-12 just before local midnight', 'Etc/GMT+12', -720, '2026-09-30T11:59:59Z'],
    ['UTC-12 at local midnight', 'Etc/GMT+12', -720, '2026-09-30T12:00:00Z'],
    ['India (+05:30) just before local midnight', 'Asia/Calcutta', 330, '2026-09-30T18:29:59Z'],
    ['India (+05:30) at local midnight', 'Asia/Calcutta', 330, '2026-09-30T18:30:00Z'],
    ['Los Angeles (PDT) just before local midnight', 'America/Los_Angeles', -420, '2026-10-01T06:59:59Z'],
    ['Los Angeles (PDT) at local midnight', 'America/Los_Angeles', -420, '2026-10-01T07:00:00Z'],
    ['Los Angeles (PST) at local midnight', 'America/Los_Angeles', -480, '2026-12-01T08:00:00Z'],
    ['Los Angeles just before spring-forward', 'America/Los_Angeles', -480, '2026-03-08T09:59:59Z'],
    ['Los Angeles just after spring-forward', 'America/Los_Angeles', -420, '2026-03-08T10:00:00Z'],
    ['Los Angeles just before fall-back', 'America/Los_Angeles', -420, '2026-11-01T08:59:59Z'],
    ['Los Angeles just after fall-back (repeated hour)', 'America/Los_Angeles', -480, '2026-11-01T09:00:00Z'],
    ['Havana the skipped local midnight (spring-forward at 00:00)', 'America/Havana', -240, '2026-03-08T05:00:00Z'],
    ['Havana the instant before it', 'America/Havana', -300, '2026-03-08T04:59:59Z'],
  ];

  it.each(cases)('%s', async (_label, zone, offset, instant) => {
    setZone(zone);
    setNow(instant);
    login(USER_A);
    const expectedDate = intlDate(zone, instant);

    await updateTodaySnapshot([task('t1', instant, 10)]); // completed "now", so it belongs to today
    await settle();
    const week = await getWeekHistory();

    // The client's idea of "today" matches the platform's timezone database...
    expect(today(week).date).toBe(expectedDate);
    expect(today(week).completedTasks.map((t) => t.id)).toEqual(['t1']);
    // ...and it declares exactly that date together with the matching offset, on both calls.
    const put = puts()[0];
    expect(put.url).toBe('/api/history/today');
    expect(put.body).toMatchObject({ date: expectedDate, utcOffsetMinutes: offset });
    expect(requests.find((r) => r.method === 'GET')!.params).toMatchObject({ endDate: expectedDate, utcOffsetMinutes: offset });
    // The contract-enforcing fake server accepted it (it would have thrown a 400 otherwise).
    expect(rowsFor('user-a').get(expectedDate)?.completedTasks.map((t) => t.taskId)).toEqual(['t1']);
  });

  it('the local day flips exactly at local midnight, and the offset is a per-request fact (DST)', async () => {
    setZone('America/Los_Angeles');
    login(USER_A);

    setNow('2026-03-08T09:59:59Z'); // 01:59:59 PST
    await updateTodaySnapshot([task('before', '2026-03-08T09:59:59Z', 10)]);
    await settle();
    expect(puts()[puts().length - 1].body).toMatchObject({ date: '2026-03-08', utcOffsetMinutes: -480 });

    setNow('2026-03-08T10:00:00Z'); // 03:00:00 PDT — same local day, offset moved by an hour
    await updateTodaySnapshot([task('before', '2026-03-08T09:59:59Z', 10), task('after', '2026-03-08T10:00:00Z', 10)]);
    await settle();
    expect(puts()[puts().length - 1].body).toMatchObject({ date: '2026-03-08', utcOffsetMinutes: -420 });
    expect(rowsFor('user-a').get('2026-03-08')?.completedTasks.map((t) => t.taskId).sort()).toEqual(['after', 'before']);
  });

  it('a task completed one second before local midnight and one second after land on different days', async () => {
    setZone('Asia/Calcutta');
    login(USER_A);
    setNow('2026-09-30T18:30:30Z'); // 00:00:30 on Oct 1 in India

    await updateTodaySnapshot([
      task('late-sep30', '2026-09-30T18:29:59Z', 10),
      task('early-oct1', '2026-09-30T18:30:01Z', 10),
    ]);
    await settle();

    expect(rowsFor('user-a').get('2026-10-01')?.completedTasks.map((t) => t.taskId)).toEqual(['early-oct1']);
    expect(rowsFor('user-a').has('2026-09-30')).toBe(false);
  });

  it('never sends the UTC date for a device that is on a different local day', async () => {
    setZone('America/Los_Angeles');
    setNow('2026-09-30T02:00:00Z'); // UTC says Sep 30; Los Angeles is still on Sep 29
    login(USER_A);

    await updateTodaySnapshot([task('t1', '2026-09-30T01:00:00Z', 10)]);
    await settle();

    expect(puts().map((r) => r.body.date)).toEqual(['2026-09-29']);
    expect(requests.some((r) => JSON.stringify(r).includes('2026-09-30'))).toBe(false);
  });
});

// ── Strict "today" + a device clock that differs from the server's at local midnight ──

describe('strict today: a device clock a few seconds off the server near local midnight loses nothing', () => {
  const entryFor = (date: string) =>
    (idb.get('task_history:user-a') as { date: string; pendingSync: boolean; completedTasks: { id: string }[] }[] | null)?.find((e) => e.date === date);

  it('client BEHIND the server: the rejected day stays pending and is delivered once the client crosses midnight (via the backfill route)', async () => {
    serverSkewMs = 10_000; // server runs 10s ahead of this device
    setNow('2026-09-30T23:59:58Z'); // device: Sep 30; server: 00:00:08 Oct 1
    login(USER_A);

    await updateTodaySnapshot([task('t1', '2026-09-30T23:59:00Z', 10)]);
    await settle();

    // Server's "today" is Oct 1, so it refuses the device's Sep 30 "today": nothing stored, but nothing dropped.
    expect(rowsFor('user-a').size).toBe(0);
    expect(entryFor('2026-09-30')).toMatchObject({ pendingSync: true });
    expect((await getWeekHistory()).slice(-1)[0].completedTasks.map((t) => t.id)).toEqual(['t1']); // still shown locally

    advance(20_000); // the device clock now passes midnight too
    await getWeekHistory();
    await settle();

    expect(puts().some((r) => r.url === '/api/history/2026-09-30')).toBe(true); // Sep 30 is now a past day → backfill route
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(entryFor('2026-09-30')).toMatchObject({ pendingSync: false });
  });

  it('client AHEAD of the server: the rejected day stays pending and is accepted as soon as the server reaches the same date', async () => {
    serverSkewMs = -10_000; // device runs 10s ahead of the server
    setNow('2026-10-01T00:00:05Z'); // device: Oct 1; server: 23:59:55 Sep 30
    login(USER_A);

    await updateTodaySnapshot([task('t1', '2026-10-01T00:00:01Z', 10)]);
    await settle();

    expect(rowsFor('user-a').size).toBe(0); // GET and PUT for Oct 1 are both "future" to the server
    expect(entryFor('2026-10-01')).toMatchObject({ pendingSync: true });
    expect((await getWeekHistory()).slice(-1)[0].completedTasks.map((t) => t.id)).toEqual(['t1']);

    serverSkewMs = 0; // the server catches up
    advance(20_000);
    await getWeekHistory();
    await settle();

    expect(puts().some((r) => r.url === '/api/history/today')).toBe(true);
    expect(rowsFor('user-a').get('2026-10-01')?.completedTasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(entryFor('2026-10-01')).toMatchObject({ pendingSync: false });
  });

  it('midnight passes between the pull and the push: the date rejection is retried, not treated as a permanent failure', async () => {
    login(USER_A);
    setNow('2026-09-30T23:59:59Z');
    holdPuts = []; // pause the PUT after the GET has already succeeded

    await updateTodaySnapshot([task('t1', '2026-09-30T23:59:00Z', 10)]);
    await settle();
    expect(puts()).toHaveLength(1);

    advance(2000); // 00:00:01 Oct 1 — while the PUT for Sep 30 is still in flight
    const held = holdPuts.splice(0);
    holdPuts = null;
    held.forEach((h) => h.resolve());
    await settle();

    expect(rowsFor('user-a').size).toBe(0); // /today refused: it is no longer Sep 30
    expect(entryFor('2026-09-30')).toMatchObject({ pendingSync: true }); // kept, not dropped

    advance(20_000);
    await getWeekHistory();
    await settle();
    expect(rowsFor('user-a').get('2026-09-30')?.completedTasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(entryFor('2026-09-30')).toMatchObject({ pendingSync: false });
  });

  it('a payload error (400 without a DATE_ code) is still permanent for that payload', async () => {
    login(USER_A);
    rejectWith400 = true;

    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10)]);
    await settle();

    expect(entryFor('2026-09-30')).toMatchObject({ pendingSync: false });
  });

  it('a date rejection never wipes or replaces local history', async () => {
    serverSkewMs = -86_400_000; // server a full day behind: the client's "today" is always "future" to it
    login(USER_A);
    await updateTodaySnapshot([task('t1', '2026-09-30T05:00:00Z', 10), task('t2', '2026-09-30T05:30:00Z', 10)]);
    await settle();
    advance(20_000);
    const week = await getWeekHistory();

    expect(week[week.length - 1].completedTasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(rowsFor('user-a').size).toBe(0);
  });
});
