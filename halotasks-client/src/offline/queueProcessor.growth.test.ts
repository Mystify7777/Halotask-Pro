import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { useAuthStore } from '../store/authStore';
import type { SyncQueueRecord } from './syncQueue';

// Issue #24 — a replayed completion earns its XP on the SERVER. The queue processor hands the server's
// `growth` answer to the caller (onGrowth) so the tree shown is the server's, including the offline
// create-then-complete case, where the completion is folded into the create request.

const db = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('./db', () => ({
  offlineDb: {
    get: async (key: string) => (db.store.has(key) ? structuredClone(db.store.get(key)) : null),
    set: async (key: string, value: unknown) => {
      db.store.set(key, structuredClone(value));
    },
    remove: async (key: string) => {
      db.store.delete(key);
    },
  },
}));

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn() },
}));

import { taskService } from '../services/taskService';
import { processSyncQueue } from './queueProcessor';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const growth = (taskId: string, xp: number, awarded = true): GrowthResult => ({
  taskId,
  awarded,
  xpGained: awarded ? 10 : 0,
  treeState: { xp, leaves: 0, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy', stage: 'seed', lastCalculatedAt: '2026-10-06T00:00:00.000Z' },
});

const seed = (entries: SyncQueueRecord[]) => db.store.set(`sync_queue:${USER.id}`, structuredClone(entries));
const callbacks = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn(), onGrowth: vi.fn() });

beforeEach(() => {
  db.store.clear();
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  useAuthStore.setState({ token: 'token-user-a', user: USER });
});

describe('processSyncQueue surfaces the server growth', () => {
  it('offline create-then-complete: the create request carries completed:true, and its growth reaches onGrowth once', async () => {
    seed([{ id: 'e1', type: 'create', taskId: 'local-1-abc', payload: { title: 'done offline', priority: 'medium', completed: true }, createdAt: 1 }]);
    vi.mocked(taskService.createTask).mockResolvedValue({ task: { _id: 'srv1' } as Task, growth: growth('srv1', 10) });
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toMatchObject({ completed: true });
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1-abc', { _id: 'srv1' });
    expect(cb.onGrowth).toHaveBeenCalledTimes(1);
    expect(cb.onGrowth).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'srv1', treeState: expect.objectContaining({ xp: 10 }) }));
  });

  it('a replayed completion of an existing task passes its growth through (awarded or refused)', async () => {
    seed([
      { id: 'e1', type: 'update', taskId: 'a'.repeat(24), payload: { completed: true }, createdAt: 1 },
      { id: 'e2', type: 'update', taskId: 'b'.repeat(24), payload: { completed: true }, createdAt: 2 },
    ]);
    vi.mocked(taskService.updateTask)
      .mockResolvedValueOnce({ task: { _id: 'a'.repeat(24) } as Task, growth: growth('a'.repeat(24), 30) })
      .mockResolvedValueOnce({ task: { _id: 'b'.repeat(24) } as Task, growth: growth('b'.repeat(24), 30, false) });
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(cb.onGrowth).toHaveBeenCalledTimes(2);
    expect(cb.onGrowth.mock.calls[1][0]).toMatchObject({ awarded: false, xpGained: 0 });
  });

  it('responses without growth (plain edits) never call onGrowth, and onGrowth is optional', async () => {
    seed([{ id: 'e1', type: 'update', taskId: 'a'.repeat(24), payload: { title: 'x' }, createdAt: 1 }]);
    vi.mocked(taskService.updateTask).mockResolvedValue({ task: { _id: 'a'.repeat(24) } as Task });
    const cb = callbacks();

    await processSyncQueue(cb);
    expect(cb.onGrowth).not.toHaveBeenCalled();

    seed([{ id: 'e2', type: 'update', taskId: 'a'.repeat(24), payload: { completed: true }, createdAt: 1 }]);
    vi.mocked(taskService.updateTask).mockResolvedValue({ task: { _id: 'a'.repeat(24) } as Task, growth: growth('a'.repeat(24), 10) });
    const { onGrowth: _omit, ...withoutGrowth } = callbacks();
    void _omit;
    await expect(processSyncQueue(withoutGrowth)).resolves.toMatchObject({ processed: 1 });
  });

  it('does not hand growth to a different account that signed in while the request was in flight', async () => {
    seed([{ id: 'e1', type: 'update', taskId: 'a'.repeat(24), payload: { completed: true }, createdAt: 1 }]);
    vi.mocked(taskService.updateTask).mockImplementation(async () => {
      useAuthStore.setState({ token: 'token-user-b', user: { id: 'user-b', name: 'Bob', email: 'b@example.com' } });
      return { task: { _id: 'a'.repeat(24) } as Task, growth: growth('a'.repeat(24), 10) };
    });
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(cb.onGrowth).not.toHaveBeenCalled();
    expect(cb.onTaskUpdated).not.toHaveBeenCalled();
  });
});
