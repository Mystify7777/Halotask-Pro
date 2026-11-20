import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';
import { resetSyncQueueState, type SyncQueueRecord } from './syncQueue';

// Issue #57: once every mutation is committed locally first and sent afterwards, the server's answer can arrive after the
// user has already gone further, and the server can refuse a change that was already shown. These tests pin both:
// a stale answer is not adopted over newer local work, and a refused entry is reported (not silently dropped).

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
import { enqueueSyncAction } from './syncQueue';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const KEY = `sync_queue:${USER.id}`;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const serverTask = (id: string, extra: Partial<Task> = {}) => ({ task: { _id: id, ...extra } as Task });
const seed = (entries: SyncQueueRecord[]) => db.store.set(KEY, structuredClone(entries));
const queue = () => (db.store.get(KEY) ?? []) as SyncQueueRecord[];
const entry = (id: string, type: SyncQueueRecord['type'], taskId: string, payload?: Record<string, unknown>): SyncQueueRecord => ({
  id,
  type,
  taskId,
  payload,
  createdAt: 1,
});
const callbacks = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 't', user: USER });
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('stale answers', () => {
  it('an update answered while the user edited the same task again is not adopted; the next run delivers the later edit', async () => {
    seed([entry('q1', 'update', 's1', { title: 'first' })]);
    vi.mocked(taskService.updateTask).mockImplementationOnce(async () => {
      // The user edits again WHILE this request is out: merged into the in-flight entry.
      await enqueueSyncAction({ type: 'update', taskId: 's1', payload: { priority: 'high' } });
      return serverTask('s1', { title: 'first' });
    });
    const cb = callbacks();
    const result = await processSyncQueue(cb);

    expect(cb.onTaskUpdated).not.toHaveBeenCalled(); // the local copy is ahead of this answer
    expect(result.remaining).toBe(1); // only what changed since is left, as an update to the same task
    expect(queue()[0]).toMatchObject({ type: 'update', taskId: 's1', payload: { priority: 'high' } });
  });

  it('a new entry for the same task queued while a request was out also makes the answer stale', async () => {
    seed([entry('q1', 'update', 's1', { title: 'first' })]);
    vi.mocked(taskService.updateTask).mockImplementationOnce(async () => {
      await enqueueSyncAction({ type: 'delete', taskId: 's1' });
      return serverTask('s1');
    });
    const cb = callbacks();
    await processSyncQueue(cb);
    expect(cb.onTaskUpdated).not.toHaveBeenCalled();
  });

  it('an answer for a task nothing changed meanwhile is adopted as before', async () => {
    seed([entry('q1', 'update', 's1', { title: 'first' })]);
    vi.mocked(taskService.updateTask).mockResolvedValueOnce(serverTask('s1', { title: 'first' }));
    const cb = callbacks();
    await processSyncQueue(cb);
    expect(cb.onTaskUpdated).toHaveBeenCalledWith('s1', expect.objectContaining({ _id: 's1' }), { stale: false });
  });

  it('work queued for ANOTHER task meanwhile does not make an answer stale', async () => {
    seed([entry('q1', 'update', 's1', { title: 'first' })]);
    vi.mocked(taskService.updateTask).mockImplementationOnce(async () => {
      await enqueueSyncAction({ type: 'update', taskId: 's2', payload: { title: 'other' } });
      return serverTask('s1');
    });
    const cb = callbacks();
    await processSyncQueue(cb);
    expect(cb.onTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it('a create answered after the user edited the new task is flagged stale: only its identity may be adopted', async () => {
    seed([entry('q1', 'create', 'local-1', { title: 'new' })]);
    vi.mocked(taskService.createTask).mockImplementationOnce(async () => {
      await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { priority: 'high' } });
      return serverTask('srv-1', { title: 'new' });
    });
    const cb = callbacks();
    await processSyncQueue(cb);
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 'srv-1' }), { stale: true });
  });
});

describe('server rejection reporting', () => {
  it('reports a permanently refused entry with its type, task, title and HTTP status, and removes it', async () => {
    seed([entry('q1', 'update', 's1', { title: 'Bad title' }), entry('q2', 'delete', 's2')]);
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(400));
    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(undefined as never);
    const result = await processSyncQueue(callbacks());

    expect(result.rejected).toEqual([{ type: 'update', taskId: 's1', title: 'Bad title', status: 400 }]);
    expect(result.remaining).toBe(0);
    expect(queue()).toEqual([]);
  });

  it('does not report a transient failure or a 401: those entries are kept, not rejected', async () => {
    seed([entry('q1', 'update', 's1', { title: 'A' }), entry('q2', 'update', 's2', { title: 'B' })]);
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(httpError(401));
    const result = await processSyncQueue(callbacks());
    expect(result.rejected).toEqual([]);
    expect(result.remaining).toBe(2);
  });

  it('a run with nothing refused reports an empty list', async () => {
    seed([entry('q1', 'delete', 's1')]);
    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(undefined as never);
    expect((await processSyncQueue(callbacks())).rejected).toEqual([]);
  });
});
