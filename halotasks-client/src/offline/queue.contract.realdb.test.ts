import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { deriveSyncState } from './syncState';

// Issue #59: the queue contract through the REAL idb layer (fake-indexeddb), the real commit transaction, and the real
// processor (only the HTTP edge is a double). Proves what the pure tests cannot: the merge happens inside the commit
// transaction against the STORED queue, two tabs coalesce against the same stored state, a reload changes nothing, and the
// coalesced queue sends exactly the requests the final state needs. fake-indexeddb is an in-memory model of the spec: it does
// not prove a real browser's multi-tab timing (same limit as Issue #57).

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn() },
}));

type Modules = {
  commit: typeof import('./localMutations');
  cache: typeof import('./cache');
  queue: typeof import('./syncQueue');
  processor: typeof import('./queueProcessor');
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
    service: await import('../services/taskService'),
  };
};

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

type Action = Parameters<Modules['commit']['commitLocalMutation']>[0] extends { derive: (s: Task[]) => { actions: infer A } } ? A : never;
const act = (m: Modules, ...actions: Array<Action extends Array<infer X> ? X : never>) =>
  m.commit.commitLocalMutation({ derive: (stored: Task[]) => ({ tasks: stored, actions }) });
const queued = async (m: Modules) => (await m.queue.getSyncQueue('user-1')).map((e) => `${e.type}:${e.taskId}${e.type === 'completion' ? `:${(e.payload as { kind: string }).kind}` : ''}`);

const complete = (taskId: string, completionId = 'c1') => ({
  type: 'completion' as const,
  taskId,
  payload: { kind: 'complete', completionId, completedAt: '2026-10-20T10:00:00.000Z', utcOffsetMinutes: 330, title: 'T', estimatedMinutes: 0 },
});

describe('through the commit transaction (real storage)', () => {
  it('create -> edit -> edit -> delete: the task list and the queue both end empty-handed', async () => {
    const m = await load();
    await m.cache.setCachedTasks([]);
    await m.commit.commitLocalMutation({
      derive: (s) => ({ tasks: [makeTask({ _id: 'local-1', title: 'x' }), ...s], actions: [{ type: 'create', taskId: 'local-1', payload: { title: 'x' } }] }),
    });
    await act(m, { type: 'update', taskId: 'local-1', payload: { title: 'y' } });
    await act(m, { type: 'update', taskId: 'local-1', payload: { priority: 'high' } });
    expect(await queued(m)).toEqual(['create:local-1']); // one create carrying every edit
    expect((await m.queue.getSyncQueue('user-1'))[0].payload).toEqual({ title: 'y', priority: 'high' });
    await m.commit.commitLocalMutation({ derive: (s) => ({ tasks: s.filter((t) => t._id !== 'local-1'), actions: [{ type: 'delete', taskId: 'local-1' }] }) });
    expect(await queued(m)).toEqual([]);
    expect(await m.cache.getCachedTasks()).toEqual([]);
  });

  it('F1: a delete in one tab and an edit for the same task in another leave only the delete', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(tab1, { type: 'delete', taskId: 's1' });
    const tab2 = await load(); // a second page over the same database
    await act(tab2, { type: 'update', taskId: 's1', payload: { title: 'late' } });
    expect(await queued(tab2)).toEqual(['delete:s1']);
    expect(await queued(tab1)).toEqual(['delete:s1']);
  });

  it('F1, the other order: an edit then a delete from another tab is one delete', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(tab1, { type: 'update', taskId: 's1', payload: { title: 'a' } });
    const tab2 = await load();
    await act(tab2, { type: 'delete', taskId: 's1' });
    expect(await queued(tab1)).toEqual(['delete:s1']);
  });

  it('two tabs editing the same task coalesce into ONE update (the merge reads the stored queue)', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(tab1, { type: 'update', taskId: 's1', payload: { title: 'from tab 1' } });
    const tab2 = await load();
    await act(tab2, { type: 'update', taskId: 's1', payload: { priority: 'high' } });
    const entries = await tab1.queue.getSyncQueue('user-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toEqual({ title: 'from tab 1', priority: 'high' });
  });

  it('update -> complete -> update: one edit entry before the event, the event untouched', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(m, { type: 'update', taskId: 's1', payload: { title: 'a' } });
    await act(m, complete('s1'));
    await act(m, { type: 'update', taskId: 's1', payload: { priority: 'high' } });
    expect(await queued(m)).toEqual(['update:s1', 'completion:s1:complete']);
    const [edit, event] = await m.queue.getSyncQueue('user-1');
    expect(edit.payload).toEqual({ title: 'a', priority: 'high' });
    expect(event.payload).toMatchObject({ completionId: 'c1' });
  });

  it('create -> complete -> delete keeps the completion (a historical event), complete -> revoke -> complete stays three events', async () => {
    const m = await load();
    await m.cache.setCachedTasks([]);
    await act(m, { type: 'create', taskId: 'local-1', payload: { title: 'x' } }, complete('local-1', 'c1'), { type: 'delete', taskId: 'local-1' });
    expect(await queued(m)).toEqual(['completion:local-1:complete']);

    const n = await load('user-2');
    await act(n, complete('s2', 'a'), { type: 'completion', taskId: 's2', payload: { kind: 'revoke', completionId: 'a', revokedAt: 'z', title: 'T', estimatedMinutes: 0 } }, complete('s2', 'b'));
    expect((await n.queue.getSyncQueue('user-2')).map((e) => (e.payload as { kind: string; completionId: string }).kind + ':' + (e.payload as { completionId: string }).completionId)).toEqual(['complete:a', 'revoke:a', 'complete:b']);
  });

  it('a reload changes nothing: the queue read back is the queue written, and later actions coalesce against it', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(m, { type: 'update', taskId: 's1', payload: { title: 'a' } }, complete('s1'));
    const before = await m.queue.getSyncQueue('user-1');
    const reloaded = await load();
    expect(await reloaded.queue.getSyncQueue('user-1')).toEqual(before);
    await act(reloaded, { type: 'update', taskId: 's1', payload: { priority: 'low' } });
    expect(await queued(reloaded)).toEqual(['update:s1', 'completion:s1:complete']);
    expect((await reloaded.queue.getSyncQueue('user-1'))[0].id).toBe(before[0].id); // identity survived the reload and the merge
  });
});

describe('the coalesced queue sends exactly what the final state needs', () => {
  const ok = (id: string) => ({ task: { _id: id } as Task });
  const run = async (m: Modules) => {
    const calls = { onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn() };
    return m.processor.processSyncQueue(calls);
  };
  const setup = async () => {
    const m = await load();
    vi.mocked(m.service.taskService.createTask).mockReset().mockImplementation((async () => ok('srv-new')) as never);
    vi.mocked(m.service.taskService.updateTask).mockReset().mockImplementation((async (id: string) => ok(id)) as never);
    vi.mocked(m.service.taskService.deleteTask).mockReset().mockImplementation((async () => ({})) as never);
    return m;
  };

  it('update, update -> one PUT with both fields', async () => {
    const m = await setup();
    await act(m, { type: 'update', taskId: 's1', payload: { title: 'a' } }, { type: 'update', taskId: 's1', payload: { priority: 'high' } });
    const result = await run(m);
    expect(result).toMatchObject({ remaining: 0, rejected: [] });
    expect(vi.mocked(m.service.taskService.updateTask).mock.calls.map(([id, body]) => [id, body])).toEqual([['s1', { title: 'a', priority: 'high' }]]);
  });

  it('create, update, update -> one POST carrying every edit, no PUT', async () => {
    const m = await setup();
    await act(m, { type: 'create', taskId: 'local-1', payload: { title: 'n' } }, { type: 'update', taskId: 'local-1', payload: { title: 'b' } }, { type: 'update', taskId: 'local-1', payload: { priority: 'high' } });
    await run(m);
    expect(vi.mocked(m.service.taskService.createTask).mock.calls.map(([body]) => body)).toEqual([{ title: 'b', priority: 'high' }]);
    expect(m.service.taskService.updateTask).not.toHaveBeenCalled();
  });

  it('update, complete, update -> the merged edit first, then the completion event with its own id', async () => {
    const m = await setup();
    await act(m, { type: 'update', taskId: 's1', payload: { title: 'a' } }, complete('s1', 'c9'), { type: 'update', taskId: 's1', payload: { priority: 'high' } });
    await run(m);
    const calls = vi.mocked(m.service.taskService.updateTask).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ title: 'a', priority: 'high' });
    expect(calls[1][1]).toMatchObject({ completed: true, completionEvent: { completionId: 'c9' } });
  });

  it('delete, then a late update -> only the delete is sent, nothing is "rejected"', async () => {
    const m = await setup();
    await act(m, { type: 'delete', taskId: 's1' }, { type: 'update', taskId: 's1', payload: { title: 'late' } });
    const result = await run(m);
    expect(m.service.taskService.deleteTask).toHaveBeenCalledTimes(1);
    expect(m.service.taskService.updateTask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ remaining: 0, rejected: [], blocked: null });
  });

  it('complete, revoke, complete -> three requests, each its own event, in order', async () => {
    const m = await setup();
    await act(m, complete('s1', 'a'), { type: 'completion', taskId: 's1', payload: { kind: 'revoke', completionId: 'a', revokedAt: '2026-10-20T11:00:00.000Z', title: 'T', estimatedMinutes: 0 } }, complete('s1', 'b'));
    await run(m);
    const bodies = vi.mocked(m.service.taskService.updateTask).mock.calls.map(([, body]) => body as { completed: boolean; completionEvent: { completionId?: string } });
    expect(bodies.map((b) => [b.completed, b.completionEvent.completionId])).toEqual([[true, 'a'], [false, 'a'], [true, 'b']]);
  });
});

describe('what the sync state says after entries collapse (Issue #58 counts entries)', () => {
  const state = (pending: number, over: Partial<Parameters<typeof deriveSyncState>[0]> = {}) =>
    deriveSyncState({ online: true, pending, draining: false, blocked: null, rejections: 0, confirmedAt: null, ...over });

  it('three edits to one task are ONE entry: "1 change not synced yet"', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await act(m, { type: 'update', taskId: 's1', payload: { a: 1 } }, { type: 'update', taskId: 's1', payload: { b: 1 } }, { type: 'update', taskId: 's1', payload: { c: 1 } });
    const length = (await m.queue.getSyncQueue('user-1')).length;
    expect(length).toBe(1);
    expect(state(length)).toMatchObject({ kind: 'pending', pending: 1 });
  });

  it('a create cancelled by its delete leaves nothing queued, and the state claims nothing (not "synced")', async () => {
    const m = await load();
    await m.cache.setCachedTasks([]);
    await act(m, { type: 'create', taskId: 'local-1', payload: { title: 'x' } }, { type: 'delete', taskId: 'local-1' });
    const length = (await m.queue.getSyncQueue('user-1')).length;
    expect(length).toBe(0);
    expect(state(length).kind).toBe('unverified'); // no confirmation was earned
    expect(state(length, { online: false }).kind).toBe('offline');
  });
});
