import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #57: the background drain that follows a local commit, and what happens when the server refuses something that
// was already shown. The queue processor and the storage are doubles (their real behaviour is covered in
// queueProcessor.localFirst.test.ts and localMutations.test.ts); this proves how the hook drives them.

vi.mock('../offline/cache', () => ({
  getCachedTasks: vi.fn(async () => []),
  getLastSyncTimestamp: vi.fn(async () => null),
  setLastSyncTimestamp: vi.fn(async () => undefined),
}));
vi.mock('../offline/localMutations', () => ({
  reconcileServerTasks: vi.fn(async (fresh: unknown[]) => fresh),
  settleRejectedLocalState: vi.fn(async () => []),
}));
vi.mock('../offline/queueProcessor', () => ({ processSyncQueue: vi.fn() }));
vi.mock('../offline/syncQueue', () => ({ getSyncQueue: vi.fn(async () => [{ id: 'q1' }]) }));
vi.mock('../services/taskService', () => ({ taskService: { getTasks: vi.fn() } }));

import { reconcileServerTasks, settleRejectedLocalState } from '../offline/localMutations';
import { processSyncQueue } from '../offline/queueProcessor';
import { taskService } from '../services/taskService';
import { useDashboardSync } from './useDashboardSync';

const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });

const ok = { processed: 1, failed: 0, remaining: 0, rejected: [] };

// Mounting online runs the initial load (one drain); it is settled and forgotten so each test counts only its own.
const mount = async (isOnline = true) => {
  const setStatusError = vi.fn();
  const setStatusInfo = vi.fn();
  const setTasks = vi.fn();
  const view = renderHook(() =>
    useDashboardSync({ isOnline, persistTasks: vi.fn(), setLoadingTasks: vi.fn(), setStatusError, setStatusInfo, setTasks }),
  );
  await settle();
  vi.clearAllMocks();
  vi.mocked(processSyncQueue).mockResolvedValue(ok as never);
  vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
  return { ...view, setStatusError, setStatusInfo, setTasks };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processSyncQueue).mockResolvedValue(ok as never);
  vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
});

describe('requestSync (the drain after a local commit)', () => {
  it('does nothing while offline: the committed entry waits', async () => {
    const m = await mount(false);
    act(() => m.result.current.requestSync());
    await settle();
    expect(processSyncQueue).not.toHaveBeenCalled();
  });

  it('online: runs one drain without blocking the caller', async () => {
    const m = await mount(true);
    act(() => m.result.current.requestSync());
    await settle();
    expect(processSyncQueue).toHaveBeenCalledTimes(1);
  });

  it('requests made while a drain runs never start a second concurrent drain: they cause exactly ONE more run afterwards', async () => {
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const m = await mount(true);
    vi.mocked(processSyncQueue).mockImplementation(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((resolve) => (release = resolve));
      running -= 1;
      return ok as never;
    });

    act(() => m.result.current.requestSync());
    await settle();
    act(() => { m.result.current.requestSync(); m.result.current.requestSync(); m.result.current.requestSync(); });
    await settle();
    expect(processSyncQueue).toHaveBeenCalledTimes(1);

    release(); // the first drain finishes; the coalesced request goes round once
    await settle();
    expect(processSyncQueue).toHaveBeenCalledTimes(2);
    release();
    await settle();
    expect(processSyncQueue).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it('a drain that throws leaves the entries queued, marks the sync as pending, and does not break later requests', async () => {
    const m = await mount(true);
    vi.mocked(processSyncQueue).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ok as never);
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncStatus).toBe('errors-pending');
    act(() => m.result.current.requestSync());
    await settle();
    expect(processSyncQueue).toHaveBeenCalledTimes(2);
  });
});

describe('a mutation the server rejected', () => {
  const rejection = { type: 'update', taskId: 's1', title: 'Report', status: 400 };

  it('says it was not saved, stops showing it as pending, and reads the server back ONCE', async () => {
    const m = await mount(true);
    vi.mocked(processSyncQueue).mockResolvedValueOnce({ processed: 0, failed: 0, remaining: 0, rejected: [rejection] } as never);

    act(() => m.result.current.requestSync());
    await settle();

    expect(m.setStatusError).toHaveBeenCalledWith(expect.stringMatching(/Not saved: the server rejected the edit to “Report” \(error 400\)/));
    expect(settleRejectedLocalState).toHaveBeenCalledTimes(1);
    expect(taskService.getTasks).toHaveBeenCalledTimes(1);
    expect(reconcileServerTasks).toHaveBeenCalledTimes(1);
  });

  it('if the server cannot be read back, the message stays and the tasks no longer claim to be pending (no retry loop)', async () => {
    const m = await mount(true);
    vi.mocked(processSyncQueue).mockResolvedValueOnce({ processed: 0, failed: 0, remaining: 0, rejected: [rejection] } as never);
    vi.mocked(taskService.getTasks).mockRejectedValue(new Error('offline'));

    act(() => m.result.current.requestSync());
    await settle();

    expect(settleRejectedLocalState).toHaveBeenCalledTimes(1);
    expect(taskService.getTasks).toHaveBeenCalledTimes(1);
    expect(processSyncQueue).toHaveBeenCalledTimes(1);
  });

  it('a retry that hits a refusal does not also announce success', async () => {
    const m = await mount(true);
    vi.mocked(processSyncQueue).mockResolvedValueOnce({ processed: 0, failed: 0, remaining: 0, rejected: [rejection] } as never);

    await act(() => m.result.current.handleRetrySync());

    expect(m.setStatusInfo).not.toHaveBeenCalledWith('Pending sync actions completed successfully.');
    expect(taskService.getTasks).toHaveBeenCalledTimes(1); // the reconciliation fetch is not repeated
  });

  it('nothing refused: no message, no reconciliation', async () => {
    const m = await mount(true);
    act(() => m.result.current.requestSync());
    await settle();
    expect(settleRejectedLocalState).not.toHaveBeenCalled();
    expect(m.setStatusError).not.toHaveBeenCalledWith(expect.stringMatching(/Not saved/));
  });
});
