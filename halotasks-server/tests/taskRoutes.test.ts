import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #21 — task identifier, ownership and input boundaries, against the REAL app with an in-memory Task
// double. Mongo-free: before this file these cases were only covered by tests/api.routes.test.ts, which needs
// MongoMemoryServer and cannot run where its binary cannot be downloaded. The double enforces the same
// {_id, userId} matching the controllers rely on, so ownership is actually exercised, not asserted on a mock.

type Doc = { _id: string; userId: string; title: string; completed: boolean; [key: string]: unknown };

const db = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  queries: [] as Array<{ op: string; filter: Record<string, unknown> }>,
  nextId: 1,
}));

const OWNER_A = '665f1c2e9b1e8a00000000aa';
const OWNER_B = '665f1c2e9b1e8a00000000bb';
const MISSING_ID = '665f1c2e9b1e8a00000000ff';

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
      // The Growth Tree award (Issue #24) is exercised in treeRoutes.test.ts; here it just has to succeed.
      findOneAndUpdate: () => ({ lean: async () => ({ treeState: { xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', awardedTaskIds: ['x'] } }) }),
    },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: (filter: Record<string, unknown>) => {
        db.queries.push({ op: 'find', filter });
        const rows = [...db.tasks.values()].filter((t) => t.userId === filter.userId);
        const chain: Record<string, unknown> = {};
        chain.sort = () => chain;
        chain.skip = () => chain;
        chain.limit = async () => rows;
        return chain;
      },
      countDocuments: async (filter: Record<string, unknown>) => [...db.tasks.values()].filter((t) => t.userId === filter.userId).length,
      create: async (data: Record<string, unknown>) => {
        db.queries.push({ op: 'create', filter: { userId: data.userId } });
        const doc = { _id: idOf(db.nextId++), ...data };
        db.tasks.set(doc._id, doc);
        return doc;
      },
      findOne: async (filter: Record<string, unknown>) => {
        db.queries.push({ op: 'findOne', filter });
        return owns(filter);
      },
      findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        db.queries.push({ op: 'findOneAndUpdate', filter });
        const task = owns(filter);
        if (!task) return null;
        Object.assign(task, update);
        return task;
      },
      findOneAndDelete: async (filter: Record<string, unknown>) => {
        db.queries.push({ op: 'findOneAndDelete', filter });
        const task = owns(filter);
        if (task) db.tasks.delete(String(filter._id));
        return task;
      },
    },
  }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });

const seed = (userId: string, title = 'seeded'): Doc => {
  const doc = { _id: idOf(db.nextId++), userId, title, completed: false, completedAt: null };
  db.tasks.set(doc._id, doc);
  return doc;
};

beforeEach(() => {
  db.tasks.clear();
  db.queries.length = 0;
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

describe('task identifiers', () => {
  it.each([
    ['too short', 'abc'],
    ['digits only, wrong length', '123'],
    ['23 characters', '507f1f77bcf86cd79943901'],
    ['25 characters', '507f1f77bcf86cd7994390111'],
    ['24 characters but not hex', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['24 characters with one non-hex character', '507f1f77bcf86cd79943901g'],
    ['12 plain characters (a legacy ObjectId spelling)', 'aaaaaaaaaaaa'],
    ['the word "undefined"', 'undefined'],
    ['the word "null"', 'null'],
    ['a leading space', '%20507f1f77bcf86cd799439011'],
    ['a trailing space', '507f1f77bcf86cd799439011%20'],
    ['a null byte', '507f1f77bcf86cd79943901%00'],
    ['a query-operator lookalike', '%7B%22%24ne%22%3Anull%7D'],
    ['path-ish text', '..%2F..%2Fetc'],
  ])('PUT and DELETE reject an id that is %s with 400 and never query the database', async (_label, id) => {
    const app = await loadApp();
    seed(OWNER_A);

    const put = await request(app).put(`/api/tasks/${id}`).set(as(OWNER_A)).send({ title: 'x' });
    const del = await request(app).delete(`/api/tasks/${id}`).set(as(OWNER_A));

    expect(put.status).toBe(400);
    expect(put.body).toEqual({ message: 'Invalid task id' });
    expect(del.status).toBe(400);
    expect(del.body).toEqual({ message: 'Invalid task id' });
    expect(db.queries).toEqual([]);
    expect(db.tasks.size).toBe(1);
  });

  it('an invalid id is reported before the body is looked at', async () => {
    const app = await loadApp();

    const res = await request(app).put('/api/tasks/not-an-id').set(as(OWNER_A));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Invalid task id' });
  });

  it('a well-formed id that does not exist is 404 (not 400) on both update and delete', async () => {
    const app = await loadApp();

    const put = await request(app).put(`/api/tasks/${MISSING_ID}`).set(as(OWNER_A)).send({ title: 'x' });
    const del = await request(app).delete(`/api/tasks/${MISSING_ID}`).set(as(OWNER_A));

    expect(put.status).toBe(404);
    expect(put.body).toEqual({ message: 'Task not found' });
    expect(del.status).toBe(404);
    expect(del.body).toEqual({ message: 'Task not found' });
  });

  it('upper-case and lower-case hex spellings of a real id both resolve to it', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A);
    db.tasks.delete(task._id);
    const upper = '507F1F77BCF86CD799439011';
    db.tasks.set(upper, { ...task, _id: upper });

    const res = await request(app).put(`/api/tasks/${upper}`).set(as(OWNER_A)).send({ title: 'renamed' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('renamed');
  });
});

describe('ownership scoping', () => {
  it('lists only the caller’s tasks, filtering on the id from the token', async () => {
    const app = await loadApp();
    seed(OWNER_A, 'mine');
    seed(OWNER_B, 'theirs');

    const res = await request(app).get('/api/tasks').set(as(OWNER_A));

    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: Doc) => t.title)).toEqual(['mine']);
    expect(res.body.total).toBe(1);
    expect(db.queries.find((q) => q.op === 'find')?.filter).toEqual({ userId: OWNER_A });
  });

  it('another account cannot update a task: 404, and the task is unchanged', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A, 'original');

    const res = await request(app).put(`/api/tasks/${task._id}`).set(as(OWNER_B)).send({ title: 'hijacked' });

    expect(res.status).toBe(404);
    expect(db.tasks.get(task._id)?.title).toBe('original');
    expect(db.queries.every((q) => q.filter.userId === OWNER_B)).toBe(true);
  });

  it('another account cannot delete a task: 404, and the task survives', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A);

    const res = await request(app).delete(`/api/tasks/${task._id}`).set(as(OWNER_B));

    expect(res.status).toBe(404);
    expect(db.tasks.has(task._id)).toBe(true);
  });

  it('the owner can update and delete their own task', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A);

    expect((await request(app).put(`/api/tasks/${task._id}`).set(as(OWNER_A)).send({ title: 'mine now' })).status).toBe(200);
    expect(db.tasks.get(task._id)?.title).toBe('mine now');
    expect((await request(app).delete(`/api/tasks/${task._id}`).set(as(OWNER_A))).status).toBe(200);
    expect(db.tasks.has(task._id)).toBe(false);
  });

  it('create stamps the caller as owner and ignores a userId supplied in the body', async () => {
    const app = await loadApp();

    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'new', userId: OWNER_B });

    expect(res.status).toBe(201);
    expect(res.body.task.userId).toBe(OWNER_A);
    expect(db.queries.find((q) => q.op === 'create')?.filter).toEqual({ userId: OWNER_A });
  });

  it('update cannot reassign a task to another owner through the body', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A);

    const res = await request(app).put(`/api/tasks/${task._id}`).set(as(OWNER_A)).send({ title: 'same', userId: OWNER_B });

    expect(res.status).toBe(200);
    expect(db.tasks.get(task._id)?.userId).toBe(OWNER_A);
  });
});

describe('task input boundaries', () => {
  it.each([
    ['title is a number', { title: 5 }],
    ['title is an object', { title: { $ne: null } }],
    ['title is blank', { title: '   ' }],
    ['title is missing', { description: 'no title' }],
    ['description is a number', { title: 't', description: 5 }],
    ['completed is a string', { title: 't', completed: 'yes' }],
    ['priority is not an allowed value', { title: 't', priority: 'urgent' }],
    ['tags is an object', { title: 't', tags: { a: 1 } }],
    ['tags holds a non-string', { title: 't', tags: ['ok', 5] }],
    ['estimatedMinutes is negative', { title: 't', estimatedMinutes: -1 }],
    ['estimatedMinutes is an object', { title: 't', estimatedMinutes: {} }],
    ['dueDate is not a date', { title: 't', dueDate: 'not-a-date' }],
    ['reminderSent is a number', { title: 't', reminderSent: 1 }],
  ])('POST rejects a body where %s with 400 and writes nothing', async (_label, body) => {
    const app = await loadApp();

    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send(body);

    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(db.tasks.size).toBe(0);
  });

  it('PUT applies only the validated fields and rejects a wrong type without changing the task', async () => {
    const app = await loadApp();
    const task = seed(OWNER_A, 'keep me');

    const bad = await request(app).put(`/api/tasks/${task._id}`).set(as(OWNER_A)).send({ completed: 'true' });

    expect(bad.status).toBe(400);
    expect(db.tasks.get(task._id)).toMatchObject({ title: 'keep me', completed: false });
  });

  it('a normal valid create and update still succeed', async () => {
    const app = await loadApp();

    const created = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: '  Buy milk  ', priority: 'high', tags: [' a '] });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ title: 'Buy milk', priority: 'high', tags: ['a'] });

    const updated = await request(app).put(`/api/tasks/${created.body.task._id}`).set(as(OWNER_A)).send({ completed: true });
    expect(updated.status).toBe(200);
    expect(updated.body.task.completed).toBe(true);
  });
});
