import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createCompletionStore, type CompletionStore } from './helpers/completionDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';
import { fingerprintOf } from '../src/utils/mutationFingerprint';

// Issue #62A — conflict semantics of POST /api/tasks/sync (an update that carries `base`), through the REAL app (auth, rate limiter, envelope, services, completion arbitration) with the
// strict in-memory User, Task and CompletionRecord doubles. Mongo-free. What these cannot prove (MongoDB's own equality on
// dates, lists and subdocuments, and real concurrency) is in tests/taskConflict.realmongo.test.ts, which needs a MongoDB binary.

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

const withBase = (mutationId: string, task: Body, payload: Body, base: unknown) => ({ ...update(mutationId, task, payload), base });
const first = (res: { body: { results: Array<Record<string, any>> } }) => res.body.results[0];
const D1 = '2026-11-01T00:00:00.000Z';
const D2 = '2026-12-01T00:00:00.000Z';
const writes = () => tasks.ops.filter((o) => o.op === 'findOneAndUpdate').length;
const id = (t: unknown) => (t as { _id: string })._id;

describe('unchanged behaviour without base (characterisation: last write wins)', () => {
  it('the same field edited from two devices: the later arrival silently wins', async () => {
    const task = id(tasks.seed(A, { title: 'Start' }));
    await sync([update('m-dev1-00001', { id: task }, { title: 'Device one' })]);
    const res = await sync([update('m-dev2-00001', { id: task }, { title: 'Device two' })]);
    expect(first(res).status).toBe('applied');
    expect(tasks.get(task)?.title).toBe('Device two');
  });

  it('the single PUT ignores a base in its body and stays last-write-wins', async () => {
    const task = id(tasks.seed(A, { title: 'Theirs' }));
    const res = await request(app).put(`/api/tasks/${task}`).set(as(A)).send({ title: 'Mine', base: { title: 'Old' } });
    expect(res.status).toBe(200);
    expect(tasks.get(task)?.title).toBe('Mine');
  });

  it('a mutation without base keeps its #60 fingerprint', async () => {
    const task = id(tasks.seed(A));
    await sync([update('m-update-001', { id: task }, { title: 'T' })]);
    expect(tasks.get(task)?.appliedMutations).toEqual([{ id: 'm-update-001', fp: fingerprintOf({ title: 'T' }) }]);
  });
});

describe('conflict detection', () => {
  it('applies when the server still holds the expected value', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res)).toMatchObject({ status: 'applied', task: { title: 'Mine' } });
  });

  it('answers conflict when another device changed the field: nothing written, no marker, current task and fields returned', async () => {
    const task = id(tasks.seed(A, { title: 'Theirs', priority: 'low' }));
    const before = writes();
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res)).toMatchObject({
      status: 'conflict',
      retryable: false,
      conflicts: [{ field: 'title', base: 'Old', requested: 'Mine', current: 'Theirs' }],
      task: { title: 'Theirs' },
    });
    expect(JSON.stringify(res.body)).not.toContain('appliedMutations');
    expect(writes()).toBe(before);
    expect(tasks.get(task)?.title).toBe('Theirs');
    expect(tasks.get(task)?.appliedMutations).toBeUndefined();
  });

  it('a repeated conflicted mutation is judged again: same answer while the server is unchanged, applied once the field is back at base', async () => {
    const task = id(tasks.seed(A, { title: 'Theirs' }));
    const m = withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' });
    expect(first(await sync([m])).status).toBe('conflict');
    expect(first(await sync([m])).status).toBe('conflict');
    tasks.patch(task, { title: 'Old' });
    expect(first(await sync([m])).status).toBe('applied');
    expect(first(await sync([m])).status).toBe('replayed');
  });

  it('an APPLIED mutation replays as a replay even after the field changed again (the marker is checked first)', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    const m = withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' });
    await sync([m]);
    tasks.patch(task, { title: 'Someone else' });
    expect(first(await sync([m]))).toMatchObject({ status: 'replayed' });
    expect(tasks.get(task)?.title).toBe('Someone else');
  });

  it('D5: a field that already holds the requested value is not a conflict', async () => {
    const task = id(tasks.seed(A, { title: 'Mine' }));
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res).status).toBe('applied');
  });

  it('different fields never conflict: both edits survive', async () => {
    const task = id(tasks.seed(A, { title: 'Old', priority: 'low' }));
    await sync([update('m-dev1-00001', { id: task }, { priority: 'high' })]); // the other device
    const res = await sync([withBase('m-dev2-00001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res).status).toBe('applied');
    expect(tasks.get(task)).toMatchObject({ title: 'Mine', priority: 'high' });
  });

  it('D3: one conflicting field stops the WHOLE mutation, including its non-conflicting fields', async () => {
    const task = id(tasks.seed(A, { title: 'Old', priority: 'high' }));
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine', priority: 'low' }, { title: 'Old', priority: 'medium' })]);
    expect(first(res).conflicts.map((c: { field: string }) => c.field)).toEqual(['priority']);
    expect(tasks.get(task)).toMatchObject({ title: 'Old', priority: 'high' });
  });

  it('a field NOT named in base stays last-write-wins even in a mutation that has a base', async () => {
    const task = id(tasks.seed(A, { title: 'Old', priority: 'high' }));
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine', priority: 'low' }, { title: 'Old' })]);
    expect(first(res).status).toBe('applied');
    expect(tasks.get(task)).toMatchObject({ title: 'Mine', priority: 'low' });
  });

  it('a conflict does not block later mutations of the task, and later mutations are judged on their own', async () => {
    const task = id(tasks.seed(A, { title: 'Theirs', priority: 'low' }));
    const res = await sync([
      withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' }),
      update('m-update-002', { id: task }, { priority: 'high' }),
    ]);
    expect(statuses(res)).toEqual(['conflict', 'applied']);
  });

  it('optional fields: absent is a value. Expected-absent vs set elsewhere conflicts; clearing what is expected applies', async () => {
    const task = id(tasks.seed(A, { dueDate: new Date(D2) }));
    const clash = await sync([withBase('m-update-001', { id: task }, { dueDate: D1 }, { dueDate: null })]);
    expect(first(clash)).toMatchObject({ status: 'conflict', conflicts: [{ field: 'dueDate', base: null, requested: D1, current: D2 }] });

    const clear = await sync([withBase('m-update-002', { id: task }, { dueDate: null }, { dueDate: D2 })]);
    expect(first(clear).status).toBe('applied');
    expect(tasks.get(task)?.dueDate).toBeUndefined();
  });

  it('dates are compared as instants, whatever form the client wrote them in', async () => {
    const task = id(tasks.seed(A, { dueDate: new Date(D1) }));
    const res = await sync([withBase('m-update-001', { id: task }, { dueDate: D2 }, { dueDate: '2026-11-01T05:30:00+05:30' })]);
    expect(first(res).status).toBe('applied');
  });

  it('strings are compared as the server stores them (trimmed)', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: '  Old  ' })]);
    expect(first(res).status).toBe('applied');
  });

  it('dueTime and startTime are checked like any optional field', async () => {
    const task = id(tasks.seed(A, { dueDate: new Date(D1), dueTime: '10:00' }));
    const res = await sync([withBase('m-update-001', { id: task }, { dueTime: '11:00' }, { dueTime: '09:00' })]);
    expect(first(res)).toMatchObject({ status: 'conflict', conflicts: [{ field: 'dueTime', current: '10:00' }] });
    const ok = await sync([withBase('m-update-002', { id: task }, { startTime: '2026-11-01T09:30:00Z' }, { startTime: null })]);
    expect(first(ok).status).toBe('applied');
  });

  it('tags are ONE field: any change to the list conflicts, an identical list does not', async () => {
    const task = id(tasks.seed(A, { tags: ['a', 'b'] }));
    expect(first(await sync([withBase('m-update-001', { id: task }, { tags: ['z'] }, { tags: ['a'] })])).status).toBe('conflict');
    expect(first(await sync([withBase('m-update-002', { id: task }, { tags: ['z'] }, { tags: ['a', 'b'] })])).status).toBe('applied');
    // order matters: a reordered list is a different list
    expect(first(await sync([withBase('m-update-003', { id: task }, { tags: ['q'] }, { tags: ['z', 'y'] })])).status).toBe('conflict');
  });

  it('subtasks are ONE field: compared on id, title and completed, in order', async () => {
    const s = (sid: string, title: string, completed = false) => ({ id: sid, title, completed });
    const task = id(tasks.seed(A, { subtasks: [s('s1', 'One'), s('s2', 'Two', true)] }));
    expect(first(await sync([withBase('m-update-001', { id: task }, { subtasks: [] }, { subtasks: [s('s1', 'One')] })])).status).toBe('conflict');
    expect(first(await sync([withBase('m-update-002', { id: task }, { subtasks: [s('s1', 'One', true), s('s2', 'Two', true)] }, { subtasks: [s('s1', 'One'), s('s2', 'Two', true)] })])).status).toBe('applied');
    // a toggled flag on the server is a change to the field
    expect(first(await sync([withBase('m-update-003', { id: task }, { subtasks: [] }, { subtasks: [s('s1', 'One'), s('s2', 'Two', true)] })])).status).toBe('conflict');
  });

  it('empty and absent lists are the same value (a null subtasks base means [])', async () => {
    const task = id(tasks.seed(A, {}));
    const res = await sync([withBase('m-update-001', { id: task }, { subtasks: [{ id: 's1', title: 'One', completed: false }], tags: ['x'] }, { subtasks: null, tags: [] })]);
    expect(first(res).status).toBe('applied');
  });

  it('a task from before a field existed (missing in the database) matches its schema default', async () => {
    const task = id(tasks.seed(A, {}));
    const res = await sync([withBase('m-update-001', { id: task }, { estimatedMinutes: 30, reminderSent: true, description: 'd' }, { estimatedMinutes: 0, reminderSent: false, description: '' })]);
    expect(first(res).status).toBe('applied');
  });

  it('completion is independent of a title update: completing does not conflict with an edit based on the title', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    await sync([complete('m-compl-0001', { id: task })]);
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res).status).toBe('applied');
    expect(tasks.get(task)).toMatchObject({ title: 'Mine', completed: true });
  });
});

describe('delete vs update (D9: delete wins, no precondition)', () => {
  it('delete then update: the update is rejected 404, as today', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    await sync([remove('m-delete-001', { id: task })]);
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res)).toMatchObject({ status: 'rejected', error: { httpStatus: 404 } });
  });

  it('update then delete: the delete wins even though the task changed', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    await sync([update('m-update-001', { id: task }, { title: 'Theirs' })]);
    const res = await sync([remove('m-delete-001', { id: task })]);
    expect(first(res).status).toBe('applied');
    expect(tasks.has(task)).toBe(false);
  });
});

describe('base validation (a bad base rejects that item only, 400 INVALID_BASE)', () => {
  const bad = async (base: unknown, payload: Body = { title: 'Mine' }) => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    const res = await sync([withBase('m-bad-000001', { id: task }, payload, base), update('m-good-00001', { id: task }, { priority: 'high' })]);
    expect(first(res)).toMatchObject({ status: 'rejected', retryable: false, error: { httpStatus: 400, code: 'INVALID_BASE' } });
    expect(res.body.results[1].status).toBe('applied'); // the batch carries on
    expect(tasks.get(task)?.title).toBe('Old');
  };
  it('not an object', async () => {
    await bad('Old');
    await bad(['Old']);
    await bad(null);
  });
  it('a field that cannot be checked (completion is its own mutation type)', async () => bad({ completed: false }, { title: 'Mine' }));
  it('an unknown field', async () => bad({ colour: 'red' }));
  it('a field the mutation does not change', async () => bad({ priority: 'low' }));
  it('a value the field would not accept', async () => bad({ title: '   ' }));
  it('a value of the wrong type', async () => bad({ tags: 'a' }, { tags: ['a'] }));

  it('a base on a create, completion or delete is refused instead of silently unchecked', async () => {
    const task = id(tasks.seed(A));
    const res = await sync([
      { ...create('m-create-001', 'local-1'), base: { title: 'x' } },
      { ...complete('m-compl-0001', { id: task }), base: { title: 'x' } },
      { ...remove('m-delete-001', { id: task }), base: { title: 'x' } },
    ]);
    expect(res.body.results.map((r: { status: string; error: { code: string } }) => [r.status, r.error.code])).toEqual([
      ['rejected', 'INVALID_BASE'],
      ['rejected', 'INVALID_BASE'],
      ['rejected', 'INVALID_BASE'],
    ]);
    expect(tasks.has(task)).toBe(true);
  });

  it('the same mutation id with a different base is a reuse (409 MUTATION_ID_REUSED), not a silent replay', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Other' })]);
    expect(first(res)).toMatchObject({ status: 'rejected', error: { code: 'MUTATION_ID_REUSED' } });
  });
});

describe('races between the check and the write', () => {
  it('another request changes a checked field after the read: the write matches nothing, the update is evaluated again and conflicts', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    tasks.hooks.beforeWrite = () => {
      tasks.hooks.beforeWrite = undefined;
      tasks.patch(task, { title: 'Raced in' });
    };
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res)).toMatchObject({ status: 'conflict', conflicts: [{ current: 'Raced in' }] });
    expect(tasks.get(task)?.title).toBe('Raced in');
    expect(tasks.get(task)?.appliedMutations).toBeUndefined();
  });

  it('...or changes it to the REQUESTED value: the re-check finds it already there and applies (D5)', async () => {
    const task = id(tasks.seed(A, { title: 'Old' }));
    tasks.hooks.beforeWrite = () => {
      tasks.hooks.beforeWrite = undefined;
      tasks.patch(task, { title: 'Mine' });
    };
    const res = await sync([withBase('m-update-001', { id: task }, { title: 'Mine' }, { title: 'Old' })]);
    expect(first(res).status).toBe('applied');
  });

  it('a field that flips between base and requested on every attempt: bounded, nothing written, a retryable failure that blocks the task\'s later mutations', async () => {
    const task = id(tasks.seed(A, { priority: 'low', title: 'T' }));
    let n = 0;
    // each rival write lands after the read and leaves a value the NEXT read accepts (low = base, high = requested)
    tasks.hooks.beforeWrite = () => {
      n += 1;
      tasks.patch(task, { priority: n % 2 === 1 ? 'high' : 'low' });
    };
    const res = await sync([
      withBase('m-update-001', { id: task }, { priority: 'high' }, { priority: 'low' }),
      update('m-update-002', { id: task }, { title: 'Later' }),
    ]);
    tasks.hooks.beforeWrite = undefined;
    expect(first(res)).toMatchObject({ status: 'failed', retryable: true, error: { httpStatus: 503, code: 'TASK_BUSY' } });
    expect(res.body.results[1].status).toBe('skipped');
    expect(n).toBe(4);
    expect(tasks.get(task)?.title).toBe('T');
    expect(tasks.get(task)?.appliedMutations).toBeUndefined();
  });

  it('the #43 recovery is unchanged: a due date removed under a due-time edit with a base is still TASK_DUE_DATE_REMOVED', async () => {
    const task = id(tasks.seed(A, { dueDate: new Date(D1), dueTime: '09:00' }));
    tasks.hooks.beforeWrite = () => {
      tasks.hooks.beforeWrite = undefined;
      tasks.patch(task, { dueDate: undefined });
    };
    const res = await sync([withBase('m-update-001', { id: task }, { dueTime: '10:00' }, { dueTime: '09:00' })]);
    expect(first(res)).toMatchObject({ status: 'rejected', error: { httpStatus: 409, code: 'TASK_DUE_DATE_REMOVED' } });
  });
});
