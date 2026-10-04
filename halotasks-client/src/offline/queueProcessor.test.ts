import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';
import { resetSyncQueueState, type SyncQueueRecord } from './syncQueue';

// Session invalidation (Issue #27) turns a 401 into something that routinely happens to a device that
// was offline: a password reset elsewhere revokes its token and the first request on reconnect is
// refused. A 401 says the CREDENTIAL is not accepted, not that the queued action is bad, so the queue
// must survive it. But a surviving queue is only safe if it stays attached to the account that made it:
// requests carry whatever token is current, so another account signing in on the same browser must
// never cause these entries to be sent under its credentials.
//
// The real queue storage (per-account keys) and the real auth store run here; only IndexedDB and the
// HTTP service are replaced, so the isolation under test is the production isolation.

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
  taskService: {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
  },
}));

import { taskService } from '../services/taskService';
import { processSyncQueue } from './queueProcessor';

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };

const signIn = (user: typeof USER_A) => useAuthStore.setState({ token: `token-${user.id}`, user });
// What the 401 response interceptor does (authStore.clearAuth), without its IndexedDB side effects.
const signOut = () => useAuthStore.setState({ token: null, user: null });

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const serverTask = (id: string) => ({ task: { _id: id } as Task });

const entry = (id: string, type: SyncQueueRecord['type'], taskId?: string): SyncQueueRecord => ({
  id,
  type,
  taskId,
  payload: type === 'delete' ? undefined : { title: `title-${id}` },
  createdAt: 1,
});

const keyOf = (userId: string) => `sync_queue:${userId}`;
const seed = (userId: string, entries: SyncQueueRecord[]) => db.store.set(keyOf(userId), structuredClone(entries));
const stored = (userId: string) => (db.store.get(keyOf(userId)) ?? []) as SyncQueueRecord[];
const idsOf = (userId: string) => stored(userId).map((e) => e.id);

const callbacks = () => ({
  onTaskCreated: vi.fn(),
  onTaskUpdated: vi.fn(),
  onTaskDeleted: vi.fn(),
});

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  signIn(USER_A);
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a 401 keeps the account’s queue', () => {
  it('stops at the first 401 and keeps every entry, in order, untouched', async () => {
    seed(USER_A.id, [entry('a', 'update', 'srv-1'), entry('b', 'update', 'srv-2'), entry('c', 'delete', 'srv-3')]);
    const original = structuredClone(stored(USER_A.id));
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(401));

    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 0, failed: 3, remaining: 3 });
    expect(stored(USER_A.id)).toEqual(original);
    // Stopped: nothing after the first refused request was attempted.
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
    expect(taskService.deleteTask).not.toHaveBeenCalled();
  });

  it('keeps the refused entry and everything after it, but not what already synced', async () => {
    seed(USER_A.id, [
      entry('a', 'update', 'srv-1'),
      entry('b', 'update', 'srv-2'),
      entry('c', 'update', 'srv-3'),
      entry('d', 'delete', 'srv-4'),
    ]);
    vi.mocked(taskService.updateTask)
      .mockResolvedValueOnce(serverTask('srv-1'))
      .mockResolvedValueOnce(serverTask('srv-2'))
      .mockRejectedValueOnce(httpError(401));
    const cb = callbacks();

    const result = await processSyncQueue(cb);

    expect(result).toEqual({ processed: 2, failed: 2, remaining: 2 });
    expect(idsOf(USER_A.id)).toEqual(['c', 'd']);
    expect(cb.onTaskUpdated).toHaveBeenCalledTimes(2);
    expect(taskService.deleteTask).not.toHaveBeenCalled();
  });

  it('keeps an earlier entry that was deferred, ahead of the refused ones', async () => {
    // 'a' waits on a task that only exists locally; 'b' is refused with 401; 'c' is never reached.
    seed(USER_A.id, [entry('a', 'update', 'local-9'), entry('b', 'update', 'srv-2'), entry('c', 'update', 'srv-3')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(401));

    await processSyncQueue(callbacks());

    expect(idsOf(USER_A.id)).toEqual(['a', 'b', 'c']);
  });

  it('a create refused with 401 is kept, so the task is not lost', async () => {
    seed(USER_A.id, [entry('a', 'create', 'local-1')]);
    vi.mocked(taskService.createTask).mockRejectedValue(httpError(401));

    await processSyncQueue(callbacks());

    expect(stored(USER_A.id)).toEqual([entry('a', 'create', 'local-1')]);
  });

  it('writes the remainder back to the OWNER even though the interceptor has already signed everyone out', async () => {
    seed(USER_A.id, [entry('a', 'update', 'srv-1'), entry('b', 'update', 'srv-2')]);
    vi.mocked(taskService.updateTask).mockImplementation(async () => {
      signOut(); // the 401 interceptor runs before the processor sees the rejection
      throw httpError(401);
    });

    const result = await processSyncQueue(callbacks());

    expect(result.remaining).toBe(2);
    expect(idsOf(USER_A.id)).toEqual(['a', 'b']);
    // Nothing was written under any other key (e.g. one derived from "nobody").
    expect([...db.store.keys()]).toEqual([keyOf(USER_A.id)]);
  });
});

describe('the queue stays with the account that made it', () => {
  const aGetsRefused = async () => {
    seed(USER_A.id, [entry('a1', 'create', 'local-1'), entry('a2', 'update', 'srv-2')]);
    vi.mocked(taskService.createTask).mockImplementation(async () => {
      signOut();
      throw httpError(401);
    });
    await processSyncQueue(callbacks());
    vi.mocked(taskService.createTask).mockReset();
  };

  it('B signing in after A was refused does NOT send A’s entries, and does not alter them', async () => {
    await aGetsRefused();
    const before = structuredClone(stored(USER_A.id));

    signIn(USER_B);
    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(taskService.deleteTask).not.toHaveBeenCalled();
    expect(stored(USER_A.id)).toEqual(before);
  });

  it('B’s own queue still processes while A’s entries are waiting', async () => {
    await aGetsRefused();
    seed(USER_B.id, [entry('b1', 'update', 'srv-9')]);
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-9'));

    signIn(USER_B);
    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
    // ...with B's own session bound to the request (account + token), not whatever is current later.
    expect(taskService.updateTask).toHaveBeenCalledWith(
      'srv-9',
      { title: 'title-b1' },
      { session: { userId: USER_B.id, token: `token-${USER_B.id}` } },
    );
    expect(stored(USER_B.id)).toEqual([]);
    expect(idsOf(USER_A.id)).toEqual(['a1', 'a2']); // untouched
  });

  it('when A signs back in, A’s preserved entries sync completely and empty the queue', async () => {
    await aGetsRefused();
    signIn(USER_B);
    await processSyncQueue(callbacks()); // B visits in between; sends nothing of A's

    signIn(USER_A);
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1'));
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-2'));
    const cb = callbacks();
    const result = await processSyncQueue(cb);

    expect(result).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(stored(USER_A.id)).toEqual([]);
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', { _id: 'srv-1' });
  });

  it('with both accounts holding entries, each run sends only the signed-in account’s own', async () => {
    seed(USER_A.id, [entry('a1', 'update', 'srv-a')]);
    seed(USER_B.id, [entry('b1', 'update', 'srv-b')]);
    vi.mocked(taskService.updateTask).mockImplementation(async (id: string) => serverTask(id));

    signIn(USER_A);
    await processSyncQueue(callbacks());
    expect(vi.mocked(taskService.updateTask).mock.calls.map((c) => c[0])).toEqual(['srv-a']);
    expect(stored(USER_A.id)).toEqual([]);
    expect(idsOf(USER_B.id)).toEqual(['b1']); // B's waits

    signIn(USER_B);
    await processSyncQueue(callbacks());
    expect(vi.mocked(taskService.updateTask).mock.calls.map((c) => c[0])).toEqual(['srv-a', 'srv-b']);
    expect(stored(USER_B.id)).toEqual([]);
  });

  it('stops without sending anything more if the account changes in the middle of a run', async () => {
    seed(USER_A.id, [entry('a1', 'update', 'srv-1'), entry('a2', 'update', 'srv-2'), entry('a3', 'update', 'srv-3')]);
    seed(USER_B.id, [entry('b1', 'update', 'srv-b')]);
    vi.mocked(taskService.updateTask).mockImplementationOnce(async () => {
      signIn(USER_B); // A signs out and B signs in while the first request is in flight
      return serverTask('srv-1');
    });

    const cb = callbacks();
    const result = await processSyncQueue(cb);

    expect(taskService.updateTask).toHaveBeenCalledTimes(1); // a2 and a3 were NOT sent under B's token
    expect(cb.onTaskUpdated).not.toHaveBeenCalled(); // and A's result is not fed into B's screen
    expect(result).toEqual({ processed: 1, failed: 2, remaining: 2 });
    expect(idsOf(USER_A.id)).toEqual(['a2', 'a3']); // kept for A
    expect(idsOf(USER_B.id)).toEqual(['b1']); // B's queue untouched
  });

  it('does nothing and reads nothing when nobody is signed in', async () => {
    seed(USER_A.id, [entry('a1', 'update', 'srv-1')]);
    signOut();

    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(idsOf(USER_A.id)).toEqual(['a1']);
  });
});

describe('other failures (unchanged behaviour)', () => {
  it.each([400, 403, 404, 422])('still discards the entry on a permanent %i and carries on', async (status) => {
    seed(USER_A.id, [entry('a', 'update', 'srv-1'), entry('b', 'update', 'srv-2')]);
    vi.mocked(taskService.updateTask)
      .mockRejectedValueOnce(httpError(status))
      .mockResolvedValueOnce(serverTask('srv-2'));

    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(stored(USER_A.id)).toEqual([]);
    expect(taskService.updateTask).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 500, 503])('keeps the entry on a transient %i and carries on with the rest', async (status) => {
    seed(USER_A.id, [entry('a', 'update', 'srv-1'), entry('b', 'update', 'srv-2')]);
    vi.mocked(taskService.updateTask)
      .mockRejectedValueOnce(httpError(status))
      .mockResolvedValueOnce(serverTask('srv-2'));

    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 1, failed: 1, remaining: 1 });
    expect(idsOf(USER_A.id)).toEqual(['a']);
    expect(taskService.updateTask).toHaveBeenCalledTimes(2);
  });

  it('keeps the entry when there is no response at all (offline)', async () => {
    seed(USER_A.id, [entry('a', 'update', 'srv-1')]);
    vi.mocked(taskService.updateTask).mockRejectedValue(new Error('Network Error'));

    const result = await processSyncQueue(callbacks());

    expect(result.remaining).toBe(1);
    expect(idsOf(USER_A.id)).toEqual(['a']);
  });
});
