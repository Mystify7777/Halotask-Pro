import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';

// Only one sync run per account at a time: overlapping runs would read the same queue and send the same create twice.
// Real queue and processor; IndexedDB is a Map and the HTTP service is mocked. A real second browser tab is not exercised:
// the Web Locks path is checked against a stand-in lock manager.

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
import { enqueueSyncAction, getSyncQueue, resetSyncQueueState } from './syncQueue';

const A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };
const cbs = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });
const ok = (id: string) => ({ task: { _id: id } as Task });

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 'token-a', user: A });
  vi.mocked(taskService.createTask).mockReset().mockResolvedValue(ok('srv-1'));
  vi.mocked(taskService.updateTask).mockReset().mockImplementation(async (id: string) => ok(id));
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('overlapping sync runs for one account', () => {
  it('send a queued create once, however many runs start together', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip' } });
    // the first create is slow, so the others start while it is in flight
    vi.mocked(taskService.createTask).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok('srv-1')), 30)));

    const results = await Promise.all([processSyncQueue(cbs()), processSyncQueue(cbs()), processSyncQueue(cbs())]);

    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.processed).sort()).toEqual([0, 0, 1]);
    expect(await getSyncQueue(A.id)).toEqual([]);
  });

  it('send a queued update once', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    vi.mocked(taskService.updateTask).mockImplementation((id: string) => new Promise((resolve) => setTimeout(() => resolve(ok(id)), 30)));

    await Promise.all([processSyncQueue(cbs()), processSyncQueue(cbs())]);

    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
  });

  it('a later run still sees what the earlier one left (a failed entry is retried, in order)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(new Error('offline')); // network failure: entry stays queued

    const [first, second] = await Promise.all([processSyncQueue(cbs()), processSyncQueue(cbs())]);

    expect(first).toEqual({ processed: 0, failed: 1, remaining: 1 });
    expect(second).toEqual({ processed: 1, failed: 0, remaining: 0 }); // the retry succeeded
    expect(taskService.updateTask).toHaveBeenCalledTimes(2);
  });

  it('a run that ends does not block the next one', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    await processSyncQueue(cbs());
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'two' } });
    await processSyncQueue(cbs());
    expect(vi.mocked(taskService.updateTask).mock.calls.map(([id]) => id)).toEqual(['srv-1', 'srv-2']);
  });

  it('with nobody signed in a run does nothing and does not wait', async () => {
    useAuthStore.setState({ token: null, user: null });
    expect(await processSyncQueue(cbs())).toEqual({ processed: 0, failed: 0, remaining: 0 });
  });

  it('different accounts are not serialized against each other', async () => {
    let releaseA!: () => void;
    await enqueueSyncAction({ type: 'update', taskId: 'srv-a', payload: { title: 'a' } });
    vi.mocked(taskService.updateTask).mockImplementationOnce((id: string) => new Promise((resolve) => { releaseA = () => resolve(ok(id)); }));
    const runA = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalledTimes(1));

    useAuthStore.setState({ token: 'token-b', user: B });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-b', payload: { title: 'b' } });
    const resultB = await processSyncQueue(cbs()); // finishes while A's request is still held

    expect(resultB.processed).toBe(1);
    expect(taskService.updateTask).toHaveBeenCalledTimes(2);
    releaseA();
    await runA;
  });
});

describe('across browser tabs (Web Locks)', () => {
  it('a run goes through a lock named after the account when the browser has Web Locks', async () => {
    const request = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });

    await processSyncQueue(cbs());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('halotasks-sync:user-a');
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
  });

  it('without Web Locks it still runs', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    await processSyncQueue(cbs());
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
  });
});
