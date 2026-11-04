import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subtask, Task } from '../types/task';
import { useAuthStore } from '../store/authStore';

// Issue #15 (phase 4): ordering and omission through the REAL queue and processor; only IndexedDB (a structured-clone Map)
// and the HTTP service are replaced. The real browser IndexedDB is a separate check (scripts in the Chromium run).

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

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const sub = (id: string, completed = false): Subtask => ({ id, title: `step ${id}`, completed });
const queue = () => getSyncQueue(USER.id);
const cbs = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });
const ok = (id: string) => ({ task: { _id: id } as Task });
const sent = () => vi.mocked(taskService.updateTask).mock.calls.map(([id, body]) => [id, body] as const);

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 'token-a', user: USER });
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset().mockImplementation(async (id: string) => ok(id));
  vi.mocked(taskService.deleteTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('an old client (an edit that never mentions subtasks)', () => {
  it('goes out without a subtasks key, so the server keeps the stored checklist', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'renamed' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { completed: true } });

    await processSyncQueue(cbs());

    expect(sent()).toEqual([['srv-1', { title: 'renamed', completed: true }]]);
    expect(Object.keys(sent()[0][1])).not.toContain('subtasks');
  });

  it('a checklist edit and a later title edit leave as ONE request that carries both, subtasks whole', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a', true), sub('b')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'renamed' } });

    await processSyncQueue(cbs());

    expect(sent()).toEqual([['srv-1', { subtasks: [sub('a', true), sub('b')], title: 'renamed' }]]);
  });
});

describe('ordering', () => {
  it('rapid edits to one task collapse into one request holding the LAST value of every field', async () => {
    for (const title of ['a', 'ab', 'abc']) await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('x')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('x', true)] } });

    await processSyncQueue(cbs());

    expect(sent()).toEqual([['srv-1', { title: 'abc', subtasks: [sub('x', true)] }]]);
  });

  it('actions for different tasks are sent in the order each task was FIRST queued', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'two' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { completed: true } });

    await processSyncQueue(cbs());

    expect(sent().map(([id]) => id)).toEqual(['srv-1', 'srv-2']);
  });

  it('create, then its edits, then a second create: the edits ride the first create and creates stay in order', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'first', subtasks: [sub('a')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { subtasks: [sub('a', true)] } });
    await enqueueSyncAction({ type: 'create', taskId: 'local-2', payload: { title: 'second' } });
    vi.mocked(taskService.createTask).mockImplementation(async (p) => ok(`srv-${(p as { title: string }).title}`));

    await processSyncQueue(cbs());

    expect(vi.mocked(taskService.createTask).mock.calls.map(([p]) => (p as { title: string }).title)).toEqual(['first', 'second']);
    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toEqual({ title: 'first', subtasks: [sub('a', true)] });
    expect(vi.mocked(taskService.updateTask)).not.toHaveBeenCalled();
  });

  it('an update to a task whose create has not synced yet waits, and is sent to the REAL id once it has', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'first' } });
    // the create already left the queue as a merged entry in another run; here the update names the local id directly
    // after the create failed once: the entry order must survive
    vi.mocked(taskService.createTask).mockRejectedValueOnce(Object.assign(new Error('net'), { response: undefined }));
    await processSyncQueue(cbs());
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { subtasks: [sub('a')] } });
    expect((await queue()).map((q) => q.type)).toEqual(['create']); // merged into the pending create

    vi.mocked(taskService.createTask).mockResolvedValue(ok('srv-1'));
    await processSyncQueue(cbs());
    expect(vi.mocked(taskService.createTask).mock.calls[vi.mocked(taskService.createTask).mock.calls.length - 1][0]).toEqual({ title: 'first', subtasks: [sub('a')] });
    expect(await queue()).toEqual([]);
  });

  it('a failed request keeps its entry AND everything after it, still in order', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'two' } });
    vi.mocked(taskService.updateTask).mockImplementation(async (id: string) => {
      if (id === 'srv-1') throw new Error('offline'); // no response: a network failure, kept for retry
      return ok(id);
    });

    const result = await processSyncQueue(cbs());

    expect(result).toEqual({ processed: 1, failed: 1, remaining: 1 });
    expect((await queue()).map((q) => q.taskId)).toEqual(['srv-1']);
  });
});

describe('an edit made WHILE a sync is in flight', () => {
  it('is not lost when the sync finishes (a different task)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    let release!: () => void;
    vi.mocked(taskService.updateTask).mockImplementation(
      (id: string) => new Promise((resolve) => { release = () => resolve(ok(id)); }),
    );

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalled());
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { subtasks: [sub('n')] } });
    release();
    await running;

    expect((await queue()).map((q) => q.taskId)).toEqual(['srv-2']);
  });

  it('is not lost when the sync finishes (the SAME task, a checklist tick)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    let release!: () => void;
    vi.mocked(taskService.updateTask).mockImplementation(
      (id: string) => new Promise((resolve) => { release = () => resolve(ok(id)); }),
    );

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalled());
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('n', true)] } });
    release();
    await running;

    const left = await queue();
    expect(left).toHaveLength(1);
    expect(left[0].payload).toMatchObject({ subtasks: [sub('n', true)] });
  });
});

describe('what is merged into an entry while it is in flight', () => {
  // Holds the network call open so the test can edit "while syncing", then lets it finish.
  const hold = <T>(mock: ReturnType<typeof vi.fn>, value: (id?: string) => T) => {
    let release!: () => void;
    mock.mockImplementation((idOrPayload?: string) => new Promise((resolve) => { release = () => resolve(value(idOrPayload)); }));
    return () => release();
  };

  it('a checklist tick merged into an IN-FLIGHT UPDATE is sent next as only that change, once', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    const release = hold(vi.mocked(taskService.updateTask) as never, () => ok('srv-1'));

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalledTimes(1));
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('n', true)] } });
    release();
    await running;

    expect(await queue()).toEqual([expect.objectContaining({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('n', true)] } })]);

    vi.mocked(taskService.updateTask).mockReset().mockImplementation(async (id: string) => ok(id));
    await processSyncQueue(cbs());
    expect(sent()).toEqual([['srv-1', { subtasks: [sub('n', true)] }]]); // the title is not sent a second time
    expect(await queue()).toEqual([]);
  });

  it('an edit that re-sets a field to a DIFFERENT value is kept; one that sets it to the same value is not re-sent', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one', priority: 'low' } });
    const release = hold(vi.mocked(taskService.updateTask) as never, () => ok('srv-1'));

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalledTimes(1));
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one', priority: 'high' } });
    release();
    await running;

    expect((await queue())[0].payload).toEqual({ priority: 'high' });
  });

  it('an edit merged into an IN-FLIGHT CREATE becomes an update to the new server id', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip', subtasks: [sub('a')] } });
    const release = hold(vi.mocked(taskService.createTask) as never, () => ok('srv-9'));

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.createTask).toHaveBeenCalledTimes(1));
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { subtasks: [sub('a', true)] } });
    release();
    await running;

    expect(await queue()).toEqual([expect.objectContaining({ type: 'update', taskId: 'srv-9', payload: { subtasks: [sub('a', true)] } })]);

    await processSyncQueue(cbs());
    expect(sent()).toEqual([['srv-9', { subtasks: [sub('a', true)] }]]);
  });

  it('a task DELETED while its create is in flight does not stay behind on the server: a delete is queued for it', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip' } });
    const release = hold(vi.mocked(taskService.createTask) as never, () => ok('srv-9'));

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.createTask).toHaveBeenCalledTimes(1));
    await enqueueSyncAction({ type: 'delete', taskId: 'local-1' }); // removes the create entry: nothing else is queued
    release();
    await running;

    expect(await queue()).toEqual([expect.objectContaining({ type: 'delete', taskId: 'srv-9' })]);
    await processSyncQueue(cbs());
    expect(vi.mocked(taskService.deleteTask).mock.calls[0][0]).toBe('srv-9');
    expect(await queue()).toEqual([]);
  });

  it('a task deleted while its UPDATE is in flight keeps the queued delete and does not resurrect the update', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    const release = hold(vi.mocked(taskService.updateTask) as never, () => ok('srv-1'));

    const running = processSyncQueue(cbs());
    await vi.waitFor(() => expect(taskService.updateTask).toHaveBeenCalledTimes(1));
    await enqueueSyncAction({ type: 'delete', taskId: 'srv-1' });
    release();
    await running;

    expect((await queue()).map((q) => `${q.type}:${q.taskId}`)).toEqual(['delete:srv-1']);
  });

  it('with nothing queued meanwhile, a finished run leaves an empty queue and reports it', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    expect(await processSyncQueue(cbs())).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await queue()).toEqual([]);
  });

  it('entries not reached (the run stopped on a 401) stay, in order, together with anything queued meanwhile', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'one' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'two' } });
    vi.mocked(taskService.updateTask).mockRejectedValueOnce(Object.assign(new Error('auth'), { response: { status: 401 } }));

    await processSyncQueue(cbs());
    await enqueueSyncAction({ type: 'update', taskId: 'srv-3', payload: { title: 'three' } });

    expect((await queue()).map((q) => q.taskId)).toEqual(['srv-1', 'srv-2', 'srv-3']);
  });

  it('a permanently refused entry (400) is dropped; the rest of the queue is untouched', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: '' } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-2', payload: { title: 'two' } });
    vi.mocked(taskService.updateTask).mockImplementation(async (id: string) => {
      if (id === 'srv-1') throw Object.assign(new Error('bad'), { response: { status: 400 } });
      return ok(id);
    });

    expect(await processSyncQueue(cbs())).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(await queue()).toEqual([]);
  });
});
