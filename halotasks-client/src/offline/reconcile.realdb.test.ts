import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import type { SyncMutation, SyncResult } from './batchProtocol';
import type { SettledEntry, SyncQueueRecord } from './syncQueue';

// Issue #61: reconciling server answers with local state, on the REAL idb layer (fake-indexeddb), the real commit transaction, the real
// processor and the real adoption/settle transactions. Only the HTTP edge is a double. fake-indexeddb models the spec, not a real
// browser's multi-tab timing.
//
// The races are injected DETERMINISTICALLY: `gate.beforeAdopt` runs a user's edit commit at the instant the processor asks for the
// adoption, so the commit is already in line for the store lock ahead of it. A staleness decision made OUTSIDE the adoption's
// transaction (the pre-#61 shape) cannot see that edit and overwrites it; the decision made inside the transaction does.

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn(), syncBatch: vi.fn() },
}));
vi.mock('../services/completionService', () => ({ completionService: { postEvent: vi.fn() } }));

const gate = { beforeAdopt: null as null | (() => void), afterAdopt: null as null | (() => void) };

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
    const result = await realAdopt(request);
    const after = gate.afterAdopt;
    gate.afterAdopt = null;
    after?.();
    return result;
  });
  return {
    commit,
    cache: await import('./cache'),
    queue: await import('./syncQueue'),
    processor: await import('./queueProcessor'),
    reconcile: await import('./taskReconcile'),
    service: await import('../services/taskService'),
    completion: await import('../services/completionService'),
  };
};
type M = Awaited<ReturnType<typeof load>>;

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  gate.beforeAdopt = null;
  gate.afterAdopt = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const T = (n: number) => `2026-11-21T10:00:00.${String(n).padStart(3, '0')}Z`; // server instants, "revision n"
const COMPLETE = { kind: 'complete', completionId: 'c-1', completedAt: '2026-11-21T10:00:00.000Z', utcOffsetMinutes: 0, title: 'T', estimatedMinutes: 0 };
const REVOKE = { kind: 'revoke', completionId: 'c-1', revokedAt: '2026-11-21T10:05:00.000Z', title: 'T', estimatedMinutes: 0 };

/** A user's edit: stored list AND queue entry in one commit, exactly as the dashboard does it. */
const edit = (m: M, taskId: string, patch: Partial<Task>) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: stored.map((t) => (t._id === taskId ? { ...t, ...patch, pendingSync: true } : t)),
      actions: [{ type: 'update' as const, taskId, payload: patch as Record<string, unknown> }],
    }),
  });
const complete = (m: M, taskId: string, payload: Record<string, unknown> = COMPLETE) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: stored.map((t) => (t._id === taskId ? { ...t, completed: payload.kind === 'complete', pendingSync: true } : t)),
      actions: [{ type: 'completion' as const, taskId, payload }],
    }),
  });
const create = (m: M, localId: string, title: string) =>
  m.commit.commitLocalMutation({
    derive: (stored: Task[]) => ({
      tasks: [makeTask({ _id: localId, title, pendingSync: true }), ...stored],
      actions: [{ type: 'create' as const, taskId: localId, payload: { title, priority: 'medium' } }],
    }),
  });

/** The server answers every mutation with `answer(mutation)`. */
const serverAnswers = (m: M, answer: (mutation: SyncMutation) => Partial<SyncResult>) =>
  vi.mocked(m.service.taskService.syncBatch).mockImplementation((async (mutations: SyncMutation[]) => ({
    results: mutations.map((x) => ({ mutationId: x.mutationId, ...answer(x) }) as SyncResult),
  })) as never);
const applied = (task: Task) => ({ status: 'applied' as const, task });
const failed = { status: 'failed' as const, retryable: true as const, error: { httpStatus: 503, code: 'X', message: 'x' } };

const run = (m: M, callbacks: Record<string, unknown> = {}) =>
  m.processor.processSyncQueue({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn(), ...callbacks } as never);

const stored = async (m: M, id: string) => (await m.cache.getCachedTasks()).find((t) => t._id === id)!;
const queueOf = (m: M) => m.queue.getSyncQueue('user-1');

/** I4: after a synchronization-induced write, every task's flag equals "a durable queue entry names it" (no exceptions). */
const flagsMatchQueue = async (m: M) => {
  const queue = await queueOf(m);
  for (const task of await m.cache.getCachedTasks()) {
    const named = queue.some((e) => e.taskId === task._id || (task.clientKey !== undefined && e.taskId === task.clientKey));
    expect({ id: task._id, pending: task.pendingSync === true }).toEqual({ id: task._id, pending: named });
  }
};

describe('F1: an edit that lands between the answer and its adoption survives (the decision is made inside the write transaction)', () => {
  it('update', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 's1', { title: 'C' });
    };
    const onTaskUpdated = vi.fn();
    await run(m, { onTaskUpdated });
    await racing;

    const task = await stored(m, 's1');
    expect(task.title).toBe('C');
    expect(task.pendingSync).toBe(true);
    expect(task.syncedRevision).toBeUndefined(); // a stale answer is not adopted, so no revision advances
    expect(onTaskUpdated).not.toHaveBeenCalled();
    expect((await queueOf(m)).map((e) => e.payload)).toEqual([{ title: 'C' }]); // exactly the residual: C is still to be sent, once
    await flagsMatchQueue(m);
  });

  it('create', async () => {
    const m = await load();
    await create(m, 'local-1', 'T');
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'T', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 'local-1', { title: 'T2' });
    };
    const onTaskCreated = vi.fn();
    await run(m, { onTaskCreated });
    await racing;

    const task = await stored(m, 's1'); // identity adopted
    expect(task.title).toBe('T2'); // content stays the user's
    expect(task.pendingSync).toBe(true);
    expect(task.syncedRevision).toBeUndefined();
    expect(onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 's1' }), { stale: true });
    expect((await queueOf(m)).map((e) => [e.type, e.taskId, e.payload])).toEqual([['update', 's1', { title: 'T2' }]]);
    await flagsMatchQueue(m);
  });

  it('completion', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'T', updatedAt: T(1) })]);
    await complete(m, 's1');
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'T', completed: true, completionId: 'c-1', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.beforeAdopt = () => {
      racing = edit(m, 's1', { title: 'C' });
    };
    const onTaskUpdated = vi.fn();
    await run(m, { onTaskUpdated });
    await racing;

    const task = await stored(m, 's1');
    expect(task.title).toBe('C');
    expect(task.completed).toBe(true); // the local state the user is looking at
    expect(task.pendingSync).toBe(true);
    expect(onTaskUpdated).not.toHaveBeenCalled();
    expect((await queueOf(m)).map((e) => e.type)).toEqual(['update']);
    await flagsMatchQueue(m);
  });

  it('with nothing in between, the same answer IS adopted and the task stops being pending', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(5) })));
    const result = await run(m);
    const task = await stored(m, 's1');
    expect(result.remaining).toBe(0);
    expect(task).toMatchObject({ title: 'B', pendingSync: false, syncedRevision: T(5) });
  });

  it('an edit that commits between the adoption and the final settle leaves the task pending (adoption and settle never derive from different queues)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(5) })));
    let racing: Promise<unknown> | null = null;
    gate.afterAdopt = () => {
      racing = edit(m, 's1', { title: 'C' });
    };
    await run(m);
    await racing;
    const task = await stored(m, 's1');
    expect(task).toMatchObject({ title: 'C', pendingSync: true });
    expect((await queueOf(m)).map((e) => e.payload)).toEqual([{ title: 'C' }]);
    await flagsMatchQueue(m);
  });
});

describe('pendingSync is true iff a durable queue entry names the task, including the acknowledged-but-unsettled interval', () => {
  it('adoption of e1 leaves the task pending while e1 is still queued; the settle that removes e1 makes it false', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    const [e1] = await queueOf(m);
    const adoption = await m.commit.adoptServerAnswer({
      ownerId: 'user-1',
      taskIds: ['s1'],
      snapshot: new Map([[e1.id, JSON.stringify(e1.payload)]]),
      apply: (list, { stale }) => m.reconcile.adoptUpdated(list, 's1', makeTask({ _id: 's1', title: 'B', updatedAt: T(5) }), stale),
    });
    expect(adoption.stale).toBe(false);
    // the durable state right after the adoption (a crash here leaves exactly this): content adopted, entry still queued, task pending
    expect(await queueOf(m)).toHaveLength(1);
    expect(await stored(m, 's1')).toMatchObject({ title: 'B', syncedRevision: T(5), pendingSync: true });
    expect(adoption.tasks[0].pendingSync).toBe(true);
    await flagsMatchQueue(m);

    await m.queue.settleSyncQueueAndTasks('user-1', new Map([[e1.id, { outcome: 'sent', payload: e1.payload as Record<string, unknown>, serverTaskId: 's1' }]]), new Map());
    expect(await queueOf(m)).toHaveLength(0);
    expect(await stored(m, 's1')).toMatchObject({ title: 'B', pendingSync: false });
    await flagsMatchQueue(m);
  });

  it('through the processor: after every adoption the stored flag agrees with the stored queue; only the settle clears it', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(5) })));
    let during: Promise<[Task, SyncQueueRecord[]]> | null = null;
    gate.afterAdopt = () => {
      during = Promise.all([stored(m, 's1'), queueOf(m)]);
    };
    const shown: Task[][] = [];
    await run(m, { onTasksStored: (tasks: Task[]) => shown.push(tasks) });
    const [taskDuring, queueDuring] = await during!;
    expect(queueDuring).toHaveLength(1); // delivered but not yet settled
    expect(taskDuring.pendingSync).toBe(true); // so the cache still says queued
    expect(shown.map((tasks) => tasks[0].pendingSync)).toEqual([true, false]); // what the UI is told: adoption (queued), then the settle (clear)
    expect(await stored(m, 's1')).toMatchObject({ pendingSync: false });
    expect(await queueOf(m)).toHaveLength(0);
  });
});

describe('F2: an older server snapshot never replaces a newer one that was adopted', () => {
  const adoptAck = async (m: M, revision: number, title: string) => {
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title });
    serverAnswers(m, () => applied(makeTask({ _id: 's1', title, updatedAt: T(revision) })));
    await run(m);
  };

  it('newer ack, then an older list: the acknowledged state stays; then a newer list wins', async () => {
    const m = await load();
    await adoptAck(m, 100, 'B');
    expect(await stored(m, 's1')).toMatchObject({ title: 'B', syncedRevision: T(100), pendingSync: false });

    const afterOlder = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(99) })]);
    expect(afterOlder[0]).toMatchObject({ title: 'B', syncedRevision: T(100) });
    expect(await stored(m, 's1')).toMatchObject({ title: 'B' }); // and it is what is STORED

    const afterNewer = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'C', updatedAt: T(101) })]);
    expect(afterNewer[0]).toMatchObject({ title: 'C', syncedRevision: T(101), pendingSync: false });
  });

  it('newer list, then an older list: the newer list stays', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'N', updatedAt: T(101) })]);
    const result = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'O', updatedAt: T(99) })]);
    expect(result[0]).toMatchObject({ title: 'N', syncedRevision: T(101) });
  });

  it('EQUAL revision is accepted (locked behaviour, D6): updatedAt is an ordering signal here, not a unique version', async () => {
    const m = await load();
    await adoptAck(m, 100, 'B');
    const result = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'same-instant', updatedAt: T(100) })]);
    expect(result[0]).toMatchObject({ title: 'same-instant', syncedRevision: T(100) });
  });

  it('a copy without a revision (cached before this existed) behaves as before: the list replaces it', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'old', updatedAt: T(500) })]);
    const result = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'server', updatedAt: T(1) })]);
    expect(result[0].title).toBe('server');
  });

  it('a list older than a task that still has queued work changes nothing (queued work wins regardless)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'mine' });
    const result = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'theirs', updatedAt: T(900) })]);
    expect(result[0]).toMatchObject({ title: 'mine', pendingSync: true });
  });

  it('a REFUSED local change is not protected: the list fetched after a rejection replaces it', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(50), syncedRevision: T(50) })]);
    await edit(m, 's1', { title: 'refused', updatedAt: T(900) }); // the user's own clock may be ahead of the server's
    await m.queue.setSyncQueue([], 'user-1'); // the processor dropped the refused entry
    await m.commit.settleRejectedLocalState();
    const result = await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(60) })]);
    expect(result[0].title).toBe('A');
  });

  it('two tabs: an ack adopted in tab A and an older list applied by tab B, in either order, leave the acknowledged state', async () => {
    for (const listFirst of [true, false]) {
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      const a = await load();
      await a.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
      await edit(a, 's1', { title: 'B' });
      const [entry] = await queueOf(a);
      const b = await load(); // a second module instance (its own store lock) over the same database
      const ack = () =>
        a.commit.adoptServerAnswer({
          ownerId: 'user-1',
          taskIds: ['s1'],
          snapshot: new Map([[entry.id, JSON.stringify(entry.payload)]]),
          apply: (list, { stale }) => a.reconcile.adoptUpdated(list, 's1', makeTask({ _id: 's1', title: 'B', updatedAt: T(100) }), stale),
        });
      const older = () => b.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(99) })]);
      await (listFirst ? Promise.all([older(), ack()]) : Promise.all([ack(), older()]));
      // the entry is still queued (settle has not run), so either order keeps the local/acknowledged copy
      expect((await a.cache.getCachedTasks())[0].title).toBe('B');
    }
  });
});

describe('F3: pendingSync follows the queue', () => {
  it('a completion still queued behind an acknowledged create keeps the task pending; the next run clears it', async () => {
    const m = await load();
    await create(m, 'local-1', 'T');
    await complete(m, 'local-1');
    serverAnswers(m, (x) => (x.type === 'create' ? applied(makeTask({ _id: 's1', title: 'T', updatedAt: T(5) })) : failed));
    const first = await run(m);
    expect(first).toMatchObject({ remaining: 1, blocked: 'unreachable' });
    expect(await stored(m, 's1')).toMatchObject({ pendingSync: true, clientKey: 'local-1' }); // the claim matches the queue
    await flagsMatchQueue(m);

    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'T', completed: true, completionId: 'c-1', updatedAt: T(8) })));
    const second = await run(m);
    expect(second.remaining).toBe(0);
    expect(await stored(m, 's1')).toMatchObject({ pendingSync: false, syncedRevision: T(8) });
  });

  it('a task keeps its flag while ANY entry for it waits: update then two completions, acknowledged one at a time', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1) })]);
    await edit(m, 's1', { title: 'B' });
    await complete(m, 's1', COMPLETE);
    await complete(m, 's1', REVOKE);
    const [e1, e2, e3] = await queueOf(m);
    expect([e1.type, e2.type, e3.type]).toEqual(['update', 'completion', 'completion']);
    const t = (await m.cache.getCachedTasks())[0];
    const flag = (stillQueued: typeof e1[]) => m.reconcile.derivePending([t], stillQueued)[0].pendingSync;
    expect(flag([e1, e2, e3])).toBe(true);
    expect(flag([e2, e3])).toBe(true); // e1 delivered and settled away, two completions still wait
    expect(flag([e3])).toBe(true);
    expect(flag([])).toBe(false); // only when the last applicable entry is gone

    // and through the processor: the update is delivered, the first completion is delivered, the last one fails
    serverAnswers(m, (x) => (x.mutationId === e3.mutationId ? failed : applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(5) }))));
    const result = await run(m);
    expect(result.remaining).toBe(1);
    expect((await stored(m, 's1')).pendingSync).toBe(true);
  });

  it('settle: flags follow the FINAL queue (a finished task stops being pending, one with a residual stays pending)', async () => {
    const m = await load();
    const entry = (id: string, taskId: string, payload: Record<string, unknown>): SyncQueueRecord => ({ id, type: 'update', taskId, payload, createdAt: 1, mutationId: `m-${id}` });
    await m.cache.setCachedTasks([makeTask({ _id: 's1', pendingSync: true }), makeTask({ _id: 's2', pendingSync: true }), makeTask({ _id: 's3', pendingSync: true })]);
    await m.queue.setSyncQueue([entry('e1', 's1', { title: 'x' }), entry('e2', 's2', { title: 'new' })], 'user-1');
    const settled = new Map<string, SettledEntry>([
      ['e1', { outcome: 'sent', payload: { title: 'x' }, serverTaskId: 's1' }],
      ['e2', { outcome: 'sent', payload: { title: 'old' }, serverTaskId: 's2' }], // edited since: a residual stays
    ]);
    const { queue, tasks } = await m.queue.settleSyncQueueAndTasks('user-1', settled, new Map());
    expect(queue.map((e) => e.taskId)).toEqual(['s2']);
    expect(Object.fromEntries(tasks!.map((t) => [t._id, t.pendingSync]))).toEqual({ s1: false, s2: true, s3: false });
    expect((await m.cache.getCachedTasks()).map((t) => t.pendingSync)).toEqual([false, true, false]);
  });

  it('every synchronization-induced write derives the flag from the queue it saw (adoption, settle, list, rejection)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', updatedAt: T(1) }), makeTask({ _id: 's2', updatedAt: T(1) }), makeTask({ _id: 's3', updatedAt: T(1), pendingSync: true })]);
    await edit(m, 's1', { title: 'one' });
    await edit(m, 's2', { title: 'two' });

    const [e1] = await queueOf(m);
    await m.commit.adoptServerAnswer({
      ownerId: 'user-1',
      taskIds: ['s1'],
      snapshot: new Map([[e1.id, JSON.stringify(e1.payload)]]),
      apply: (list, { stale }) => m.reconcile.adoptUpdated(list, 's1', makeTask({ _id: 's1', title: 'one', updatedAt: T(5) }), stale),
    });
    await flagsMatchQueue(m); // s1's acknowledged entry is still queued until settle, so s1 stays pending; s2 queued; s3 never queued (its stale flag is corrected)

    await m.commit.reconcileServerTasks([makeTask({ _id: 's1', updatedAt: T(5) }), makeTask({ _id: 's2', updatedAt: T(1) }), makeTask({ _id: 's3', updatedAt: T(1) })]);
    await flagsMatchQueue(m);

    await m.queue.settleSyncQueueAndTasks('user-1', new Map([[e1.id, { outcome: 'sent', payload: e1.payload, serverTaskId: 's1' }]]), new Map());
    await flagsMatchQueue(m);

    await m.commit.settleRejectedLocalState();
    await flagsMatchQueue(m);
  });
});

describe('syncedRevision only ever comes from server data', () => {
  it('a local edit, a commit, and a stale answer never set or move it; an adoption sets it to the SERVER updatedAt', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1), syncedRevision: T(1) })]);
    await edit(m, 's1', { title: 'B', updatedAt: T(900) }); // the client's own (later) timestamp
    expect((await stored(m, 's1')).syncedRevision).toBe(T(1)); // unchanged by a local commit

    serverAnswers(m, () => applied(makeTask({ _id: 's1', title: 'B', updatedAt: T(7) })));
    await run(m);
    const task = await stored(m, 's1');
    expect(task.syncedRevision).toBe(T(7)); // the server's value, not the client's T(900)
    expect(m.reconcile.withRevision(makeTask({ updatedAt: T(3) })).syncedRevision).toBe(T(3));
  });

  it('a rejected-by-revision ack changes nothing (an answer older than what is adopted)', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'NEW', updatedAt: T(100), syncedRevision: T(100) })]);
    const list = m.reconcile.adoptUpdated(await m.cache.getCachedTasks(), 's1', makeTask({ _id: 's1', title: 'OLD', updatedAt: T(50) }), false);
    expect(list[0]).toMatchObject({ title: 'NEW', syncedRevision: T(100) });
  });

  it('isOlderSnapshot: strictly older only; missing or unparsable values protect nothing', () => {
    return load().then((m) => {
      const { isOlderSnapshot } = m.reconcile;
      expect(isOlderSnapshot({ updatedAt: T(99) }, { syncedRevision: T(100) })).toBe(true);
      expect(isOlderSnapshot({ updatedAt: T(100) }, { syncedRevision: T(100) })).toBe(false);
      expect(isOlderSnapshot({ updatedAt: T(101) }, { syncedRevision: T(100) })).toBe(false);
      expect(isOlderSnapshot({ updatedAt: T(1) }, {})).toBe(false);
      expect(isOlderSnapshot({ updatedAt: 'not a date' }, { syncedRevision: T(100) })).toBe(false);
    });
  });
});

describe('the adoption transaction is pure and synchronous', () => {
  it('an apply that is asynchronous is refused before anything is written', async () => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A' })]);
    await expect(
      m.commit.adoptServerAnswer({
        ownerId: 'user-1',
        taskIds: ['s1'],
        snapshot: new Map(),
        apply: (async (list: Task[]) => list.map((t) => ({ ...t, title: 'changed' }))) as never,
      }),
    ).rejects.toThrow(/synchronous/);
    expect((await stored(m, 's1')).title).toBe('A');
  });

  it('nothing is stored and nothing to store: the list key is not created', async () => {
    const m = await load();
    const result = await m.commit.adoptServerAnswer({ ownerId: 'user-1', taskIds: ['s1'], snapshot: new Map(), apply: (list) => list });
    expect(result.tasks).toEqual([]);
    expect(await m.cache.getCachedTasks()).toEqual([]);
  });
});

describe('interleaving: edit, ack and list in every order, then settle', () => {
  const orders: string[][] = [];
  const permute = (rest: string[], done: string[] = []) => (rest.length === 0 ? orders.push(done) : rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...done, x])));
  permute(['edit', 'ack', 'list']);

  it.each(orders.map((o) => [o.join(' > '), o] as const))('%s', async (_name, order) => {
    const m = await load();
    await m.cache.setCachedTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(1), syncedRevision: T(1) })]);
    await edit(m, 's1', { title: 'B' }); // entry e1, sent with {title: B}
    const [e1] = await queueOf(m);
    const sentSnapshot = JSON.stringify({ title: 'B' });

    for (const step of order) {
      if (step === 'edit') await edit(m, 's1', { title: 'C' });
      if (step === 'ack') {
        await m.commit.adoptServerAnswer({
          ownerId: 'user-1',
          taskIds: ['s1'],
          snapshot: new Map([[e1.id, sentSnapshot]]),
          apply: (list, { stale }) => m.reconcile.adoptUpdated(list, 's1', makeTask({ _id: 's1', title: 'B', updatedAt: T(110) }), stale),
        });
      }
      if (step === 'list') await m.commit.reconcileServerTasks([makeTask({ _id: 's1', title: 'A', updatedAt: T(109) })]);
    }
    await m.queue.settleSyncQueueAndTasks('user-1', new Map([[e1.id, { outcome: 'sent', payload: { title: 'B' }, serverTaskId: 's1' }]]), new Map());

    // whatever the order: the user's later edit is what is shown, it is still to be sent exactly once, and nothing regressed to A or B
    const task = await stored(m, 's1');
    expect(task.title).toBe('C');
    expect(task.pendingSync).toBe(true);
    expect((await queueOf(m)).map((e) => e.payload)).toEqual([{ title: 'C' }]);
    await flagsMatchQueue(m);
  });
});
