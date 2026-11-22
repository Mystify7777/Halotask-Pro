import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useAuthStore } from '../store/authStore';
import { enqueueSyncAction, resetSyncQueueState, type SyncQueueRecord } from './syncQueue';
import { resetBatchSupport } from './batchTransport';
import type { SyncMutation, SyncResult } from './batchProtocol';

// Issue #60 — the processor sends the coalesced queue as batches. The real queue storage, the real batch transport and the
// real processor run; only IndexedDB and the HTTP service are doubles, so what is asserted is what the real code does with
// each kind of answer: one result per mutation, applied / replayed / rejected / failed / skipped, ordering, ids, fallbacks.

const db = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('./db', () => ({
  offlineDb: {
    get: async (key: string) => (db.store.has(key) ? structuredClone(db.store.get(key)) : null),
    set: async (key: string, value: unknown) => {
      db.store.set(key, structuredClone(value));
    },
    // Staged like the real transaction: applied together only if `fn` succeeds (Issue #57; used by the Issue #61 adoption and settle).
    transaction: async <T,>(fn: (tx: { get: <V>(key: string) => Promise<V | null>; put: (key: string, value: unknown) => Promise<void> }) => Promise<T>) => {
      const staged = new Map<string, unknown>();
      const result = await fn({
        get: async <V,>(key: string) => {
          const source = staged.has(key) ? staged : db.store;
          return source.has(key) ? (structuredClone(source.get(key)) as V) : null;
        },
        put: async (key: string, value: unknown) => {
          staged.set(key, structuredClone(value));
        },
      });
      staged.forEach((value, key) => db.store.set(key, value));
      return result;
    },
    remove: async (key: string) => {
      db.store.delete(key);
    },
  },
}));

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), syncBatch: vi.fn() },
}));
vi.mock('../services/completionService', () => ({ completionService: { postEvent: vi.fn() } }));

import { taskService } from '../services/taskService';
import { completionService } from '../services/completionService';
import { processSyncQueue } from './queueProcessor';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const key = `sync_queue:${USER.id}`;
const seed = (entries: SyncQueueRecord[]) => db.store.set(key, structuredClone(entries));
const stored = () => (db.store.get(key) ?? []) as SyncQueueRecord[];

const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const task = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, ...extra }) as unknown as Task;

let n = 0;
const mid = () => `m-test-${String(++n).padStart(6, '0')}`;
const create = (id: string, taskId: string, payload: Record<string, unknown> = { title: id }): SyncQueueRecord => ({ id, type: 'create', taskId, payload, createdAt: 1, mutationId: mid() });
const update = (id: string, taskId: string, payload: Record<string, unknown> = { title: id }): SyncQueueRecord => ({ id, type: 'update', taskId, payload, createdAt: 1, mutationId: mid() });
const remove = (id: string, taskId: string): SyncQueueRecord => ({ id, type: 'delete', taskId, createdAt: 1, mutationId: mid() });
const completion = (id: string, taskId: string, completionId = `c-${id}`): SyncQueueRecord => ({
  id,
  type: 'completion',
  taskId,
  payload: { kind: 'complete', completionId, completedAt: '2026-11-20T10:00:00.000Z', utcOffsetMinutes: 330, title: 'T', estimatedMinutes: 0 },
  createdAt: 1,
  mutationId: mid(),
});

const applied = (m: SyncMutation, taskId?: string): SyncResult => ({
  mutationId: m.mutationId,
  status: 'applied',
  ...(m.type === 'delete' ? {} : { task: task(taskId ?? ('localId' in m ? m.localId : 'id' in m.task ? m.task.id : m.task.localId)) }),
});
const sentBatches = () => vi.mocked(taskService.syncBatch).mock.calls.map((call) => call[0]);
const allApplied = () => vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({ results: mutations.map((m) => applied(m, m.type === 'create' ? `srv-${m.localId}` : undefined)) }));

const callbacks = () => ({
  onTaskCreated: vi.fn(),
  onTaskUpdated: vi.fn(),
  onTaskDeleted: vi.fn(),
  onGrowth: vi.fn(),
});

beforeEach(() => {
  db.store.clear();
  resetSyncQueueState();
  resetBatchSupport();
  useAuthStore.setState({ token: 'tok', user: USER } as never);
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(taskService.deleteTask).mockReset();
  vi.mocked(taskService.syncBatch).mockReset();
  vi.mocked(completionService.postEvent).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('one request for many queued mutations', () => {
  it('sends the whole coalesced queue in order, in ONE request, each under its own mutation id, and none to the single endpoints', async () => {
    const entries = [create('c1', 'local-1'), update('u1', 'local-1', { priority: 'high' }), update('u2', 'srv-2'), completion('k1', 'srv-3'), remove('d1', 'srv-4')];
    seed(entries);
    allApplied();
    const cb = callbacks();

    const result = await processSyncQueue(cb);

    expect(sentBatches()).toHaveLength(1);
    const [mutations] = sentBatches();
    expect(mutations.map((m) => [m.type, m.mutationId])).toEqual(entries.map((e) => [e.type, e.mutationId]));
    expect(mutations[0]).toMatchObject({ type: 'create', localId: 'local-1' });
    expect(mutations[1]).toMatchObject({ type: 'update', task: { localId: 'local-1' } }); // not yet known by its server id: named by the local id
    expect(mutations[2]).toMatchObject({ type: 'update', task: { id: 'srv-2' } });
    expect(mutations[3]).toMatchObject({ type: 'completion', task: { id: 'srv-3' }, payload: { completed: true, completionEvent: { completionId: 'c-k1' } } });
    expect(mutations[4]).toMatchObject({ type: 'delete', task: { id: 'srv-4' } });
    for (const fn of [taskService.createTask, taskService.updateTask, taskService.deleteTask]) expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 5, remaining: 0, rejected: [], blocked: null });
    expect(stored()).toEqual([]);
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 'srv-local-1' }), expect.anything());
    expect(cb.onTaskDeleted).toHaveBeenCalledWith('srv-4');
  });

  it('feeds a completion\'s Growth answer to the screen', async () => {
    seed([completion('k1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({ results: mutations.map((m) => ({ ...applied(m), growth: { xp: 5 } }) as SyncResult) }));
    const cb = callbacks();
    await processSyncQueue(cb);
    expect(cb.onGrowth).toHaveBeenCalledWith({ xp: 5 });
  });

  it('plans exactly what the loop would send: an update waiting behind no create, and a delete of a task the server never saw, are not sent', async () => {
    seed([update('u1', 'local-orphan'), remove('d1', 'local-never'), update('u2', 'srv-2')]);
    allApplied();
    const result = await processSyncQueue(callbacks());
    expect(sentBatches()[0].map((m) => m.type)).toEqual(['update']);
    expect(sentBatches()[0][0]).toMatchObject({ task: { id: 'srv-2' } });
    expect(stored().map((e) => e.id)).toEqual(['u1']); // the update that waits for a create that is not there stays queued, as before
    expect(result.processed).toBe(2);
  });

  it('an update that names completion state (a legacy shape) is not batched: the single request keeps its old handling', async () => {
    seed([update('u1', 'srv-1', { title: 'x', completed: true }), update('u2', 'srv-2')]);
    allApplied();
    vi.mocked(taskService.updateTask).mockImplementation(async (id) => ({ task: task(String(id)) }));
    await processSyncQueue(callbacks());
    expect(sentBatches()[0].map((m) => m.type === 'update' && 'id' in m.task && m.task.id)).toEqual(['srv-2']);
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskService.updateTask).mock.calls[0][0]).toBe('srv-1');
  });

  it('a completion for a task that only exists locally (no create queued) goes standalone, not in the batch', async () => {
    seed([completion('k1', 'local-gone'), update('u1', 'srv-1')]);
    allApplied();
    vi.mocked(completionService.postEvent).mockResolvedValue({ status: 201 } as never);
    await processSyncQueue(callbacks());
    expect(sentBatches()[0].map((m) => m.type)).toEqual(['update']);
    expect(completionService.postEvent).toHaveBeenCalledTimes(1);
  });

  it('a completion the server answers 404 (the task is gone) is delivered standalone, as before', async () => {
    seed([completion('k1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({
      results: mutations.map((m) => ({ mutationId: m.mutationId, status: 'rejected', retryable: false, error: { httpStatus: 404, message: 'Task not found' } }) as SyncResult),
    }));
    vi.mocked(completionService.postEvent).mockResolvedValue({ status: 201 } as never);
    const result = await processSyncQueue(callbacks());
    expect(completionService.postEvent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, remaining: 0, rejected: [] });
  });
});

describe('independent results (partial success)', () => {
  it('a refused mutation is discarded and reported; the others in the same request are settled normally', async () => {
    seed([update('u1', 'srv-1', { title: 'ok' }), update('u2', 'srv-2', { title: 'bad' }), update('u3', 'srv-3', { title: 'ok' })]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({
      results: mutations.map((m, i) =>
        i === 1
          ? ({ mutationId: m.mutationId, status: 'rejected', retryable: false, error: { httpStatus: 400, message: 'title must be a non-empty string' } } as SyncResult)
          : applied(m),
      ),
    }));
    const cb = callbacks();
    const result = await processSyncQueue(cb);
    expect(result).toMatchObject({ processed: 3, remaining: 0, blocked: null }); // processed counts every entry taken off the queue, refused or applied
    expect(result.rejected).toEqual([{ type: 'update', taskId: 'srv-2', title: 'bad', status: 400 }]);
    expect(cb.onTaskUpdated).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([]);
  });

  it('failed and skipped mutations stay queued, in order and untouched, and the run reports `unreachable`', async () => {
    const entries = [update('u1', 'srv-1'), update('u2', 'srv-1'), update('u3', 'srv-3')];
    seed(entries);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({
      results: [
        { mutationId: mutations[0].mutationId, status: 'failed', retryable: true, error: { message: 'busy' } },
        { mutationId: mutations[1].mutationId, status: 'skipped', retryable: true, error: { message: 'blocked', blockedBy: mutations[0].mutationId } },
        applied(mutations[2]),
      ] as SyncResult[],
    }));
    const result = await processSyncQueue(callbacks());
    expect(result).toMatchObject({ processed: 1, remaining: 2, blocked: 'unreachable', rejected: [] });
    expect(stored().map((e) => [e.id, e.mutationId])).toEqual([['u1', entries[0].mutationId], ['u2', entries[1].mutationId]]);
  });

  it('a retry reuses the stored mutation ids of what stayed queued', async () => {
    seed([update('u1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockImplementationOnce(async (mutations) => ({ results: [{ mutationId: mutations[0].mutationId, status: 'failed', retryable: true, error: { message: 'x' } }] as SyncResult[] }));
    await processSyncQueue(callbacks());
    allApplied();
    await processSyncQueue(callbacks());
    const [first, second] = sentBatches();
    expect(second[0].mutationId).toBe(first[0].mutationId);
  });

  it('a request that fails as a whole (network) keeps everything, reports `unreachable`, and never falls back to single requests', async () => {
    seed([update('u1', 'srv-1'), update('u2', 'srv-2')]);
    vi.mocked(taskService.syncBatch).mockRejectedValue(new Error('Network Error'));
    const result = await processSyncQueue(callbacks());
    expect(result).toMatchObject({ processed: 0, remaining: 2, blocked: 'unreachable' });
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });

  it('a 401 on the batch keeps every entry and reports `auth`', async () => {
    seed([update('u1', 'srv-1'), update('u2', 'srv-2')]);
    vi.mocked(taskService.syncBatch).mockRejectedValue(httpError(401));
    const result = await processSyncQueue(callbacks());
    expect(result).toMatchObject({ processed: 0, remaining: 2, blocked: 'auth' });
  });
});

describe('delete', () => {
  it('an already-deleted task is a success, not a "Not saved"', async () => {
    seed([remove('d1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({ results: mutations.map((m) => ({ mutationId: m.mutationId, status: 'applied', alreadyDeleted: true }) as SyncResult) }));
    const cb = callbacks();
    const result = await processSyncQueue(cb);
    expect(result).toMatchObject({ processed: 1, remaining: 0, rejected: [] });
    expect(cb.onTaskDeleted).toHaveBeenCalledWith('srv-1');
  });

  it('on the single-request path a 404 for a delete is a success too', async () => {
    seed([remove('d1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockRejectedValue(httpError(404)); // no batch route: one request per entry
    vi.mocked(taskService.deleteTask).mockRejectedValue(httpError(404));
    const result = await processSyncQueue(callbacks());
    expect(result).toMatchObject({ processed: 1, remaining: 0, rejected: [] });
  });
});

describe('size and shape limits', () => {
  it('splits more than 50 mutations into batches of at most 50, sent one after another in order', async () => {
    seed(Array.from({ length: 120 }, (_, i) => update(`u${i}`, `srv-${i}`)));
    allApplied();
    const result = await processSyncQueue(callbacks());
    expect(sentBatches().map((b) => b.length)).toEqual([50, 50, 20]);
    expect(sentBatches().flat().map((m) => m.type === 'update' && 'id' in m.task && m.task.id)).toEqual(Array.from({ length: 120 }, (_, i) => `srv-${i}`));
    expect(result.processed).toBe(120);
  });

  it('stops sending later batches once one comes back with something not applied: a later edit never overtakes an earlier one', async () => {
    seed(Array.from({ length: 120 }, (_, i) => update(`u${i}`, `srv-${i % 3}`)));
    vi.mocked(taskService.syncBatch)
      .mockImplementationOnce(async (mutations) => ({ results: mutations.map((m) => applied(m)) }))
      .mockImplementationOnce(async (mutations) => ({ results: mutations.map((m, i) => (i === 0 ? ({ mutationId: m.mutationId, status: 'failed', retryable: true, error: { message: 'busy' } } as SyncResult) : applied(m))) }));
    const result = await processSyncQueue(callbacks());
    expect(sentBatches().map((b) => b.length)).toEqual([50, 50]); // the third was never sent
    expect(result).toMatchObject({ blocked: 'unreachable' });
    expect(result.remaining).toBe(21 + 0); // 1 failed + the 20 of the unsent batch
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });

  it('a 413 splits the batch in halves; a single mutation that still gets 413 is refused for good ("Not saved")', async () => {
    seed([update('u1', 'srv-1'), update('u2', 'srv-2'), update('u3', 'srv-3', { title: 'huge' }), update('u4', 'srv-4')]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => {
      if (mutations.length > 1 || mutations[0].type === 'update' && mutations[0].payload.title === 'huge') throw httpError(413);
      return { results: mutations.map((m) => applied(m)) };
    });
    const result = await processSyncQueue(callbacks());
    expect(sentBatches().map((b) => b.length)).toEqual([4, 2, 1, 1, 2, 1, 1]); // 4 -> 2+2; each half -> 1+1; the huge one alone is refused
    expect(result.rejected).toEqual([{ type: 'update', taskId: 'srv-3', title: 'huge', status: 413 }]);
    expect(result).toMatchObject({ processed: 4, remaining: 0 });
  });
});

describe('compatibility', () => {
  it('a server without the batch route (404) is served one request per entry, and the batch is not tried again', async () => {
    seed([update('u1', 'srv-1'), update('u2', 'srv-2')]);
    vi.mocked(taskService.syncBatch).mockRejectedValue(httpError(404));
    vi.mocked(taskService.updateTask).mockImplementation(async (id) => ({ task: task(String(id)) }));
    const first = await processSyncQueue(callbacks());
    expect(first).toMatchObject({ processed: 2, remaining: 0, blocked: null });
    expect(taskService.updateTask).toHaveBeenCalledTimes(2);

    seed([update('u3', 'srv-3')]);
    await processSyncQueue(callbacks());
    expect(taskService.syncBatch).toHaveBeenCalledTimes(1); // not asked again
    expect(taskService.updateTask).toHaveBeenCalledTimes(3);
  });

  it('a batch refused as malformed (400 INVALID_SYNC_REQUEST) falls back for this run only', async () => {
    seed([update('u1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockRejectedValueOnce(httpError(400, { code: 'INVALID_SYNC_REQUEST', message: 'x' }));
    vi.mocked(taskService.updateTask).mockImplementation(async (id) => ({ task: task(String(id)) }));
    await processSyncQueue(callbacks());
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);

    seed([update('u2', 'srv-2')]);
    allApplied();
    await processSyncQueue(callbacks());
    expect(taskService.syncBatch).toHaveBeenCalledTimes(2); // asked again
  });

  it('an answer that does not match the request is not trusted: one request per entry', async () => {
    seed([update('u1', 'srv-1')]);
    vi.mocked(taskService.syncBatch).mockResolvedValue({ results: [] });
    vi.mocked(taskService.updateTask).mockImplementation(async (id) => ({ task: task(String(id)) }));
    const result = await processSyncQueue(callbacks());
    expect(result).toMatchObject({ processed: 1, remaining: 0 });
    expect(taskService.updateTask).toHaveBeenCalledTimes(1);
  });
});

describe('mutation ids', () => {
  it('an entry queued before mutation ids existed gets one, STORED before anything is sent', async () => {
    const legacy: SyncQueueRecord = { id: 'old', type: 'update', taskId: 'srv-1', payload: { title: 'x' }, createdAt: 1 };
    seed([legacy]);
    let storedDuringSend: string | undefined;
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => {
      storedDuringSend = stored()[0]?.mutationId;
      return { results: [{ mutationId: mutations[0].mutationId, status: 'failed', retryable: true, error: { message: 'x' } }] as SyncResult[] };
    });
    await processSyncQueue(callbacks());
    expect(storedDuringSend).toBeTruthy();
    expect(sentBatches()[0][0].mutationId).toBe(storedDuringSend);
    expect(stored()[0].mutationId).toBe(storedDuringSend); // and it survived the run, so the retry uses it
  });
});

describe('an edit made while the request is out (the in-flight merge)', () => {
  it('the answer to M1 does not settle the entry as it is now: the later edit is kept, under a NEW mutation id, and goes out next run as its own change', async () => {
    seed([update('u1', 'srv-1', { title: 'One' })]);
    const m1 = stored()[0].mutationId as string;
    let afterMerge: SyncQueueRecord[] = [];
    vi.mocked(taskService.syncBatch).mockImplementationOnce(async (mutations) => {
      // while M1 is on the wire the user edits the same task: the edit merges into the queued entry (same entry id)
      afterMerge = await enqueueSyncAction({ type: 'update', taskId: 'srv-1', payload: { priority: 'high' } });
      return { results: mutations.map((m) => applied(m)) };
    });
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(afterMerge).toHaveLength(1);
    expect(afterMerge[0].id).toBe('u1'); // identity survives the merge
    const m2 = afterMerge[0].mutationId as string;
    expect(m2).not.toBe(m1); // ...the mutation id does not: it names the payload as it is now
    // M1's answer settled what M1 carried; what was merged after is what remains, and only that
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ type: 'update', taskId: 'srv-1', payload: { priority: 'high' } });
    expect(stored()[0].payload).not.toHaveProperty('title');
    expect(stored()[0].mutationId).not.toBe(m1);
    expect(stored()[0].mutationId).not.toBe(m2); // the residual is a different change from the merged entry too: its own id
    expect(cb.onTaskUpdated).not.toHaveBeenCalled(); // an answer older than the screen is never laid over it

    allApplied();
    await processSyncQueue(cb);
    const second = sentBatches()[1];
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'update', payload: { priority: 'high' } });
    expect(second[0].mutationId).not.toBe(m1);
    expect(stored()).toEqual([]);
  });
});

describe('a create the server already made (replayed)', () => {
  it('only what the server\'s task already holds counts as sent: an edit merged in since is queued as an update', async () => {
    seed([create('c1', 'local-1', { title: 'T', priority: 'high' })]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({
      results: mutations.map((m) => ({ mutationId: m.mutationId, status: 'replayed', task: task('srv-1', { title: 'T', priority: 'low' }) }) as SyncResult),
    }));
    const cb = callbacks();
    const result = await processSyncQueue(cb);
    expect(result).toMatchObject({ processed: 1 });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ type: 'update', taskId: 'srv-1', payload: { priority: 'high' } });
    expect(stored()[0].payload).not.toHaveProperty('title');
    expect(cb.onTaskCreated).toHaveBeenCalledWith('local-1', expect.objectContaining({ _id: 'srv-1' }), { stale: true });
  });

  it('a replay that matches the entry settles it completely', async () => {
    seed([create('c1', 'local-1', { title: 'T', priority: 'high' })]);
    vi.mocked(taskService.syncBatch).mockImplementation(async (mutations) => ({
      results: mutations.map((m) => ({ mutationId: m.mutationId, status: 'replayed', task: task('srv-1', { title: 'T', priority: 'high' }) }) as SyncResult),
    }));
    await processSyncQueue(callbacks());
    expect(stored()).toEqual([]);
  });
});
