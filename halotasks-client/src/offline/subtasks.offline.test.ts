import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Subtask, Task } from '../types/task';
import { useAuthStore } from '../store/authStore';

// Issue #15 (phase 2) through the offline layer: the real queue merging, the real processor and the real cache code run;
// only IndexedDB (a structured-clone Map) and the HTTP service are replaced. Proves the checklist is replaced WHOLE by the
// queue's existing shallow merge (like `tags`), survives queuing, the local-id remap and the cache, and is sent untouched.
// It does not prove what the server stores (tests/taskSubtasks*.test.ts do) or exercise a real browser IndexedDB.

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
import { getCachedTasks, setCachedTasks } from './cache';
import { processSyncQueue } from './queueProcessor';
import { enqueueSyncAction, getSyncQueue, resetSyncQueueState } from './syncQueue';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const sub = (id: string, completed = false): Subtask => ({ id, title: `step ${id}`, completed });
const queue = () => getSyncQueue(USER.id);
const callbacks = () => ({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() });
const serverTask = (id: string, extra: Partial<Task> = {}) => ({ task: { _id: id, ...extra } as Task });

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 'token-a', user: USER });
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('queue merging replaces the checklist whole', () => {
  it('a second queued update replaces the first list; it is not merged item by item', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a'), sub('b')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a', true)] } });

    expect(await queue()).toHaveLength(1);
    expect((await queue())[0].payload).toEqual({ subtasks: [sub('a', true)] });
  });

  it('an update with other fields keeps the queued list; an update that sends [] clears it', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { title: 'renamed' } });
    expect((await queue())[0].payload).toEqual({ subtasks: [sub('a')], title: 'renamed' });

    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [] } });
    expect((await queue())[0].payload).toEqual({ subtasks: [], title: 'renamed' });
  });

  it('an update that does not mention subtasks never adds the key (so it cannot clear stored subtasks)', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { completed: true } });
    expect((await queue())[0].payload).not.toHaveProperty('subtasks');
  });

  it('subtask edits made while the task is still queued as a create are merged into that create', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip', priority: 'low', subtasks: [sub('a'), sub('b')] } });
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { subtasks: [sub('a', true), sub('b')] } });

    const q = await queue();
    expect(q).toHaveLength(1);
    expect(q[0].type).toBe('create');
    expect(q[0].payload).toEqual({ title: 'Trip', priority: 'low', subtasks: [sub('a', true), sub('b')] });
  });

  it('deleting the task drops its queued checklist update along with it', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a')] } });
    await enqueueSyncAction({ type: 'delete', taskId: 'srv-1' });
    expect((await queue()).map((q) => q.type)).toEqual(['delete']);
  });
});

describe('the processor sends the checklist untouched', () => {
  it('a queued create goes out with the same subtask ids, titles and states; the server task reaches the callback', async () => {
    const subtasks = [sub('id-one'), sub('id-two', true)];
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip', priority: 'low', subtasks } });
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1', { subtasks }));
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(vi.mocked(taskService.createTask).mock.calls[0][0]).toEqual({ title: 'Trip', priority: 'low', subtasks });
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 'srv-1', subtasks }));
  });

  it('a queued update is sent with the whole list and no `completed` key', async () => {
    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('a', true)] } });
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-1'));

    await processSyncQueue(callbacks());

    expect(vi.mocked(taskService.updateTask).mock.calls[0][1]).toEqual({ subtasks: [sub('a', true)] });
  });

  it('create then a later checklist update (made after the create synced) goes to the REAL id with the same subtask ids', async () => {
    const subtasks = [sub('stable-1'), sub('stable-2')];
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'Trip', priority: 'low', subtasks } });
    vi.mocked(taskService.createTask).mockResolvedValue(serverTask('srv-1', { subtasks }));
    await processSyncQueue(callbacks());

    await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { subtasks: [sub('stable-1', true), sub('stable-2')] } });
    vi.mocked(taskService.updateTask).mockResolvedValue(serverTask('srv-1'));
    await processSyncQueue(callbacks());

    expect(vi.mocked(taskService.updateTask).mock.calls[0][0]).toBe('srv-1');
    expect((vi.mocked(taskService.updateTask).mock.calls[0][1].subtasks ?? []).map((s) => s.id)).toEqual(['stable-1', 'stable-2']);
  });
});

describe('the offline cache keeps the checklist', () => {
  it('round-trips a checklist byte for byte, and a legacy task is not given one', async () => {
    const withList = makeTask({ _id: 'with', subtasks: [sub('a', true), sub('b')] });
    const legacy = makeTask({ _id: 'legacy' });
    await setCachedTasks([withList, legacy]);

    const [a, b] = await getCachedTasks();

    expect(a).toEqual(withList);
    expect(b).toEqual(legacy);
    expect(b).not.toHaveProperty('subtasks');
  });
});
