import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #62B: what the sync hook does with the conflicts a drain reports. The processor and storage are doubles.

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
const conflictOf = (taskId: string, title: string | null) => ({
  taskId,
  title,
  fields: [{ field: 'title', base: 'A', requested: 'Mine', current: 'Theirs' }],
  mine: { title: 'Mine' },
  base: { title: 'A' },
});
const drain = (conflicts: unknown[]) => ({ processed: 1, failed: 0, remaining: 0, rejected: [], conflicts, blocked: null });

const mount = async () => {
  const view = renderHook(() => useDashboardSync({ isOnline: true, persistTasks: vi.fn(), setLoadingTasks: vi.fn(), setStatusError: vi.fn(), setStatusInfo: vi.fn(), setTasks: vi.fn() }));
  await settle();
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  queue.length = 0;
  vi.mocked(processSyncQueue).mockResolvedValue(drain([]) as never);
  vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
});

describe('conflicts from a drain', () => {
  const sync = async (m: Awaited<ReturnType<typeof mount>>, conflicts: unknown[]) => {
    queue.length = 1;
    vi.mocked(processSyncQueue).mockImplementationOnce((async () => {
      queue.length = 0;
      return drain(conflicts);
    }) as never);
    vi.mocked(taskService.getTasks).mockRejectedValue(new Error('offline')); // no read-back: only the drain speaks
    act(() => m.result.current.requestSync());
    await settle();
  };

  it('become one notice each, carrying the conflict, and count as attention', async () => {
    const m = await mount();
    await sync(m, [conflictOf('s1', 'Plan'), conflictOf('s2', 'Other')]);
    const notices = m.result.current.rejectionNotices;
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toContain('“Plan” was changed on another device');
    expect(notices[0].conflict?.taskId).toBe('s1');
    expect(m.result.current.syncState).toMatchObject({ kind: 'attention', rejected: 2 });
  });

  it('never confirm the device: once resolved, nothing in that run proved it synchronized', async () => {
    const m = await mount();
    await sync(m, [conflictOf('s1', 'Plan')]);
    expect(m.result.current.syncState.kind).toBe('attention');
    act(() => m.result.current.resolveNotice(m.result.current.rejectionNotices[0]));
    expect(m.result.current.syncState.kind).toBe('unverified');
  });

  it('use the live title when the conflict does not know it', async () => {
    const m = await mount();
    m.result.current.setTitleLookup(() => 'Live title');
    await sync(m, [conflictOf('s1', null)]);
    expect(m.result.current.rejectionNotices[0].message).toContain('“Live title”');
  });

  it('Dismiss clears refusals but a conflict stays until it is resolved; resolveNotice removes exactly that one', async () => {
    const m = await mount();
    await sync(m, [conflictOf('s1', 'Plan'), conflictOf('s2', 'Other')]);
    act(() => m.result.current.dismissRejections());
    expect(m.result.current.rejectionNotices).toHaveLength(2);
    const [first, second] = m.result.current.rejectionNotices;
    act(() => m.result.current.resolveNotice(first));
    expect(m.result.current.rejectionNotices).toEqual([second]);
    act(() => m.result.current.resolveNotice(second));
    expect(m.result.current.rejectionNotices).toEqual([]);
    expect(m.result.current.syncState.kind).not.toBe('attention');
  });
});
