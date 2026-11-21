import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';
import { resetSyncQueueState, type SyncQueueRecord } from './syncQueue';

// Issue #58: the processor says WHY it stopped with work left, and keeps that apart from a refusal.
//   unreachable = the server may not have received it; auth = the session is not accepted; a 4xx refusal is `rejected`, not blocked.

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
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), syncBatch: vi.fn(async () => { throw Object.assign(new Error('no batch route'), { response: { status: 404 } }); }) },
}));

import { SessionChangedError } from '../services/api';
import { taskService } from '../services/taskService';
import { processSyncQueue } from './queueProcessor';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const KEY = `sync_queue:${USER.id}`;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const ok = (id: string) => ({ task: { _id: id } as Task });
const seed = (entries: SyncQueueRecord[]) => db.store.set(KEY, structuredClone(entries));
const upd = (id: string, taskId: string): SyncQueueRecord => ({ id, type: 'update', taskId, payload: { title: id }, createdAt: 1 });
const cb = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 't', user: USER });
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ProcessSyncQueueResult.blocked', () => {
  it('everything sent: blocked is null', async () => {
    seed([upd('q1', 's1')]);
    vi.mocked(taskService.updateTask).mockResolvedValue(ok('s1'));
    expect(await processSyncQueue(cb())).toMatchObject({ remaining: 0, blocked: null, rejected: [] });
  });

  it('nothing queued: blocked is null', async () => {
    expect(await processSyncQueue(cb())).toMatchObject({ remaining: 0, blocked: null });
  });

  it.each([
    ['a network failure (no response)', () => new Error('Network Error')],
    ['a 503', () => httpError(503)],
    ['a 500', () => httpError(500)],
    ['a timeout (408)', () => httpError(408)],
    ['rate limiting (429)', () => httpError(429)],
  ])('%s: unreachable, the entry is kept', async (_name, make) => {
    seed([upd('q1', 's1')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(make());
    const result = await processSyncQueue(cb());
    expect(result).toMatchObject({ remaining: 1, blocked: 'unreachable', rejected: [] });
  });

  it('a 401: auth, the run stops and everything is kept', async () => {
    seed([upd('q1', 's1'), upd('q2', 's2')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(401));
    const result = await processSyncQueue(cb());
    expect(result).toMatchObject({ remaining: 2, blocked: 'auth', rejected: [] });
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
  });

  it('the session changed mid-run: auth', async () => {
    seed([upd('q1', 's1')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(new SessionChangedError());
    expect(await processSyncQueue(cb())).toMatchObject({ remaining: 1, blocked: 'auth' });
  });

  it('a refusal (400) is REJECTED, not blocked: the server received it', async () => {
    seed([upd('q1', 's1')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(400));
    expect(await processSyncQueue(cb())).toMatchObject({
      remaining: 0,
      blocked: null,
      rejected: [{ type: 'update', taskId: 's1', status: 400 }],
    });
  });

  it('mixed: one sent, one refused, one unreachable -> both facts reported, apart', async () => {
    seed([upd('q1', 's1'), upd('q2', 's2'), upd('q3', 's3')]);
    vi.mocked(taskService.updateTask)
      .mockResolvedValueOnce(ok('s1'))
      .mockRejectedValueOnce(httpError(422))
      .mockRejectedValueOnce(httpError(502));
    const result = await processSyncQueue(cb());
    expect(result).toMatchObject({ processed: 2, remaining: 1, blocked: 'unreachable' });
    expect(result.rejected).toHaveLength(1);
  });

  it('a transient failure followed by a 401 ends as auth (the reason the run stopped)', async () => {
    seed([upd('q1', 's1'), upd('q2', 's2')]);
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(httpError(401));
    expect(await processSyncQueue(cb())).toMatchObject({ remaining: 2, blocked: 'auth' });
  });

  it('entries that only wait behind an unsynced create are not "blocked" by themselves', async () => {
    seed([
      { id: 'c1', type: 'create', taskId: 'local-1', payload: { title: 'x' }, createdAt: 1 },
      upd('q2', 'local-1'),
    ]);
    vi.mocked(taskService.createTask).mockRejectedValue(httpError(503));
    const result = await processSyncQueue(cb());
    expect(result).toMatchObject({ remaining: 2, blocked: 'unreachable' }); // the create's failure is the reason
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });
});
