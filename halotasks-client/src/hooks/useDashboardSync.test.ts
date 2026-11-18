import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardSync } from './useDashboardSync';

vi.mock('../offline/cache', () => ({
  getCachedTasks: vi.fn(async () => []),
  getLastSyncTimestamp: vi.fn(async () => null),
  setCachedTasks: vi.fn(async () => undefined),
  setLastSyncTimestamp: vi.fn(async () => undefined),
}));

vi.mock('../offline/localMutations', () => ({
  // The real merge runs in one IndexedDB transaction (localMutations.test.ts); here the server's list is what is adopted.
  reconcileServerTasks: vi.fn(async (fresh: unknown[]) => fresh),
  settleRejectedLocalState: vi.fn(async () => []),
}));

vi.mock('../offline/queueProcessor', () => ({
  processSyncQueue: vi.fn(async () => ({ processed: 0, failed: 0, remaining: 0, rejected: [] })),
}));

vi.mock('../offline/syncQueue', () => ({
  getSyncQueue: vi.fn(async () => []),
}));

vi.mock('../services/taskService', () => ({
  taskService: {
    getTasks: vi.fn(),
  },
}));

import { AxiosError } from 'axios';
import { getCachedTasks } from '../offline/cache';
import { taskService } from '../services/taskService';

// Lets already-queued microtasks (the async chain inside loadTasks) settle
// without advancing fake timers.
async function flushMicrotasks(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setupHook() {
  return renderHook(() =>
    useDashboardSync({
      isOnline: true,
      persistTasks: vi.fn(),
      setLoadingTasks: vi.fn(),
      setStatusError: vi.fn(),
      setStatusInfo: vi.fn(),
      setTasks: vi.fn(),
    }),
  );
}

describe('useDashboardSync owns no cold-start overlay signal (the game is only ever opened by the person)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(taskService.getTasks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a request that takes a long time changes nothing but the sync status: no "waking" state is exposed, and the load still completes', async () => {
    let resolveTasks: ((value: Awaited<ReturnType<typeof taskService.getTasks>>) => void) | undefined;
    vi.mocked(taskService.getTasks).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTasks = resolve;
        }),
    );

    const { result } = setupHook();
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.syncStatus).toBe('syncing');
    expect('coldStartPhase' in result.current).toBe(false);

    await act(async () => {
      resolveTasks?.({ tasks: [], page: 1, limit: 0, hasMore: false });
    });
    await flushMicrotasks();
    expect(result.current.syncStatus).toBe('synced');
    expect('coldStartPhase' in result.current).toBe(false);
  });

  it('a slow sync queue is just a sync in progress: nothing is exposed that a page could turn into a modal', async () => {
    vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [], page: 1, limit: 0, hasMore: false });
    const { result } = setupHook();
    await flushMicrotasks();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(Object.keys(result.current).filter((key) => /cold|wak|overlay/i.test(key))).toEqual([]);
  });
});

describe('useDashboardSync: an unreachable server is a calm note, not an alarm (Issue #49, 49D)', () => {
  const setup = () => {
    const setStatusError = vi.fn();
    const setStatusInfo = vi.fn();
    const hook = renderHook(({ online }: { online: boolean }) =>
      useDashboardSync({
        isOnline: online,
        persistTasks: vi.fn(),
        setLoadingTasks: vi.fn(),
        setStatusError,
        setStatusInfo,
        setTasks: vi.fn(),
      }),
    { initialProps: { online: true } });
    return { ...hook, setStatusError, setStatusInfo };
  };
  const cached = [{ _id: 'a', title: 'cached task' }] as never;
  const answered = (status: number) =>
    new AxiosError('x', 'ERR_BAD_RESPONSE', undefined, null, { status, statusText: '', headers: {}, config: {} as never, data: { message: 'Boom' } });

  beforeEach(() => {
    vi.mocked(taskService.getTasks).mockReset();
    vi.mocked(getCachedTasks).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.mocked(getCachedTasks).mockResolvedValue([]);
  });

  it('no response and nothing cached: a neutral note that says why, never a red error', async () => {
    vi.mocked(taskService.getTasks).mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
    const { setStatusError, setStatusInfo } = setup();
    await flushMicrotasks(8);
    expect(setStatusInfo).toHaveBeenCalledWith('Nothing is saved on this device yet. Your tasks will appear here when the server is back.');
    expect(setStatusError).not.toHaveBeenCalledWith(expect.stringMatching(/Unable/));
  });

  it('no response with cached tasks: shows that what is on screen is what is saved here', async () => {
    vi.mocked(getCachedTasks).mockResolvedValue(cached);
    vi.mocked(taskService.getTasks).mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED'));
    const { result, setStatusError, setStatusInfo } = setup();
    await flushMicrotasks(8);
    expect(setStatusInfo).toHaveBeenCalledWith("Showing what's saved on this device. Updates will appear when the server is back.");
    expect(setStatusError).not.toHaveBeenCalledWith(expect.stringMatching(/Unable/));
    expect(result.current.syncStatus).toBe('cached');
  });

  it('a gateway answer (503) is the same calm note', async () => {
    vi.mocked(taskService.getTasks).mockRejectedValue(answered(503));
    const { setStatusError, setStatusInfo } = setup();
    await flushMicrotasks(8);
    expect(setStatusInfo).toHaveBeenCalledWith(expect.stringMatching(/Nothing is saved on this device yet/));
    expect(setStatusError).not.toHaveBeenCalledWith('Boom');
  });

  it('a server that answers with a real error keeps the real error', async () => {
    vi.mocked(taskService.getTasks).mockRejectedValue(answered(500));
    const { setStatusError, setStatusInfo } = setup();
    await flushMicrotasks(8);
    expect(setStatusError).toHaveBeenCalledWith('Boom');
    expect(setStatusInfo).not.toHaveBeenCalledWith(expect.stringMatching(/saved on this device/));
  });

  it('the note goes away when a later load succeeds, and only its own note', async () => {
    vi.mocked(taskService.getTasks).mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
    const { rerender, setStatusInfo } = setup();
    await flushMicrotasks(8);
    // A second load, as happens when the browser goes offline and comes back (the effect re-runs on `isOnline`).
    rerender({ online: false });
    await flushMicrotasks(8);
    setStatusInfo.mockClear();
    rerender({ online: true });
    await flushMicrotasks(8);
    expect(setStatusInfo).toHaveBeenCalledWith(null);
  });

  it('does not turn a request failure into a server-unreachable note when the browser has gone offline', async () => {
    let rejectLoad: (e: unknown) => void = () => {};
    vi.mocked(taskService.getTasks).mockReturnValue(new Promise((_, reject) => { rejectLoad = reject; }) as never);
    const { rerender, setStatusInfo } = setup();
    await flushMicrotasks(4);
    rerender({ online: false });
    await act(async () => {
      rejectLoad(new AxiosError('Network Error', 'ERR_NETWORK'));
    });
    await flushMicrotasks(8);
    expect(setStatusInfo).not.toHaveBeenCalledWith(expect.stringMatching(/server is back/i));
    expect(setStatusInfo).not.toHaveBeenCalledWith(expect.stringMatching(/saved on this device/));
  });

  it('while offline no request is made at all (the invariant behind the check above)', async () => {
    const { rerender } = setup();
    await flushMicrotasks(8);
    vi.mocked(taskService.getTasks).mockClear();
    rerender({ online: false });
    await flushMicrotasks(8);
    expect(taskService.getTasks).not.toHaveBeenCalled();
  });

  it('a successful load with no earlier note does not wipe an unrelated message', async () => {
    vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
    const { setStatusInfo } = setup();
    await flushMicrotasks(8);
    expect(setStatusInfo).not.toHaveBeenCalledWith(null);
  });
});
