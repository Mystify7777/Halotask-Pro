import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrowthResult, TreeStateJSON } from '../growth/treeTypes';
import { makeTask } from '../test/taskFactory';
import { resetOfflineStore } from '../test/dashboardTasksHarness';
import type { Task } from '../types/task';

// Issue #57 review: with every completion local-first, an ONLINE tap now shows an optimistic +10 preview and the XP is then
// awarded by the SERVER when the drain sends the completion. This runs the real Growth hook, the real dashboard hook, the real
// queue and the real processor (only the HTTP services are doubles) and proves the person is never shown, nor the tree
// credited, with the XP twice.

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));
vi.mock('../services/taskService', () => ({ taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn() } }));
vi.mock('../services/treeService', () => ({ treeService: { getTree: vi.fn() } }));

import { processSyncQueue } from '../offline/queueProcessor';
import { getSyncQueue } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import { treeService } from '../services/treeService';
import { useDashboardGrowth } from './useDashboardGrowth';
import { useDashboardTasks } from './useDashboardTasks';

const BASE_XP = 20;
const treeJson = (xp: number): TreeStateJSON => ({
  xp, leaves: 1, streakDays: 1, lastActiveDate: '2026-10-20', health: 'healthy', stage: 'seed', lastCalculatedAt: '2026-10-20T00:00:00.000Z', awardedTaskIds: [],
});
const serverGrowth = (taskId: string, xp: number, awarded: boolean): GrowthResult => ({
  taskId,
  awarded,
  xpGained: awarded ? 10 : 0,
  ...(awarded ? {} : { reason: 'already_awarded' as const }),
  treeState: { xp, leaves: 1, streakDays: 1, lastActiveDate: '2026-10-20', health: 'healthy', stage: 'seed', lastCalculatedAt: '2026-10-20T00:00:00.000Z' },
});

const mount = async (initial: Task[]) => {
  await resetOfflineStore();
  const { setCachedTasks } = await import('../offline/cache');
  await setCachedTasks(initial);
  const requestSync = vi.fn();
  const view = renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const growth = useDashboardGrowth();
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline: true,
      syncBridgeRef: { current: { refreshPendingQueueCount: vi.fn(async () => 0), requestSync } },
      previewGrowthForCompletion: growth.previewGrowthForCompletion,
      setStatusError: vi.fn(),
      setStatusInfo: vi.fn(),
    });
    return { hook, tasks, growth };
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); // Growth init
  return Object.assign(view, { requestSync });
};

/** What the sync hook does with a drain: hand the server's growth to the Growth hook. */
const drain = (m: Awaited<ReturnType<typeof mount>>) =>
  act(async () => {
    await processSyncQueue({
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onGrowth: (growth) => m.result.current.growth.applyServerGrowth(growth),
    });
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(treeService.getTree).mockResolvedValue(treeJson(BASE_XP));
});

describe('an online optimistic completion does not double-award XP', () => {
  it('the tap shows +10 once; the server award then REPLACES the preview (still +10 in total, not +20)', async () => {
    const task = makeTask({ _id: 'a'.repeat(24), completed: false });
    const m = await mount([task]);
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP);

    await act(() => m.result.current.hook.handleToggleTask(task));
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 10); // optimistic preview
    expect(await getSyncQueue('user-1')).toHaveLength(1);
    expect(taskService.updateTask).not.toHaveBeenCalled(); // the tap itself awards nothing: only the server does

    vi.mocked(taskService.updateTask).mockResolvedValue({ task: { ...task, completed: true }, growth: serverGrowth(task._id, BASE_XP + 10, true) } as never);
    await drain(m);

    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 10); // the server's tree, not preview + award
  });

  it('a server that had ALREADY awarded the task (refusal, same XP) leaves the XP unchanged; the preview is not kept on top', async () => {
    const task = makeTask({ _id: 'b'.repeat(24), completed: false });
    treeServerXp(BASE_XP + 10); // another device already earned it
    const m = await mount([task]);
    await act(() => m.result.current.hook.handleToggleTask(task));

    vi.mocked(taskService.updateTask).mockResolvedValue({ task: { ...task, completed: true }, growth: serverGrowth(task._id, BASE_XP + 10, false) } as never);
    await drain(m);

    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 10);
  });

  it('complete, re-open, complete again before the drain: one award at most, and re-opening never takes XP back or adds any', async () => {
    const task = makeTask({ _id: 'c'.repeat(24), completed: false });
    const m = await mount([task]);

    await act(() => m.result.current.hook.handleToggleTask(task)); // complete: preview +10
    await act(() => m.result.current.hook.handleToggleTask(m.result.current.tasks[0])); // re-open: no XP change
    await act(() => m.result.current.hook.handleToggleTask(m.result.current.tasks[0])); // complete again: the same task is never previewed twice
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 10);

    vi.mocked(taskService.updateTask).mockResolvedValue({ task: { ...task, completed: true }, growth: serverGrowth(task._id, BASE_XP + 10, true) } as never);
    await drain(m);
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 10);
  });

  it('a bulk online completion previews +10 per task and the server answers (in either order) end at exactly +10 per task', async () => {
    const a = makeTask({ _id: 'd'.repeat(24) });
    const b = makeTask({ _id: 'e'.repeat(24) });
    const m = await mount([a, b]);
    act(() => m.result.current.hook.toggleSelect(a._id));
    act(() => m.result.current.hook.toggleSelect(b._id));
    await act(() => m.result.current.hook.handleMarkSelectedComplete());
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 20);

    // The server answers its two awards; the second answer (higher XP) arrives, then a stale lower one must not win.
    vi.mocked(taskService.updateTask)
      .mockResolvedValueOnce({ task: { ...a, completed: true }, growth: serverGrowth(a._id, BASE_XP + 10, true) } as never)
      .mockResolvedValueOnce({ task: { ...b, completed: true }, growth: serverGrowth(b._id, BASE_XP + 20, true) } as never);
    await drain(m);
    expect(m.result.current.growth.treeState?.xp).toBe(BASE_XP + 20);
  });
});

function treeServerXp(xp: number) {
  vi.mocked(treeService.getTree).mockResolvedValue(treeJson(xp));
}
