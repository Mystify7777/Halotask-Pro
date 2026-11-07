import jwt from 'jsonwebtoken';
import request from 'supertest';
import { addDays, getToday, localDateAt } from '../src/utils/calendarDate';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import CompletionRecord from '../src/models/CompletionRecord.model';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { recordCompletion, revokeCompletion } from '../src/utils/completionRecords';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #47, Phase 1 + 1B — the completion-record guarantees against a REAL MongoDB (MongoMemoryServer). The in-memory doubles
// in completionRecords.service.test.ts prove the service logic; this file proves the two promises that only a database can
// keep:
//   1. the unique indexes exist and MongoDB itself raises the duplicate-key error the service relies on;
//   2. under real concurrency, "one event = one record" and "at most one ACTIVE live completion per task" hold, with the
//      database (not a read-then-write) deciding the winner.
// Like the other *.realmongo tests it needs a MongoDB binary and is not skipped when one is unavailable. Everything is read
// back from the raw collection, without Mongoose casting.

type Raw = Record<string, unknown> & { completionId: string; taskId: string; status: string; source?: string };

let mongoServer: MongoMemoryServer;
const NOW = () => new Date();
const MIN = 60 * 1000;

const userId = String(new mongoose.Types.ObjectId());
const otherUserId = String(new mongoose.Types.ObjectId());

const event = (over: Record<string, unknown> = {}) => ({
  completionId: 'c1',
  taskId: 'task-1',
  titleSnapshot: 'Write report',
  estimatedMinutesSnapshot: 30,
  completedAt: new Date(Date.now() - 10 * MIN),
  utcOffsetMinutes: 330,
  localDate: new Date(Date.now() - 10 * MIN + 330 * MIN).toISOString().slice(0, 10),
  ...over,
});

const all = async (): Promise<Raw[]> => (await CompletionRecord.collection.find({}).toArray()) as unknown as Raw[];
const forTask = async (taskId: string): Promise<Raw[]> => (await all()).filter((d) => d.taskId === taskId);
const activeFor = async (taskId: string): Promise<Raw[]> => (await forTask(taskId)).filter((d) => d.status === 'active' && d.source === 'live');

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // Build the indexes now: autoIndex runs in the background, and the tests depend on the unique ones being there.
  await CompletionRecord.syncIndexes();
});

beforeEach(async () => {
  await CompletionRecord.collection.deleteMany({});
  await Task.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('real MongoDB: the indexes exist and are enforced', () => {
  it('has the idempotency index and the partial single-active-slot index', async () => {
    const indexes = (await CompletionRecord.collection.indexes()) as unknown as {
      name: string;
      unique?: boolean;
      key: Record<string, number>;
      partialFilterExpression?: Record<string, unknown>;
    }[];
    const byName = (name: string) => indexes.find((index) => index.name === name);

    expect(byName('completion_id_per_user')).toMatchObject({ unique: true, key: { userId: 1, completionId: 1 } });
    expect(byName('one_active_live_completion_per_task')).toMatchObject({
      unique: true,
      key: { userId: 1, taskId: 1 },
      partialFilterExpression: { status: 'active', source: 'live' },
    });
    expect(byName('completions_by_local_date')).toBeDefined();
    expect(byName('completions_by_task')).toBeDefined();
  });

  it('MongoDB itself refuses a duplicate (userId, completionId) with code 11000', async () => {
    await recordCompletion(userId, event(), NOW());
    const doc = (await all())[0];

    await expect(CompletionRecord.collection.insertOne({ ...doc, _id: new mongoose.Types.ObjectId() })).rejects.toMatchObject({ code: 11000 });
  });

  it('MongoDB itself refuses a second ACTIVE live record for one task, but allows revoked ones and other accounts', async () => {
    await recordCompletion(userId, event({ completionId: 'c1' }), NOW());
    const doc = (await all())[0];

    await expect(
      CompletionRecord.collection.insertOne({ ...doc, _id: new mongoose.Types.ObjectId(), completionId: 'c2' }),
    ).rejects.toMatchObject({ code: 11000 });

    await expect(
      CompletionRecord.collection.insertOne({ ...doc, _id: new mongoose.Types.ObjectId(), completionId: 'c3', status: 'revoked', revokedReason: 'superseded' }),
    ).resolves.toBeDefined();
    await expect(
      CompletionRecord.collection.insertOne({ ...doc, _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(otherUserId), completionId: 'c1' }),
    ).resolves.toBeDefined();
  });

  it('the partial index does not block migrated records: one task may appear on several legacy days', async () => {
    const base = { userId: new mongoose.Types.ObjectId(userId), taskId: 'legacy-task', status: 'active', source: 'migrated', completedAtSource: 'migrated' };

    await expect(CompletionRecord.collection.insertOne({ ...base, completionId: 'm1', localDate: '2026-10-01' })).resolves.toBeDefined();
    await expect(CompletionRecord.collection.insertOne({ ...base, completionId: 'm2', localDate: '2026-10-02' })).resolves.toBeDefined();
  });
});

describe('real MongoDB: concurrency decided by the database', () => {
  it('20 devices complete the same task at once with different completionIds: every id is accounted for, exactly one is active', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `dev-${i}`);
    const results = await Promise.all(ids.map((completionId) => recordCompletion(userId, event({ completionId }), NOW())));

    const rows = await forTask('task-1');
    expect(rows.map((r) => r.completionId).sort()).toEqual([...ids].sort()); // none lost, none invented, none twice
    const winners = rows.filter((r) => r.status === 'active');
    expect(winners).toHaveLength(1);
    const losers = rows.filter((r) => r.status === 'revoked');
    expect(losers).toHaveLength(19);
    expect(losers.every((r) => r.revokedReason === 'superseded')).toBe(true);
    // every caller was told the truth about ITS id: the winner "recorded", each loser "superseded"
    results.forEach((result, i) => {
      expect(result.completionId, ids[i]).toBe(ids[i]);
      expect(result.outcome, ids[i]).toBe(ids[i] === winners[0].completionId ? 'recorded' : 'superseded');
    });
  });

  it('the same event delivered 20 times at once: one record', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => recordCompletion(userId, event(), NOW())));

    expect(await all()).toHaveLength(1);
    expect(results.every((r) => r.outcome === 'recorded' || r.outcome === 'duplicate')).toBe(true);
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
  });

  it('10 concurrent revokes of one record: it ends revoked once, every call succeeds', async () => {
    await recordCompletion(userId, event(), NOW());

    const results = await Promise.all(Array.from({ length: 10 }, () => revokeCompletion(userId, { completionId: 'c1', revokedAt: NOW() }, NOW())));

    expect(results.filter((r) => r.outcome === 'revoked')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_revoked')).toHaveLength(9);
    expect((await all())[0]).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted' });
  });

  it('a completion racing a revoke of the previous one never leaves two active records', async () => {
    await recordCompletion(userId, event({ completionId: 'c1' }), NOW());

    await Promise.all([
      revokeCompletion(userId, { completionId: 'c1', revokedAt: NOW() }, NOW()),
      recordCompletion(userId, event({ completionId: 'c2' }), NOW()),
    ]);

    const rows = await forTask('task-1');
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'active').length).toBeLessThanOrEqual(1);
  });

  it('randomised bursts of records and exact-id revokes across several tasks keep every invariant (seeded, reproducible)', async () => {
    let seed = 20261105;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const taskIds = ['t-a', 't-b', 't-c'];
    const issued = new Map<string, string>(); // completionId -> taskId (so a "retry" resends a real event)
    let counter = 0;

    for (let round = 0; round < 12; round += 1) {
      const burst = Array.from({ length: 10 }, () => {
        const task = taskIds[Math.floor(rand() * taskIds.length)];
        if (rand() < 0.5 || issued.size === 0) {
          const completionId = `r-${counter++}`;
          issued.set(completionId, task);
          return recordCompletion(userId, event({ completionId, taskId: task, completedAt: new Date(Date.now() - 5 * MIN) }), NOW());
        }
        const [completionId, owner] = [...issued.entries()][Math.floor(rand() * issued.size)];
        return revokeCompletion(userId, { completionId, taskId: owner, revokedAt: NOW() }, NOW());
      });
      await Promise.all(burst);

      const rows = await all();
      for (const task of taskIds) {
        expect((await activeFor(task)).length, `round ${round}: at most one active completion for ${task}`).toBeLessThanOrEqual(1);
      }
      expect(new Set(rows.map((r) => r.completionId)).size, `round ${round}: completionIds are unique`).toBe(rows.length);
    }
  });
});

describe('real MongoDB: through the HTTP API', () => {
  const makeAccount = async (label: string) => {
    const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x' });
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, {
      expiresIn: '1h',
      algorithm: 'HS256',
    });
    return { id: user.id as string, auth: { Authorization: `Bearer ${token}` } };
  };

  it('two devices complete the same task at once through PUT: one active record, one task completion, no 4xx', async () => {
    const owner = await makeAccount('owner');
    const task = await Task.create({ userId: owner.id, title: 'Shared task', estimatedMinutes: 20 });
    const at = new Date(Date.now() - 5 * MIN).toISOString();

    const responses = await Promise.all(
      ['dev-a', 'dev-b', 'dev-c'].map((completionId) =>
        request(app)
          .put(`/api/tasks/${task.id}`)
          .set(owner.auth)
          .send({ completed: true, completionEvent: { completionId, completedAt: at, utcOffsetMinutes: 330 } }),
      ),
    );

    for (const res of responses) {
      // Contention may surface the documented retryable award failure; nothing else is acceptable.
      expect([200, 500]).toContain(res.status);
    }
    const rows = await forTask(task.id);
    const stored = (await Task.collection.findOne({ _id: task._id })) as unknown as { completed: boolean; completionId: string };
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.every((r) => r.titleSnapshot === 'Shared task')).toBe(true);
    // Phase 1B: the task points at the winner, and every event that got a 200 is stored (one active, the rest superseded)
    expect(stored.completed).toBe(true);
    expect(rows.find((r) => r.status === 'active')?.completionId).toBe(stored.completionId);
    responses.forEach((res, i) => {
      if (res.status === 200) expect(rows.map((r) => r.completionId)).toContain(['dev-a', 'dev-b', 'dev-c'][i]);
    });
  });

  it('complete -> uncomplete -> complete -> delete the task: the records survive the deletion', async () => {
    const owner = await makeAccount('owner2');
    const task = await Task.create({ userId: owner.id, title: 'Short-lived', estimatedMinutes: 10 });
    const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);

    await put({ completed: true, completionEvent: { completionId: 'c1', completedAt: new Date(Date.now() - 30 * MIN).toISOString(), utcOffsetMinutes: 330 } });
    await put({ completed: false, completionEvent: { completionId: 'c1', revokedAt: new Date(Date.now() - 20 * MIN).toISOString() } });
    await put({ completed: true, completionEvent: { completionId: 'c2', completedAt: new Date(Date.now() - 10 * MIN).toISOString(), utcOffsetMinutes: 330 } });
    const del = await request(app).delete(`/api/tasks/${task.id}`).set(owner.auth);

    expect(del.status).toBe(200);
    const rows = await forTask(task.id);
    expect(rows.map((r) => [r.completionId, r.status]).sort()).toEqual([
      ['c1', 'revoked'],
      ['c2', 'active'],
    ]);
  });

  it('a standalone event for a task that never existed, delivered twice, is one record', async () => {
    const owner = await makeAccount('owner3');
    const body = {
      type: 'complete',
      completionId: 'orphan-1',
      taskId: 'local-1730000000000-ab12cd',
      title: 'Created and deleted offline',
      estimatedMinutes: 5,
      completedAt: new Date(Date.now() - 3 * 60 * MIN).toISOString(),
      utcOffsetMinutes: 330,
    };

    const first = await request(app).post('/api/completion-events').set(owner.auth).send(body);
    const second = await request(app).post('/api/completion-events').set(owner.auth).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await all()).filter((r) => r.completionId === 'orphan-1')).toHaveLength(1);
  });
});

// -- Phase 1B: opposing transitions through the HTTP API against real MongoDB -----------------------------------------
// The invariant (utils/taskCompletion.ts): once the requests have settled,
//   task.completed  -> exactly ONE active live record, and its completionId is task.completionId
//   !task.completed -> NO active live record
describe('real MongoDB: opposing transitions (Issue #47, Phase 1B)', () => {
  const makeAccount = async (label: string) => {
    const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x' });
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, {
      expiresIn: '1h',
      algorithm: 'HS256',
    });
    return { id: user.id as string, auth: { Authorization: `Bearer ${token}` } };
  };

  const events = new Map<string, object>();
  const eventFor = (completionId: string) => {
    if (!events.has(completionId)) events.set(completionId, { completionId, completedAt: new Date(Date.now() - MIN).toISOString(), utcOffsetMinutes: 330 });
    return events.get(completionId) as object;
  };
  const revokeFor = (completionId: string) => ({ completionId, revokedAt: new Date(Date.now() - MIN / 2).toISOString() });

  const rawTask = async (id: string) =>
    (await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as unknown as { completed: boolean; completionId?: string | null } | null;

  const expectConsistent = async (taskId: string) => {
    const task = await rawTask(taskId);
    const active = await activeFor(taskId);
    if (task?.completed) expect(active.map((r) => r.completionId)).toEqual(task.completionId ? [task.completionId] : []);
    else expect(active).toHaveLength(0);
    const rows = await all();
    expect(new Set(rows.map((r) => r.completionId)).size).toBe(rows.length);
  };

  beforeEach(() => events.clear());
  afterEach(() => vi.restoreAllMocks());

  it('a stale "uncomplete C1" cannot undo a newer completion C2', async () => {
    const owner = await makeAccount('stale');
    const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
    const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
    await put({ completed: true, completionEvent: eventFor('c1') });
    await put({ completed: false, completionEvent: revokeFor('c1') });
    await put({ completed: true, completionEvent: eventFor('c2') });

    const stale = await put({ completed: false, completionEvent: revokeFor('c1') });

    expect(stale.status).toBe(200);
    expect(await rawTask(task.id)).toMatchObject({ completed: true, completionId: 'c2' });
    await expectConsistent(task.id);
  });

  it('a retried complete whose uncomplete already committed does not complete the task again', async () => {
    const owner = await makeAccount('retry');
    const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
    const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
    await put({ completed: true, completionEvent: eventFor('c1') });
    await put({ completed: false, completionEvent: revokeFor('c1') });

    const retry = await put({ completed: true, completionEvent: eventFor('c1') });

    expect(retry.status).toBe(200);
    expect((await rawTask(task.id))?.completed).toBe(false);
    await expectConsistent(task.id);
  });

  it('complete and uncomplete fired at the same moment from two devices: the task and its records agree (30 rounds)', async () => {
    const owner = await makeAccount('opposing');
    for (let round = 0; round < 30; round += 1) {
      const task = await Task.create({ userId: owner.id, title: `T${round}`, estimatedMinutes: 5 });
      const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
      await put({ completed: true, completionEvent: eventFor(`r${round}-a`) });

      await Promise.all([
        put({ completed: false, completionEvent: revokeFor(`r${round}-a`) }),
        put({ completed: true, completionEvent: eventFor(`r${round}-b`) }),
        put({ completed: false }),
        put({ completed: true }),
      ]);
      // a request that gave up under contention is retried by its client; here, one more settling pass of the same requests
      await put({ completed: false, completionEvent: revokeFor(`r${round}-a`) });

      await expectConsistent(task.id);
    }
  });

  it('seeded random mixes of 8 concurrent requests per task keep the invariant (60 seeds)', async () => {
    const owner = await makeAccount('random');
    for (let seed = 1; seed <= 60; seed += 1) {
      let state = seed * 2654435761;
      const rand = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      const task = await Task.create({ userId: owner.id, title: `S${seed}`, estimatedMinutes: 5 });
      const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
      const issued: string[] = [];
      const ops = Array.from({ length: 8 }, (_, n) => {
        const kind = Math.floor(rand() * 5);
        if (kind === 0 || issued.length === 0) {
          const id = `s${seed}-c${n}`;
          issued.push(id);
          return () => put({ completed: true, completionEvent: eventFor(id) });
        }
        const known = issued[Math.floor(rand() * issued.length)];
        if (kind === 1) return () => put({ completed: false, completionEvent: revokeFor(known) });
        if (kind === 2) return () => put({ completed: false });
        if (kind === 3) return () => put({ completed: true });
        return () => put({ completed: true, completionEvent: eventFor(known) });
      });

      const settled = await Promise.all(ops.map((run) => run()));
      for (let i = 0; i < ops.length; i += 1) if (settled[i].status >= 500) expect((await ops[i]()).status).toBeLessThan(500);

      await expectConsistent(task.id);
    }
  });

  it('the standalone endpoint refuses a new completion for a task that still exists (409), and an orphan event is still one record', async () => {
    const owner = await makeAccount('standalone');
    const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
    const body = { type: 'complete', completionId: 'x1', taskId: task.id, title: 'T', estimatedMinutes: 5, completedAt: new Date(Date.now() - MIN).toISOString(), utcOffsetMinutes: 330 };

    const refused = await request(app).post('/api/completion-events').set(owner.auth).send(body);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('COMPLETION_TASK_EXISTS');
    expect(await forTask(task.id)).toHaveLength(0);
  });

  it('REWARD: 12 devices complete one task at once with different completionIds: exactly one award, the task points at the winner', async () => {
    const owner = await makeAccount('reward-race');
    const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
    const ids = Array.from({ length: 12 }, (_, i) => `dev-${i}`);

    const res = await Promise.all(
      ids.map((id) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({ completed: true, completionEvent: eventFor(id) })),
    );
    for (let i = 0; i < ids.length; i += 1) {
      if (res[i].status >= 500) {
        const retry = await request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({ completed: true, completionEvent: eventFor(ids[i]) });
        expect(retry.status).toBeLessThan(500);
      }
    }

    await expectConsistent(task.id);
    const user = (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(owner.id) })) as unknown as { treeState?: { xp?: number; awardedTaskIds?: string[] } };
    expect(user.treeState?.awardedTaskIds).toEqual([task.id]);
    expect(user.treeState?.xp).toBe(10);
    expect((await forTask(task.id)).map((r) => r.completionId).sort()).toEqual([...ids].sort()); // every event accounted for
  });

  it('a refused event (id already bound to another task) is a 400 and changes nothing: task, records, reward', async () => {
    const owner = await makeAccount('refused');
    const first = await Task.create({ userId: owner.id, title: 'A', estimatedMinutes: 5 });
    const second = await Task.create({ userId: owner.id, title: 'B', estimatedMinutes: 5 });
    const put = (id: string, body: object) => request(app).put(`/api/tasks/${id}`).set(owner.auth).send(body);
    await put(first.id, { completed: true, completionEvent: eventFor('c1') });

    const res = await put(second.id, { completed: true, completionEvent: eventFor('c1') });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMPLETION_ID_REUSED');
    expect(await rawTask(second.id)).toMatchObject({ completed: false });
    expect(await forTask(second.id)).toHaveLength(0);
    const user = (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(owner.id) })) as unknown as { treeState?: { awardedTaskIds?: string[] } };
    expect(user.treeState?.awardedTaskIds).toEqual([first.id]);
  });

  it('HISTORY (Phase 2A): a deleted task stays in GET /api/history; canonical days win, legacy days fall back, per day (real indexes and $in)', async () => {
    const owner = await makeAccount('history');
    const IST = 330;
    const today = getToday(IST);
    const get = () => request(app).get(`/api/history?days=7&endDate=${today}&utcOffsetMinutes=${IST}`).set(owner.auth);
    const task = await Task.create({ userId: owner.id, title: 'Write report', estimatedMinutes: 30 });
    await request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({
      completed: true,
      completionEvent: { completionId: 'h1', completedAt: new Date(Date.now() - MIN).toISOString(), utcOffsetMinutes: IST },
    });
    await Task.deleteOne({ _id: task._id });
    // a legacy snapshot for today (must lose to the canonical day) and for two days ago (must be served as stored)
    await request(app).put('/api/history/today').set(owner.auth).send({
      date: today, utcOffsetMinutes: IST, completedCount: 1, workDoneMinutes: 5, completedTasks: [{ taskId: 'legacy-1', title: 'Legacy today', estimatedMinutes: 5 }],
    });
    await request(app).put(`/api/history/${addDays(today, -2)}`).set(owner.auth).send({
      date: addDays(today, -2), utcOffsetMinutes: IST, completedCount: 1, workDoneMinutes: 7, completedTasks: [{ taskId: 'legacy-2', title: 'Legacy older', estimatedMinutes: 7 }],
    });

    const res = await get();

    expect(res.status).toBe(200);
    const byDate = new Map<string, { completedTasks: { title: string }[]; completedCount: number }>(res.body.history.map((e: { date: string }) => [e.date, e]));
    expect(byDate.get(localDateAt(new Date(Date.now() - MIN), IST))?.completedTasks.map((t) => t.title)).toEqual(['Write report']);
    expect(byDate.get(addDays(today, -2))?.completedTasks.map((t) => t.title)).toEqual(['Legacy older']);
    expect(byDate.get(addDays(today, -1))?.completedCount).toBe(0);
  });

  describe('fault injection: inspect the task, the records and the award state after the failed request AND after the retry', () => {
    const snapshot = async (taskId: string, accountId: string) => {
      const task = await rawTask(taskId);
      const user = (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(accountId) })) as unknown as {
        treeState?: { xp?: number; awardedTaskIds?: string[] };
      } | null;
      return {
        completed: task?.completed,
        pointer: task?.completionId ?? null,
        records: (await forTask(taskId)).map((r) => `${r.completionId}:${r.status}`).sort(),
        xp: user?.treeState?.xp ?? 0,
      };
    };

    it('completion: the award fails (task and record already committed) -> the retry awards once and changes nothing else', async () => {
      const owner = await makeAccount('f-award');
      const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
      const put = () => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({ completed: true, completionEvent: eventFor('c1') });
      vi.spyOn(User, 'findOneAndUpdate').mockImplementationOnce((() => {
        throw new Error('simulated database failure');
      }) as never);

      const failed = await put();

      expect(failed.status).toBe(500);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 0 });
      vi.restoreAllMocks();

      const retry = await put();

      expect(retry.status).toBe(200);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('completion: the task write fails -> no record and NO reward (the award never ran); the retry completes and awards once', async () => {
      const owner = await makeAccount('f-taskwrite');
      const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
      const put = () => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({ completed: true, completionEvent: eventFor('c1') });
      vi.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce((() => {
        throw new Error('simulated database failure');
      }) as never);

      const failed = await put();

      expect(failed.status).toBe(500);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: false, pointer: null, records: [], xp: 0 });
      vi.restoreAllMocks();

      const retry = await put();

      expect(retry.status).toBe(200);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('completion: the record write fails after the task committed -> the retry writes the record, nothing else changes', async () => {
      const owner = await makeAccount('f-record');
      const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
      const put = () => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send({ completed: true, completionEvent: eventFor('c1') });
      vi.spyOn(CompletionRecord, 'create').mockImplementationOnce((() => {
        throw new Error('simulated database failure');
      }) as never);

      const failed = await put();

      expect(failed.status).toBe(500);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: [], xp: 0 });
      vi.restoreAllMocks();

      const retry = await put();

      expect(retry.status).toBe(200);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
    });

    it('uncomplete: the task write fails -> nothing changed (record still active); the retry uncompletes and revokes', async () => {
      const owner = await makeAccount('f-undo-task');
      const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
      const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
      await put({ completed: true, completionEvent: eventFor('c1') });
      vi.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce((() => {
        throw new Error('simulated database failure');
      }) as never);

      const failed = await put({ completed: false, completionEvent: revokeFor('c1') });

      expect(failed.status).toBe(500);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: true, pointer: 'c1', records: ['c1:active'], xp: 10 });
      vi.restoreAllMocks();

      const retry = await put({ completed: false, completionEvent: revokeFor('c1') });

      expect(retry.status).toBe(200);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:revoked'], xp: 10 });
    });

    it('uncomplete: the revoke fails after the task committed -> the retry finishes the revoke', async () => {
      const owner = await makeAccount('f-undo-revoke');
      const task = await Task.create({ userId: owner.id, title: 'T', estimatedMinutes: 5 });
      const put = (body: object) => request(app).put(`/api/tasks/${task.id}`).set(owner.auth).send(body);
      await put({ completed: true, completionEvent: eventFor('c1') });
      vi.spyOn(CompletionRecord, 'findOneAndUpdate').mockImplementationOnce((() => {
        throw new Error('simulated database failure');
      }) as never);

      const failed = await put({ completed: false, completionEvent: revokeFor('c1') });

      expect(failed.status).toBe(500);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:active'], xp: 10 });
      vi.restoreAllMocks();

      const retry = await put({ completed: false, completionEvent: revokeFor('c1') });

      expect(retry.status).toBe(200);
      expect(await snapshot(task.id, owner.id)).toEqual({ completed: false, pointer: 'c1', records: ['c1:revoked'], xp: 10 });
    });
  });
});
