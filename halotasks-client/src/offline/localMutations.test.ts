import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';

// Issue #57: these tests run the REAL `idb` layer on fake-indexeddb. They prove the transaction semantics we rely on
// (atomic list+queue, read-inside-transaction, ordering). They do NOT prove crash durability or multi-tab behaviour of a
// real browser: fake-indexeddb is an in-memory model of the spec. See the real-browser check recorded with the design.

type Modules = {
  commit: typeof import('./localMutations');
  cache: typeof import('./cache');
  queue: typeof import('./syncQueue');
  db: typeof import('./db');
};

const load = async (userId: string | null = 'user-1'): Promise<Modules> => {
  vi.resetModules();
  const { useAuthStore } = await import('../store/authStore');
  useAuthStore.setState({ user: userId ? ({ id: userId } as never) : null, token: userId ? 'tok' : null } as never);
  return {
    commit: await import('./localMutations'),
    cache: await import('./cache'),
    queue: await import('./syncQueue'),
    db: await import('./db'),
  };
};

const renameTo = (id: string, title: string) => (stored: Task[]) => ({
  tasks: stored.map((task) => (task._id === id ? { ...task, title } : task)),
  actions: [{ type: 'update' as const, taskId: id, payload: { title } }],
});

beforeEach(() => {
  // A brand-new database per test; module instances are re-imported by `load`.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('commitLocalMutation (real idb on fake-indexeddb)', () => {
  it('stores the task list and the queue entry together, and both survive a simulated reload', async () => {
    const m = await load();
    const base = makeTask({ _id: 's1', title: 'Old' });
    await m.cache.setCachedTasks([base]);

    const result = await m.commit.commitLocalMutation({ derive: renameTo('s1', 'New') });
    expect(result.tasks[0].title).toBe('New');
    expect(result.queue).toHaveLength(1);

    // "Reload": fresh module instances over the same database.
    const again = await load();
    expect((await again.cache.getCachedTasks())?.[0].title).toBe('New');
    const queued = await again.queue.getSyncQueue('user-1');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'update', taskId: 's1', payload: { title: 'New' } });
  });

  it('refuses without a signed-in account and writes nothing', async () => {
    const m = await load(null);
    await expect(m.commit.commitLocalMutation({ derive: () => ({ tasks: [], actions: [] }) })).rejects.toThrow(/signed-in/);
    expect(await m.cache.getCachedTasks()).toEqual([]);
  });

  it('writes nothing when derive throws (a rejected mutation leaves list and queue untouched)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'Old' })]);
    await expect(
      m.commit.commitLocalMutation({
        derive: () => {
          throw new Error('invalid');
        },
      }),
    ).rejects.toBeTruthy();
    expect((await m.cache.getCachedTasks())?.[0].title).toBe('Old');
    expect(await m.queue.getSyncQueue('user-1')).toEqual([]);
  });

  it('is atomic: if the queue write fails after the list write, the list write is rolled back', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'Old' })]);
    // A function in the payload cannot be structured-cloned, so the SECOND put (the queue) throws DataCloneError.
    await expect(
      m.commit.commitLocalMutation({
        derive: (stored) => ({
          tasks: stored.map((task) => ({ ...task, title: 'Changed' })),
          actions: [{ type: 'update', taskId: 's1', payload: { title: () => 'boom' } as never }],
        }),
      }),
    ).rejects.toBeTruthy();

    const again = await load();
    expect((await again.cache.getCachedTasks())?.[0].title).toBe('Old');
    expect(await again.queue.getSyncQueue('user-1')).toEqual([]);
  });

  it('rapid sequential commits from separate calls all land, in call order (none is lost)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([]);
    const ids = Array.from({ length: 20 }, (_, i) => `local-${i}`);
    await Promise.all(
      ids.map((id) =>
        m.commit.commitLocalMutation({
          derive: (stored) => ({
            tasks: [{ ...makeTask({ _id: id, title: id }) }, ...stored],
            actions: [{ type: 'create', taskId: id, payload: { title: id } }],
          }),
        }),
      ),
    );
    const tasks = (await m.cache.getCachedTasks()) ?? [];
    expect(tasks.map((t) => t._id).sort()).toEqual([...ids].sort());
    const queue = await m.queue.getSyncQueue('user-1');
    expect(queue.map((e) => e.taskId)).toEqual(ids);
  });

  it('mutation B derives from the result of mutation A, not from a copy read before A', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'T', priority: 'low' })]);
    const a = m.commit.commitLocalMutation({
      derive: (s) => ({ tasks: s.map((t) => ({ ...t, title: 'A' })), actions: [{ type: 'update', taskId: 's1', payload: { title: 'A' } }] }),
    });
    const b = m.commit.commitLocalMutation({
      derive: (s) => ({ tasks: s.map((t) => ({ ...t, priority: 'high' as const })), actions: [{ type: 'update', taskId: 's1', payload: { priority: 'high' } }] }),
    });
    await Promise.all([a, b]);
    const [task] = (await m.cache.getCachedTasks()) ?? [];
    expect(task).toMatchObject({ title: 'A', priority: 'high' });
    expect((await m.queue.getSyncQueue('user-1'))[0].payload).toEqual({ title: 'A', priority: 'high' });
  });

  it('two module instances (two tabs) committing at once lose nothing: the transaction is the serialization point', async () => {
    const tab1 = await load();
    await tab1.cache.setCachedTasks([]);
    // Second instance over the SAME database, without resetting the factory.
    vi.resetModules();
    const { useAuthStore } = await import('../store/authStore');
    useAuthStore.setState({ user: { id: 'user-1' } as never, token: 'tok' } as never);
    const tab2 = { commit: await import('./localMutations'), queue: await import('./syncQueue') };
    const make = (id: string) => ({
      derive: (stored: Task[]) => ({
        tasks: [makeTask({ _id: id, title: id }), ...stored],
        actions: [{ type: 'create' as const, taskId: id, payload: { title: id } }],
      }),
    });
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => tab1.commit.commitLocalMutation(make(`a${i}`))),
      ...Array.from({ length: 8 }, (_, i) => tab2.commit.commitLocalMutation(make(`b${i}`))),
    ]);
    const tasks = (await tab1.cache.getCachedTasks()) ?? [];
    expect(tasks).toHaveLength(16);
    expect(await tab1.queue.getSyncQueue('user-1')).toHaveLength(16);
  });

  it('uses the seed only when no list has been stored', async () => {
    const m = await load();
    const seeded = await m.commit.commitLocalMutation({
      seed: [makeTask({ _id: 'seed' })],
      derive: (s) => ({ tasks: s, actions: [] }),
    });
    expect(seeded.tasks.map((t) => t._id)).toEqual(['seed']);

    const m2 = await load();
    const kept = await m2.commit.commitLocalMutation({ seed: [makeTask({ _id: 'other' })], derive: (s) => ({ tasks: s, actions: [] }) });
    expect(kept.tasks.map((t) => t._id)).toEqual(['seed']);
  });

  it('keeps entries per account: the queue written belongs to the signed-in user', async () => {
    const m = await load('user-1');
    await m.cache.setCachedTasks([makeTask({ _id: 's1' })]);
    await m.commit.commitLocalMutation({ derive: renameTo('s1', 'X') });
    const other = await load('user-2');
    expect(await other.queue.getSyncQueue('user-2')).toEqual([]);
    expect(await other.queue.getSyncQueue('user-1')).toHaveLength(1);
  });
});

describe('updateCachedTasks', () => {
  it('serializes concurrent read-modify-write updates (no lost update)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([]);
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => m.cache.updateCachedTasks((s) => [...s, makeTask({ _id: `t${i}` })])),
    );
    expect(((await m.cache.getCachedTasks()) ?? []).length).toBe(15);
  });
});

describe('reconcileServerTasks', () => {
  it('keeps local copies of tasks with queued work, drops queued deletes, keeps queued creates, adopts the rest', async () => {
    const m = await load();
    const local = [
      makeTask({ _id: 'edited', title: 'local edit' }),
      makeTask({ _id: 'gone', title: 'to delete' }),
      makeTask({ _id: 'local-new', title: 'created offline' }),
      makeTask({ _id: 'plain', title: 'old plain' }),
    ];
    await m.cache.setCachedTasks(local);
    await m.commit.commitLocalMutation({
      derive: (s) => ({
        tasks: s,
        actions: [
          { type: 'update', taskId: 'edited', payload: { title: 'local edit' } },
          { type: 'delete', taskId: 'gone' },
          { type: 'create', taskId: 'local-new', payload: { title: 'created offline' } },
        ],
      }),
    });

    const fresh = [
      makeTask({ _id: 'edited', title: 'server edit' }),
      makeTask({ _id: 'gone', title: 'server gone' }),
      makeTask({ _id: 'plain', title: 'server plain' }),
      makeTask({ _id: 'other', title: 'brand new on server' }),
    ];
    const next = await m.commit.reconcileServerTasks(fresh);
    const byId = Object.fromEntries(next.map((t) => [t._id, t.title]));
    expect(byId).toEqual({
      'local-new': 'created offline',
      edited: 'local edit',
      plain: 'server plain',
      other: 'brand new on server',
    });
    expect((await m.cache.getCachedTasks())?.map((t) => t._id).sort()).toEqual(['edited', 'local-new', 'other', 'plain']);
  });
});

describe('reconcileServerTasks: pending local work is never erased by the server omitting the task', () => {
  it.each([
    ['an edit', { type: 'update' as const, payload: { title: 'edited locally' } }],
    ['a completion', { type: 'completion' as const, payload: { kind: 'complete', completionId: 'c1', completedAt: '2026-10-20T10:00:00.000Z', utcOffsetMinutes: 0 } }],
  ])('a synced task with %s still queued survives a server list that does not contain it', async (_label, action) => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'edited locally', pendingSync: true }), makeTask({ _id: 's2', title: 'other' })]);
    await m.commit.commitLocalMutation({ derive: (s) => ({ tasks: s, actions: [{ ...action, taskId: 's1' } as never] }) });

    // A partial / empty / unrelated server answer: it omits s1 (and s2).
    const next = await m.commit.reconcileServerTasks([makeTask({ _id: 's3', title: 'server only' })]);

    expect(next.map((t) => t._id).sort()).toEqual(['s1', 's3']); // s1 kept (pending), s2 (no work) follows the server, s3 adopted
    expect(next.find((t) => t._id === 's1')).toMatchObject({ title: 'edited locally', pendingSync: true });
    expect((await m.cache.getCachedTasks())?.map((t) => t._id).sort()).toEqual(['s1', 's3']);
    expect(await m.queue.getSyncQueue('user-1')).toHaveLength(1); // the queue is untouched
  });

  it('an EMPTY server list keeps every task that still has queued work, and only those', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 'a' }), makeTask({ _id: 'b' }), makeTask({ _id: 'local-c' })]);
    await m.commit.commitLocalMutation({
      derive: (s) => ({
        tasks: s,
        actions: [
          { type: 'update', taskId: 'a', payload: { title: 'x' } },
          { type: 'create', taskId: 'local-c', payload: { title: 'c' } },
        ],
      }),
    });
    const next = await m.commit.reconcileServerTasks([]);
    expect(next.map((t) => t._id).sort()).toEqual(['a', 'local-c']);
  });

  it('a queued delete still removes a task the server omits (nothing is resurrected)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 'gone' })]);
    await m.commit.commitLocalMutation({ derive: (s) => ({ tasks: s.filter((t) => t._id !== 'gone'), actions: [{ type: 'delete', taskId: 'gone' }] }) });
    expect(await m.commit.reconcileServerTasks([])).toEqual([]);
  });
});

describe('settleRejectedLocalState', () => {
  it('clears pending on tasks with no queued work and drops local-only tasks whose create is gone, keeping queued ones', async () => {
    const m = await load();
    await m.cache.setCachedTasks([
      makeTask({ _id: 'edited', pendingSync: true }),
      makeTask({ _id: 'refused', pendingSync: true }),
      makeTask({ _id: 'local-refused', pendingSync: true }),
      makeTask({ _id: 'local-live', pendingSync: true }),
      makeTask({ _id: 'plain', pendingSync: false }),
    ]);
    await m.commit.commitLocalMutation({
      derive: (s) => ({
        tasks: s,
        actions: [
          { type: 'update', taskId: 'edited', payload: { title: 'x' } },
          { type: 'create', taskId: 'local-live', payload: { title: 'live' } },
        ],
      }),
    });
    const next = await m.commit.settleRejectedLocalState();
    const byId = Object.fromEntries(next.map((t) => [t._id, t.pendingSync]));
    expect(byId).toEqual({ edited: true, refused: false, 'local-live': true, plain: false });
    expect((await m.cache.getCachedTasks())?.map((t) => t._id)).not.toContain('local-refused');
  });
});
