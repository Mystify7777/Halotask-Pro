import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import type { SyncMutation, SyncResult } from './batchProtocol';

// Issue #60 (D13): the mutation id lifecycle through the REAL idb layer (fake-indexeddb), the real commit transaction, and the real
// processor and batch transport (only the HTTP edge is a double). It proves what the pure tests cannot: the new id is stored in the SAME
// transaction as the payload change, it is on disk before anything is sent and after a reload, and an answer to the old id cannot
// settle an entry that has been edited since, even when the edit comes from another tab. fake-indexeddb is an in-memory model of the
// spec: it does not prove a real browser's multi-tab timing (same limit as Issues #57 and #59).

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn(), syncBatch: vi.fn() },
}));
vi.mock('../services/completionService', () => ({ completionService: { postEvent: vi.fn() } }));

type Modules = {
  commit: typeof import('./localMutations');
  cache: typeof import('./cache');
  queue: typeof import('./syncQueue');
  processor: typeof import('./queueProcessor');
  transport: typeof import('./batchTransport');
  service: typeof import('../services/taskService');
};

/** Fresh module instances over the SAME database: a page load (or a second tab). */
const load = async (userId = 'user-1'): Promise<Modules> => {
  vi.resetModules();
  const { useAuthStore } = await import('../store/authStore');
  useAuthStore.setState({ user: { id: userId } as never, token: 'tok' } as never);
  return {
    commit: await import('./localMutations'),
    cache: await import('./cache'),
    queue: await import('./syncQueue'),
    processor: await import('./queueProcessor'),
    transport: await import('./batchTransport'),
    service: await import('../services/taskService'),
  };
};

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const edit = (m: Modules, taskId: string, payload: Record<string, unknown>) =>
  m.commit.commitLocalMutation({ derive: (stored: Task[]) => ({ tasks: stored, actions: [{ type: 'update' as const, taskId, payload }] }) });
const noop = { onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() };
const ok = (mutations: SyncMutation[]) => ({ results: mutations.map((m) => ({ mutationId: m.mutationId, status: 'applied', ...(m.type === 'delete' ? {} : { task: makeTask({ _id: 's1' }) }) }) as SyncResult) });

describe('the mutation id is part of the committed change', () => {
  it('a merge in the commit transaction keeps the entry id, stores a NEW mutation id, and both survive a reload', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await edit(m, 's1', { title: 'one' });
    const [first] = await m.queue.getSyncQueue('user-1');
    await edit(m, 's1', { priority: 'high' });

    const reloaded = await load();
    const queue = await reloaded.queue.getSyncQueue('user-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(first.id);
    expect(queue[0].mutationId).toBeTruthy();
    expect(queue[0].mutationId).not.toBe(first.mutationId);
    expect(queue[0].payload).toEqual({ title: 'one', priority: 'high' });
  });

  it('two tabs merging into one entry: each merge gets its own id, and the stored entry is consistent', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await edit(tab1, 's1', { title: 'from tab 1' });
    const id1 = (await tab1.queue.getSyncQueue('user-1'))[0].mutationId;
    const tab2 = await load();
    await edit(tab2, 's1', { priority: 'high' });
    const [entry] = await tab1.queue.getSyncQueue('user-1');
    expect(entry.mutationId).not.toBe(id1);
    expect(entry.payload).toEqual({ title: 'from tab 1', priority: 'high' });
  });
});

describe('an entry without a mutation id (queued before they existed)', () => {
  it('gets one stored before the first send, and a retry after a reload sends the SAME id', async () => {
    const m = await load();
    await m.queue.setSyncQueue([{ id: 'old', type: 'update', taskId: 's1', payload: { title: 'x' }, createdAt: 1 }], 'user-1'); // legacy shape
    vi.mocked(m.service.taskService.syncBatch).mockRejectedValue(new Error('Network Error'));
    await m.processor.processSyncQueue(noop);
    const sentFirst = vi.mocked(m.service.taskService.syncBatch).mock.calls[0][0][0].mutationId;

    const reloaded = await load();
    expect((await reloaded.queue.getSyncQueue('user-1'))[0].mutationId).toBe(sentFirst); // it was on disk, not only in memory
    vi.mocked(reloaded.service.taskService.syncBatch).mockImplementation(async (mutations) => ok(mutations));
    await reloaded.processor.processSyncQueue(noop);
    expect(vi.mocked(reloaded.service.taskService.syncBatch).mock.calls[0][0][0].mutationId).toBe(sentFirst);
  });
});

describe('an edit from another tab while the request is out', () => {
  it('the answer to the old id does not settle the entry as it is now; the edit is kept under a new id and goes out next', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await edit(tab1, 's1', { title: 'One' });
    const m1 = (await tab1.queue.getSyncQueue('user-1'))[0].mutationId;

    vi.mocked(tab1.service.taskService.syncBatch).mockImplementationOnce(async (mutations) => {
      const tab2 = await load(); // another tab, over the same database, edits the same task while M1 is in flight
      await edit(tab2, 's1', { priority: 'high' });
      return ok(mutations);
    });
    // the module registry was reset by the second tab: take the processor that belongs to the first tab's mocks
    const result = await tab1.processor.processSyncQueue(noop);

    const after = await (await load()).queue.getSyncQueue('user-1');
    expect(result.processed).toBe(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'update', taskId: 's1', payload: { priority: 'high' } });
    expect(after[0].payload).not.toHaveProperty('title');
    expect(after[0].mutationId).toBeTruthy();
    expect(after[0].mutationId).not.toBe(m1);
  });
});
