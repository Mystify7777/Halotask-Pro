import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #58, the guardrail on `confirmedAt`: it only advances when the queue is observed EMPTY as part of a successful drain or
// list fetch. Here the processor and the storage are doubles with a controllable queue length, so each way of NOT confirming
// is forced on its own.

const queue = vi.hoisted(() => ({ length: 0 }));

vi.mock('../offline/cache', () => ({ getCachedTasks: vi.fn(async () => []) }));
vi.mock('../offline/localMutations', () => ({
  reconcileServerTasks: vi.fn(async (fresh: unknown[]) => fresh),
  settleRejectedLocalState: vi.fn(async () => []),
}));
vi.mock('../offline/queueProcessor', () => ({ processSyncQueue: vi.fn() }));
vi.mock('../offline/syncQueue', () => ({ getSyncQueue: vi.fn(async () => Array.from({ length: queue.length }, (_, i) => ({ id: `q${i}` }))) }));
vi.mock('../services/taskService', () => ({ taskService: { getTasks: vi.fn() } }));

import { processSyncQueue } from '../offline/queueProcessor';
import { taskService } from '../services/taskService';
import { useDashboardSync } from './useDashboardSync';

const settle = () => act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
const done = { processed: 1, failed: 0, remaining: 0, rejected: [] as unknown[], blocked: null as 'auth' | 'unreachable' | null };

const mount = async () => {
  const view = renderHook(() =>
    useDashboardSync({ isOnline: true, persistTasks: vi.fn(), setLoadingTasks: vi.fn(), setStatusError: vi.fn(), setStatusInfo: vi.fn(), setTasks: vi.fn() }),
  );
  await settle();
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  queue.length = 0;
  vi.mocked(processSyncQueue).mockResolvedValue(done as never);
  vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
});

describe('confirmedAt', () => {
  it('a successful list fetch with an empty queue confirms', async () => {
    const m = await mount();
    expect(m.result.current.syncState).toMatchObject({ kind: 'synced' });
    expect(m.result.current.syncState.confirmedAt).not.toBeNull();
  });

  it('a fetch that finishes while work is queued (committed during the request) claims nothing', async () => {
    vi.mocked(taskService.getTasks).mockImplementation((async () => {
      queue.length = 1; // the user committed a change while the request was out
      return { tasks: [] };
    }) as never);
    const m = await mount();
    expect(m.result.current.syncState).toMatchObject({ kind: 'pending', pending: 1 });
    // (derived states other than "synced" do not carry the time, so prove it by what the state becomes once the queue reads empty)
    queue.length = 0;
    await act(async () => { await m.result.current.refreshPendingQueueCount(); });
    expect(m.result.current.syncState.kind).toBe('unverified');
  });

  it('a drain starting over new work drops the earlier confirmation for its whole duration', async () => {
    const m = await mount();
    expect(m.result.current.syncState.kind).toBe('synced');

    queue.length = 2; // work that arrived without this tab re-reading the queue first
    let release!: () => void;
    vi.mocked(processSyncQueue).mockImplementationOnce(() => new Promise((resolve) => (release = () => { queue.length = 0; resolve(done as never); })));
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncState).toMatchObject({ kind: 'syncing', confirmedAt: null });

    await act(async () => release());
    await settle();
    expect(m.result.current.syncState.kind).toBe('synced');
    expect(m.result.current.syncState.confirmedAt).not.toBeNull();
  });

  it('a drain that stopped early never confirms, even if the queue then reads empty', async () => {
    const m = await mount();
    queue.length = 1;
    vi.mocked(processSyncQueue).mockImplementationOnce((async () => {
      queue.length = 0; // another tab delivered it meanwhile
      return { ...done, blocked: 'auth' };
    }) as never);
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncState.kind).toBe('unverified');
  });

  it('a drain that ended with a refusal does not confirm by itself; only the read-back that follows can', async () => {
    const m = await mount();
    queue.length = 1;
    vi.mocked(processSyncQueue).mockImplementationOnce((async () => {
      queue.length = 0;
      return { ...done, rejected: [{ type: 'update', taskId: 's1', title: 'T', status: 400 }] };
    }) as never);
    vi.mocked(taskService.getTasks).mockRejectedValue(new Error('offline')); // the read-back fails
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncState).toMatchObject({ kind: 'attention', rejected: 1 });
    expect(m.result.current.rejectionNotices).toHaveLength(1);
    act(() => m.result.current.dismissRejections());
    expect(m.result.current.syncState.kind).toBe('unverified'); // nothing in this run proved the device synchronized
  });

  it('a failed drain (the processor throws) never confirms', async () => {
    const m = await mount();
    queue.length = 1;
    vi.mocked(processSyncQueue).mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncState).toMatchObject({ kind: 'attention', blocked: 'unreachable' });
  });

  it('an UNCLASSIFIED throw (a plain Error, no response, not network-shaped) with queued work is actionable attention, never a silent "pending"', async () => {
    const m = await mount();
    queue.length = 2;
    vi.mocked(processSyncQueue).mockRejectedValueOnce(new Error('unexpected'));
    act(() => m.result.current.requestSync());
    await settle();
    expect(m.result.current.syncState).toMatchObject({ kind: 'attention', blocked: 'unreachable', rejected: 0, pending: 2 });
    expect(m.result.current.rejectionNotices).toEqual([]);
  });

  it('the same for a manual retry that throws an unclassified error', async () => {
    const m = await mount();
    queue.length = 1;
    vi.mocked(processSyncQueue).mockRejectedValueOnce(new Error('unexpected'));
    await act(async () => { await m.result.current.handleRetrySync(); });
    expect(m.result.current.syncState).toMatchObject({ kind: 'attention', blocked: 'unreachable', pending: 1 });
  });
});
