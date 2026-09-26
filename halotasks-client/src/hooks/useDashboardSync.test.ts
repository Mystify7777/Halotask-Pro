import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardSync } from './useDashboardSync';

vi.mock('../offline/cache', () => ({
  getCachedTasks: vi.fn(async () => []),
  getLastSyncTimestamp: vi.fn(async () => null),
  setCachedTasks: vi.fn(async () => undefined),
  setLastSyncTimestamp: vi.fn(async () => undefined),
}));

vi.mock('../offline/queueProcessor', () => ({
  processSyncQueue: vi.fn(async () => ({ processed: 0, failed: 0, remaining: 0 })),
}));

vi.mock('../offline/syncQueue', () => ({
  getSyncQueue: vi.fn(async () => []),
}));

vi.mock('../services/taskService', () => ({
  taskService: {
    getTasks: vi.fn(),
  },
}));

import { taskService } from '../services/taskService';
import type { Task } from '../types/task';

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

describe('useDashboardSync cold-start phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(taskService.getTasks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only enters "waking" after 3s, and only reports "ready" once the request genuinely succeeds', async () => {
    let resolveTasks: ((value: { tasks: Task[] }) => void) | undefined;
    vi.mocked(taskService.getTasks).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTasks = resolve;
        }),
    );

    const { result } = setupHook();
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current.coldStartPhase).toBe('idle');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.coldStartPhase).toBe('waking');

    await act(async () => {
      resolveTasks?.({ tasks: [] });
    });
    await flushMicrotasks();

    expect(result.current.coldStartPhase).toBe('ready');
  });

  it('never reports "ready" when the request ultimately fails', async () => {
    let rejectTasks: ((reason?: unknown) => void) | undefined;
    vi.mocked(taskService.getTasks).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectTasks = reject;
        }),
    );

    const { result } = setupHook();
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.coldStartPhase).toBe('waking');

    await act(async () => {
      rejectTasks?.(new Error('network error'));
    });
    await flushMicrotasks();

    expect(result.current.coldStartPhase).toBe('error');
    expect(result.current.coldStartPhase).not.toBe('ready');
  });

  it('never enters "waking" at all for a fast, successful response', async () => {
    vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] });

    const { result } = setupHook();
    await flushMicrotasks();

    expect(result.current.coldStartPhase).toBe('idle');

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    // The 3s timer's own guard (matching the load's cycle id) prevents a
    // stale timer from a completed, fast load from ever firing 'waking'.
    expect(result.current.coldStartPhase).toBe('idle');
  });
});
