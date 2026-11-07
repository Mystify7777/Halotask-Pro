import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createCompletionStore, type CompletionStore } from './helpers/completionDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';

// Issue #47, Phase 1 — the server contract through the REAL app (routes, auth, validators, controllers, completion
// service) with strict in-memory User, Task and CompletionRecord doubles. Mongo-free.

const A = '665f1c2e9b1e8a00000000aa';
const B = '665f1c2e9b1e8a00000000bb';
const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const emptyTree = () => ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [] });

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let users: UserStore;
let tasks: TaskStore;
let records: CompletionStore;
let app: Express;

beforeEach(async () => {
  users = createUserStore();
  tasks = createTaskStore();
  records = createCompletionStore();
  users.seed(A, emptyTree());
  users.seed(B, emptyTree());
  app = await loadAppWith(users, tasks, SECRET, records);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  unmockModels();
});

const standalone = (body: unknown, user = A) => request(app).post('/api/completion-events').set(as(user)).send(body as object);
const put = (id: string, body: object, user = A) => request(app).put(`/api/tasks/${id}`).set(as(user)).send(body);
const post = (body: object, user = A) => request(app).post('/api/tasks').set(as(user)).send(body);

const completeBody = (over: Record<string, unknown> = {}) => ({
  type: 'complete',
  completionId: 'c1',
  taskId: 'local-1730000000000-ab12cd',
  title: 'Write report',
  estimatedMinutes: 30,
  completedAt: ago(10 * MIN),
  utcOffsetMinutes: 330,
  ...over,
});
const eventOf = (over: Record<string, unknown> = {}) => ({ completionId: 'c1', completedAt: ago(10 * MIN), utcOffsetMinutes: 330, ...over });
const active = () => records.docs.filter((d) => d.status === 'active');
const byId = (id: string) => records.docs.find((d) => d.completionId === id);
const xpOf = (user = A) => (users.tree(user) as { xp: number }).xp;

describe('POST /api/completion-events', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/completion-events').send(completeBody());

    expect(res.status).toBe(401);
    expect(records.docs).toHaveLength(0);
  });

  it('records a completion for a task that does not exist here, with the task id stored exactly as sent and never looked up', async () => {
    const res = await standalone(completeBody());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ completion: { outcome: 'recorded', completionId: 'c1' } });
    expect(records.docs[0]).toMatchObject({ userId: A, taskId: 'local-1730000000000-ab12cd', titleSnapshot: 'Write report', status: 'active' });
    expect(tasks.ops).toHaveLength(0); // a local-* id is not a server task reference
  });

  it('derives localDate from completedAt + utcOffsetMinutes: an event at 23:50 in India is that day, whenever it arrives', async () => {
    const res = await standalone(completeBody({ completedAt: new Date(Date.now() - 2 * DAY).toISOString(), utcOffsetMinutes: 330 }));

    expect(res.status).toBe(201);
    const stored = records.docs[0];
    const expected = new Date((stored.completedAt as Date).getTime() + 330 * MIN).toISOString().slice(0, 10);
    expect(stored.localDate).toBe(expected);
  });

  it('a delivery for 23:50 local on the previous day keeps that day', async () => {
    // 18:20Z is 23:50 in UTC+5:30. Pick the most recent such instant strictly in the past.
    const at = new Date();
    at.setUTCHours(18, 20, 0, 0);
    if (at.getTime() > Date.now()) at.setUTCDate(at.getUTCDate() - 1);

    await standalone(completeBody({ completedAt: at.toISOString() }));

    expect(records.docs[0].localDate).toBe(at.toISOString().slice(0, 10)); // 23:50 IST is still the same calendar date as 18:20Z
  });

  it('is idempotent: the same event again answers 200 duplicate and stores nothing more', async () => {
    const body = completeBody();
    await standalone(body);

    const res = await standalone(body);

    expect(res.status).toBe(200);
    expect(res.body.completion).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'active' });
    expect(records.docs).toHaveLength(1);
  });

  it('the same id for a different event is refused (400 COMPLETION_ID_REUSED) and nothing changes', async () => {
    await standalone(completeBody());

    const res = await standalone(completeBody({ title: 'x', taskId: 'other-task' }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMPLETION_ID_REUSED');
    expect(records.docs).toHaveLength(1);
  });

  it('an event older than 90 days, or more than 5 minutes ahead, is refused with a code and not re-dated', async () => {
    const old = await standalone(completeBody({ completionId: 'old', completedAt: ago(91 * DAY) }));
    const future = await standalone(completeBody({ completionId: 'future', completedAt: new Date(Date.now() + 6 * MIN).toISOString() }));
    const ok = await standalone(completeBody({ completionId: 'ok', completedAt: ago(89 * DAY) }));

    expect(old.status).toBe(400);
    expect(old.body.code).toBe('COMPLETION_TIME_OUT_OF_WINDOW');
    expect(future.body.code).toBe('COMPLETION_TIME_OUT_OF_WINDOW');
    expect(ok.status).toBe(201);
    expect(records.docs.map((d) => d.completionId)).toEqual(['ok']);
  });

  it.each([
    ['a body that is not an object', 'nope'],
    ['an unknown type', completeBody({ type: 'snapshot' })],
    ['a missing type', (() => { const b = completeBody(); delete (b as Record<string, unknown>).type; return b; })()],
    ['a completionId with a space', completeBody({ completionId: 'a b' })],
    ['a completionId over 64 characters', completeBody({ completionId: 'x'.repeat(65) })],
    ['a missing completedAt', completeBody({ completedAt: undefined })],
    ['a completedAt without a time zone', completeBody({ completedAt: '2026-11-04T20:00:00' })],
    ['a missing offset', completeBody({ utcOffsetMinutes: undefined })],
    ['an offset out of range', completeBody({ utcOffsetMinutes: 900 })],
    ['a fractional offset', completeBody({ utcOffsetMinutes: 330.5 })],
    ['a localDate that disagrees with completedAt + offset', completeBody({ localDate: '2001-01-01' })],
    ['a malformed localDate', completeBody({ localDate: '5 Nov' })],
    ['a taskId with a slash', completeBody({ taskId: 'a/b' })],
    ['an empty title', completeBody({ title: '   ' })],
    ['a title over 200 characters', completeBody({ title: 'x'.repeat(201) })],
    ['negative minutes', completeBody({ estimatedMinutes: -1 })],
    ['minutes as a string', completeBody({ estimatedMinutes: '30' })],
  ])('rejects %s (400, nothing written)', async (_label, body) => {
    const res = await standalone(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined(); // a payload error is permanent: no retry code
    expect(records.docs).toHaveLength(0);
  });

  it('accepts a matching client localDate and ignores unknown fields', async () => {
    const at = new Date(Date.now() - 10 * MIN);
    const localDate = new Date(at.getTime() + 330 * MIN).toISOString().slice(0, 10);

    const res = await standalone(completeBody({ completedAt: at.toISOString(), localDate, status: 'revoked', source: 'migrated', receivedAt: '2000-01-01T00:00:00Z' }));

    expect(res.status).toBe(201);
    expect(records.docs[0]).toMatchObject({ status: 'active', source: 'live', completedAtSource: 'client', localDate });
    expect((records.docs[0].receivedAt as Date).getFullYear()).toBeGreaterThanOrEqual(2026); // server-supplied, never client-supplied
  });

  describe('revocation', () => {
    beforeEach(async () => {
      await standalone(completeBody());
    });

    it('revokes that exact record and keeps it', async () => {
      const res = await standalone({ type: 'revoke', completionId: 'c1', revokedAt: ago(MIN) });

      expect(res.status).toBe(200);
      expect(res.body.completion).toEqual({ outcome: 'revoked', completionId: 'c1' });
      expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted', titleSnapshot: 'Write report' });
    });

    it('is idempotent', async () => {
      const body = { type: 'revoke', completionId: 'c1', revokedAt: ago(MIN) };
      await standalone(body);

      const res = await standalone(body);

      expect(res.status).toBe(200);
      expect(res.body.completion.outcome).toBe('already_revoked');
    });

    it('an unknown completionId is a 404 COMPLETION_NOT_FOUND and nothing is invented', async () => {
      const res = await standalone({ type: 'revoke', completionId: 'ghost', revokedAt: ago(MIN) });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COMPLETION_NOT_FOUND');
      expect(records.docs).toHaveLength(1);
    });

    it("another account's completionId is a 404, and the record is untouched", async () => {
      const res = await standalone({ type: 'revoke', completionId: 'c1', revokedAt: ago(MIN) }, B);

      expect(res.status).toBe(404);
      expect(byId('c1')?.status).toBe('active');
    });

    it('a revoke that names the wrong task is refused', async () => {
      const res = await standalone({ type: 'revoke', completionId: 'c1', taskId: 'other', revokedAt: ago(MIN) });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COMPLETION_TASK_MISMATCH');
      expect(byId('c1')?.status).toBe('active');
    });

    it('requires completionId and revokedAt', async () => {
      expect((await standalone({ type: 'revoke', revokedAt: ago(MIN) })).status).toBe(400);
      expect((await standalone({ type: 'revoke', completionId: 'c1' })).status).toBe(400);
    });

    it('offline complete -> uncomplete -> complete, delivered in order: two records, one active', async () => {
      await standalone({ type: 'revoke', completionId: 'c1', revokedAt: ago(5 * MIN) });
      await standalone(completeBody({ completionId: 'c2', completedAt: ago(3 * MIN) }));

      expect(records.docs).toHaveLength(2);
      expect(byId('c1')?.status).toBe('revoked');
      expect(byId('c2')?.status).toBe('active');
      expect(active()).toHaveLength(1);
    });
  });

  it('two accounts are isolated: the same ids are independent records', async () => {
    await standalone(completeBody(), A);
    const res = await standalone(completeBody(), B);

    expect(res.status).toBe(201);
    expect(records.docs.map((d) => String(d.userId)).sort()).toEqual([A, B]);
  });

  it('a database failure is a 5xx, and the same event succeeds when retried', async () => {
    records.hooks.failCreate = () => new Error('simulated database failure');
    const failed = await standalone(completeBody());
    records.hooks.failCreate = undefined;
    const retried = await standalone(completeBody());

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(records.docs).toHaveLength(1);
  });
});

describe('PUT /api/tasks/:id with a completionEvent', () => {
  it('records the completion from the event (client fidelity) and says so in the response', async () => {
    const task = tasks.seed(A, { title: 'Write report', estimatedMinutes: 30 });

    const res = await put(String(task._id), { completed: true, completionEvent: eventOf() });

    expect(res.status).toBe(200);
    expect(res.body.task.completed).toBe(true);
    expect(res.body.completion).toEqual({ outcome: 'recorded', completionId: 'c1' });
    expect(records.docs[0]).toMatchObject({
      userId: A,
      completionId: 'c1',
      taskId: String(task._id),
      titleSnapshot: 'Write report',
      estimatedMinutesSnapshot: 30,
      status: 'active',
      completedAtSource: 'client',
      utcOffsetMinutes: 330,
    });
    expect(xpOf()).toBe(10);
  });

  it('a retry of the same request is idempotent: still one record, XP awarded once', async () => {
    const task = tasks.seed(A);
    const body = { completed: true, completionEvent: eventOf() };

    await put(String(task._id), body);
    const retry = await put(String(task._id), body);

    expect(retry.status).toBe(200);
    expect(retry.body.completion.outcome).toBe('duplicate');
    expect(records.docs).toHaveLength(1);
    expect(xpOf()).toBe(10);
  });

  it('the same completionId through the task endpoint and the standalone endpoint resolves to ONE record', async () => {
    const task = tasks.seed(A);
    await put(String(task._id), { completed: true, completionEvent: eventOf() });

    const viaStandalone = await standalone(completeBody({ taskId: String(task._id), completedAt: records.docs[0].completedAt instanceof Date ? (records.docs[0].completedAt as Date).toISOString() : '' }));

    expect(viaStandalone.status).toBe(200);
    expect(viaStandalone.body.completion.outcome).toBe('duplicate');
    expect(records.docs).toHaveLength(1);
  });

  it('the other order: the standalone endpoint refuses a NEW completion for a task that still exists (the task write arbitrates)', async () => {
    const task = tasks.seed(A);

    const res = await standalone(completeBody({ taskId: String(task._id), title: 'seeded', estimatedMinutes: 0 }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPLETION_TASK_EXISTS');
    expect(records.docs).toHaveLength(0);
    expect(tasks.get(String(task._id))?.completed).toBe(false);
  });

  it('complete -> uncomplete -> complete with events: two records, one active; the revoke targets the exact record', async () => {
    const task = tasks.seed(A);
    const id = String(task._id);

    await put(id, { completed: true, completionEvent: eventOf({ completionId: 'c1', completedAt: ago(30 * MIN) }) });
    const undo = await put(id, { completed: false, completionEvent: { completionId: 'c1', revokedAt: ago(20 * MIN) } });
    await put(id, { completed: true, completionEvent: eventOf({ completionId: 'c2', completedAt: ago(10 * MIN) }) });

    expect(undo.body.completion).toEqual({ outcome: 'revoked', completionId: 'c1' });
    expect(records.docs).toHaveLength(2);
    expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted' });
    expect(byId('c2')).toMatchObject({ status: 'active' });
    expect(active()).toHaveLength(1);
    expect(tasks.get(id)?.completed).toBe(true);
  });

  it('the 23:59 / 00:01 / 00:02 case: complete offline, uncomplete offline, reconnect later = one revoked record on the ORIGINAL day', async () => {
    // Offline, in India: completed 23:59 on day D (18:29Z), uncompleted 00:01 on D+1 (18:31Z). Delivered later, in order.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() - 2);
    const completedAt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 18, 29));
    const revokedAt = new Date(completedAt.getTime() + 2 * MIN);
    const task = tasks.seed(A);

    await put(String(task._id), { completed: true, completionEvent: eventOf({ completedAt: completedAt.toISOString() }) });
    await put(String(task._id), { completed: false, completionEvent: { completionId: 'c1', revokedAt: revokedAt.toISOString() } });

    expect(records.docs).toHaveLength(1);
    expect(byId('c1')).toMatchObject({ status: 'revoked', completedAt, revokedAt });
    expect(byId('c1')?.localDate).toBe(completedAt.toISOString().slice(0, 10)); // 23:59 IST on day D, not D+1
    expect(active()).toHaveLength(0);
  });

  it('a second device completing an already-completed task: that event is stored superseded, the first stays active', async () => {
    const task = tasks.seed(A);
    const id = String(task._id);
    await put(id, { completed: true, completionEvent: eventOf({ completionId: 'c1' }) });

    const second = await put(id, { completed: true, completionEvent: eventOf({ completionId: 'c2', completedAt: ago(2 * MIN) }) });

    expect(second.status).toBe(200);
    expect(second.body.completion).toEqual({ outcome: 'superseded', completionId: 'c2' });
    expect(byId('c1')?.status).toBe('active');
    expect(byId('c2')).toMatchObject({ status: 'revoked', revokedReason: 'superseded' });
    expect(xpOf()).toBe(10); // still one award
  });

  // Strong invariant (Phase 1B review): a refused event refuses the WHOLE request. Nothing is changed: no task write, no
  // record, no reward. There is no "completed anyway" state.
  it('an event outside the window is refused with 400 and NOTHING changes: task, records and reward', async () => {
    const task = tasks.seed(A);

    const res = await put(String(task._id), { completed: true, title: 'renamed too', completionEvent: eventOf({ completedAt: ago(120 * DAY) }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'COMPLETION_TIME_OUT_OF_WINDOW' });
    expect(tasks.get(String(task._id))).toMatchObject({ completed: false, title: 'seeded' });
    expect(records.docs).toHaveLength(0);
    expect(xpOf()).toBe(0);
  });

  it('a completionId that belongs to a different event is refused with 400 and nothing changes (task, records, reward)', async () => {
    const first = tasks.seed(A);
    const second = tasks.seed(A);
    await put(String(first._id), { completed: true, completionEvent: eventOf() });
    const xpAfterFirst = xpOf();

    const res = await put(String(second._id), { completed: true, completionEvent: eventOf() });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'COMPLETION_ID_REUSED' });
    expect(tasks.get(String(second._id))).toMatchObject({ completed: false });
    expect(records.docs).toHaveLength(1);
    expect(xpOf()).toBe(xpAfterFirst);
  });

  it('a revoke naming ANOTHER task\'s completion is refused with 400 and the task stays completed', async () => {
    const first = tasks.seed(A);
    const second = tasks.seed(A);
    await put(String(first._id), { completed: true, completionEvent: eventOf() });
    await put(String(second._id), { completed: true, completionEvent: eventOf({ completionId: 'c2' }) });

    const res = await put(String(second._id), { completed: false, completionEvent: { completionId: 'c1', revokedAt: ago(MIN) } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'COMPLETION_TASK_MISMATCH' });
    expect(tasks.get(String(second._id))).toMatchObject({ completed: true, completionId: 'c2' });
    expect(records.docs.filter((d) => d.status === 'active')).toHaveLength(2);
  });

  it.each([
    ['an event without completed', { completionEvent: eventOf() }],
    ['a completion with no completionId', { completed: true, completionEvent: { completedAt: ago(MIN), utcOffsetMinutes: 330 } }],
    ['a completion with no offset', { completed: true, completionEvent: { completionId: 'c1', completedAt: ago(MIN) } }],
    ['a completion with a localDate that does not match', { completed: true, completionEvent: eventOf({ localDate: '2001-01-01' }) }],
    ['a revocation-shaped event on completed: true', { completed: true, completionEvent: { completionId: 'c1', revokedAt: ago(MIN) } }],
    ['a completion-shaped event on completed: false', { completed: false, completionEvent: eventOf() }],
    ['a revocation with no revokedAt', { completed: false, completionEvent: { completionId: 'c1' } }],
    ['an event that is not an object', { completed: true, completionEvent: 'c1' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const task = tasks.seed(A, { completed: _label.includes('completed: false') });

    const res = await put(String(task._id), body);

    expect(res.status).toBe(400);
    expect(records.docs).toHaveLength(0);
    expect(tasks.get(String(task._id))?.completed).toBe(_label.includes('completed: false'));
    expect(xpOf()).toBe(0);
  });

  it('the response of a request WITHOUT an event has no completion block (the legacy response is unchanged)', async () => {
    const task = tasks.seed(A);

    const res = await put(String(task._id), { title: 'renamed' });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('completion');
  });

  it("an event cannot be used on someone else's task, and writes no record", async () => {
    const task = tasks.seed(B);

    const res = await put(String(task._id), { completed: true, completionEvent: eventOf() }, A);

    expect(res.status).toBe(404);
    expect(records.docs).toHaveLength(0);
  });

  it('deleting a completed task leaves its records; renaming it leaves the snapshot', async () => {
    const task = tasks.seed(A, { title: 'Original title', estimatedMinutes: 25 });
    const id = String(task._id);
    await put(id, { completed: true, completionEvent: eventOf() });

    await put(id, { title: 'Renamed', estimatedMinutes: 99 });
    expect(byId('c1')).toMatchObject({ titleSnapshot: 'Original title', estimatedMinutesSnapshot: 25 });

    const del = await request(app).delete(`/api/tasks/${id}`).set(as(A));
    expect(del.status).toBe(200);
    expect(tasks.has(id)).toBe(false);
    expect(byId('c1')).toMatchObject({ status: 'active', titleSnapshot: 'Original title', taskId: id });
  });

  it('edits that do not change completed (subtasks, title, tags) never touch the records', async () => {
    const task = tasks.seed(A, { completed: true });
    await standalone(completeBody({ taskId: String(task._id) }));
    const before = JSON.stringify(records.docs);

    await put(String(task._id), { title: 'new', tags: ['x'], priority: 'high' });

    expect(JSON.stringify(records.docs)).toBe(before);
  });

  describe('failure recovery (Phase 1B order: award -> conditional task write -> records), inspected after the failure AND after the retry', () => {
    const state = (id: string) => ({
      completed: tasks.get(id)?.completed,
      pointer: tasks.get(id)?.completionId ?? null,
      records: records.docs.map((d) => `${d.completionId}:${d.status}`),
      xp: xpOf(),
    });

    it('completion: the award fails (after the task and record committed) -> 500; the retry awards once and changes nothing else', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      const body = { completed: true, completionEvent: eventOf() }; // a retry resends the SAME payload
      users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => op.update?.$push !== undefined });

      const failed = await put(id, body);

      expect(failed.status).toBe(500);
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 0 });

      const retry = await put(id, body);

      expect(retry.status).toBe(200);
      expect(retry.body.completion).toMatchObject({ outcome: 'duplicate', status: 'active' });
      expect(retry.body.growth).toMatchObject({ awarded: true });
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('completion: the task write fails -> 500, no record and NO reward (the award never ran); the retry completes and awards once', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      const body = { completed: true, completionEvent: eventOf() };
      tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });

      const failed = await put(id, body);

      expect(failed.status).toBe(500);
      expect(state(id)).toEqual({ completed: false, pointer: null, records: [], xp: 0 });

      const retry = await put(id, body);

      expect(retry.status).toBe(200);
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('completion: the record write fails after the task committed -> 500; the retry writes the record, nothing else changes', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      const body = { completed: true, completionEvent: eventOf() };
      records.hooks.failCreate = () => new Error('simulated database failure');

      const failed = await put(id, body);

      expect(failed.status).toBe(500);
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: [], xp: 0 }); // the task is the arbiter; the record follows, the award last

      records.hooks.failCreate = undefined;
      const retry = await put(id, body);

      expect(retry.status).toBe(200);
      expect(retry.body.completion.outcome).toBe('recorded');
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('legacy completion: the record write fails after the commit; the legacy retry heals the missing server-observed record', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      records.hooks.failCreate = () => new Error('simulated database failure');

      expect((await put(id, { completed: true })).status).toBe(500);
      const serverId = tasks.get(id)?.completionId as string;
      expect(serverId).toMatch(/^srv-/);
      expect(records.docs).toHaveLength(0);

      records.hooks.failCreate = undefined;
      expect((await put(id, { completed: true })).status).toBe(200);

      expect(state(id)).toEqual({ completed: true, pointer: serverId, records: [`${serverId}:active`], xp: 10 });
      expect(records.docs[0]).toMatchObject({ completedAtSource: 'server' });
    });

    it('uncomplete: the task write fails -> 500, nothing changed (record still active); the retry uncompletes and revokes', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      await put(id, { completed: true, completionEvent: eventOf() });
      const undo = { completed: false, completionEvent: { completionId: 'c1', revokedAt: ago(MIN) } };
      tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });

      const failed = await put(id, undo);

      expect(failed.status).toBe(500);
      expect(state(id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });

      const retry = await put(id, undo);

      expect(retry.status).toBe(200);
      expect(retry.body.completion).toEqual({ outcome: 'revoked', completionId: 'c1' });
      expect(state(id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:revoked'], xp: 10 });
    });

    it('uncomplete: the revoke fails after the task committed -> 500; the retry (task already incomplete) finishes the revoke', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      await put(id, { completed: true, completionEvent: eventOf() });
      const undo = { completed: false, completionEvent: { completionId: 'c1', revokedAt: ago(MIN) } };
      records.hooks.failUpdate = () => new Error('simulated database failure');

      const failed = await put(id, undo);

      expect(failed.status).toBe(500);
      expect(state(id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:active'], xp: 10 });

      records.hooks.failUpdate = undefined;
      const retry = await put(id, undo);

      expect(retry.status).toBe(200);
      expect(retry.body.completion).toEqual({ outcome: 'revoked', completionId: 'c1' });
      expect(state(id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:revoked'], xp: 10 });
    });

    it('legacy uncomplete: the revoke fails after the commit; the legacy retry revokes what the task held', async () => {
      const task = tasks.seed(A);
      const id = String(task._id);
      await put(id, { completed: true });
      records.hooks.failUpdate = () => new Error('simulated database failure');

      expect((await put(id, { completed: false })).status).toBe(500);
      expect(active()).toHaveLength(1);

      records.hooks.failUpdate = undefined;
      expect((await put(id, { completed: false })).status).toBe(200);

      expect(active()).toHaveLength(0);
      expect(tasks.get(id)?.completed).toBe(false);
    });
  });
});

describe('POST /api/tasks created already completed (offline create -> complete)', () => {
  it('records the completion for the NEW task id, with the event carried by the create', async () => {
    const res = await post({ title: 'Offline task', estimatedMinutes: 15, completed: true, completionEvent: eventOf() });

    expect(res.status).toBe(201);
    expect(res.body.completion).toEqual({ outcome: 'recorded', completionId: 'c1' });
    expect(records.docs[0]).toMatchObject({ completionId: 'c1', taskId: String(res.body.task._id), titleSnapshot: 'Offline task', estimatedMinutesSnapshot: 15 });
    expect(xpOf()).toBe(10);
  });

  it('a retried create (same event) after a lost response is refused (the event is already bound to the first task); nothing is duplicated', async () => {
    const body = { title: 'Offline task', completed: true, completionEvent: eventOf() };
    const first = await post(body);
    const retry = await post(body);

    // Creates are not idempotent by themselves (that is the queue's concern), but a refused event creates nothing at all.
    expect(first.status).toBe(201);
    expect(retry.status).toBe(400);
    expect(retry.body).toMatchObject({ code: 'COMPLETION_ID_REUSED' });
    expect(tasks.size()).toBe(1);
    expect(records.docs).toHaveLength(1);
    expect(xpOf()).toBe(10);
  });

  it('a create with an event outside the window is refused (400): no task, no record, no reward', async () => {
    const res = await post({ title: 'Too old', completed: true, completionEvent: eventOf({ completedAt: ago(120 * DAY) }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'COMPLETION_TIME_OUT_OF_WINDOW' });
    expect(tasks.size()).toBe(0);
    expect(records.docs).toHaveLength(0);
    expect(xpOf()).toBe(0);
  });

  it('a revocation event on a create is a 400 (a task that does not exist yet cannot be uncompleted)', async () => {
    const res = await post({ title: 'x', completed: false, completionEvent: { completionId: 'c1', revokedAt: ago(MIN) } });

    expect(res.status).toBe(400);
    expect(tasks.size()).toBe(0);
    expect(records.docs).toHaveLength(0);
  });

  it('a completion event on a create that is not completed is a 400', async () => {
    const res = await post({ title: 'x', completionEvent: eventOf() });

    expect(res.status).toBe(400);
    expect(tasks.size()).toBe(0);
  });

  it('a completed create whose AWARD fails removes the task AND withdraws the record, so the retry with the same event succeeds', async () => {
    const body = { title: 'Offline task', completed: true, completionEvent: eventOf() };
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => op.update?.$push !== undefined });

    const failed = await post(body);

    expect(failed.status).toBe(500);
    expect(tasks.size()).toBe(0);
    expect(records.docs).toHaveLength(0);

    const retry = await post(body);

    expect(retry.status).toBe(201);
    expect(retry.body.completion).toEqual({ outcome: 'recorded', completionId: 'c1' });
    expect(records.docs).toHaveLength(1);
    expect(xpOf()).toBe(10);
  });

  it('a create that fails to RECORD removes the just-created task (nothing is left completed without a record)', async () => {
    records.hooks.failCreate = () => new Error('simulated database failure');

    const res = await post({ title: 'Offline task', completed: true, completionEvent: eventOf() });

    expect(res.status).toBe(500);
    expect(tasks.size()).toBe(0);
    expect(records.docs).toHaveLength(0);
  });
});

describe('legacy clients (no completionEvent)', () => {
  it('completed: true creates a server-observed, lower-fidelity record: receipt time as completedAt, local day unknown', async () => {
    const task = tasks.seed(A, { title: 'Legacy', estimatedMinutes: 20 });

    const res = await put(String(task._id), { completed: true });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('completion'); // the legacy response is unchanged
    expect(records.docs).toHaveLength(1);
    expect(records.docs[0]).toMatchObject({
      taskId: String(task._id),
      titleSnapshot: 'Legacy',
      estimatedMinutesSnapshot: 20,
      status: 'active',
      source: 'live',
      completedAtSource: 'server',
      utcOffsetMinutes: null,
      localDate: null,
    });
    expect(String(records.docs[0].completionId)).toMatch(/^srv-/);
  });

  it('completing an already-completed task (a retry) creates no second record', async () => {
    const task = tasks.seed(A);
    await put(String(task._id), { completed: true });

    await put(String(task._id), { completed: true });

    expect(records.docs).toHaveLength(1);
  });

  it("completed: false revokes the task's active record", async () => {
    const task = tasks.seed(A);
    await put(String(task._id), { completed: true });

    const res = await put(String(task._id), { completed: false });

    expect(res.status).toBe(200);
    expect(active()).toHaveLength(0);
    expect(records.docs[0]).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted', revokedAt: null });
    expect(records.docs[0].revokeReceivedAt).toBeInstanceOf(Date);
  });

  it('legacy complete, uncomplete, complete = two records, one active', async () => {
    const task = tasks.seed(A);
    const id = String(task._id);

    await put(id, { completed: true });
    await put(id, { completed: false });
    await put(id, { completed: true });

    expect(records.docs).toHaveLength(2);
    expect(active()).toHaveLength(1);
  });

  it('a legacy create that is already completed records a server-observed completion for the new task', async () => {
    const res = await post({ title: 'Legacy create', completed: true });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('completion');
    expect(records.docs[0]).toMatchObject({ taskId: String(res.body.task._id), completedAtSource: 'server', status: 'active' });
  });

  it('a task created NOT completed, and edits to it, create no record', async () => {
    const res = await post({ title: 'plain' });
    await put(String(res.body.task._id), { title: 'plain 2' });

    expect(records.docs).toHaveLength(0);
  });

  it('a legacy client and an event-carrying client on the same task: one active record', async () => {
    const task = tasks.seed(A);
    const id = String(task._id);
    await put(id, { completed: true, completionEvent: eventOf() });

    await put(id, { completed: true }); // an old tab retries

    expect(active()).toHaveLength(1);
  });
});

describe('subtask-only writes never touch completion records', () => {
  it('a subtask update on a completed task leaves the records as they were', async () => {
    const task = tasks.seed(A, { completed: true });
    await standalone(completeBody({ taskId: String(task._id) }));
    const before = JSON.stringify(records.docs);

    await put(String(task._id), { subtasks: [{ id: 's1', title: 'step', completed: true }] });

    expect(JSON.stringify(records.docs)).toBe(before);
  });
});
