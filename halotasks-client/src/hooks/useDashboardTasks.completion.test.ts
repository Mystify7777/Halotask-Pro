import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';

// Issue #47, Phase 2E: what the dashboard writers send and queue when a task is completed or re-opened. The HTTP service, the
// queue and the cache are doubles: this proves what the hook builds, that ONE event is made per transition, and that it is
// the same event whether it goes out now or waits in the queue. The delivery itself is proven in completionPipeline.test.ts.

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn() },
}));
vi.mock('../offline/syncQueue', () => ({ enqueueSyncAction: vi.fn(async () => []) }));
vi.mock('../offline/cache', () => ({ setCachedTasks: vi.fn(async () => undefined) }));
vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

import { enqueueSyncAction } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import { useDashboardTasks } from './useDashboardTasks';

const growth = vi.fn();
const preview = vi.fn();

const mount = (initial: Task[], isOnline: boolean) =>
  renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline,
      syncBridgeRef: { current: { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0) } },
      previewGrowthForCompletion: preview,
      applyServerGrowth: growth,
      setStatusError: vi.fn(),
      setStatusInfo: vi.fn(),
    });
    return { hook, tasks };
  });

const queued = () => vi.mocked(enqueueSyncAction).mock.calls.map((c) => c[0]);
const sentUpdates = () => vi.mocked(taskService.updateTask).mock.calls;

beforeEach(() => {
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(enqueueSyncAction).mockReset().mockResolvedValue([]);
  growth.mockClear();
  preview.mockClear();
  vi.mocked(taskService.updateTask).mockImplementation(async (id, payload) => ({
    task: makeTask({ _id: id, completed: payload.completed === true, completionId: payload.completed ? (payload.completionEvent as { completionId: string }).completionId : 'c-old' }),
  }));
});

describe('completing from the dashboard checkbox', () => {
  it('online: ONE task write carries the completion event, and nothing is queued', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = mount([task], true);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(sentUpdates()).toHaveLength(1);
    expect(sentUpdates()[0][1]).toEqual({
      completed: true,
      completionEvent: { completionId: expect.any(String), completedAt: expect.any(String), utcOffsetMinutes: expect.any(Number) },
    });
    expect(queued()).toEqual([]);
    expect(m.result.current.tasks[0]).toMatchObject({ completed: true, completionId: (sentUpdates()[0][1].completionEvent as { completionId: string }).completionId });
  });

  it('offline: ONE completion entry is queued, no request is sent, and the local task shows it completed and pending', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = mount([task], false);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(sentUpdates()).toEqual([]);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ type: 'completion', taskId: 'srv-1', payload: { kind: 'complete', completionId: expect.any(String), completedAt: expect.any(String), utcOffsetMinutes: expect.any(Number) } });
    expect(m.result.current.tasks[0]).toMatchObject({ completed: true, pendingSync: true, completionId: (queued()[0].payload as { completionId: string }).completionId });
    expect(preview).toHaveBeenCalledWith('srv-1');
  });

  it('a task that has not reached the server yet is queued even while online', async () => {
    const task = makeTask({ _id: 'local-9', completed: false });
    const m = mount([task], true);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(sentUpdates()).toEqual([]);
    expect(queued()[0]).toMatchObject({ type: 'completion', taskId: 'local-9' });
  });

  it('re-opening names the completion the task holds, online and offline', async () => {
    const task = makeTask({ _id: 'srv-1', completed: true, completionId: 'c-held' });

    const online = mount([task], true);
    await act(() => online.result.current.hook.handleToggleTask(task));
    expect(sentUpdates()[0][1]).toEqual({ completed: false, completionEvent: { completionId: 'c-held', revokedAt: expect.any(String) } });

    const offline = mount([task], false);
    await act(() => offline.result.current.hook.handleToggleTask(task));
    expect(queued()[0]).toMatchObject({ type: 'completion', payload: { kind: 'revoke', completionId: 'c-held' } });
    expect(preview).not.toHaveBeenCalled(); // no Growth for a re-open
  });

  it('is built from the LATEST task, not the stale object a render captured: a double tap offline is a completion then a revocation of that same completion', async () => {
    const stale = makeTask({ _id: 'srv-1', completed: false });
    const m = mount([stale], false);

    await act(async () => {
      await m.result.current.hook.handleToggleTask(stale);
      await m.result.current.hook.handleToggleTask(stale); // the same stale object again
    });

    const [first, second] = queued().map((q) => q.payload as { kind: string; completionId?: string });
    expect(first.kind).toBe('complete');
    expect(second).toMatchObject({ kind: 'revoke', completionId: first.completionId });
  });

  it('a storage failure while queueing leaves the task as it was (no optimistic flip without an event behind it)', async () => {
    vi.mocked(enqueueSyncAction).mockRejectedValue(new Error('quota'));
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = mount([task], false);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(m.result.current.tasks[0].completed).toBe(false);
  });
});

describe('bulk "mark complete"', () => {
  const select = async (m: ReturnType<typeof mount>, ids: string[]) => {
    for (const id of ids) act(() => m.result.current.hook.toggleSelect(id));
  };

  it('online: one write and one distinct event per task', async () => {
    const tasks = [makeTask({ _id: 'srv-1' }), makeTask({ _id: 'srv-2' })];
    const m = mount(tasks, true);
    await select(m, ['srv-1', 'srv-2']);

    await act(() => m.result.current.hook.handleMarkSelectedComplete());

    expect(sentUpdates().map((c) => c[0]).sort()).toEqual(['srv-1', 'srv-2']);
    const ids = sentUpdates().map((c) => (c[1].completionEvent as { completionId: string }).completionId);
    expect(new Set(ids).size).toBe(2);
  });

  it('offline: one completion entry per task', async () => {
    const tasks = [makeTask({ _id: 'srv-1' }), makeTask({ _id: 'srv-2' })];
    const m = mount(tasks, false);
    await select(m, ['srv-1', 'srv-2']);

    await act(() => m.result.current.hook.handleMarkSelectedComplete());

    expect(queued().map((q) => [q.type, q.taskId])).toEqual([['completion', 'srv-1'], ['completion', 'srv-2']]);
    expect(m.result.current.tasks.every((t) => t.completed && t.pendingSync)).toBe(true);
  });
});
