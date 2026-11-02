import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #15 (Phase 1, server contract): subtasks on a task, against the REAL app and controller with an in-memory Task
// double and a counting User double. Mongo-free. The double applies updates the way MongoDB does ($set writes, $unset
// removes), so "an update that omits subtasks leaves them alone" and "a rejected update writes nothing" are proven on
// the stored document, not asserted on a mock. What the double cannot prove (schema validation, real defaults,
// persistence) is covered by tests/taskModel.subtasks.test.ts (driver stubbed) and tests/taskSubtasks.realmongo.test.ts.

type Stored = Record<string, unknown> & { _id: string; userId: string };

const db = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  ops: [] as string[],
  /** Growth Tree award writes: every award goes through User.findOneAndUpdate. */
  awardWrites: 0,
  nextId: 1,
}));

const OWNER_A = '665f1c2e9b1e8a00000000aa';
const OWNER_B = '665f1c2e9b1e8a00000000bb';
const idOf = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;

  const owns = (filter: Record<string, unknown>) => {
    const task = db.tasks.get(String(filter._id));
    return task && task.userId === filter.userId ? task : null;
  };

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: () => ({ select: () => ({ lean: async () => ({ tokenVersion: 0 }) }) }),
      findOneAndUpdate: () => {
        db.awardWrites += 1;
        return { lean: async () => ({ treeState: { xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', awardedTaskIds: ['x'] } }) };
      },
    },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: (filter: Record<string, unknown>) => {
        const rows = [...db.tasks.values()].filter((t) => t.userId === filter.userId);
        const chain: Record<string, unknown> = {};
        chain.sort = () => chain;
        chain.skip = () => chain;
        chain.limit = async () => rows;
        return chain;
      },
      countDocuments: async (filter: Record<string, unknown>) => [...db.tasks.values()].filter((t) => t.userId === filter.userId).length,
      create: async (data: Record<string, unknown>) => {
        db.ops.push('create');
        const doc = { _id: idOf(db.nextId++), ...JSON.parse(JSON.stringify(data)) };
        db.tasks.set(doc._id, doc);
        return doc;
      },
      findOne: async (filter: Record<string, unknown>) => owns(filter),
      findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        db.ops.push('findOneAndUpdate');
        const task = owns(filter);
        if (!task) return null;
        const { $set, $unset, ...plain } = update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
        Object.assign(task, JSON.parse(JSON.stringify({ ...plain, ...($set ?? {}) })));
        for (const key of Object.keys($unset ?? {})) delete task[key];
        return task;
      },
      findOneAndDelete: async (filter: Record<string, unknown>) => {
        const task = owns(filter);
        if (task) db.tasks.delete(String(filter._id));
        return task;
      },
    },
  }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const create = (app: Express, body: Record<string, unknown>, userId = OWNER_A) =>
  request(app).post('/api/tasks').set(as(userId)).send({ title: 't', ...body });
const update = (app: Express, id: string, body: Record<string, unknown>, userId = OWNER_A) =>
  request(app).put(`/api/tasks/${id}`).set(as(userId)).send(body);

const sub = (n: number | string, extra: Record<string, unknown> = {}) => ({ id: `s${n}`, title: `step ${n}`, completed: false, ...extra });
const many = (count: number) => Array.from({ length: count }, (_, i) => sub(i));
const stored = (id: string): Stored => JSON.parse(JSON.stringify(db.tasks.get(id)));
const seed = (fields: Record<string, unknown> = {}, userId = OWNER_A): string => {
  const doc = { _id: idOf(db.nextId++), userId, title: 'seeded', completed: false, completedAt: null, ...fields };
  db.tasks.set(doc._id, doc);
  return doc._id;
};

beforeEach(() => {
  db.tasks.clear();
  db.ops.length = 0;
  db.awardWrites = 0;
  db.nextId = 1;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

describe('POST /api/tasks with subtasks', () => {
  it('a task without subtasks is created with an empty checklist (the field is optional)', async () => {
    const app = await loadApp();
    const res = await create(app, {});
    expect(res.status).toBe(201);
    expect(res.body.task.subtasks).toEqual([]);
  });

  it('stores the checklist as sent, trimming titles and dropping keys that are not part of a subtask', async () => {
    const app = await loadApp();
    const res = await create(app, {
      subtasks: [
        { id: 'a', title: '  Pack bag ', completed: true, priority: 'high', dueDate: '2026-11-01', _id: 'nope' },
        sub('b'),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.task.subtasks).toEqual([
      { id: 'a', title: 'Pack bag', completed: true },
      { id: 'sb', title: 'step b', completed: false },
    ]);
    expect(stored(res.body.task._id).subtasks).toEqual(res.body.task.subtasks);
  });

  it('null means no subtasks', async () => {
    const app = await loadApp();
    const res = await create(app, { subtasks: null });
    expect(res.status).toBe(201);
    expect(res.body.task.subtasks).toEqual([]);
  });

  it('allows exactly 20 and refuses 21, creating nothing', async () => {
    const app = await loadApp();
    expect((await create(app, { subtasks: many(20) })).status).toBe(201);
    db.ops.length = 0;
    const res = await create(app, { subtasks: many(21) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'subtasks cannot have more than 20 entries' });
    expect(db.ops).toEqual([]);
  });

  it.each([
    ['not an array', 'one', 'subtasks must be an array'],
    ['an object instead of an array', { 0: sub(1) }, 'subtasks must be an array'],
    ['an entry that is not an object', ['x'], 'subtasks[0] must be an object'],
    ['an invalid id', [{ id: 'a b', title: 't', completed: false }], 'subtasks[0].id must be 1-64 characters: letters, digits, underscore or hyphen'],
    ['a missing id (the server never invents one)', [{ title: 't', completed: false }], 'subtasks[0].id must be 1-64 characters: letters, digits, underscore or hyphen'],
    ['an empty title', [sub(1, { title: '  ' })], 'subtasks[0].title must be a non-empty string of at most 200 characters'],
    ['a non-boolean completed', [sub(1, { completed: 'yes' })], 'subtasks[0].completed must be a boolean'],
    ['a repeated id', [sub(1), sub(2), sub(1)], 'subtasks[2].id is already used by another subtask'],
  ])('refuses %s with a specific message and creates nothing', async (_label, subtasks, message) => {
    const app = await loadApp();
    const res = await create(app, { subtasks });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message });
    expect(res.body).not.toHaveProperty('code');
    expect(db.ops).toEqual([]);
    expect(db.tasks.size).toBe(0);
  });
});

describe('PUT /api/tasks/:id with subtasks', () => {
  it('replaces the whole checklist', async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1), sub(2)] });
    const res = await update(app, id, { subtasks: [sub(2, { completed: true }), sub(3)] });
    expect(res.status).toBe(200);
    expect(res.body.task.subtasks).toEqual([
      { id: 's2', title: 'step 2', completed: true },
      { id: 's3', title: 'step 3', completed: false },
    ]);
    expect(stored(id).subtasks).toEqual(res.body.task.subtasks);
  });

  it.each([[[]], [null]])('%j clears the checklist (stored as an empty list, not removed)', async (clear) => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1), sub(2)] });
    const res = await update(app, id, { subtasks: clear });
    expect(res.status).toBe(200);
    expect(res.body.task.subtasks).toEqual([]);
    expect(stored(id).subtasks).toEqual([]);
  });

  describe('an update that does not send subtasks (an older client) never clears them', () => {
    const body = (b: Record<string, unknown>) => b;
    it.each([
      ['a title change', body({ title: 'renamed' })],
      ['completing the task', body({ completed: true })],
      ['uncompleting the task', body({ completed: false })],
      ['tags, priority and estimate', body({ tags: ['a'], priority: 'high', estimatedMinutes: 30 })],
      ['clearing the due date', body({ dueDate: null })],
      ['an empty body', body({})],
    ])('%s leaves the stored subtasks exactly as they were', async (_label, change) => {
      const app = await loadApp();
      const id = seed({ subtasks: [sub(1, { completed: true }), sub(2)], dueDate: '2026-10-20T00:00:00.000Z' });
      const before = stored(id).subtasks;
      const res = await update(app, id, change);
      expect(res.status).toBe(200);
      expect(stored(id).subtasks).toEqual(before);
      expect(res.body.task.subtasks).toEqual(before);
    });

    it('a stored task that has no subtasks key at all (created before the field) stays that way when updated without it', async () => {
      const app = await loadApp();
      const id = seed({});
      const res = await update(app, id, { title: 'renamed' });
      expect(res.status).toBe(200);
      expect(stored(id)).not.toHaveProperty('subtasks');
    });
  });

  describe('a rejected update writes nothing', () => {
    it.each([
      ['more than 20', many(21), 'subtasks cannot have more than 20 entries'],
      ['a repeated id', [sub(1), sub(1)], 'subtasks[1].id is already used by another subtask'],
      ['a bad id', [sub(1, { id: 'x y' })], 'subtasks[0].id must be 1-64 characters: letters, digits, underscore or hyphen'],
      ['a non-array', 'nope', 'subtasks must be an array'],
    ])('%s: 400, no database write, the task is unchanged', async (_label, subtasks, message) => {
      const app = await loadApp();
      const id = seed({ subtasks: [sub(1)], title: 'keep me' });
      const before = stored(id);
      db.ops.length = 0;

      const res = await update(app, id, { subtasks });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message });
      expect(res.body).not.toHaveProperty('code');
      expect(db.ops).toEqual([]);
      expect(stored(id)).toEqual(before);
    });

    it('a valid title next to an invalid checklist changes neither (no partial update)', async () => {
      const app = await loadApp();
      const id = seed({ subtasks: [sub(1)], title: 'keep me' });
      const before = stored(id);

      const res = await update(app, id, { title: 'new title', subtasks: [sub(1, { completed: 'x' })] });

      expect(res.status).toBe(400);
      expect(stored(id)).toEqual(before);
    });
  });

  it('a title and a checklist can change in the same request', async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1)] });
    const res = await update(app, id, { title: 'both', subtasks: [sub(1, { completed: true })] });
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ title: 'both', subtasks: [{ id: 's1', title: 'step 1', completed: true }] });
  });

  it("another user's task cannot be changed: 404, and the stored checklist is untouched", async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1)] }, OWNER_A);
    const before = stored(id);
    const res = await update(app, id, { subtasks: [sub('hijack')] }, OWNER_B);
    expect(res.status).toBe(404);
    expect(stored(id)).toEqual(before);
  });
});

describe('GET /api/tasks returns the checklist with the task', () => {
  it('includes each task\'s subtasks', async () => {
    const app = await loadApp();
    seed({ subtasks: [sub(1, { completed: true })] });
    const res = await request(app).get('/api/tasks').set(as(OWNER_A));
    expect(res.status).toBe(200);
    expect(res.body.tasks[0].subtasks).toEqual([{ id: 's1', title: 'step 1', completed: true }]);
  });
});

// Parent and subtasks are independent. Only the parent's own incomplete -> complete transition can award growth XP.
describe('growth award: subtasks never feed it', () => {
  /** How many award writes one ordinary completion of a task with NO subtasks makes (the baseline for "awarded once"). */
  const baselineAwardWrites = async (app: Express): Promise<number> => {
    const id = seed({});
    db.awardWrites = 0;
    expect((await update(app, id, { completed: true })).status).toBe(200);
    const writes = db.awardWrites;
    db.awardWrites = 0;
    expect(writes).toBeGreaterThan(0);
    return writes;
  };

  it('completing EVERY subtask leaves the parent incomplete and awards nothing', async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1), sub(2)] });
    const res = await update(app, id, { subtasks: [sub(1, { completed: true }), sub(2, { completed: true })] });

    expect(res.status).toBe(200);
    expect(res.body.task.completed).toBe(false);
    expect(res.body.task.completedAt).toBeNull();
    expect(res.body).not.toHaveProperty('growth');
    expect(db.awardWrites).toBe(0);
  });

  it('a subtask-only update on an incomplete parent never reaches the award', async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1)] });
    await update(app, id, { subtasks: [sub(1, { completed: true })] });
    await update(app, id, { subtasks: [sub(1, { completed: false })] });
    expect(db.awardWrites).toBe(0);
  });

  it('completing the PARENT awards exactly once, and leaves every subtask as it was', async () => {
    const app = await loadApp();
    const expectedWrites = await baselineAwardWrites(app);
    const id = seed({ subtasks: [sub(1, { completed: true }), sub(2)] });
    const before = stored(id).subtasks;

    const res = await update(app, id, { completed: true });

    expect(res.status).toBe(200);
    expect(res.body.task.completed).toBe(true);
    expect(res.body.task.subtasks).toEqual(before); // the parent's completion did not tick or untick anything
    expect(res.body).toHaveProperty('growth');
    expect(db.awardWrites).toBe(expectedWrites);
  });

  it('completing the parent again, or uncompleting it, awards nothing more and still leaves the subtasks alone', async () => {
    const app = await loadApp();
    const id = seed({ subtasks: [sub(1), sub(2, { completed: true })] });
    const before = stored(id).subtasks;

    await update(app, id, { completed: true });
    const afterFirst = db.awardWrites;
    expect(afterFirst).toBeGreaterThan(0);

    await update(app, id, { completed: true }); // already complete: not a transition
    await update(app, id, { completed: false });
    expect(db.awardWrites).toBe(afterFirst);
    expect(stored(id).subtasks).toEqual(before);
  });

  it('subtask edits on an already-completed parent award nothing', async () => {
    const app = await loadApp();
    const id = seed({ completed: true, completedAt: '2026-10-20T00:00:00.000Z', subtasks: [sub(1)] });
    await update(app, id, { subtasks: [sub(1, { completed: true }), sub(2)] });
    expect(db.awardWrites).toBe(0);
  });

  it('creating a task with completed subtasks but an incomplete parent awards nothing; creating a completed parent awards as before', async () => {
    const app = await loadApp();
    const expectedWrites = await baselineAwardWrites(app);

    expect((await create(app, { subtasks: [sub(1, { completed: true })] })).status).toBe(201);
    expect(db.awardWrites).toBe(0);

    const completedParent = await create(app, { completed: true, subtasks: [sub(1)] });
    expect(completedParent.status).toBe(201);
    expect(completedParent.body.task.subtasks).toEqual([{ id: 's1', title: 'step 1', completed: false }]);
    expect(db.awardWrites).toBe(expectedWrites);
  });
});
