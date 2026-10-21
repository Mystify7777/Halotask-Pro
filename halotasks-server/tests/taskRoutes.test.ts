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
  /** Runs inside findOneAndUpdate before the write, to simulate another request landing between a read and a write. */
  beforeUpdate: undefined as (() => void) | undefined,
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
        db.beforeUpdate?.();
        const task = owns(filter);
        if (!task) return null;
        // Applies an update the way MongoDB does: `$set` writes fields, `$unset` removes them, and an update with
        // no operators is a plain field set. A filter key beyond _id/userId (e.g. a precondition) must match too.
        const { $set, $unset, ...plain } = update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
        for (const [key, condition] of Object.entries(filter)) {
          if (key === '_id' || key === 'userId') continue;
          const present = task[key] !== undefined && task[key] !== null;
          const wantsPresent = typeof condition === 'object' && condition !== null && (condition as { $exists?: boolean }).$exists === true;
          if (wantsPresent && !present) return null;
        }
        Object.assign(task, plain, $set ?? {});
        for (const key of Object.keys($unset ?? {})) delete task[key];
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
  db.beforeUpdate = undefined;
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


// Issues #9 and #10: optional start time and due time. The model's own `match` validator and the real $unset behaviour
// are covered against a real MongoDB in tests/taskTimes.realmongo.test.ts; this file runs without one.
describe('start time and due time (Issues #9, #10)', () => {
  const create = async (app: Express, body: Record<string, unknown>) =>
    request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 't', ...body });
  const update = async (app: Express, id: string, body: Record<string, unknown>, who = OWNER_A) =>
    request(app).put(`/api/tasks/${id}`).set(as(who)).send(body);

  describe('create', () => {
    it.each([
      ['neither time', {}, {}],
      ['a due date only', { dueDate: '2026-10-20' }, {}],
      ['a due date and a due time', { dueDate: '2026-10-20', dueTime: '17:30' }, { dueTime: '17:30' }],
      ['a start time only', { startTime: '2026-10-20T09:30:00Z' }, { startTime: '2026-10-20T09:30:00.000Z' }],
      [
        'a start time with an offset (stored as the instant it names)',
        { startTime: '2026-10-20T09:30:00+05:30' },
        { startTime: '2026-10-20T04:00:00.000Z' },
      ],
      [
        'all three',
        { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:00Z' },
        { dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' },
      ],
    ])('accepts %s and returns it unchanged', async (_label, body, expected) => {
      const app = await loadApp();

      const res = await create(app, body);

      expect(res.status).toBe(201);
      const { dueTime, startTime } = res.body.task;
      expect({ ...(dueTime !== undefined ? { dueTime } : {}), ...(startTime !== undefined ? { startTime } : {}) }).toEqual(expected);
      // The date-only deadline keeps its established representation (UTC midnight of the day) and is never given a time.
      if ('dueDate' in body) expect(res.body.task.dueDate).toBe('2026-10-20T00:00:00.000Z');
      else expect(res.body.task).not.toHaveProperty('dueDate');
      expect(db.tasks.size).toBe(1);
    });

    it('treats null and "" as "not set": a 201 that stores neither field', async () => {
      const app = await loadApp();

      const res = await create(app, { dueDate: null, dueTime: '', startTime: null });

      expect(res.status).toBe(201);
      expect(res.body.task).not.toHaveProperty('dueDate');
      expect(res.body.task).not.toHaveProperty('dueTime');
      expect(res.body.task).not.toHaveProperty('startTime');
    });

    it.each([
      ['dueTime is not HH:mm', { dueDate: '2026-10-20', dueTime: '5pm' }, 'dueTime'],
      ['dueTime is 24:00', { dueDate: '2026-10-20', dueTime: '24:00' }, 'dueTime'],
      ['dueTime is a number', { dueDate: '2026-10-20', dueTime: 1730 }, 'dueTime'],
      ['dueTime is an object', { dueDate: '2026-10-20', dueTime: { $ne: null } }, 'dueTime'],
      ['dueTime has no dueDate', { dueTime: '17:30' }, 'dueTime requires a dueDate'],
      ['dueTime comes with a null dueDate', { dueDate: null, dueTime: '17:30' }, 'dueTime requires a dueDate'],
      ['dueTime comes with an empty dueDate', { dueDate: '', dueTime: '17:30' }, 'dueTime requires a dueDate'],
      ['startTime has no zone', { startTime: '2026-10-20T09:30:00' }, 'startTime'],
      ['startTime is a date that does not exist', { startTime: '2026-02-30T09:30:00Z' }, 'startTime'],
      ['startTime is text', { startTime: 'tomorrow at noon' }, 'startTime'],
      ['startTime is a number', { startTime: 1792474200000 }, 'startTime'],
      ['startTime is an object', { startTime: { $gt: '' } }, 'startTime'],
    ])('rejects a body where %s with a 400 naming the problem, and writes nothing', async (_label, body, mention) => {
      const app = await loadApp();

      const res = await create(app, body);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain(mention);
      expect(db.tasks.size).toBe(0);
    });
  });

  describe('update', () => {
    const seedTimed = async (app: Express) => {
      const created = await create(app, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:00Z' });
      expect(created.status).toBe(201);
      return created.body.task._id as string;
    };

    it('sets a due time on a task that already has a due date, and a start time on one that has neither', async () => {
      const app = await loadApp();
      const dated = (await create(app, { dueDate: '2026-10-20' })).body.task._id as string;
      const bare = (await create(app, {})).body.task._id as string;

      const withTime = await update(app, dated, { dueTime: '08:15' });
      const withStart = await update(app, bare, { startTime: '2026-10-21T07:00:00Z' });

      expect(withTime.status).toBe(200);
      expect(withTime.body.task).toMatchObject({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '08:15' });
      expect(withStart.status).toBe(200);
      expect(withStart.body.task.startTime).toBe('2026-10-21T07:00:00.000Z');
    });

    it('does not erase either time when only unrelated fields change', async () => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { title: 'renamed', priority: 'high', completed: true, estimatedMinutes: 45 });

      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({
        title: 'renamed',
        dueDate: '2026-10-20T00:00:00.000Z',
        dueTime: '17:30',
        startTime: '2026-10-20T09:30:00.000Z',
      });
    });

    it.each([null, ''])('clears the due time with %j and leaves the due date and start time alone', async (clear) => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { dueTime: clear });

      expect(res.status).toBe(200);
      expect(res.body.task).not.toHaveProperty('dueTime');
      expect(res.body.task).toMatchObject({ dueDate: '2026-10-20T00:00:00.000Z', startTime: '2026-10-20T09:30:00.000Z' });
    });

    it.each([null, ''])('clears the start time with %j and leaves the due fields alone', async (clear) => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { startTime: clear });

      expect(res.status).toBe(200);
      expect(res.body.task).not.toHaveProperty('startTime');
      expect(res.body.task).toMatchObject({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' });
    });

    it.each([null, ''])('clearing the due date with %j actually removes it, and its due time goes with it', async (clear) => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { dueDate: clear });

      expect(res.status).toBe(200);
      expect(res.body.task).not.toHaveProperty('dueDate'); // before Issue #10 a null here was silently ignored
      expect(res.body.task).not.toHaveProperty('dueTime');
      expect(res.body.task.startTime).toBe('2026-10-20T09:30:00.000Z'); // an independent instant: kept
    });

    it('clears the due date and the due time together when the request sends both as null', async () => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { dueDate: null, dueTime: null });

      expect(res.status).toBe(200);
      expect(res.body.task).not.toHaveProperty('dueDate');
      expect(res.body.task).not.toHaveProperty('dueTime');
    });

    it('moves the due date and keeps the due time that belongs with it', async () => {
      const app = await loadApp();
      const id = await seedTimed(app);

      const res = await update(app, id, { dueDate: '2026-10-25' });

      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({ dueDate: '2026-10-25T00:00:00.000Z', dueTime: '17:30' });
    });

    it('rejects a request that clears the due date and sets a due time, changing nothing', async () => {
      const app = await loadApp();
      const id = await seedTimed(app);
      const before = structuredClone(db.tasks.get(id));

      const res = await update(app, id, { dueDate: null, dueTime: '09:00' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('dueTime requires a dueDate');
      expect(db.tasks.get(id)).toEqual(before);
    });

    it('rejects a due time for a task that has no due date, changing nothing', async () => {
      const app = await loadApp();
      const id = (await create(app, {})).body.task._id as string;

      const res = await update(app, id, { dueTime: '09:00' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('dueTime requires a dueDate');
      expect(db.tasks.get(id)?.dueTime).toBeUndefined();
    });

    it.each([
      ['a malformed dueTime', { dueTime: '9am' }],
      ['an impossible dueTime', { dueTime: '23:60' }],
      ['a zone-less startTime', { startTime: '2026-10-20T09:30:00' }],
      ['a non-date startTime', { startTime: 'soon' }],
      ['a numeric startTime', { startTime: 5 }],
    ])('rejects %s with a 400 (never a 500) and leaves the task untouched', async (_label, body) => {
      const app = await loadApp();
      const id = await seedTimed(app);
      const before = structuredClone(db.tasks.get(id));

      const res = await update(app, id, body);

      expect(res.status).toBe(400);
      expect(db.tasks.get(id)).toEqual(before);
    });

    it("cannot be used to change another user's task", async () => {
      const app = await loadApp();
      const id = await seedTimed(app);
      const before = structuredClone(db.tasks.get(id));

      const res = await update(app, id, { dueTime: '01:00', startTime: '2026-01-01T00:00:00Z' }, OWNER_B);

      expect(res.status).toBe(404);
      expect(db.tasks.get(id)).toEqual(before);
    });

    it('does not leave a due time behind when the due date is removed by another request between the read and the write', async () => {
      const app = await loadApp();
      const id = (await create(app, { dueDate: '2026-10-20' })).body.task._id as string;
      // Another request clears the due date after this request has read the task and validated against it.
      db.beforeUpdate = () => {
        delete db.tasks.get(id)!.dueDate;
      };

      const res = await update(app, id, { dueTime: '09:00' });

      expect(res.status).toBe(409);
      expect(db.tasks.get(id)?.dueTime).toBeUndefined();
      expect(db.tasks.get(id)?.dueDate).toBeUndefined();
    });
  });

  describe('a legacy task (created before either field existed)', () => {
    it('stays valid: it is listed, can be edited, and is never given a time', async () => {
      const app = await loadApp();
      const legacy = seed(OWNER_A, 'old task');
      legacy.dueDate = new Date('2026-04-21');

      const listed = await request(app).get('/api/tasks').set(as(OWNER_A));
      expect(listed.status).toBe(200);
      expect(listed.body.tasks[0]).toMatchObject({ title: 'old task', dueDate: '2026-04-21T00:00:00.000Z' });
      expect(listed.body.tasks[0]).not.toHaveProperty('dueTime');
      expect(listed.body.tasks[0]).not.toHaveProperty('startTime');

      const edited = await update(app, legacy._id, { title: 'old task, edited' });
      expect(edited.status).toBe(200);
      expect(edited.body.task).not.toHaveProperty('dueTime');
      expect(edited.body.task).not.toHaveProperty('startTime');
      expect(edited.body.task.dueDate).toBe('2026-04-21T00:00:00.000Z');
    });
  });
});
