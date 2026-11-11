import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #47, Phase 2E: the client completion-event pipeline, end to end against a fake server.
//
// The REAL pieces run: the completion transition, the sync queue, the queue processor, the task and completion services, the
// API client (its real interceptor puts the signed-in user's token on every request) and the history reconcile. Only the
// storage and the network end are doubles. The fake server follows the server's documented rules (halotasks-server
// completionRecords.ts / taskCompletion.ts): a record is keyed by (user, completionId), a repeat is a no-op, a task holds at
// most one active completion, the window is 90 days back and 5 minutes ahead, a standalone event for a task that still exists
// is a 409, and history is canonical for any day that has a record. What it proves is what the CLIENT sends and does.

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

import { apiClient } from '../services/api';
import { useDashboardTasks } from '../hooks/useDashboardTasks';
import { useAuthStore } from '../store/authStore';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { enqueueCompletion, makeCompletionTransition, parseCompletionEntry } from './completionEvents';
import { getUnreconciledCompletions, getWeekHistory, requestHistoryReconcile, resetHistoryState, updateTodaySnapshot } from './history';
import { processSyncQueue } from './queueProcessor';
import { enqueueSyncAction, getSyncQueue, resetSyncQueueState } from './syncQueue';

// ── Fake server ─────────────────────────────────────────────────────────────

type Rec = { completionId: string; taskId: string; title: string; estimatedMinutes: number; completedAt: string; utcOffsetMinutes: number; status: 'active' | 'revoked' };
type ServerTask = { _id: string; title: string; estimatedMinutes: number; completed: boolean; completedAt: string | null; completionId: string | null };

const users = new Map<string, { tasks: Map<string, ServerTask>; records: Map<string, Rec> }>();
const sent: { userId: string; method: string; url: string; body: any }[] = [];
let offline = false;
/** Fails task writes (PUT /api/tasks/:id) with a network error while every other request still works. */
let failTaskPuts = false;
/** The task write is APPLIED (the completion is stored), then the answer is lost: the client sees a network error. */
let loseTaskPutResponses = false;
/** Task writes are refused with this status before anything is stored (503: transient; 400: permanent). */
let refuseTaskPutsWith: number | null = null;
let nextTaskId = 1;

const state = (userId: string) => {
  if (!users.has(userId)) users.set(userId, { tasks: new Map(), records: new Map() });
  return users.get(userId)!;
};
const currentUser = () => useAuthStore.getState().user!.id;

const reply = (config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosResponse => ({ data: structuredClone(data), status, statusText: String(status), headers: {}, config });
const fail = (config: InternalAxiosRequestConfig, status: number, data: unknown): never => {
  throw new AxiosError('error', 'ERR_BAD_REQUEST', config, undefined, reply(config, status, data));
};

const dateAtOffset = (iso: string, offset: number) => new Date(new Date(iso).getTime() + offset * 60_000).toISOString().slice(0, 10);
const withinWindow = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= Date.now() - 90 * 86_400_000 && t <= Date.now() + 5 * 60_000;
};
const validComplete = (e: any) =>
  e && /^[A-Za-z0-9_-]{1,64}$/.test(e.completionId ?? '') && withinWindow(e.completedAt) && Number.isInteger(e.utcOffsetMinutes) && e.utcOffsetMinutes >= -720 && e.utcOffsetMinutes <= 840;

/** One record per (user, completionId); a repeat changes nothing; a task holds one active completion. */
const storeComplete = (u: ReturnType<typeof state>, e: any, taskId: string, title: string, estimatedMinutes: number) => {
  if (u.records.has(e.completionId)) return 'duplicate';
  const holder = [...u.records.values()].some((r) => r.taskId === taskId && r.status === 'active');
  u.records.set(e.completionId, { completionId: e.completionId, taskId, title, estimatedMinutes, completedAt: e.completedAt, utcOffsetMinutes: e.utcOffsetMinutes, status: holder ? 'revoked' : 'active' });
  return holder ? 'superseded' : 'created';
};
const storeRevoke = (u: ReturnType<typeof state>, completionId: string | undefined, taskId: string) => {
  const target = completionId ? u.records.get(completionId) : [...u.records.values()].find((r) => r.taskId === taskId && r.status === 'active');
  if (target) target.status = 'revoked';
};

const handle = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
  const userId = currentUser();
  const u = state(userId);
  const url = config.url ?? '';
  const method = (config.method ?? 'get').toLowerCase();
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  sent.push({ userId, method, url, body });
  if (offline || (failTaskPuts && method === 'put' && /^\/api\/tasks\//.test(url))) throw new AxiosError('Network Error', 'ERR_NETWORK', config);

  if (method === 'post' && url === '/api/tasks') {
    const task: ServerTask = { _id: `srv-${nextTaskId++}`, title: body.title, estimatedMinutes: body.estimatedMinutes ?? 0, completed: false, completedAt: null, completionId: null };
    u.tasks.set(task._id, task);
    return reply(config, 201, { task });
  }
  const taskMatch = url.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === 'put' && taskMatch && refuseTaskPutsWith !== null) return fail(config, refuseTaskPutsWith, { message: 'refused' });
  if (method === 'put' && taskMatch) {
    const task = u.tasks.get(taskMatch[1]);
    if (!task) return fail(config, 404, { message: 'Task not found' });
    if (typeof body.title === 'string') task.title = body.title;
    const event = body.completionEvent;
    if (event !== undefined) {
      if (body.completed === true) {
        if (!validComplete(event)) return fail(config, 400, { code: 'COMPLETION_EVENT_INVALID' });
        const outcome = storeComplete(u, event, task._id, task.title, task.estimatedMinutes);
        if (outcome === 'created') Object.assign(task, { completed: true, completedAt: new Date().toISOString(), completionId: event.completionId });
        else if (!task.completed) Object.assign(task, { completed: true }); // superseded/duplicate: the task is still completed
      } else {
        storeRevoke(u, event.completionId, task._id);
        Object.assign(task, { completed: false, completedAt: null });
      }
    }
    if (loseTaskPutResponses) throw new AxiosError('Network Error', 'ERR_NETWORK', config); // applied, answer lost
    return reply(config, 200, { task: { ...task } });
  }
  if (method === 'delete' && taskMatch) {
    u.tasks.delete(taskMatch[1]);
    return reply(config, 200, {});
  }
  if (method === 'post' && url === '/api/completion-events') {
    if (u.tasks.has(body.taskId)) return fail(config, 409, { code: 'COMPLETION_TASK_EXISTS' });
    if (body.type === 'complete') {
      if (!validComplete(body)) return fail(config, 400, { code: 'COMPLETION_EVENT_INVALID' });
      return reply(config, 200, { completion: { outcome: storeComplete(u, body, body.taskId, body.title, body.estimatedMinutes) } });
    }
    storeRevoke(u, body.completionId, body.taskId);
    return reply(config, 200, { completion: { outcome: 'revoked' } });
  }
  if (method === 'get' && url === '/api/history') {
    const { days, endDate, utcOffsetMinutes } = config.params;
    const history = Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.UTC(+endDate.slice(0, 4), +endDate.slice(5, 7) - 1, +endDate.slice(8, 10) - (days - 1 - i))).toISOString().slice(0, 10);
      const own = [...u.records.values()].filter((r) => dateAtOffset(r.completedAt, r.utcOffsetMinutes) === date);
      if (own.length === 0) return { date, completedCount: 0, workDoneMinutes: 0, completedTasks: [], updatedAt: null, source: 'none' };
      const active = own.filter((r) => r.status === 'active');
      return {
        date,
        completedCount: active.length,
        workDoneMinutes: active.reduce((s, r) => s + r.estimatedMinutes, 0),
        completedTasks: active.map((r) => ({ taskId: r.taskId, title: r.title, estimatedMinutes: r.estimatedMinutes })),
        updatedAt: '2026-11-11T00:00:00.000Z',
        source: 'canonical',
      };
    });
    void utcOffsetMinutes;
    return reply(config, 200, { history });
  }
  if (url.startsWith('/api/history/')) {
    return reply(config, 200, { entry: body }); // legacy write: acknowledged, never read for a canonical day
  }
  return fail(config, 404, {});
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };
const signIn = (user: typeof USER_A) => useAuthStore.setState({ token: `token-${user.id}`, user });
const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const NOW = '2026-11-11T06:00:00Z';
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const events = () => sent.filter((r) => r.url === '/api/completion-events');
const taskWrites = () => sent.filter((r) => r.method === 'put' && r.url.startsWith('/api/tasks/'));
const historyPuts = () => sent.filter((r) => r.method === 'put' && r.url.startsWith('/api/history/'));
const records = (userId = 'user-a') => [...state(userId).records.values()];

const seedTask = (userId = 'user-a', extra: Partial<ServerTask> = {}): ServerTask => {
  const task: ServerTask = { _id: `srv-${nextTaskId++}`, title: 'Write report', estimatedMinutes: 30, completed: false, completedAt: null, completionId: null, ...extra };
  state(userId).tasks.set(task._id, task);
  return task;
};
const localOf = (t: ServerTask, extra: Partial<Task> = {}): Task => makeTask({ _id: t._id, title: t.title, estimatedMinutes: t.estimatedMinutes, completed: t.completed, completionId: t.completionId, ...extra });

const run = (callbacks: Partial<Parameters<typeof processSyncQueue>[0]> = {}) =>
  processSyncQueue({ onTaskCreated: vi.fn(), onTaskUpdated: vi.fn(), onTaskDeleted: vi.fn(), ...callbacks });

/** What the dashboard does for an offline tap: build the event from the task as it is, queue it, return the new local task. */
const tapOffline = async (task: Task, at?: string) => {
  if (at) vi.setSystemTime(new Date(at));
  const transition = makeCompletionTransition(task);
  await enqueueCompletion(task._id, transition.entry);
  return { ...task, ...transition.localPatch } as Task;
};

beforeEach(() => {
  db.store.clear();
  users.clear();
  sent.length = 0;
  offline = false;
  failTaskPuts = false;
  loseTaskPutResponses = false;
  refuseTaskPutsWith = null;
  nextTaskId = 1;
  nodeEnv.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetSyncQueueState();
  resetHistoryState();
  apiClient.defaults.adapter = handle as never;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  signIn(USER_A);
});

afterEach(() => {
  vi.useRealTimers();
  delete nodeEnv.TZ;
  vi.restoreAllMocks();
  useAuthStore.setState({ token: null, user: null });
});

// ── The event itself ────────────────────────────────────────────────────────

describe('the completion event', () => {
  it('completing creates exactly one event: a fresh id, the instant now and the device offset', () => {
    nodeEnv.TZ = 'Asia/Kolkata';
    const t = makeCompletionTransition(makeTask({ _id: 't1', title: ' Write report ', estimatedMinutes: 25 }));
    expect(t.completed).toBe(true);
    expect(t.event).toEqual({ completionId: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), completedAt: NOW.replace('Z', '.000Z'), utcOffsetMinutes: 330 });
    expect(t.entry).toMatchObject({ kind: 'complete', title: 'Write report', estimatedMinutes: 25 });
    expect(t.localPatch).toMatchObject({ completed: true, completionId: t.event.completionId });
  });

  it('every transition makes a NEW id (never reused across completions)', () => {
    const a = makeCompletionTransition(makeTask({ _id: 't1' }));
    const b = makeCompletionTransition(makeTask({ _id: 't1' }));
    expect((a.event as any).completionId).not.toBe((b.event as any).completionId);
  });

  it('un-completing is a revocation that names the completion the task holds, and keeps the pointer locally', () => {
    const t = makeCompletionTransition(makeTask({ _id: 't1', completed: true, completionId: 'c-held' }));
    expect(t.completed).toBe(false);
    expect(t.event).toEqual({ completionId: 'c-held', revokedAt: expect.any(String) });
    expect(t.entry.kind).toBe('revoke');
    expect('completionId' in t.localPatch).toBe(false); // the pointer is not cleared
  });

  it('a task completed before records existed is revoked without naming one', () => {
    const t = makeCompletionTransition(makeTask({ _id: 't1', completed: true }));
    expect(t.event).toEqual({ revokedAt: expect.any(String) });
  });

  it('a malformed queue payload is never trusted', () => {
    const good = { kind: 'complete', completionId: 'c1', completedAt: NOW, utcOffsetMinutes: 0, title: 'x', estimatedMinutes: 1 };
    expect(parseCompletionEntry(good)).not.toBeNull();
    for (const bad of [
      null, [], { ...good, kind: 'other' }, { ...good, completionId: 'bad id!' }, { ...good, completionId: undefined }, { ...good, completedAt: 'nope' },
      { ...good, utcOffsetMinutes: 1.5 }, { ...good, utcOffsetMinutes: 900 }, { ...good, title: '' }, { ...good, estimatedMinutes: -1 },
      { kind: 'revoke', revokedAt: 'nope', title: 'x', estimatedMinutes: 1 },
    ]) {
      expect(parseCompletionEntry(bad)).toBeNull();
    }
  });
});

// ── Queue behaviour ─────────────────────────────────────────────────────────

describe('the sync queue', () => {
  it('queuing the same event twice stores it once', async () => {
    const task = makeTask({ _id: 'srv-1' });
    const { entry } = makeCompletionTransition(task);
    await enqueueCompletion('srv-1', entry);
    await enqueueCompletion('srv-1', entry);
    expect(await getSyncQueue()).toHaveLength(1);
  });

  it('complete → un-complete → complete stays three events (nothing coalesces)', async () => {
    const server = seedTask();
    let local = localOf(server);
    local = await tapOffline(local);
    local = await tapOffline(local);
    local = await tapOffline(local);
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.payload?.kind)).toEqual(['complete', 'revoke', 'complete']);

    await run();

    expect(taskWrites().map((w) => w.body.completed)).toEqual([true, false, true]);
    // two completions, the first revoked by the second transition, the last one active: exactly one counts
    expect(records().map((r) => r.status)).toEqual(['revoked', 'active']);
    expect(state('user-a').tasks.get(server._id)).toMatchObject({ completed: true });
  });

  it('a completion never merges into an edit, and no edit merges into it (edits keep merging with each other, as before)', async () => {
    const server = seedTask();
    await enqueueSyncAction({ type: 'update', taskId: server._id, payload: { title: 'Renamed' } });
    await tapOffline(localOf(server));
    await enqueueSyncAction({ type: 'update', taskId: server._id, payload: { priority: 'high' } });

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.type)).toEqual(['update', 'completion']);
    expect(queue[0].payload).toMatchObject({ title: 'Renamed', priority: 'high' }); // the two edits merged, as they always did
    expect(queue[1].payload).toMatchObject({ kind: 'complete' }); // the completion is untouched
    expect(queue[1].payload).not.toHaveProperty('priority');
  });

  it('a delete of the task does not drop its completion entry', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    await enqueueSyncAction({ type: 'delete', taskId: server._id });
    expect((await getSyncQueue()).map((q) => q.type)).toEqual(['completion', 'delete']);
  });
});

// ── Delivery ────────────────────────────────────────────────────────────────

describe('offline completion → reconnect → server', () => {
  it('delivers once on the task write, with the event made at tap time, and empties the queue', async () => {
    const server = seedTask();
    vi.setSystemTime(new Date('2026-11-11T05:00:00Z'));
    await tapOffline(localOf(server));
    vi.setSystemTime(new Date(NOW)); // reconnects an hour later

    const onTaskUpdated = vi.fn();
    const result = await run({ onTaskUpdated });

    expect(result.remaining).toBe(0);
    expect(taskWrites()).toHaveLength(1);
    expect(taskWrites()[0].body).toEqual({ completed: true, completionEvent: { completionId: expect.any(String), completedAt: '2026-11-11T05:00:00.000Z', utcOffsetMinutes: 0 } });
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ taskId: server._id, status: 'active', completedAt: '2026-11-11T05:00:00.000Z' });
    expect(onTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it('delivery asks for a history reconcile but acknowledges nothing by itself', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    const onCompletionsDelivered = vi.fn();
    await run({ onCompletionsDelivered });
    expect(onCompletionsDelivered).toHaveBeenCalledTimes(1);
    expect(getUnreconciledCompletions).toBeTypeOf('function');
  });

  it('a network failure leaves the entry queued, and the retry makes no second record', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    offline = true;
    expect((await run()).remaining).toBe(1);
    expect(records()).toHaveLength(0);

    offline = false;
    expect((await run()).remaining).toBe(0);
    expect(records()).toHaveLength(1);
  });

  it('re-processing the same event (delivered, but the reply was lost) is idempotent', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    const [queued] = await getSyncQueue();
    await run();
    // the device never learned of the success: the same entry is back in the queue and goes out again
    db.store.set('sync_queue:user-a', [queued]);
    resetSyncQueueState();
    await run();

    expect(taskWrites()).toHaveLength(2);
    expect(records()).toHaveLength(1);
    expect(records()[0].status).toBe('active');
  });

  it('survives a reload while pending: the stored entry is delivered by a fresh session of the app', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    resetSyncQueueState();
    resetHistoryState();
    expect(await getSyncQueue()).toHaveLength(1);
    await run();
    expect(records()).toHaveLength(1);
  });

  it('the same completion queued from two devices becomes one record per id; one task holds one active completion', async () => {
    const server = seedTask();
    await tapOffline(localOf(server)); // device 1
    await run();
    // device 2 never saw device 1's completion: it still shows the task open, so its own tap makes its own id
    await tapOffline(localOf(server, { completed: false, completionId: null }));
    await run();

    expect(records()).toHaveLength(2);
    expect(records().filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('a refused event (bad window) rejects only itself: it is discarded, not retried forever, and later entries still go', async () => {
    const server = seedTask();
    const other = seedTask();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z')); // > 90 days before NOW
    await tapOffline(localOf(server));
    vi.setSystemTime(new Date(NOW));
    await tapOffline(localOf(other));

    const result = await run();

    expect(result.remaining).toBe(0);
    expect(records().map((r) => r.taskId)).toEqual([other._id]);
  });

  it('a malformed stored entry is discarded without being sent', async () => {
    const server = seedTask();
    db.store.set('sync_queue:user-a', [{ id: 'q1', type: 'completion', taskId: server._id, payload: { kind: 'complete', completionId: 'bad id' }, createdAt: 1 }]);
    resetSyncQueueState();
    expect((await run()).remaining).toBe(0);
    expect(sent.filter((r) => r.url !== '/api/history')).toHaveLength(0);
  });
});

// ── Deletion, offline creation ──────────────────────────────────────────────

describe('a task that is gone', () => {
  it('deleted on the server before delivery: the completion is delivered standalone and survives', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    state('user-a').tasks.delete(server._id); // another device deleted it

    await run();

    expect(events()).toHaveLength(1);
    expect(events()[0].body).toMatchObject({ type: 'complete', taskId: server._id, title: 'Write report', estimatedMinutes: 30 });
    expect(records()).toHaveLength(1);
    expect(records()[0].status).toBe('active');
  });

  it('completed then deleted while offline: the delete runs and the completion is still recorded', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    await enqueueSyncAction({ type: 'delete', taskId: server._id });

    await run();

    expect(state('user-a').tasks.has(server._id)).toBe(false);
    expect(records()).toHaveLength(1);
  });

  it('created, completed and deleted offline: the task never existed on the server, the completion still does', async () => {
    const localId = 'local-1';
    await enqueueSyncAction({ type: 'create', taskId: localId, payload: { title: 'Ephemeral', estimatedMinutes: 12 } });
    await tapOffline(makeTask({ _id: localId, title: 'Ephemeral', estimatedMinutes: 12 }));
    await enqueueSyncAction({ type: 'delete', taskId: localId });
    expect((await getSyncQueue()).map((q) => q.type)).toContain('completion');

    const result = await run();

    expect(result.remaining).toBe(0);
    expect(events()).toHaveLength(1);
    expect(records()).toEqual([expect.objectContaining({ taskId: localId, title: 'Ephemeral', estimatedMinutes: 12, status: 'active' })]);
  });

  it('created then completed offline (task still alive): the create goes first, the completion follows on the server id', async () => {
    const localId = 'local-2';
    await enqueueSyncAction({ type: 'create', taskId: localId, payload: { title: 'New', estimatedMinutes: 5 } });
    await tapOffline(makeTask({ _id: localId, title: 'New', estimatedMinutes: 5 }));

    const onTaskCreated = vi.fn();
    const result = await run({ onTaskCreated });

    expect(result.remaining).toBe(0);
    expect(onTaskCreated).toHaveBeenCalledTimes(1);
    expect(onTaskCreated.mock.calls[0][1]).toMatchObject({ completed: true }); // the pending completion is laid over the created task
    expect(records()).toEqual([expect.objectContaining({ taskId: 'srv-1', status: 'active' })]);
    expect(events()).toHaveLength(0);
  });

  it('a standalone event for a task that exists after all stays queued (409), never dropped', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    // a transient 404 on the task write while the task exists: standalone answers 409, the entry must survive
    const original = state('user-a').tasks.get(server._id)!;
    state('user-a').tasks.delete(server._id);
    const originalHandler = apiClient.defaults.adapter;
    apiClient.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/completion-events') state('user-a').tasks.set(server._id, original);
      return (originalHandler as any)(config);
    }) as never;

    expect((await run()).remaining).toBe(1);
  });
});

describe('replay details', () => {
  it('an edit queued ahead of a completion does not flash the pre-completion server answer into the UI', async () => {
    const server = seedTask();
    await enqueueSyncAction({ type: 'update', taskId: server._id, payload: { title: 'Renamed' } });
    await tapOffline(localOf(server));

    const onTaskUpdated = vi.fn();
    await run({ onTaskUpdated });

    expect(onTaskUpdated).toHaveBeenCalledTimes(1);
    expect(onTaskUpdated.mock.calls[0][1]).toMatchObject({ title: 'Renamed', completed: true });
  });

  it('a run with no completion entries, or whose completion was not delivered, does not ask for a history reconcile', async () => {
    const server = seedTask();
    await enqueueSyncAction({ type: 'update', taskId: server._id, payload: { title: 'Renamed' } });
    const onCompletionsDelivered = vi.fn();
    await run({ onCompletionsDelivered });
    expect(onCompletionsDelivered).not.toHaveBeenCalled();

    await tapOffline(localOf(server));
    offline = true;
    await run({ onCompletionsDelivered });
    expect(onCompletionsDelivered).not.toHaveBeenCalled();
  });

  it('when a run stops right after a task was created, the waiting completion is re-pointed at the server id, so the next run delivers it on the task write', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-7', payload: { title: 'New', estimatedMinutes: 5 } });
    await tapOffline(makeTask({ _id: 'local-7', title: 'New', estimatedMinutes: 5 }));

    failTaskPuts = true; // the create works, the completion write does not
    expect((await run()).remaining).toBe(1);
    expect((await getSyncQueue())[0]).toMatchObject({ type: 'completion', taskId: 'srv-1' });

    failTaskPuts = false;
    expect((await run()).remaining).toBe(0);
    expect(records()).toEqual([expect.objectContaining({ taskId: 'srv-1', status: 'active' })]);
    expect(events()).toHaveLength(0);
  });
});

// ── Online failure boundary (Phase 2E review) ───────────────────────────────

describe('an online completion whose request fails', () => {
  const setStatusError = vi.fn();
  const setStatusInfo = vi.fn();

  const mountDashboard = (initial: Task[]) =>
    renderHook(() => {
      const [tasks, setTasks] = useState<Task[]>(initial);
      const hook = useDashboardTasks({
        tasks,
        setTasks,
        isOnline: true,
        syncBridgeRef: { current: { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0) } },
        previewGrowthForCompletion: vi.fn(),
        applyServerGrowth: vi.fn(),
        setStatusError,
        setStatusInfo,
      });
      return { hook, tasks };
    });

  const sentEventIds = () =>
    taskWrites()
      .map((w) => w.body.completionEvent?.completionId)
      .filter((id): id is string => typeof id === 'string');
  const queuedIds = async () => (await getSyncQueue()).map((q) => q.payload?.completionId);

  beforeEach(() => {
    setStatusError.mockClear();
    setStatusInfo.mockClear();
  });

  it('the server stored the completion but the answer was lost: the SAME event is queued, the retry sends the same id, and the server ends with exactly one record', async () => {
    const server = seedTask();
    const m = mountDashboard([localOf(server)]);
    loseTaskPutResponses = true;

    await act(() => m.result.current.hook.handleToggleTask(m.result.current.tasks[0]));

    // the first request reached the server and was applied
    expect(records()).toHaveLength(1);
    const original = records()[0].completionId;
    expect(sentEventIds()).toEqual([original]);
    // the client kept exactly that event
    expect(await queuedIds()).toEqual([original]);
    expect(m.result.current.tasks[0]).toMatchObject({ completed: true, pendingSync: true, completionId: original });
    expect(setStatusError).not.toHaveBeenCalledWith(expect.any(String)); // (null is the hook clearing the status)

    // the retry (queue replay) sends the same id
    loseTaskPutResponses = false;
    const result = await run();

    expect(result.remaining).toBe(0);
    expect(new Set(sentEventIds())).toEqual(new Set([original])); // no second completion id was ever generated
    expect(sentEventIds()).toHaveLength(2);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ completionId: original, status: 'active' });
    expect(state('user-a').tasks.get(server._id)).toMatchObject({ completed: true, completionId: original });
  });

  it('the same holds for a re-open: the lost revocation is queued with the id it names, and the record ends revoked exactly once', async () => {
    const server = seedTask();
    const first = makeCompletionTransition(localOf(server));
    await taskServiceComplete(server._id, first.event);
    const completed = localOf(state('user-a').tasks.get(server._id)!);
    expect(completed.completionId).toBe((first.event as { completionId: string }).completionId);

    const m = mountDashboard([completed]);
    loseTaskPutResponses = true;
    await act(() => m.result.current.hook.handleToggleTask(m.result.current.tasks[0]));

    expect((await getSyncQueue()).map((q) => [q.payload?.kind, q.payload?.completionId])).toEqual([['revoke', completed.completionId]]);
    expect(m.result.current.tasks[0]).toMatchObject({ completed: false, pendingSync: true });

    loseTaskPutResponses = false;
    expect((await run()).remaining).toBe(0);
    expect(records().map((r) => r.status)).toEqual(['revoked']);
  });

  it('a transient server error (503) queues the event too; a permanent refusal (400) does not', async () => {
    const a = seedTask();
    const transient = mountDashboard([localOf(a)]);
    refuseTaskPutsWith = 503;
    await act(() => transient.result.current.hook.handleToggleTask(transient.result.current.tasks[0]));
    expect(await getSyncQueue()).toHaveLength(1);
    expect(transient.result.current.tasks[0]).toMatchObject({ completed: true, pendingSync: true });

    await getSyncQueue();
    db.store.clear();
    resetSyncQueueState();

    const b = seedTask();
    const permanent = mountDashboard([localOf(b)]);
    refuseTaskPutsWith = 400;
    await act(() => permanent.result.current.hook.handleToggleTask(permanent.result.current.tasks[0]));
    expect(await getSyncQueue()).toHaveLength(0);
    expect(permanent.result.current.tasks[0].completed).toBe(false); // untouched
    expect(setStatusError).toHaveBeenCalledWith(expect.any(String));
  });

  it('bulk complete: every task whose answer was lost keeps its OWN event (distinct ids), and the retry gives one record each', async () => {
    const a = seedTask();
    const b = seedTask();
    const m = mountDashboard([localOf(a), localOf(b)]);
    act(() => m.result.current.hook.toggleSelect(a._id));
    act(() => m.result.current.hook.toggleSelect(b._id));
    loseTaskPutResponses = true;

    await act(() => m.result.current.hook.handleMarkSelectedComplete());

    const original = records().map((r) => r.completionId).sort();
    expect(original).toHaveLength(2);
    expect(new Set(original).size).toBe(2);
    expect((await queuedIds()).sort()).toEqual(original);
    expect(m.result.current.tasks.every((t) => t.completed && t.pendingSync)).toBe(true);
    expect(setStatusError).not.toHaveBeenCalledWith(expect.any(String)); // (null is the hook clearing the status)

    loseTaskPutResponses = false;
    expect((await run()).remaining).toBe(0);
    expect(records().map((r) => r.completionId).sort()).toEqual(original);
    expect(records().every((r) => r.status === 'active')).toBe(true);
  });

  it('bulk complete with a permanent refusal queues nothing and keeps the tasks selected for another try', async () => {
    const a = seedTask();
    const m = mountDashboard([localOf(a)]);
    act(() => m.result.current.hook.toggleSelect(a._id));
    refuseTaskPutsWith = 400;

    await act(() => m.result.current.hook.handleMarkSelectedComplete());

    expect(await getSyncQueue()).toHaveLength(0);
    expect(m.result.current.tasks[0].completed).toBe(false);
    expect(setStatusError).toHaveBeenCalledWith(expect.any(String));
  });
});

/** Sends one completion to the fake server directly, the way an earlier online write would have. */
const taskServiceComplete = async (taskId: string, event: unknown) => {
  await apiClient.put(`/api/tasks/${taskId}`, { completed: true, completionEvent: event });
};

// ── Revocation ──────────────────────────────────────────────────────────────

describe('uncompleting', () => {
  it('revokes the completion it names; history reads zero for the day', async () => {
    const server = seedTask();
    let local = await tapOffline(localOf(server));
    await run();
    local = { ...local, completionId: state('user-a').tasks.get(server._id)!.completionId };
    await tapOffline(local);
    await run();

    expect(records().map((r) => r.status)).toEqual(['revoked']);
    const week = await getWeekHistory();
    expect(week[week.length - 1]).toMatchObject({ completedCount: 0 });
  });

  it('a revoke whose task and completion are both unknown is discarded, not retried', async () => {
    await enqueueCompletion('srv-gone', { kind: 'revoke', revokedAt: NOW, title: 'x', estimatedMinutes: 1 });
    expect((await run()).remaining).toBe(0);
    expect(events()).toHaveLength(0);
  });
});

// ── Local date boundary ─────────────────────────────────────────────────────

describe('local calendar date', () => {
  it('an offline completion just after local midnight lands on the LOCAL day it happened, even when delivered much later', async () => {
    nodeEnv.TZ = 'Asia/Kolkata'; // UTC+5:30
    const server = seedTask();
    // 00:10 on 2026-11-11 in Kolkata = 2026-11-10T18:40Z
    await tapOffline(localOf(server), '2026-11-10T18:40:00Z');
    vi.setSystemTime(new Date('2026-11-11T06:00:00Z'));
    await run();

    const r = records()[0];
    expect(r).toMatchObject({ completedAt: '2026-11-10T18:40:00.000Z', utcOffsetMinutes: 330 });
    expect(dateAtOffset(r.completedAt, r.utcOffsetMinutes)).toBe('2026-11-11');
  });

  it('the offset is the one in force AT the tap (DST), not at delivery', async () => {
    nodeEnv.TZ = 'America/New_York';
    const summer = makeCompletionTransition(makeTask({ _id: 'a' }), new Date('2026-07-01T12:00:00Z'));
    const winter = makeCompletionTransition(makeTask({ _id: 'b' }), new Date('2026-12-01T12:00:00Z'));
    expect((summer.event as any).utcOffsetMinutes).toBe(-240);
    expect((winter.event as any).utcOffsetMinutes).toBe(-300);
  });
});

// ── User isolation ──────────────────────────────────────────────────────────

describe('user isolation', () => {
  it("one account's queued completion is never sent as another, and a switch leaves it queued for its owner", async () => {
    const server = seedTask('user-a');
    await tapOffline(localOf(server));

    signIn(USER_B);
    await run();
    expect(sent).toHaveLength(0);
    expect(records('user-b')).toHaveLength(0);

    signIn(USER_A);
    await run();
    expect(records('user-a')).toHaveLength(1);
    expect(sent.every((r) => r.userId === 'user-a')).toBe(true);
  });
});

// ── Canonical history and legacy writes ─────────────────────────────────────

describe('canonical history after delivery', () => {
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  const unreconciledIds = async () => (await getUnreconciledCompletions()).flatMap((day) => day.tasks.map((t) => t.id));

  /** Another device completed a different task today, so the server answers today canonically. */
  const makeTodayCanonical = () => {
    const other = seedTask('user-a', { title: 'Other', completed: true });
    state('user-a').records.set('c-other', { completionId: 'c-other', taskId: other._id, title: 'Other', estimatedMinutes: 30, completedAt: NOW, utcOffsetMinutes: 0, status: 'active' });
  };

  it('delivery is not acknowledgement: the completion stays unreconciled until a canonical answer lists it', async () => {
    makeTodayCanonical();
    const server = seedTask();
    const local = await tapOffline(localOf(server));
    await updateTodaySnapshot([{ ...local, completedAt: new Date().toISOString() }]);
    await settle();

    await getWeekHistory(); // canonical answer for today that does not list this task
    await settle();
    expect(await unreconciledIds()).toEqual([server._id]);

    await run(); // delivered: the server now has the record
    expect(records().some((r) => r.taskId === server._id)).toBe(true);
    expect(await unreconciledIds()).toEqual([server._id]); // delivery alone changed nothing

    // What the dashboard does when the queue reports delivered completions (onCompletionsDelivered): ask for a reconcile.
    await requestHistoryReconcile();
    await settle();
    const week = await getWeekHistory(); // the reconciled local copy
    expect(week[week.length - 1].completedTasks.map((t) => t.id).sort()).toEqual([server._id, 'srv-1'].sort());
    expect(await unreconciledIds()).toEqual([]);
  });

  it('no legacy history PUT for a day that has become canonical', async () => {
    const server = seedTask();
    await tapOffline(localOf(server));
    await run();
    await getWeekHistory(); // reads the canonical day: canonicalSeen
    await settle();
    sent.length = 0;

    await updateTodaySnapshot([localOf(server, { completed: true, completedAt: new Date().toISOString() })]);
    advance(30_000);
    await getWeekHistory();
    await settle();

    expect(historyPuts()).toHaveLength(0);
  });
});
