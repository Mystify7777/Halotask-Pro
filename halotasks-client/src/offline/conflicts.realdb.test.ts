import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import type { SyncMutation, SyncResult } from './batchProtocol';
import type { ConflictedMutation, FieldConflict } from './conflicts';

// Issue #62B on the REAL idb layer (fake-indexeddb), the real commit transaction, the real processor and settle. Only the HTTP edge is a
// double. fake-indexeddb models the spec, not a real browser's multi-tab timing. The server's own conflict rules are 62A's and are
// tested there (halotasks-server); here the server is whatever the test says it answered.

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn(), syncBatch: vi.fn() },
}));
vi.mock('../services/completionService', () => ({ completionService: { postEvent: vi.fn() } }));

const gate = { beforeAdopt: null as null | (() => void) };

const load = async (userId = 'user-1') => {
  vi.resetModules();
  const { useAuthStore } = await import('../store/authStore');
  useAuthStore.setState({ user: { id: userId } as never, token: 'tok' } as never);
  const commit = await import('./localMutations');
  const realAdopt = commit.adoptServerAnswer;
  vi.spyOn(commit, 'adoptServerAnswer').mockImplementation(async (request) => {
    const before = gate.beforeAdopt;
    gate.beforeAdopt = null;
    before?.();
    return realAdopt(request);
  });
  return {
    commit,
    cache: await import('./cache'),
    queue: await import('./syncQueue'),
    processor: await import('./queueProcessor'),
    conflicts: await import('./conflicts'),
    service: await import('../services/taskService'),
  };
};
type M = Awaited<ReturnType<typeof load>>;

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  gate.beforeAdopt = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const T = (n: number) => `2026-11-21T10:00:00.${String(n).padStart(3, '0')}Z`;

/** A user's edit exactly as the dashboard commits it: the list and the queue entry in one transaction (the base is captured inside). */
const edit = (m: M, taskId: string, patch: Partial<Task>) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: stored.map((t) => (t._id === taskId ? { ...t, ...patch, pendingSync: true } : t)),
      actions: [{ type: 'update' as const, taskId, payload: patch as Record<string, unknown> }],
    }),
  });
const create = (m: M, localId: string, title: string) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: [makeTask({ _id: localId, title, pendingSync: true }), ...stored],
      actions: [{ type: 'create' as const, taskId: localId, payload: { title, priority: 'medium' } }],
    }),
  });
const complete = (m: M, taskId: string) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: stored.map((t) => (t._id === taskId ? { ...t, completed: true, pendingSync: true } : t)),
      actions: [{ type: 'completion' as const, taskId, payload: { kind: 'complete', completionId: 'c-1', completedAt: '2026-11-21T10:00:00.000Z', utcOffsetMinutes: 0, title: 'T', estimatedMinutes: 0 } }],
    }),
  });

const serverAnswers = (m: M, answer: (mutation: SyncMutation) => Partial<SyncResult>) =>
  vi.mocked(m.service.taskService.syncBatch).mockImplementation((async (mutations: SyncMutation[]) => ({
    results: mutations.map((x) => ({ mutationId: x.mutationId, ...answer(x) }) as SyncResult),
  })) as never);
const applied = (task: Task) => ({ status: 'applied' as const, task });
const conflict = (task: Task, field: string, base: unknown, requested: unknown, current: unknown) => ({
  status: 'conflict' as const,
  retryable: false as const,
  task,
  conflicts: [{ field: field as FieldConflict['field'], base, requested, current }],
});
const sentMutations = (m: M): SyncMutation[] => vi.mocked(m.service.taskService.syncBatch).mock.calls.flatMap((call) => call[0] as SyncMutation[]);

const run = (m: M, callbacks: Record<string, unknown> = {}) =>
  m.processor.processSyncQueue({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn(), ...callbacks } as never);
const stored = async (m: M, id: string) => (await m.cache.getCachedTasks()).find((t) => t._id === id)!;
const queueOf = (m: M) => m.queue.getSyncQueue('user-1');

describe('base capture and D11 (the base never advances while an edit of the field is unsent)', () => {
  it('the first edit stores the server value of each field it changes, and nothing else', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B', priority: 'low' });
    const [entry] = await queueOf(m);
    expect(entry.base).toEqual({ title: 'A' });
    expect(entry.payload).toEqual({ title: 'B', priority: 'low' });
  });

  it('server A, user B, C, D: base stays A, requested is D (three separate commits)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    const first = (await queueOf(m))[0];
    await edit(m, 's1', { title: 'C' });
    await edit(m, 's1', { title: 'D' });
    const queue = await queueOf(m);
    expect(queue).toHaveLength(1);
    expect(queue[0].base).toEqual({ title: 'A' });
    expect(queue[0].payload).toEqual({ title: 'D' });
    expect(queue[0].mutationId).not.toBe(first.mutationId); // the payload changed, so it is a different mutation (#60)
  });

  it('a field edited later gets its own base then; the first field keeps its original', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    await edit(m, 's1', { priority: 'high' });
    await edit(m, 's1', { title: 'C', priority: 'medium' });
    expect((await queueOf(m))[0].base).toEqual({ title: 'A', priority: 'low' });
  });

  it('edited and put back: base A, requested A (the server accepts it: stored equals base)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    await edit(m, 's1', { title: 'A' });
    const [entry] = await queueOf(m);
    expect({ base: entry.base, requested: entry.payload }).toEqual({ base: { title: 'A' }, requested: { title: 'A' } });
  });

  it('property: over many random edit sequences on one task the base is always the first edit\'s stored value and the payload the last value per field', async () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 25; round += 1) {
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      const m = await load();
      const original = { title: 'T0', priority: 'low' as const, description: 'd0' };
      await m.cache.setCachedTasks([makeTask({ _id: 's1', ...original, updatedAt: T(1) })]);
      const expectedBase: Record<string, unknown> = {};
      const expectedPayload: Record<string, unknown> = {};
      for (let step = 0; step < 6; step += 1) {
        const field = (['title', 'priority', 'description'] as const)[rand(3)];
        const value = field === 'priority' ? (['low', 'medium', 'high'] as const)[rand(3)] : `${field}-${rand(4)}`;
        // the field's base is its stored value at its first CHANGING edit; an edit that repeats the stored value changes nothing and sets none
        const stillStored = field in expectedPayload ? expectedPayload[field] : original[field];
        if (!(field in expectedBase) && value !== stillStored) expectedBase[field] = original[field];
        await edit(m, 's1', { [field]: value });
        expectedPayload[field] = value;
      }
      const [entry] = await queueOf(m);
      expect(entry.base).toEqual(expectedBase);
      expect(entry.payload).toEqual(expectedPayload);
    }
  });

  it('a task created offline has no base, and edits merged into its create never get one', async () => {
    const m = await load();
    await create(m, 'local-1', 'New');
    await edit(m, 'local-1', { title: 'Newer' });
    const [entry] = await queueOf(m);
    expect(entry.type).toBe('create');
    expect('base' in entry).toBe(false);
  });

  it('an update entry queued before bases existed stays without one: its stored values may be local edits', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'B-unsent', updatedAt: T(1), pendingSync: true })]);
    await m.queue.setSyncQueue([{ id: 'q1', type: 'update', taskId: 's1', payload: { title: 'B-unsent' }, createdAt: 1, mutationId: 'm-legacy-1' }], 'user-1');
    await edit(m, 's1', { priority: 'high' });
    const [entry] = await queueOf(m);
    expect(entry.payload).toEqual({ title: 'B-unsent', priority: 'high' });
    expect('base' in entry).toBe(false);
  });

  it('the base is stored: it survives a reload', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    const again = await load(); // new modules, same database
    expect((await again.queue.getSyncQueue('user-1'))[0].base).toEqual({ title: 'A' });
  });

  it('a completion beside the edits is untouched: no base, and the edit keeps its base across it', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    await complete(m, 's1');
    await edit(m, 's1', { title: 'C' });
    const queue = await queueOf(m);
    expect(queue.map((e) => e.type)).toEqual(['update', 'completion']);
    expect(queue[0].base).toEqual({ title: 'A' });
    expect('base' in queue[1]).toBe(false);
  });
});

describe('what is sent', () => {
  it('an update carries its base; an update with nothing to check, a create and a delete carry none', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) }), makeTask({ _id: 's2', title: 'Z', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    await edit(m, 's2', { title: 'Z' }); // repeats the stored value: nothing changed, nothing to check
    await create(m, 'local-1', 'New');
    serverAnswers(m, (x) => (x.type === 'create' ? applied(makeTask({ _id: 'srv-1', title: 'New' })) : applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(2) }))));
    await run(m);
    const sent = sentMutations(m);
    expect(sent.find((x) => x.type === 'update' && 'id' in x.task && x.task.id === 's1')).toMatchObject({ base: { title: 'A' } });
    const noBase = sent.find((x) => x.type === 'update' && 'id' in x.task && x.task.id === 's2')!;
    expect('base' in noBase).toBe(false);
    expect('base' in sent.find((x) => x.type === 'create')!).toBe(false);
  });

  it('the single-task fallback carries no base (last write wins there, as before)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    vi.mocked(m.service.taskService.syncBatch).mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
    vi.mocked(m.service.taskService.updateTask).mockResolvedValue({ task: makeTask({ _id: 's1', title: 'B', updatedAt: T(2) }) } as never);
    await run(m);
    expect(vi.mocked(m.service.taskService.updateTask).mock.calls[0]).toEqual(['s1', { title: 'B' }, expect.anything()]);
  });
});

describe('a conflict answer', () => {
  const setup = async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) }), makeTask({ _id: 's2', title: 'Other', updatedAt: T(1) })]);
    return m;
  };

  it('drops the entry, keeps what the user asked for, adopts the server\'s task and is neither a rejection nor a failure', async () => {
    const m = await setup();
    await edit(m, 's1', { title: 'Mine' });
    const serverTask = makeTask({ _id: 's1', title: 'Theirs', updatedAt: T(5) });
    serverAnswers(m, () => conflict(serverTask, 'title', 'A', 'Mine', 'Theirs'));
    const onTaskUpdated = vi.fn();
    const result = await run(m, { onTaskUpdated });
    expect(result).toMatchObject({ rejected: [], remaining: 0, blocked: null, processed: 1 });
    expect(result.conflicts).toEqual([
      { taskId: 's1', title: 'Mine', fields: [{ field: 'title', base: 'A', requested: 'Mine', current: 'Theirs' }], mine: { title: 'Mine' }, base: { title: 'A' } },
    ]);
    expect(await queueOf(m)).toEqual([]);
    expect(await stored(m, 's1')).toMatchObject({ title: 'Theirs', pendingSync: false, syncedRevision: T(5) });
    expect(onTaskUpdated).toHaveBeenCalledWith('s1', serverTask, { stale: false });
  });

  it('does not block later work: another task in the same batch is applied', async () => {
    const m = await setup();
    await edit(m, 's1', { title: 'Mine' });
    await edit(m, 's2', { title: 'Other 2' });
    serverAnswers(m, (x) => ('id' in (x as { task: { id?: string } }).task && (x as { task: { id: string } }).task.id === 's1' ? conflict(makeTask({ _id: 's1', title: 'Theirs', updatedAt: T(5) }), 'title', 'A', 'Mine', 'Theirs') : applied(makeTask({ _id: 's2', title: 'Other 2', updatedAt: T(6) }))));
    const result = await run(m);
    expect(result.conflicts).toHaveLength(1);
    expect(result.processed).toBe(2);
    expect(await queueOf(m)).toEqual([]);
    expect((await stored(m, 's2')).title).toBe('Other 2');
  });

  it('an edit made while the request was out is NOT lost and NOT adopted over: it stays queued with the ORIGINAL base', async () => {
    const m = await setup();
    await edit(m, 's1', { title: 'Mine' });
    serverAnswers(m, () => conflict(makeTask({ _id: 's1', title: 'Theirs', updatedAt: T(5) }), 'title', 'A', 'Mine', 'Theirs'));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 's1', { title: 'Mine, later' });
    };
    const result = await run(m);
    await racing;
    expect(result.conflicts).toHaveLength(1);
    const queue = await queueOf(m);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: 'update', taskId: 's1', payload: { title: 'Mine, later' }, base: { title: 'A' } });
    expect(await stored(m, 's1')).toMatchObject({ title: 'Mine, later', pendingSync: true }); // the newer local edit survived the adoption
  });

  it('a completion waiting behind the edit keeps the local copy: the conflict answer is not adopted over it', async () => {
    const m = await setup();
    await edit(m, 's1', { title: 'Mine' });
    await complete(m, 's1');
    const failed = { status: 'failed' as const, retryable: true as const, error: { httpStatus: 503, code: 'X', message: 'x' } };
    serverAnswers(m, (x) => (x.type === 'update' ? conflict(makeTask({ _id: 's1', title: 'Theirs', updatedAt: T(5) }), 'title', 'A', 'Mine', 'Theirs') : failed));
    const onTaskUpdated = vi.fn();
    const result = await run(m, { onTaskUpdated });
    expect(result.conflicts).toHaveLength(1);
    expect(onTaskUpdated).not.toHaveBeenCalled();
    // the completion is still queued, so the local copy (the user's completed task) was not replaced by the server's pre-completion copy
    expect(await stored(m, 's1')).toMatchObject({ completed: true, pendingSync: true });
    expect((await queueOf(m)).map((e) => e.type)).toEqual(['completion']);
  });

  it('a conflict for a task named by its local id is reported under the server id', async () => {
    const m = await load();
    await create(m, 'local-1', 'New');
    serverAnswers(m, () => applied(makeTask({ _id: 'srv-1', title: 'New', updatedAt: T(2) })));
    await run(m);
    await m.cache.setCachedTasks([makeTask({ _id: 'srv-1', title: 'New', updatedAt: T(2) })]);
    await edit(m, 'srv-1', { title: 'Newer' });
    serverAnswers(m, () => conflict(makeTask({ _id: 'srv-1', title: 'Theirs', updatedAt: T(5) }), 'title', 'New', 'Newer', 'Theirs'));
    const result = await run(m);
    expect(result.conflicts?.[0].taskId).toBe('srv-1');
  });
});

describe('residual updates keep the right base', () => {
  it('after an applied send, an edit of the same field made meanwhile is based on what was sent (the server now holds it)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', priority: 'low', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = Promise.resolve().then(async () => {
        await edit(m, 's1', { title: 'C' });
        await edit(m, 's1', { priority: 'high' });
      });
    };
    await run(m);
    await racing;
    const [residual] = await queueOf(m);
    expect(residual).toMatchObject({ type: 'update', taskId: 's1', payload: { title: 'C', priority: 'high' } });
    // title: the server holds B now. priority: the first edit never changed it, so its stored value (low) was captured on merge.
    expect(residual.base).toEqual({ title: 'B', priority: 'low' });
  });

  it('the residual base is the value the server STORED, not the submitted one (the server trimmed the title)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) })]);
    await edit(m, 's1', { title: '  My task  ' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'My task', priority: 'low', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 's1', { title: 'My task!' });
    };
    await run(m);
    await racing;
    const [residual] = await queueOf(m);
    expect(residual).toMatchObject({ type: 'update', taskId: 's1', payload: { title: 'My task!' } });
    expect(residual.base).toEqual({ title: 'My task' }); // never '  My task  ', which the server never held
  });

  it('with no task in the answer nothing is guessed from the payload: the residual field has no base', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => ({ status: 'applied' as const }));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 's1', { title: 'C' });
    };
    await run(m);
    await racing;
    const queue = await queueOf(m);
    expect(queue).toHaveLength(1);
    expect(queue[0].payload).toMatchObject({ title: 'C' });
    expect('base' in queue[0]).toBe(false);
  });

  it('a create has no base, and the update that follows a partly applied (replayed) create has none', async () => {
    const m = await load();
    await create(m, 'local-1', 'New');
    serverAnswers(m, () => ({ status: 'replayed' as const, task: makeTask({ _id: 'srv-1', title: 'Old title', updatedAt: T(2) }) }));
    await run(m);
    const queue = await queueOf(m);
    for (const entry of queue) expect('base' in entry).toBe(false);
  });
});

describe('resolution (D8)', () => {
  const conflicted = async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', priority: 'low', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'Mine', priority: 'high' });
    serverAnswers(m, () => conflict(makeTask({ _id: 's1', title: 'Theirs', priority: 'low', updatedAt: T(5) }), 'title', 'A', 'Mine', 'Theirs'));
    const result = await run(m);
    return { m, conflict: (result.conflicts as ConflictedMutation[])[0] };
  };
  const keepMine = (m: M, item: ConflictedMutation) => {
    const { payload, base } = m.conflicts.keepMineEdit(item);
    return m.commit.commitLocalMutation({
      derive: (list: Task[]) => ({
        tasks: list.map((t) => (t._id === item.taskId ? { ...m.conflicts.applyUpdatePayload(t, payload), pendingSync: true } : t)),
        actions: [{ type: 'update' as const, taskId: item.taskId, payload, base, rebase: true }],
      }),
    });
  };

  it('Use theirs needs nothing: the server\'s values are already adopted and nothing is queued', async () => {
    const { m } = await conflicted();
    expect(await queueOf(m)).toEqual([]);
    expect(await stored(m, 's1')).toMatchObject({ title: 'Theirs', pendingSync: false });
  });

  it('Keep mine is an ordinary new edit: the discarded values go back, based on what the server holds NOW for the conflicted field', async () => {
    const { m, conflict: item } = await conflicted();
    await keepMine(m, item);
    const [entry] = await queueOf(m);
    expect(entry).toMatchObject({ type: 'update', taskId: 's1', payload: { title: 'Mine', priority: 'high' }, base: { title: 'Theirs', priority: 'low' } });
    expect(await stored(m, 's1')).toMatchObject({ title: 'Mine', priority: 'high', pendingSync: true });
    // and it is sent with that base
    serverAnswers(m, (x) => applied(makeTask({ _id: 's1', title: 'Mine', priority: 'high', updatedAt: T(9) })));
    await run(m);
    const sent = sentMutations(m).slice(-1)[0];
    expect(sent).toMatchObject({ type: 'update', base: { title: 'Theirs', priority: 'low' } });
  });

  it('Keep mine replaces the base of a residual that is still queued for the same field (it was the stale one)', async () => {
    const { m, conflict: item } = await conflicted();
    await edit(m, 's1', { title: 'Other thought' }); // queued after the conflict: based on the server value the user now sees
    const before = (await queueOf(m))[0];
    expect(before.base).toEqual({ title: 'Theirs' });
    await keepMine(m, item);
    const [entry] = await queueOf(m);
    expect(entry.base).toMatchObject({ title: 'Theirs' });
    expect(entry.payload).toMatchObject({ title: 'Mine' });
  });

  it('Keep mine for a task that has been deleted meanwhile is refused and queues nothing', async () => {
    const { m, conflict: item } = await conflicted();
    await m.cache.setCachedTasks([]);
    await expect(
      m.commit.commitLocalMutation({
        derive: (list: Task[]) => {
          if (!list.some((t) => t._id === item.taskId)) throw new Error('Task no longer exists');
          return { tasks: list, actions: [] };
        },
      }),
    ).rejects.toThrow();
    expect(await queueOf(m)).toEqual([]);
  });
});
