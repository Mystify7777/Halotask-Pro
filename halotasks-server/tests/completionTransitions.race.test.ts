import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createCompletionStore, type CompletionStore } from './helpers/completionDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';

// Issue #47, Phase 1B — concurrent opposing completion transitions on ONE task, through the REAL app with strict in-memory
// doubles (Mongo-free). The doubles make every single-document write atomic and let a test run another request exactly
// between a read and a write. The same scenarios against a real MongoDB are in completionRecord.realmongo.test.ts.
//
// INVARIANT under test (see utils/taskCompletion.ts): after the requests have settled,
//   task.completed  -> exactly ONE active live record for the task, and its id is task.completionId
//   !task.completed -> NO active live record for the task
// and the task's XP was awarded once.

const A = '665f1c2e9b1e8a00000000aa';
const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const emptyTree = () => ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [] });
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let users: UserStore;
let tasks: TaskStore;
let records: CompletionStore;
let app: Express;

beforeEach(async () => {
  events.clear();
  users = createUserStore();
  tasks = createTaskStore();
  records = createCompletionStore();
  users.seed(A, emptyTree());
  app = await loadAppWith(users, tasks, SECRET, records);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  unmockModels();
});

const put = (id: string, body: object) => request(app).put(`/api/tasks/${id}`).set(as(A)).send(body);
// One event per completionId, like a client that persisted it: a retry resends the SAME payload (same completedAt).
const events = new Map<string, object>();
const eventFor = (completionId: string) => {
  if (!events.has(completionId)) events.set(completionId, { completionId, completedAt: ago(MIN), utcOffsetMinutes: 330 });
  return events.get(completionId) as object;
};
const complete = (id: string, completionId: string) => put(id, { completed: true, completionEvent: eventFor(completionId) });
const uncomplete = (id: string, completionId?: string) =>
  put(id, { completed: false, ...(completionId ? { completionEvent: { completionId, revokedAt: ago(MIN / 2) } } : {}) });

const activeOf = (taskId: string) => records.docs.filter((d) => d.taskId === taskId && d.status === 'active' && d.source === 'live');
const byId = (id: string) => records.docs.find((d) => d.completionId === id);
const xpOf = () => (users.tree(A) as { xp: number }).xp;

/** The invariant, as a single assertion helper. */
const expectConsistent = (taskId: string) => {
  const task = tasks.get(taskId) as { completed: boolean; completionId?: string | null };
  const active = activeOf(taskId);
  if (task.completed) {
    expect(active.map((d) => d.completionId)).toEqual(task.completionId ? [task.completionId] : []);
  } else {
    expect(active).toHaveLength(0);
  }
  expect(new Set(records.docs.map((d) => d.completionId)).size).toBe(records.docs.length);
};

describe('deterministic interleavings (another request runs between a read and the conditional write)', () => {
  it('two devices complete at once: one wins, the other is stored as superseded, exactly one active record', async () => {
    const id = String(tasks.seed(A)._id);
    let fired = false;
    tasks.hooks.beforeWrite = async () => {
      if (fired) return;
      fired = true;
      await complete(id, 'device-b'); // lands completely between device A's read and write
    };

    const res = await complete(id, 'device-a');

    expect(res.status).toBe(200);
    expect(res.body.task.completionId).toBe('device-b');
    expect(res.body.completion.outcome).toBe('superseded');
    expect(byId('device-a')).toMatchObject({ status: 'revoked', revokedReason: 'superseded' });
    expect(byId('device-b')?.status).toBe('active');
    expectConsistent(id);
    expect(xpOf()).toBe(10);
  });

  it('a stale "uncomplete C1" cannot undo a newer completion C2 (complete C1, uncomplete C1, complete C2, then a retry of the uncomplete)', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');
    await uncomplete(id, 'c1');
    await complete(id, 'c2');

    const stale = await uncomplete(id, 'c1');

    expect(stale.status).toBe(200);
    expect(stale.body.task.completed).toBe(true);
    expect(tasks.get(id)).toMatchObject({ completed: true, completionId: 'c2' });
    expect(byId('c1')?.status).toBe('revoked');
    expect(byId('c2')?.status).toBe('active');
    expectConsistent(id);
  });

  it('an uncomplete that commits while a stale device is mid-way through completing: the loser does not resurrect the task', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');
    let fired = false;
    // device X: "uncomplete C1" has read completed/C1; before its write, device Y uncompletes C1 and completes C2
    tasks.hooks.beforeWrite = async () => {
      if (fired) return;
      fired = true;
      await uncomplete(id, 'c1');
      await complete(id, 'c2');
    };

    const res = await uncomplete(id, 'c1');

    expect(res.status).toBe(200);
    expect(tasks.get(id)).toMatchObject({ completed: true, completionId: 'c2' });
    expect(byId('c2')?.status).toBe('active');
    expectConsistent(id);
  });

  it('a completion whose record is inserted AFTER an uncomplete committed is revoked by its own request (no stale active record)', async () => {
    const id = String(tasks.seed(A)._id);
    let fired = false;
    // the completion committed on the task; before its record exists, an uncomplete of it commits and finds nothing to revoke
    records.hooks.beforeCreate = async () => {
      if (fired) return;
      fired = true;
      const undo = await uncomplete(id, 'c1');
      expect(undo.body.task.completed).toBe(false);
      expect(undo.body.completion.outcome).toBe('not_found');
    };

    const res = await complete(id, 'c1');

    expect(res.status).toBe(200);
    expect(tasks.get(id)?.completed).toBe(false);
    expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted' });
    expectConsistent(id);
  });

  it('a retry of a complete whose uncomplete already committed does not complete the task again', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');
    await uncomplete(id, 'c1');
    const xpBefore = xpOf();

    const retry = await complete(id, 'c1'); // the original request, delivered late

    expect(retry.status).toBe(200);
    expect(retry.body.task.completed).toBe(false);
    expect(retry.body.completion).toMatchObject({ outcome: 'duplicate', status: 'revoked' });
    expect(xpOf()).toBe(xpBefore);
    expectConsistent(id);
  });

  // -- reward ordering (Phase 1B review): task arbitration -> record -> convergence check -> award ----------------------------
  it('REWARD: a completion that loses the task arbitration never awards, even though it started first', async () => {
    const doc = tasks.seed(A);
    const id = String(doc._id);
    let fired = false;
    // device B commits its completion on the task between A's read and A's write, then "crashes" before it records or awards
    tasks.hooks.beforeWrite = () => {
      if (fired) return;
      fired = true;
      Object.assign(doc, { completed: true, completedAt: new Date(), completionId: 'device-b' });
    };

    const res = await complete(id, 'device-a');

    expect(res.status).toBe(200);
    expect(res.body.completion.outcome).toBe('superseded');
    expect(res.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(0); // A lost: it must not grant progression
    expect(users.applied.filter((o) => o.update?.$inc)).toHaveLength(0);
    expect(byId('device-a')).toMatchObject({ status: 'revoked', revokedReason: 'superseded' });

    // the same under retry: A resends the same payload; still no award, B's own retry is the one that rewards
    const retryA = await complete(id, 'device-a');
    expect(retryA.status).toBe(200);
    expect(xpOf()).toBe(0);

    const retryB = await complete(id, 'device-b');
    expect(retryB.status).toBe(200);
    expect(xpOf()).toBe(10);
    expect(users.applied.filter((o) => o.update?.$inc)).toHaveLength(1);
    expect(activeOf(id).map((d) => d.completionId)).toEqual(['device-b']);
  });

  it('REWARD: a request whose task write misses for a reason other than completion (the stored due date went away) awards nothing and completes nothing', async () => {
    const doc = tasks.seed(A, { dueDate: new Date(Date.now() + 86400000) });
    const id = String(doc._id);
    let fired = false;
    tasks.hooks.beforeWrite = () => {
      if (fired) return;
      fired = true;
      delete (doc as Record<string, unknown>).dueDate; // another request cleared the date
    };

    const res = await put(id, { completed: true, dueTime: '10:00', completionEvent: eventFor('c1') });

    expect(res.status).toBe(409);
    expect(tasks.get(id)).toMatchObject({ completed: false });
    expect(xpOf()).toBe(0);
    expect(records.docs).toHaveLength(0);
  });

  it('REWARD: a completion taken back by the convergence check (a duplicate of an already-decided event) does not award', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');
    await uncomplete(id, 'c1');
    const before = users.applied.filter((o) => o.update?.$inc).length;

    const dup = await complete(id, 'c1');

    expect(dup.body.task.completed).toBe(false);
    expect(users.applied.filter((o) => o.update?.$inc)).toHaveLength(before);
    expectConsistent(id);
  });

  it('REWARD: a completion uncompleted after its record settled but before the award step is not rewarded (the award requires the task to STILL hold it)', async () => {
    const id = String(tasks.seed(A)._id);
    let armed = false;
    let firing = false;
    let looks = 0;
    tasks.hooks.beforeWrite = () => {
      armed = true; // the conditional completion write is about to commit
    };
    tasks.hooks.delay = async (op) => {
      if (!armed || firing || op !== 'findOne') return;
      looks += 1;
      // Task reads after the commit: 1 = ownership re-check inside the record step, 2 = convergence check, 3 = the award's re-read
      if (looks === 3) {
        firing = true;
        await uncomplete(id, 'c1');
        firing = false;
      }
    };

    const res = await complete(id, 'c1');

    expect(res.status).toBe(200);
    expect(tasks.get(id)).toMatchObject({ completed: false });
    expect(xpOf()).toBe(0);
    expect(res.body).not.toHaveProperty('growth');
    expectConsistent(id);
  });

  it('REWARD: the award is the LAST step: when it fails the task and record already exist, and the retry awards exactly once', async () => {
    const id = String(tasks.seed(A)._id);
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => op.update?.$push !== undefined });

    const failed = await complete(id, 'c1');

    expect(failed.status).toBe(500);
    expect(tasks.get(id)).toMatchObject({ completed: true, completionId: 'c1' });
    expect(byId('c1')?.status).toBe('active');
    expect(xpOf()).toBe(0);

    const retry = await complete(id, 'c1');
    expect(retry.status).toBe(200);
    expect(xpOf()).toBe(10);
    expectConsistent(id);
  });

  it('legacy complete racing a client complete: one winner, one active record', async () => {
    const id = String(tasks.seed(A)._id);
    let fired = false;
    tasks.hooks.beforeWrite = async () => {
      if (fired) return;
      fired = true;
      await complete(id, 'client-1');
    };

    const res = await put(id, { completed: true }); // legacy: no event

    expect(res.status).toBe(200);
    expect(tasks.get(id)).toMatchObject({ completed: true, completionId: 'client-1' });
    expect(records.docs).toHaveLength(1);
    expectConsistent(id);
  });

  it('legacy uncomplete is best effort: it uncompletes whatever the task holds and revokes exactly that', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');

    const res = await uncomplete(id);

    expect(res.body.task.completed).toBe(false);
    expect(byId('c1')?.status).toBe('revoked');
    expectConsistent(id);
  });

  it('STRONG INVARIANT: a refused event completes nothing, even in a request that carries other edits', async () => {
    const id = String(tasks.seed(A)._id);
    await complete(id, 'c1');
    await uncomplete(id, 'c1');
    const other = String(tasks.seed(A)._id);

    // c1 is already bound to the first task, so it cannot complete another one
    const res = await put(other, { completed: true, title: 'edited', completionEvent: eventFor('c1') });

    expect(res.status).toBe(400);
    expect(tasks.get(other)).toMatchObject({ completed: false, title: 'seeded' });
    expect(activeOf(other)).toHaveLength(0);
  });

  it('a task completed before this feature (no pointer) can still be uncompleted by a client that names a completion', async () => {
    const id = String(tasks.seed(A, { completed: true, completedAt: new Date() })._id);

    const res = await uncomplete(id, 'c-whatever');

    expect(res.status).toBe(200);
    expect(res.body.task.completed).toBe(false);
  });
});

// -- seeded random interleavings -------------------------------------------------------------------------------------
// Every operation of the stores yields a random number of macrotask ticks, so concurrent requests interleave at every
// read and write. A failing seed is reproducible: it is printed in the test name.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('seeded random interleavings of opposing transitions', () => {
  const SEEDS = Array.from({ length: Number(process.env.RACE_SEEDS ?? 40) }, (_, i) => i + 1);

  it.each(SEEDS)('seed %i: the task and its records agree once the requests settle', async (seed) => {
    const random = mulberry32(seed);
    const jitter = async () => {
      const ticks = Math.floor(random() * 4);
      for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    tasks.hooks.delay = jitter;
    records.hooks.delay = jitter;

    const id = String(tasks.seed(A)._id);
    const issued: string[] = [];
    const operations = Array.from({ length: 8 }, (_, n) => {
      const kind = Math.floor(random() * 5);
      if (kind === 0 || issued.length === 0) {
        const completionId = `s${seed}-c${n}`;
        issued.push(completionId);
        return () => complete(id, completionId);
      }
      const known = issued[Math.floor(random() * issued.length)];
      if (kind === 1) return () => uncomplete(id, known);
      if (kind === 2) return () => uncomplete(id);
      if (kind === 3) return () => put(id, { completed: true });
      return () => complete(id, known); // a retry / duplicate of an event
    });

    const settled = await Promise.all(operations.map((run) => run()));
    // a request that gave up (the task kept changing) is retried once things are quiet, as a client would
    tasks.hooks.delay = undefined;
    records.hooks.delay = undefined;
    for (let i = 0; i < operations.length; i += 1) {
      if (settled[i].status >= 500) {
        const retry = await operations[i]();
        expect(retry.status).toBeLessThan(500);
      }
    }

    if (process.env.RACE_DEBUG) console.log(JSON.stringify({ task: tasks.get(id), records: records.docs.map((d) => [d.completionId, d.status, d.revokedReason]), settled: settled.map((r) => r.status) }));
    expectConsistent(id);
    // reward consistency: no reward without a committed completion; a task that is completed has been rewarded. (A completion that
    // committed but was uncompleted before its request reached the award step is not rewarded: re-completing it earns it.)
    const task = tasks.get(id) as { completed: boolean };
    if (xpOf() > 0) expect(records.docs.length).toBeGreaterThan(0); // never a reward without a committed completion
    if (task.completed) expect(xpOf()).toBe(10); // a completed task (its request or retry finished) has been rewarded
    expect(users.applied.filter((o) => o.update?.$inc).length).toBeLessThanOrEqual(1); // never a second award for the one task
  });
});
