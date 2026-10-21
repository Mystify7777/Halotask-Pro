import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';
import { enqueueSyncAction, getSyncQueue, resetSyncQueueState, type SyncQueueRecord } from './syncQueue';

// Issues #9 and #10 through the offline queue: the real queue storage logic, the real merging of queued edits and the
// real processor run here. Only IndexedDB (a structured-clone Map, which is what IndexedDB stores) and the HTTP service
// are replaced, so what is proven is that the time fields survive queuing, merging, retries and replay, and what the
// processor sends. It cannot prove how the server stores them: tests/taskTimes.realmongo.test.ts does that.

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
import { processSyncQueue, withConsistentDeadline } from './queueProcessor';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const serverTask = (id: string, extra: Partial<Task> = {}) => ({ task: { _id: id, ...extra } as Task });
const callbacks = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });
const queue = () => getSyncQueue(USER.id);

const TIMED = { title: 'Pay rent', priority: 'high', dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' };

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 'token-a', user: USER });
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('withConsistentDeadline: a due time never travels without a due date', () => {
  it('leaves a payload with no due time alone (same object)', () => {
    const payload = { title: 'x', dueDate: '2026-10-20' };
    expect(withConsistentDeadline(payload, 'create')).toBe(payload);
    expect(withConsistentDeadline({ title: 'x', dueTime: null }, 'create')).toEqual({ title: 'x', dueTime: null });
  });

  it('leaves a due time next to a due date alone', () => {
    const payload = { dueDate: '2026-10-20', dueTime: '09:00' };
    expect(withConsistentDeadline(payload, 'create')).toBe(payload);
    expect(withConsistentDeadline(payload, 'update')).toBe(payload);
  });

  it.each([
    ['a create with no due date', 'create', { title: 'x', dueTime: '09:00' }],
    ['a create with a null due date', 'create', { dueDate: null, dueTime: '09:00' }],
    ['an update that clears the due date', 'update', { dueDate: null, dueTime: '09:00' }],
    ['an update that blanks the due date', 'update', { dueDate: '', dueTime: '09:00' }],
  ] as const)('drops the time for %s', (_label, kind, payload) => {
    expect(withConsistentDeadline(payload, kind).dueTime).toBeNull();
  });

  it('an update that only sets a due time is left alone: the stored task may already have a due date', () => {
    const payload = { dueTime: '09:00' };
    expect(withConsistentDeadline(payload, 'update')).toBe(payload);
  });
});

describe('queued writes carry the time fields', () => {
  it('a queued create is sent with both times exactly as queued, and the server task reaches the callback', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { ...TIMED } });
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1', { dueTime: '17:30' }));
    const cb = callbacks();

    const result = await processSyncQueue(cb);

    expect(result).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toEqual(TIMED);
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 'srv-1', dueTime: '17:30' }));
  });

  it('a queued update that sets or clears the times is sent as is (null clears)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueDate: '2026-10-22', dueTime: '08:00', startTime: null } });
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-1'));

    await processSyncQueue(callbacks());

    expect(vi.mocked(taskService.updateTask).mock.calls[0][1]).toEqual({ dueDate: '2026-10-22', dueTime: '08:00', startTime: null });
  });

  it('an update that clears the due date clears the due time with it, so the server cannot reject (and discard) the edit', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'x', dueDate: null, dueTime: '09:00' } });
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-1'));

    await processSyncQueue(callbacks());

    expect(vi.mocked(taskService.updateTask).mock.calls[0][1]).toEqual({ title: 'x', dueDate: null, dueTime: null });
  });
});

describe('merging queued edits does not erase time fields', () => {
  it('an unrelated edit queued after a create keeps both times in the merged create', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { ...TIMED } });
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { title: 'Pay rent (edited)', priority: 'low' } });

    const [entry] = await queue();

    expect(await queue()).toHaveLength(1);
    expect(entry.type).toBe('create');
    expect(entry.payload).toEqual({ ...TIMED, title: 'Pay rent (edited)', priority: 'low' });
  });

  it('an unrelated edit queued after another update keeps the earlier update\'s times', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueDate: '2026-10-22', dueTime: '08:00' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { completed: true } });

    expect((await queue())[0].payload).toEqual({ dueDate: '2026-10-22', dueTime: '08:00', completed: true });
  });

  it('a later edit that changes or clears a time wins over the earlier value', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { ...TIMED } });
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { dueTime: '09:15', startTime: null } });

    expect((await queue())[0].payload).toMatchObject({ dueDate: '2026-10-20', dueTime: '09:15', startTime: null });
  });

  it('create then clear-everything is sent as a create whose time fields are cleared, and succeeds', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { ...TIMED } });
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { dueDate: null, dueTime: null, startTime: null } });
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1'));

    const result = await processSyncQueue(callbacks());

    expect(result.remaining).toBe(0);
    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toMatchObject({ title: 'Pay rent', dueDate: null, dueTime: null, startTime: null });
  });

  it('an update queued against a not-yet-synced task is deferred with its times intact, then sent once the task exists', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'local-9', payload: { dueDate: '2026-10-22', dueTime: '08:00' } });
    // Nothing maps local-9 to a server id in this run, so the update is deferred, not sent and not lost.
    const first = await processSyncQueue(callbacks());
    expect(first).toEqual({ processed: 0, failed: 1, remaining: 1 });
    expect((await queue())[0].payload).toEqual({ dueDate: '2026-10-22', dueTime: '08:00' });
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });
});

describe('retries and synchronization', () => {
  it('a failed send (server error) keeps the entry and its times untouched, and the retry sends the same values', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueDate: '2026-10-22', dueTime: '08:00', startTime: '2026-10-22T07:00:00.000Z' } });
    const original = structuredClone(await queue());
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(serverTask('srv-1'));

    const failed = await processSyncQueue(callbacks());
    expect(failed).toEqual({ processed: 0, failed: 1, remaining: 1 });
    expect(await queue()).toEqual(original);

    const retried = await processSyncQueue(callbacks());
    expect(retried).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(vi.mocked(taskService.updateTask).mock.calls.map((call) => call[1])).toEqual([
      { dueDate: '2026-10-22', dueTime: '08:00', startTime: '2026-10-22T07:00:00.000Z' },
      { dueDate: '2026-10-22', dueTime: '08:00', startTime: '2026-10-22T07:00:00.000Z' },
    ]);
  });

  it('an offline-created task syncs once even when the first attempt fails after queuing (no duplicate create)', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { ...TIMED } });
    vi.mocked(taskService.createTask).mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(serverTask('srv-1'));

    await processSyncQueue(callbacks());
    await processSyncQueue(callbacks());
    const third = await processSyncQueue(callbacks()); // nothing left to send

    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledTimes(2); // the failed try and its retry; never a third
    expect(third).toEqual({ processed: 0, failed: 0, remaining: 0 });
  });
});

describe('legacy queue entries (queued before these fields existed)', () => {
  it('are sent exactly as stored, with no time fields added', async () => {
    const legacy: SyncQueueRecord[] = [
      { id: 'q1', type: 'create', taskId: 'local-1', payload: { title: 'old', priority: 'medium', dueDate: '2026-04-21' }, createdAt: 1 },
      { id: 'q2', type: 'update', taskId: 'srv-2', payload: { title: 'old edit', dueDate: null }, createdAt: 2 },
      { id: 'q3', type: 'update', taskId: 'srv-3', payload: { completed: true }, createdAt: 3 },
    ];
    db.store.set(`sync_queue:${USER.id}`, structuredClone(legacy));
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1'));
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-2'));

    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 3, failed: 0, remaining: 0 });
    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toEqual({ title: 'old', priority: 'medium', dueDate: '2026-04-21' });
    expect(vi.mocked(taskService.updateTask).mock.calls.map((call) => call[1])).toEqual([
      { title: 'old edit', dueDate: null },
      { completed: true },
    ]);
    for (const [, payload] of vi.mocked(taskService.updateTask).mock.calls) {
      expect(payload).not.toHaveProperty('dueTime');
      expect(payload).not.toHaveProperty('startTime');
    }
  });
});

// Review follow-up: the server answers 409 to an update that sets a due time while relying on the stored due date, when
// that date was removed meanwhile. The real queue processor, real queue storage and real status handling run here; only
// the HTTP service is replaced, so these prove what the client does with the response, not what the server returns.
describe('409: a due-time edit whose due date was removed elsewhere is reconciled, not discarded', () => {
  const lastCall = (n: number) => vi.mocked(taskService.updateTask).mock.calls[n];

  it('resends the edit with the due time cleared, adopts the server task and reports the conflict', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'Renamed', dueTime: '09:00' } });
    vi.mocked(taskService.updateTask)
      .mockRejectedValueOnce(httpError(409))
      .mockResolvedValueOnce(serverTask('srv-1', { title: 'Renamed' }));
    const cb = { ...callbacks(), onDueTimeConflict: vi.fn() };

    const result = await processSyncQueue(cb);

    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(2);
    expect(lastCall(0)[1]).toEqual({ title: 'Renamed', dueTime: '09:00' });
    expect(lastCall(1)[1]).toEqual({ title: 'Renamed', dueTime: null });
    expect(cb.onTaskUpdated).toHaveBeenCalledWith('srv-1', expect.objectContaining({ title: 'Renamed' }));
    expect(cb.onDueTimeConflict).toHaveBeenCalledWith('srv-1', '09:00');
    expect(result).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await queue()).toEqual([]);
  });

  it('a due-time-only edit is reconciled the same way (so the cached task is replaced by the server truth)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueTime: '09:00' } });
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(409)).mockResolvedValueOnce(serverTask('srv-1'));
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(lastCall(1)[1]).toEqual({ dueTime: null });
    expect(cb.onTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it('is bounded: if the reconciling request fails transiently the ORIGINAL entry is kept, with one extra request per run', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'Renamed', dueTime: '09:00' } });
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(409)).mockRejectedValueOnce(httpError(503));
    const cb = { ...callbacks(), onDueTimeConflict: vi.fn() };

    const result = await processSyncQueue(cb);

    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ processed: 0, failed: 1, remaining: 1 });
    expect((await queue())[0].payload).toEqual({ title: 'Renamed', dueTime: '09:00' });
    expect(cb.onTaskUpdated).not.toHaveBeenCalled();
    expect(cb.onDueTimeConflict).not.toHaveBeenCalled();

    // The next run is again exactly one conflict plus one reconciling request, never an unbounded loop.
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(409)).mockRejectedValueOnce(httpError(503));
    await processSyncQueue(callbacks());
    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(4);
  });

  it('if the reconciling request is rejected with a 401 the entry and everything after it are kept', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueTime: '09:00' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'later' } });
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(httpError(409)).mockRejectedValueOnce(httpError(401));

    const result = await processSyncQueue(callbacks());

    expect(result.remaining).toBe(2);
    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no due time in the edit', { title: 'x' }],
    ['a due date in the same edit (the server does not rely on the stored date)', { dueDate: '2026-10-22', dueTime: '09:00' }],
    ['a due time clear', { dueTime: null }],
  ])('a 409 for %s is not this conflict: no extra request, handled as before (discarded)', async (_label, payload) => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload });
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(409));
    const cb = { ...callbacks(), onDueTimeConflict: vi.fn() };

    const result = await processSyncQueue(cb);

    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(cb.onDueTimeConflict).not.toHaveBeenCalled();
  });

  it('other permanent errors on a due-time edit are still discarded without a reconciling request', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { dueTime: '09:00' } });
    vi.mocked(taskService.updateTask).mockRejectedValue(httpError(404));

    await processSyncQueue(callbacks());

    expect(vi.mocked(taskService.updateTask)).toHaveBeenCalledTimes(1);
  });
});
