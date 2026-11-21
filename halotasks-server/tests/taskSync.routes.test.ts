import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createCompletionStore, type CompletionStore } from './helpers/completionDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';
import { fingerprintOf } from '../src/utils/mutationFingerprint';

// Issue #60 — POST /api/tasks/sync through the REAL app (auth, rate limiter, envelope, services, completion arbitration) with the
// strict in-memory User, Task and CompletionRecord doubles. Mongo-free. What these cannot prove (the real unique index, real
// concurrency between two requests with one mutation id) is in tests/taskSync.realmongo.test.ts, which needs a MongoDB binary.

const A = '665f1c2e9b1e8a00000000aa';
const B = '665f1c2e9b1e8a00000000bb';
const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const emptyTree = () => ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [] });
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
// one fixed instant, so a repeated completion is the SAME event (a different time under one id would be a refused reuse)
const COMPLETED_AT = ago(10 * MIN);

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

type Body = Record<string, unknown>;
const sync = (mutations: unknown, user = A) => request(app).post('/api/tasks/sync').set(as(user)).send({ mutations } as Body);
const syncRaw = (body: unknown, user = A) => request(app).post('/api/tasks/sync').set(as(user)).send(body as Body);

const create = (mutationId: string, localId: string, payload: Body = { title: 'New task' }) => ({ mutationId, type: 'create', localId, payload });
const update = (mutationId: string, task: Body, payload: Body) => ({ mutationId, type: 'update', task, payload });
const complete = (mutationId: string, task: Body, completionId = 'c1') => ({
  mutationId,
  type: 'completion',
  task,
  payload: { completed: true, completionEvent: { completionId, completedAt: COMPLETED_AT, utcOffsetMinutes: 330 } },
});
const remove = (mutationId: string, task: Body) => ({ mutationId, type: 'delete', task });

const statuses = (res: { body: { results: Array<{ status: string }> } }) => res.body.results.map((r) => r.status);
const ids = (res: { body: { results: Array<{ mutationId: string }> } }) => res.body.results.map((r) => r.mutationId);

describe('envelope', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/tasks/sync').send({ mutations: [] });
    expect(res.status).toBe(401);
  });

  it.each([
    ['a non-object body', [] as unknown],
    ['no mutations', {}],
    ['mutations that is not an array', { mutations: 'x' }],
    ['an empty list', { mutations: [] }],
    ['51 mutations', { mutations: Array.from({ length: 51 }, (_, i) => create(`m-over-${i}00`, `local-${i}`)) }],
    ['an item that is not an object', { mutations: ['x'] }],
    ['a missing mutationId', { mutations: [{ type: 'delete', task: { id: 'a' } }] }],
    ['a too-short mutationId', { mutations: [create('m1', 'local-1')] }],
    ['an unknown type', { mutations: [{ mutationId: 'm-unknown-1', type: 'rename', task: { id: 'a' } }] }],
    ['a create without a localId', { mutations: [{ mutationId: 'm-nolocal-1', type: 'create', payload: { title: 't' } }] }],
    ['a create with an invalid localId', { mutations: [create('m-badlocal-1', 'has space')] }],
    ['an update without a payload', { mutations: [{ mutationId: 'm-nopay-001', type: 'update', task: { id: 'a' } }] }],
    ['a task ref with both id and localId', { mutations: [remove('m-bothref-1', { id: 'a', localId: 'local-1' })] }],
    ['a task ref with neither', { mutations: [remove('m-noref-0001', {})] }],
  ])('fails the whole request (400, nothing applied) for %s', async (_name, body) => {
    const res = await syncRaw(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SYNC_REQUEST');
    expect(tasks.size()).toBe(0);
  });

  it('fails the whole request when one mutation id is repeated, even if every other item is valid', async () => {
    const res = await sync([create('m-dup-00001', 'local-1'), create('m-dup-00001', 'local-2')]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SYNC_REQUEST');
    expect(tasks.size()).toBe(0);
  });

  it('accepts exactly 50 mutations and answers every one, in request order', async () => {
    const list = Array.from({ length: 50 }, (_, i) => create(`m-fifty-${String(i).padStart(3, '0')}`, `local-${i}`, { title: `t${i}` }));
    const res = await sync(list);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(list.map((m) => m.mutationId));
    expect(new Set(statuses(res))).toEqual(new Set(['applied']));
    expect(tasks.size()).toBe(50);
  });

  it('refuses a body over the 1 MB limit with 413', async () => {
    const res = await sync([create('m-big-000001', 'local-1', { title: 't', description: 'x'.repeat(1_100_000) })]);
    expect(res.status).toBe(413);
    expect(tasks.size()).toBe(0);
  });

  it('rate limits per user: the 61st request in a minute is 429, another user is not affected', async () => {
    for (let i = 0; i < 60; i += 1) expect((await syncRaw({ mutations: [] })).status).toBe(400);
    expect((await syncRaw({ mutations: [] })).status).toBe(429);
    expect((await syncRaw({ mutations: [] }, B)).status).toBe(400);
  });
});

describe('create', () => {
  it('creates tasks, stores the client key, and never returns hidden fields', async () => {
    const res = await sync([create('m-create-001', 'local-aaa', { title: 'Write report', priority: 'high' })]);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ mutationId: 'm-create-001', status: 'applied', task: { title: 'Write report', priority: 'high', clientKey: 'local-aaa' } });
    expect(JSON.stringify(res.body)).not.toContain('appliedMutations');
  });

  it('a retried create (same local id) returns the task it already made and creates no second one', async () => {
    const first = await sync([create('m-create-001', 'local-aaa')]);
    const retry = await sync([create('m-create-002', 'local-aaa')]);
    expect(retry.body.results[0].status).toBe('replayed');
    expect(retry.body.results[0].task._id).toBe(first.body.results[0].task._id);
    expect(tasks.size()).toBe(1);
  });

  it('a retried create whose payload has since changed still creates no second task (the key is the identity)', async () => {
    const first = await sync([create('m-create-001', 'local-aaa', { title: 'Old' })]);
    const retry = await sync([create('m-create-002', 'local-aaa', { title: 'Newer' })]);
    expect(retry.body.results[0].status).toBe('replayed');
    expect(tasks.size()).toBe(1);
    // the replay reports the task as stored: the client turns the difference into an update
    expect(retry.body.results[0].task.title).toBe('Old');
    expect(retry.body.results[0].task._id).toBe(first.body.results[0].task._id);
  });

  it('two requests racing on one client key: the unique index lets one insert win and the other is a replay', async () => {
    tasks.hooks.beforeCreate = async (data) => {
      tasks.hooks.beforeCreate = undefined;
      // a rival request inserts the same key after this request looked and found nothing
      await tasks.model.create({ ...data, _id: '507f1f77bcf86cd7994399aa', title: 'Rival' });
    };
    const res = await sync([create('m-create-001', 'local-aaa', { title: 'Mine' })]);
    expect(res.body.results[0].status).toBe('replayed');
    expect(res.body.results[0].task.title).toBe('Rival');
    expect(tasks.size()).toBe(1);
  });

  it('a retried create that was created already completed is a replay too (its completion id is not refused as reused)', async () => {
    const completedCreate = create('m-create-001', 'local-done', { title: 'Done', completed: true, completionEvent: { completionId: 'c-create', completedAt: COMPLETED_AT, utcOffsetMinutes: 330 } });
    const first = await sync([completedCreate]);
    const retry = await sync([{ ...completedCreate, mutationId: 'm-create-002' }]);
    expect(first.body.results[0].status).toBe('applied');
    expect(retry.body.results[0]).toMatchObject({ status: 'replayed', task: { completed: true, completionId: 'c-create' } });
    expect(tasks.size()).toBe(1);
    expect(records.docs.filter((d) => d.completionId === 'c-create')).toHaveLength(1);
  });

  it('a different user can use the same client key (the key is per user)', async () => {
    await sync([create('m-create-001', 'local-aaa')]);
    const res = await sync([create('m-create-001', 'local-aaa')], B);
    expect(res.body.results[0].status).toBe('applied');
    expect(tasks.size()).toBe(2);
  });

  it('single-task POST accepts the same optional clientKey, replays it, and refuses an invalid one', async () => {
    const first = await request(app).post('/api/tasks').set(as(A)).send({ title: 'x', clientKey: 'local-solo' });
    const again = await request(app).post('/api/tasks').set(as(A)).send({ title: 'x', clientKey: 'local-solo' });
    const bad = await request(app).post('/api/tasks').set(as(A)).send({ title: 'x', clientKey: 'no spaces' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.task._id).toBe(first.body.task._id);
    expect(bad.status).toBe(400);
    expect(tasks.size()).toBe(1);
  });
});

describe('update', () => {
  it('applies an update, stores the marker beside it, and a retry of the same mutation changes nothing', async () => {
    const task = tasks.seed(A, { title: 'Before' }) as { _id: string };
    const first = await sync([update('m-update-001', { id: task._id }, { title: 'After' })]);
    expect(first.body.results[0]).toMatchObject({ status: 'applied', task: { title: 'After' } });
    expect(JSON.stringify(first.body)).not.toContain('appliedMutations');
    expect(tasks.get(task._id)?.appliedMutations).toEqual([{ id: 'm-update-001', fp: fingerprintOf({ title: 'After' }) }]);

    const writes = tasks.ops.filter((o) => o.op === 'findOneAndUpdate').length;
    const retry = await sync([update('m-update-001', { id: task._id }, { title: 'After' })]);
    expect(retry.body.results[0]).toMatchObject({ status: 'replayed', task: { title: 'After' } });
    expect(tasks.ops.filter((o) => o.op === 'findOneAndUpdate').length).toBe(writes); // a replay writes nothing
    expect(JSON.stringify(retry.body)).not.toContain('appliedMutations');
  });

  it('a replay of an older mutation does not undo a newer one (the stale-retry case)', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    await sync([update('m-update-001', { id: task._id }, { title: 'One' })]);
    await sync([update('m-update-002', { id: task._id }, { title: 'Two' })]);
    const replay = await sync([update('m-update-001', { id: task._id }, { title: 'One' })]);
    expect(replay.body.results[0].status).toBe('replayed');
    expect(tasks.get(task._id)?.title).toBe('Two');
  });

  it('the same mutation id with a DIFFERENT change is refused (409 MUTATION_ID_REUSED) and changes nothing', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    await sync([update('m-update-001', { id: task._id }, { title: 'One' })]);
    const res = await sync([update('m-update-001', { id: task._id }, { title: 'Different' })]);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', retryable: false, error: { httpStatus: 409, code: 'MUTATION_ID_REUSED' } });
    expect(tasks.get(task._id)?.title).toBe('One');
  });

  it('the fingerprint ignores key order', async () => {
    const task = tasks.seed(A) as { _id: string };
    await sync([update('m-update-001', { id: task._id }, { title: 'T', priority: 'high' })]);
    const res = await sync([update('m-update-001', { id: task._id }, { priority: 'high', title: 'T' })]);
    expect(res.body.results[0].status).toBe('replayed');
  });

  it('a concurrent request that applies the same mutation between the read and the write makes this one a replay (not a 404 or 409)', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    const payload = { title: 'Raced' };
    tasks.hooks.beforeWrite = () => {
      tasks.hooks.beforeWrite = undefined;
      tasks.patch(task._id, { title: 'Raced', appliedMutations: [{ id: 'm-race-00001', fp: fingerprintOf(payload) }] });
    };
    const res = await sync([update('m-race-00001', { id: task._id }, payload)]);
    expect(res.body.results[0]).toMatchObject({ status: 'replayed', task: { title: 'Raced' } });
    expect(tasks.get(task._id)?.appliedMutations).toHaveLength(1); // the duplicate guard matched nothing: no second marker
  });

  it('remembers only the last 25 applied mutations of a task (a documented, bounded window)', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    const list = Array.from({ length: 26 }, (_, i) => update(`m-window-${String(i).padStart(3, '0')}`, { id: task._id }, { title: `T${i}` }));
    await sync(list);
    const stored = tasks.get(task._id)?.appliedMutations as Array<{ id: string }>;
    expect(stored).toHaveLength(25);
    expect(stored[0].id).toBe('m-window-001');
    // inside the window: a replay. Outside it: the oldest id is forgotten and would apply again.
    expect((await sync([list[25]])).body.results[0].status).toBe('replayed');
    expect((await sync([list[0]])).body.results[0].status).toBe('applied');
  });

  it('refuses an update that carries completion state (completions are their own mutation type)', async () => {
    const task = tasks.seed(A) as { _id: string };
    const withCompleted = await sync([update('m-update-001', { id: task._id }, { completed: true })]);
    const withEvent = await sync([update('m-update-002', { id: task._id }, { completed: false, completionEvent: { revokedAt: ago(MIN) } })]);
    for (const res of [withCompleted, withEvent]) {
      expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 400, code: 'UPDATE_CARRIES_COMPLETION' } });
    }
    expect(tasks.get(task._id)?.completed).toBe(false);
  });

  it('every single-task validation rule applies per item: a bad item is rejected, the others are still applied', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    const res = await sync([
      update('m-update-001', { id: task._id }, { title: '   ' }),
      update('m-update-002', { id: task._id }, { priority: 'urgent' }),
      update('m-update-003', { id: task._id }, { title: 'Good' }),
    ]);
    expect(statuses(res)).toEqual(['rejected', 'rejected', 'applied']);
    expect(res.body.results[0].error).toMatchObject({ httpStatus: 400, message: 'title must be a non-empty string' });
    expect(tasks.get(task._id)?.title).toBe('Good');
  });

  it("answers 404 for a task that does not exist and for another user's task, and never touches the latter", async () => {
    const mine = tasks.seed(A, { title: 'Mine' }) as { _id: string };
    const res = await sync([update('m-update-001', { id: '665f1c2e9b1e8a00000000ff' }, { title: 'x' })], B);
    const other = await sync([update('m-update-002', { id: mine._id }, { title: 'Hijacked' })], B);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 404 } });
    expect(other.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 404 } });
    expect(tasks.get(mine._id)).toMatchObject({ title: 'Mine' });
    expect(tasks.get(mine._id)?.appliedMutations).toBeUndefined();
  });

  it('the same mutation id from two users is independent', async () => {
    const a = tasks.seed(A, { title: 'A' }) as { _id: string };
    const b = tasks.seed(B, { title: 'B' }) as { _id: string };
    const resA = await sync([update('m-shared-001', { id: a._id }, { title: 'A2' })]);
    const resB = await sync([update('m-shared-001', { id: b._id }, { title: 'B2' })], B);
    expect(resA.body.results[0].status).toBe('applied');
    expect(resB.body.results[0].status).toBe('applied');
  });

  it('a malformed task id is rejected per item (400), not a failed request', async () => {
    const res = await sync([update('m-update-001', { id: 'nope' }, { title: 'x' })]);
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 400 } });
  });

  it('keeps the single-task 409 for a due date removed under a due-time edit, with its code, as a rejected item', async () => {
    const task = tasks.seed(A, { dueDate: new Date('2026-12-01T00:00:00Z') }) as { _id: string };
    tasks.hooks.beforeWrite = () => {
      tasks.hooks.beforeWrite = undefined;
      tasks.patch(task._id, { dueDate: undefined }); // another request removes the date between the read and the write
    };
    const res = await sync([update('m-update-001', { id: task._id }, { dueTime: '09:00' })]);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', retryable: false, error: { httpStatus: 409, code: 'TASK_DUE_DATE_REMOVED' } });
    expect(tasks.get(task._id)?.dueTime).toBeUndefined();
    expect(tasks.get(task._id)?.appliedMutations).toBeUndefined(); // nothing was written, so nothing is marked applied
  });
});

describe('completion', () => {
  it('records a completion through the same arbitration as the single route, and a repeat is safe', async () => {
    const task = tasks.seed(A, { title: 'Done soon' }) as { _id: string };
    const first = await sync([complete('m-compl-0001', { id: task._id })]);
    expect(first.body.results[0]).toMatchObject({ status: 'applied', task: { completed: true, completionId: 'c1' } });
    expect(records.docs.filter((d) => d.completionId === 'c1')).toHaveLength(1);

    const again = await sync([complete('m-compl-0002', { id: task._id })]);
    expect(again.body.results[0].status).toBe('applied');
    expect(records.docs.filter((d) => d.completionId === 'c1')).toHaveLength(1);
  });

  it('a completion for a task that is gone is rejected 404 (the client delivers it standalone)', async () => {
    const res = await sync([complete('m-compl-0001', { id: '665f1c2e9b1e8a00000000ff' })]);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 404 } });
  });

  it('a completion without a completionEvent, or without completed, is rejected per item', async () => {
    const task = tasks.seed(A) as { _id: string };
    const res = await sync([
      { mutationId: 'm-compl-0001', type: 'completion', task: { id: task._id }, payload: { completed: true } },
      { mutationId: 'm-compl-0002', type: 'completion', task: { id: task._id }, payload: { completionEvent: {} } },
    ]);
    expect(statuses(res)).toEqual(['rejected', 'rejected']);
    expect(tasks.get(task._id)?.completed).toBe(false);
  });

  it('a completion event the server refuses (id belongs to another task) is rejected and changes nothing', async () => {
    const one = tasks.seed(A) as { _id: string };
    const two = tasks.seed(A) as { _id: string };
    await sync([complete('m-compl-0001', { id: one._id }, 'shared-id')]);
    const res = await sync([complete('m-compl-0002', { id: two._id }, 'shared-id')]);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 400 } });
    expect(tasks.get(two._id)?.completed).toBe(false);
  });
});

describe('delete', () => {
  it('deletes, and a repeat (or a task that never existed) is a success marked alreadyDeleted', async () => {
    const task = tasks.seed(A) as { _id: string };
    const first = await sync([remove('m-delete-001', { id: task._id })]);
    const repeat = await sync([remove('m-delete-002', { id: task._id })]);
    const never = await sync([remove('m-delete-003', { localId: 'local-never' })]);
    expect(first.body.results[0]).toEqual({ mutationId: 'm-delete-001', status: 'applied' });
    expect(repeat.body.results[0]).toEqual({ mutationId: 'm-delete-002', status: 'applied', alreadyDeleted: true });
    expect(never.body.results[0]).toEqual({ mutationId: 'm-delete-003', status: 'applied', alreadyDeleted: true });
    expect(tasks.has(task._id)).toBe(false);
  });

  it("deleting another user's task answers exactly like a missing one and deletes nothing", async () => {
    const mine = tasks.seed(A) as { _id: string };
    const res = await sync([remove('m-delete-001', { id: mine._id })], B);
    expect(res.body.results[0]).toEqual({ mutationId: 'm-delete-001', status: 'applied', alreadyDeleted: true });
    expect(tasks.has(mine._id)).toBe(true);
  });

  it('a malformed id is rejected, not treated as already deleted', async () => {
    const res = await sync([remove('m-delete-001', { id: 'nope' })]);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 400 } });
  });

  it('the single-task DELETE keeps its 404 for a repeat', async () => {
    const task = tasks.seed(A) as { _id: string };
    expect((await request(app).delete(`/api/tasks/${task._id}`).set(as(A))).status).toBe(200);
    expect((await request(app).delete(`/api/tasks/${task._id}`).set(as(A))).status).toBe(404);
  });
});

describe('ordering and partial failure', () => {
  it('create -> update -> complete -> delete of one local task runs in request order, resolving the local id, in one request', async () => {
    const res = await sync([
      create('m-order-0001', 'local-chain', { title: 'Chain' }),
      update('m-order-0002', { localId: 'local-chain' }, { title: 'Chain 2' }),
      complete('m-order-0003', { localId: 'local-chain' }),
      remove('m-order-0004', { localId: 'local-chain' }),
    ]);
    expect(statuses(res)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(res.body.results[1].task.title).toBe('Chain 2');
    expect(res.body.results[2].task.completed).toBe(true);
    expect(tasks.size()).toBe(0);
    const kinds = tasks.ops.map((o) => o.op);
    expect(kinds.indexOf('create')).toBeLessThan(kinds.indexOf('findOneAndUpdate'));
    expect(kinds.indexOf('findOneAndUpdate')).toBeLessThan(kinds.indexOf('findOneAndDelete'));
  });

  it('results keep request order and length with a mix of outcomes (partial success)', async () => {
    const task = tasks.seed(A) as { _id: string };
    const res = await sync([
      create('m-mixed-0001', 'local-1'),
      update('m-mixed-0002', { id: task._id }, { title: '' }),
      remove('m-mixed-0003', { id: '665f1c2e9b1e8a00000000ff' }),
      update('m-mixed-0004', { id: task._id }, { title: 'Fine' }),
    ]);
    expect(ids(res)).toEqual(['m-mixed-0001', 'm-mixed-0002', 'm-mixed-0003', 'm-mixed-0004']);
    expect(statuses(res)).toEqual(['applied', 'rejected', 'applied', 'applied']);
  });

  it('a transient failure of a create skips the later mutations of that task, not other tasks; the same batch then retries cleanly', async () => {
    const other = tasks.seed(A, { title: 'Other' }) as { _id: string };
    tasks.faults.push({ op: 'create', count: 1 });
    const batch = [
      create('m-fail-00001', 'local-x', { title: 'X' }),
      update('m-fail-00002', { localId: 'local-x' }, { title: 'X2' }),
      remove('m-fail-00003', { localId: 'local-x' }),
      update('m-fail-00004', { id: other._id }, { title: 'Other 2' }),
    ];
    const res = await sync(batch);
    expect(statuses(res)).toEqual(['failed', 'skipped', 'skipped', 'applied']);
    expect(res.body.results[0]).toMatchObject({ retryable: true });
    expect(res.body.results[1]).toMatchObject({ retryable: true, error: { code: 'BLOCKED_BY_EARLIER_MUTATION', blockedBy: 'm-fail-00001' } });
    expect(tasks.size()).toBe(1);

    const retry = await sync(batch);
    expect(statuses(retry)).toEqual(['applied', 'applied', 'applied', 'replayed']);
    expect(tasks.size()).toBe(1); // created, edited, then deleted; the other task is untouched by the retry
    expect(tasks.get(other._id)?.title).toBe('Other 2');
  });

  it('a transient failure of an update skips the next update of the SAME task only', async () => {
    const one = tasks.seed(A, { title: '1' }) as { _id: string };
    const two = tasks.seed(A, { title: '2' }) as { _id: string };
    tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });
    const res = await sync([
      update('m-fail-00001', { id: one._id }, { title: '1a' }),
      update('m-fail-00002', { id: one._id }, { title: '1b' }),
      update('m-fail-00003', { id: two._id }, { title: '2a' }),
    ]);
    expect(statuses(res)).toEqual(['failed', 'skipped', 'applied']);
    expect(tasks.get(one._id)?.title).toBe('1'); // the later edit did not land before the earlier one
    expect(tasks.get(two._id)?.title).toBe('2a');
  });

  it('a block holds however the task is named: a failure by local id also skips a later mutation naming it by id', async () => {
    const task = tasks.seed(A, { title: 'Keyed', clientKey: 'local-keyed' }) as { _id: string };
    tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });
    const res = await sync([
      update('m-name-000001', { localId: 'local-keyed' }, { title: 'By local id' }),
      update('m-name-000002', { id: task._id }, { title: 'By id' }),
    ]);
    expect(statuses(res)).toEqual(['failed', 'skipped']);
    expect(tasks.get(task._id)?.title).toBe('Keyed');
  });

  it('...and the other way round: a failure by id also skips a later mutation naming the task by local id', async () => {
    const task = tasks.seed(A, { title: 'Keyed', clientKey: 'local-keyed' }) as { _id: string };
    tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });
    const res = await sync([
      update('m-name-000001', { id: task._id }, { title: 'By id' }),
      update('m-name-000002', { localId: 'local-keyed' }, { title: 'By local id' }),
    ]);
    expect(statuses(res)).toEqual(['failed', 'skipped']);
    expect(tasks.get(task._id)?.title).toBe('Keyed');
  });

  it('a permanent refusal does not block later mutations of the task', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    const res = await sync([update('m-rej-000001', { id: task._id }, { title: '' }), update('m-rej-000002', { id: task._id }, { title: 'Next' })]);
    expect(statuses(res)).toEqual(['rejected', 'applied']);
  });

  it('a rejected create leaves later mutations to be answered on their own merits (404), not skipped', async () => {
    const res = await sync([
      create('m-rej-000001', 'local-bad', { title: '' }),
      update('m-rej-000002', { localId: 'local-bad' }, { title: 'x' }),
    ]);
    expect(statuses(res)).toEqual(['rejected', 'rejected']);
    expect(res.body.results[1].error.httpStatus).toBe(404);
  });

  it('a user cannot resolve another user\'s local id', async () => {
    await sync([create('m-create-001', 'local-private', { title: 'Private' })]);
    const res = await sync([update('m-update-001', { localId: 'local-private' }, { title: 'Hijack' })], B);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', error: { httpStatus: 404 } });
    expect(tasks.all().map((t) => t.title)).toEqual(['Private']);
  });
});

describe('single-task routes keep their contract', () => {
  it('PUT answers exactly as before, and never exposes the marker even after a batch update', async () => {
    const task = tasks.seed(A, { title: 'Start' }) as { _id: string };
    await sync([update('m-update-001', { id: task._id }, { title: 'Batched' })]);
    const res = await request(app).put(`/api/tasks/${task._id}`).set(as(A)).send({ title: 'Single' });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Single');
    expect(JSON.stringify(res.body)).not.toContain('appliedMutations');
    const list = await request(app).get('/api/tasks').set(as(A));
    expect(JSON.stringify(list.body)).not.toContain('appliedMutations');
  });
});
