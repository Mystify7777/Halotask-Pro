import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';

// Issue #24 — the Growth Tree through the REAL app (routes, auth, controllers, treeAward, treeRules) with
// strict in-memory User and Task doubles. Mongo-free; the doubles apply every update atomically and throw
// on operators the code does not use. See treeAward.mongoose.test.ts for the exact command Mongoose sends.

const OWNER_A = '665f1c2e9b1e8a00000000aa';
const OWNER_B = '665f1c2e9b1e8a00000000bb';

const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const emptyTree = (over: Record<string, unknown> = {}) => ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [], ...over });

let users: UserStore;
let tasks: TaskStore;
let app: Express;

beforeEach(async () => {
  users = createUserStore();
  tasks = createTaskStore();
  users.seed(OWNER_A, emptyTree());
  users.seed(OWNER_B, emptyTree());
  app = await loadAppWith(users, tasks, SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  unmockModels();
});

const complete = (id: string, completed = true, owner = OWNER_A) => request(app).put(`/api/tasks/${id}`).set(as(owner)).send({ completed });
const xpOf = (owner = OWNER_A) => (users.tree(owner) as { xp: number }).xp;
const ledgerOf = (owner = OWNER_A) => (users.tree(owner) as { awardedTaskIds: string[] }).awardedTaskIds;
const mutations = () => users.applied;

describe('PUT /api/tasks/:id — completion earns the award', () => {
  it('incomplete -> complete awards exactly +10 and returns the server tree state', async () => {
    const task = tasks.seed(OWNER_A);

    const res = await complete(String(task._id));

    expect(res.status).toBe(200);
    expect(res.body.task.completed).toBe(true);
    expect(res.body.growth).toMatchObject({ taskId: String(task._id), awarded: true, xpGained: 10 });
    expect(res.body.growth.treeState).toMatchObject({ xp: 10, streakDays: 1, health: 'healthy' });
    expect(res.body.growth.treeState).not.toHaveProperty('awardedTaskIds');
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toEqual([String(task._id)]);
  });

  it('an already-completed task does not award, and carries no growth block', async () => {
    const task = tasks.seed(OWNER_A, { completed: true });

    const res = await complete(String(task._id));

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it('an edit that does not touch completion never awards', async () => {
    const task = tasks.seed(OWNER_A);
    const res = await request(app).put(`/api/tasks/${task._id}`).set(as(OWNER_A)).send({ title: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(0);
  });

  it('a retried completion request does not award twice', async () => {
    const task = tasks.seed(OWNER_A);
    await complete(String(task._id));
    const retry = await complete(String(task._id));
    expect(retry.status).toBe(200);
    expect(retry.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(10);
  });

  it('uncomplete -> re-complete does not award a second time (the ledger remembers)', async () => {
    const task = tasks.seed(OWNER_A);
    await complete(String(task._id));
    await complete(String(task._id), false);
    const again = await complete(String(task._id));

    expect(again.status).toBe(200);
    expect(again.body.growth).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
    expect(again.body.growth.treeState.xp).toBe(10);
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toHaveLength(1);
  });

  it('concurrent duplicate completions of one task award once', async () => {
    const task = tasks.seed(OWNER_A);
    const id = String(task._id);

    const results = await Promise.all(Array.from({ length: 8 }, () => complete(id)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toEqual([id]);
    expect(results.filter((r) => r.body.growth?.awarded === true).length).toBeLessThanOrEqual(1);
  });

  it('concurrent completions of different tasks keep all the XP', async () => {
    const ids = Array.from({ length: 20 }, () => String(tasks.seed(OWNER_A)._id));

    const results = await Promise.all(ids.map((id) => complete(id)));

    expect(results.every((r) => r.status === 200 && r.body.growth.awarded === true)).toBe(true);
    expect(xpOf()).toBe(200);
    expect(new Set(ledgerOf()).size).toBe(20);
    expect(users.tree(OWNER_A)).toMatchObject({ streakDays: 1 });
  });

  it("someone else's task id can neither be completed nor awarded", async () => {
    const foreign = tasks.seed(OWNER_B);

    const res = await complete(String(foreign._id), true, OWNER_A);

    expect(res.status).toBe(404);
    expect(xpOf(OWNER_A)).toBe(0);
    expect(xpOf(OWNER_B)).toBe(0);
    expect(tasks.get(String(foreign._id))).toMatchObject({ completed: false });
    expect(mutations()).toEqual([]);
  });

  it('a nonexistent id is 404 and a malformed id is 400, as before; neither touches the tree', async () => {
    const missing = await complete('665f1c2e9b1e8a00000000ff');
    const malformed = await complete('not-an-id');

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ message: 'Task not found' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ message: 'Invalid task id' });
    expect(mutations()).toEqual([]);
  });

  it('deleting a task never removes XP that was already awarded', async () => {
    const task = tasks.seed(OWNER_A);
    await complete(String(task._id));

    const del = await request(app).delete(`/api/tasks/${task._id}`).set(as(OWNER_A));
    const tree = await request(app).get('/api/tree').set(as(OWNER_A));

    expect(del.status).toBe(200);
    expect(tree.body.treeState).toMatchObject({ xp: 10 });
    expect(tree.body.treeState.awardedTaskIds).toEqual([String(task._id)]);
  });

  it('legacy XP without matching ledger entries is preserved and built on', async () => {
    users.seed(OWNER_A, emptyTree({ xp: 500, leaves: 25, stage: 'lush', awardedTaskIds: [] }));
    const task = tasks.seed(OWNER_A);

    const before = await request(app).get('/api/tree').set(as(OWNER_A));
    const res = await complete(String(task._id));

    expect(before.body.treeState.xp).toBe(500);
    expect(res.body.growth.treeState.xp).toBe(510);
  });
});

describe('POST /api/tasks — a task created already completed (offline create-then-complete)', () => {
  it('awards once and returns the growth block', async () => {
    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'done offline', completed: true });

    expect(res.status).toBe(201);
    expect(res.body.growth).toMatchObject({ awarded: true, xpGained: 10 });
    expect(res.body.growth.taskId).toBe(String(res.body.task._id));
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toEqual([String(res.body.task._id)]);
  });

  it('a later PUT completed:true on that task does not award again', async () => {
    const created = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 't', completed: true });
    const again = await complete(created.body.task._id);
    expect(again.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(10);
  });

  it('a task created incomplete awards nothing', async () => {
    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'todo' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('growth');
    expect(xpOf()).toBe(0);
  });

  it('a client-supplied task id or reward field in the body cannot influence the award', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(as(OWNER_A))
      .send({ title: 'x', completed: true, _id: '507f1f77bcf86cd799439099', xp: 99999, awardedTaskIds: ['a'] });
    expect(res.status).toBe(201);
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toEqual([String(res.body.task._id)]);
  });
});

describe('failure and retry semantics', () => {
  it('PUT: the award fails -> 500, the task is untouched, and the retry awards exactly once', async () => {
    const task = tasks.seed(OWNER_A);
    users.faults.push({ op: 'findOneAndUpdate', count: 1 });

    const failed = await complete(String(task._id));

    expect(failed.status).toBe(500);
    expect(tasks.get(String(task._id))).toMatchObject({ completed: false });
    expect(xpOf()).toBe(0);

    const retry = await complete(String(task._id));
    expect(retry.status).toBe(200);
    expect(retry.body.growth.awarded).toBe(true);
    expect(xpOf()).toBe(10);
  });

  it('PUT: the award lands but the task write fails -> 500; the retry completes the task and awards nothing more', async () => {
    const task = tasks.seed(OWNER_A);
    tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });

    const failed = await complete(String(task._id));
    expect(failed.status).toBe(500);
    expect(xpOf()).toBe(10);
    expect(tasks.get(String(task._id))).toMatchObject({ completed: false });

    const retry = await complete(String(task._id));
    expect(retry.status).toBe(200);
    expect(retry.body.task.completed).toBe(true);
    expect(retry.body.growth).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(xpOf()).toBe(10);
  });

  it('POST: the award fails -> 500 and the just-created task is removed; a retry creates and awards once', async () => {
    users.faults.push({ op: 'findOneAndUpdate', count: 1 });

    const failed = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'x', completed: true });

    expect(failed.status).toBe(500);
    expect(tasks.size()).toBe(0);
    expect(xpOf()).toBe(0);

    const retry = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'x', completed: true });
    expect(retry.status).toBe(201);
    expect(tasks.size()).toBe(1);
    expect(xpOf()).toBe(10);
  });

  it('POST: the award fails AND the cleanup fails -> still 500, logged, and a completed task remains unrewarded (documented gap)', async () => {
    users.faults.push({ op: 'findOneAndUpdate', count: 1 });
    tasks.faults.push({ op: 'findOneAndDelete', count: 1 });

    const failed = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'x', completed: true });

    expect(failed.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be removed'));
    expect(tasks.size()).toBe(1);
    expect(xpOf()).toBe(0);
  });
});

describe('recovery when the award is recorded but its streak/derived write is not', () => {
  // The derived write is the findOneAndUpdate that $sets the streak (the award itself carries $inc/$push/$addToSet).
  const failNextDerivedWrite = () => users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => (op.update?.$set as Record<string, unknown> | undefined)?.['treeState.streakDays'] !== undefined });
  // The retained award-day history: the day is recorded with the XP even when the derived copy is not written.
  const activeDays = () => (users.tree(OWNER_A) as { activeDays?: string[] }).activeDays;
  const incrementsApplied = () => users.applied.filter((o) => o.update?.$inc).length;

  it('PUT: the request fails and the task stays incomplete, XP is recorded once, and the retry finishes the job without a second award', async () => {
    const task = tasks.seed(OWNER_A);
    failNextDerivedWrite();

    const failed = await complete(String(task._id));

    expect(failed.status).toBe(500);
    expect(failed.body).not.toHaveProperty('growth'); // no unpersisted projection is ever reported
    expect(tasks.get(String(task._id))).toMatchObject({ completed: false });
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 10, awardedTaskIds: [String(task._id)], streakDays: 0 });
    expect(activeDays()).toHaveLength(1); // the award day is recorded with the XP

    const retry = await complete(String(task._id));

    expect(retry.status).toBe(200);
    expect(retry.body.task.completed).toBe(true);
    expect(retry.body.growth).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
    expect(retry.body.growth.treeState).toMatchObject({ xp: 10, streakDays: 1, health: 'healthy' });
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 10, streakDays: 1 });
    expect(activeDays()).toHaveLength(1);
    expect(incrementsApplied()).toBe(1);
  });

  it('PUT: derived write fails, then the task write fails, then it works: still exactly one award', async () => {
    const task = tasks.seed(OWNER_A);
    failNextDerivedWrite();
    expect((await complete(String(task._id))).status).toBe(500);

    tasks.faults.push({ op: 'findOneAndUpdate', count: 1 });
    expect((await complete(String(task._id))).status).toBe(500);
    expect(users.tree(OWNER_A)).toMatchObject({ streakDays: 1 }); // the second attempt already finished the derived write
    expect(tasks.get(String(task._id))).toMatchObject({ completed: false });

    const third = await complete(String(task._id));
    expect(third.status).toBe(200);
    expect(third.body.task.completed).toBe(true);
    expect(xpOf()).toBe(10);
    expect(incrementsApplied()).toBe(1);
  });

  it('POST: the task and its XP are kept (never deleted/re-created), and the response is the PERSISTED tree', async () => {
    failNextDerivedWrite();

    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'offline done', completed: true });

    expect(res.status).toBe(201);
    expect(tasks.size()).toBe(1);
    expect(res.body.growth).toMatchObject({ awarded: true, xpGained: 10 });
    // Read back from storage, never a projection: storage still holds the unreconciled copy plus the recorded day, but the
    // response folds the recorded award day in memory, so the completion is not shown as an idle tree.
    expect(res.body.growth.treeState).toMatchObject({ xp: 10, streakDays: 1, status: 'active', health: 'healthy' });
    expect(users.tree(OWNER_A)).toMatchObject({ streakDays: 0, lastActiveDate: null });
    expect(activeDays()).toHaveLength(1);
    expect(incrementsApplied()).toBe(1);
  });

  it('POST: even if the read-back ALSO fails, the task is kept and the request still succeeds (201, no growth block) — a retry must not create a second task', async () => {
    users.seed(OWNER_A, emptyTree({ activeDays: [] })); // already adopted: a legacy tree would read once more to adopt
    failNextDerivedWrite();
    let userReads = 0;
    // findById call 1 is authentication; call 2 is the award's pre-flight integrity read; call 3 is the read-back
    // after the failed derived write.
    users.faults.push({ op: 'findById', count: 1, when: () => (userReads += 1) === 3 });

    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'offline done', completed: true });

    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({ title: 'offline done', completed: true });
    expect(res.body).not.toHaveProperty('growth');
    expect(tasks.size()).toBe(1);
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 10, awardedTaskIds: [String(res.body.task._id)] });
    expect(activeDays()).toHaveLength(1);
  });

  it('POST: the next completion finishes the leftover derived write (no lost streak day, no lost XP)', async () => {
    failNextDerivedWrite();
    await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'offline done', completed: true });
    const next = tasks.seed(OWNER_A);

    const res = await complete(String(next._id));

    expect(res.status).toBe(200);
    expect(res.body.growth).toMatchObject({ awarded: true });
    expect(res.body.growth.treeState).toMatchObject({ xp: 20, streakDays: 1 });
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 20, streakDays: 1 });
    expect(activeDays()).toHaveLength(1); // two awards on one day are one day in the history
  });
});

describe('recovery across several UTC days (HTTP)', () => {
  const failNextDerivedWrite = () => users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => (op.update?.$set as Record<string, unknown> | undefined)?.['treeState.streakDays'] !== undefined });
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('derived writes fail on Monday and Tuesday; Wednesday\'s retry persists BOTH days: streak 2, last active Tuesday', async () => {
    const monday = tasks.seed(OWNER_A);
    const tuesday = tasks.seed(OWNER_A);

    at('2026-10-05T09:00:00.000Z'); // Monday
    failNextDerivedWrite();
    expect((await complete(String(monday._id))).status).toBe(500);

    at('2026-10-06T09:00:00.000Z'); // Tuesday
    failNextDerivedWrite();
    expect((await complete(String(tuesday._id))).status).toBe(500);
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 20, streakDays: 0, activeDays: ['2026-10-05', '2026-10-06'] });

    at('2026-10-07T09:00:00.000Z'); // Wednesday: retry of Monday's completion
    const retry = await complete(String(monday._id));

    expect(retry.status).toBe(200);
    expect(retry.body.task.completed).toBe(true);
    expect(retry.body.growth).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(retry.body.growth.treeState).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-06', health: 'healthy' });
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-06', activeDays: ['2026-10-05', '2026-10-06'] });
    expect(users.applied.filter((o) => o.update?.$inc)).toHaveLength(2); // two awards in total, never three
  });

  it('...and a new completion on Wednesday makes it streak 3 on Wednesday', async () => {
    const [a, b, c] = [tasks.seed(OWNER_A), tasks.seed(OWNER_A), tasks.seed(OWNER_A)];
    at('2026-10-05T09:00:00.000Z');
    failNextDerivedWrite();
    await complete(String(a._id));
    at('2026-10-06T09:00:00.000Z');
    failNextDerivedWrite();
    await complete(String(b._id));

    at('2026-10-07T09:00:00.000Z');
    const res = await complete(String(c._id));

    expect(res.body.growth).toMatchObject({ awarded: true });
    expect(res.body.growth.treeState).toMatchObject({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-07' });
  });
});

describe('reset and recovery rules over HTTP (Issue #16)', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const stored = () => users.tree(OWNER_A) as Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    users.seed(OWNER_A, emptyTree({ xp: 130, leaves: 6, stage: 'mature', health: 'healthy', streakDays: 6, lastActiveDate: '2026-10-06', awardedTaskIds: ['a'] }));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['same day', '2026-10-06T22:00:00Z', 'active', 6, 'healthy'],
    ['next day: today still open', '2026-10-07T00:00:00Z', 'at_risk', 6, 'healthy'],
    ['one missed day', '2026-10-08T00:00:00Z', 'wilting', 0, 'wilting'],
    ['still one missed day, end of that UTC day', '2026-10-08T23:59:59Z', 'wilting', 0, 'wilting'],
    ['two missed days', '2026-10-09T00:00:00Z', 'dead', 0, 'dead'],
    ['a year later', '2027-10-06T00:00:00Z', 'dead', 0, 'dead'],
  ])('GET %s -> %s (streak %i, %s), with xp, leaves and stage untouched', async (_label, iso, status, streak, health) => {
    at(iso);

    const res = await request(app).get('/api/tree').set(as(OWNER_A));

    expect(res.status).toBe(200);
    expect(res.body.treeState).toMatchObject({ status, streakDays: streak, health, xp: 130, leaves: 6, stage: 'mature', awardedTaskIds: ['a'] });
  });

  it('a GET (and a no-op PATCH) at any idleness persists nothing', async () => {
    const before = JSON.stringify(stored());
    for (const iso of ['2026-10-07T12:00:00Z', '2026-10-08T12:00:00Z', '2026-10-20T12:00:00Z']) {
      at(iso);
      expect((await request(app).get('/api/tree').set(as(OWNER_A))).status).toBe(200);
      expect((await request(app).patch('/api/tree').set(as(OWNER_A)).send({})).status).toBe(200);
    }
    expect(users.applied).toHaveLength(0);
    expect(JSON.stringify(stored())).toBe(before);
  });

  it('two reads at the same instant agree, and repeated reads never change the answer', async () => {
    at('2026-10-08T09:00:00Z');
    const first = (await request(app).get('/api/tree').set(as(OWNER_A))).body.treeState;
    const second = (await request(app).get('/api/tree').set(as(OWNER_A))).body.treeState;
    expect({ ...second, lastCalculatedAt: undefined }).toEqual({ ...first, lastCalculatedAt: undefined });
  });

  it.each([
    ['wilting', '2026-10-08T09:00:00Z'],
    ['dead', '2026-10-20T09:00:00Z'],
  ])('one completion restores a %s tree to healthy immediately; the streak restarts at 1 and XP only grows', async (_label, iso) => {
    at(iso);
    const task = tasks.seed(OWNER_A);

    const res = await complete(String(task._id));

    expect(res.status).toBe(200);
    expect(res.body.growth.treeState).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, xp: 140, leaves: 7, stage: 'mature' });
    const get = await request(app).get('/api/tree').set(as(OWNER_A));
    expect(get.body.treeState).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, xp: 140 });
  });

  it('completing the day after the last one continues the streak (no reset without a missed day)', async () => {
    at('2026-10-07T09:00:00Z');
    const task = tasks.seed(OWNER_A);
    const res = await complete(String(task._id));
    expect(res.body.growth.treeState).toMatchObject({ status: 'active', streakDays: 7, xp: 140 });
  });

  it('un-completing a task never lowers xp or the stage, and cannot revive a dead tree', async () => {
    at('2026-10-20T09:00:00Z');
    const task = tasks.seed(OWNER_A, { completed: true });
    const res = await complete(String(task._id), false);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ xp: 130, streakDays: 6, lastActiveDate: '2026-10-06' });
    expect((await request(app).get('/api/tree').set(as(OWNER_A))).body.treeState).toMatchObject({ status: 'dead', xp: 130, stage: 'mature' });
  });
});

describe('recorded-but-unreconciled award on a long-idle tree (Issue #16 review)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
    users.seed(OWNER_A, emptyTree({ xp: 130, leaves: 6, stage: 'mature', health: 'dead', streakDays: 6, lastActiveDate: '2026-10-01', awardedTaskIds: ['a'] }));
  });
  afterEach(() => vi.useRealTimers());

  it('POST with a failed derived write: the fallback response AND a later GET show a healthy restored tree; storage is untouched by both', async () => {
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => (op.update?.$set as Record<string, unknown> | undefined)?.['treeState.streakDays'] !== undefined });

    const res = await request(app).post('/api/tasks').set(as(OWNER_A)).send({ title: 'back again', completed: true });

    expect(res.status).toBe(201);
    expect(res.body.growth.treeState).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, lastActiveDate: '2026-10-20', xp: 140 });
    const stored = JSON.stringify(users.tree(OWNER_A));
    // The legacy tree adopted its history (6 implied days ending 2026-10-01) and the award day was recorded with the XP.
    expect(users.tree(OWNER_A)).toMatchObject({ streakDays: 6, lastActiveDate: '2026-10-01', activeDays: ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-20'] });
    const writesAfterAward = users.applied.length;

    const get = await request(app).get('/api/tree').set(as(OWNER_A));

    expect(get.body.treeState).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, lastActiveDate: '2026-10-20', xp: 140 });
    expect(users.applied).toHaveLength(writesAfterAward); // the GET wrote nothing
    expect(JSON.stringify(users.tree(OWNER_A))).toBe(stored);
  });

  it('PUT with a failed derived write answers 500, yet a GET already shows the recorded completion; the retry then reconciles it', async () => {
    const task = tasks.seed(OWNER_A);
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: (op) => (op.update?.$set as Record<string, unknown> | undefined)?.['treeState.streakDays'] !== undefined });
    expect((await complete(String(task._id))).status).toBe(500);

    const get = await request(app).get('/api/tree').set(as(OWNER_A));
    expect(get.body.treeState).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, xp: 140 });

    const retry = await complete(String(task._id));
    expect(retry.status).toBe(200);
    expect(retry.body.growth.treeState).toMatchObject({ status: 'active', streakDays: 1, xp: 140 });
    expect(users.tree(OWNER_A)).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-20', xp: 140 });
  });
});

describe('what the read endpoints do with damaged stored data', () => {
  const damaged = () =>
    users.seed(OWNER_A, emptyTree({ xp: Infinity, streakDays: -3, lastActiveDate: 'junk', leaves: 9999, stage: 'lush', health: 'healthy', awardedTaskIds: ['ok', '', 7], pendingDerivedDays: ['2026-10-05'] }));

  it('GET and the PATCH no-op repair the RESPONSE only: storage is not written, and the internal marker is never exposed', async () => {
    damaged();
    const before = users.tree(OWNER_A);

    const get = await request(app).get('/api/tree').set(as(OWNER_A));
    const noop = await request(app).patch('/api/tree').set(as(OWNER_A)).send({});

    for (const res of [get, noop]) {
      expect(res.status).toBe(200);
      // The recorded 2026-10-05 award is folded into the response (streak 1) but long ago: the tree reads as dead.
      expect(res.body.treeState).toMatchObject({ xp: 0, streakDays: 0, status: 'dead', lastActiveDate: '2026-10-05', leaves: 0, stage: 'seed', awardedTaskIds: ['ok'] });
      expect(res.body.treeState).not.toHaveProperty('pendingDerivedDays');
    }
    expect(users.applied).toEqual([]);
    expect(users.tree(OWNER_A)).toEqual(before);
  });

  it('the first award is where storage is repaired: xp, streak, date and derived fields are rewritten, the ledger is only ever appended to', async () => {
    damaged();
    const task = tasks.seed(OWNER_A);

    const res = await complete(String(task._id));

    expect(res.status).toBe(200);
    expect(users.tree(OWNER_A)).toMatchObject({ xp: 10, streakDays: 1, leaves: 0, stage: 'seed', health: 'healthy', awardedTaskIds: ['ok', '', 7, String(task._id)] });
    // The legacy marker day was folded into the adopted history and the marker removed.
    expect(users.tree(OWNER_A)).not.toHaveProperty('pendingDerivedDays');
    expect((users.tree(OWNER_A) as { activeDays: string[] }).activeDays).toHaveLength(2);
    expect((users.tree(OWNER_A) as { activeDays: string[] }).activeDays[0]).toBe('2026-10-05');
  });
});

describe('GET /api/tree', () => {
  it('returns the stored tree with the established response shape, derived fields recomputed', async () => {
    users.seed(OWNER_A, emptyTree({ xp: 130, leaves: 0, stage: 'seed', health: 'dead', streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['a'] }));

    const res = await request(app).get('/api/tree').set(as(OWNER_A));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.treeState).sort()).toEqual(['awardedTaskIds', 'daysSinceActive', 'health', 'lastActiveDate', 'lastCalculatedAt', 'leaves', 'stage', 'status', 'streakDays', 'xp']);
    expect(res.body.treeState).toMatchObject({ xp: 130, leaves: 6, stage: 'mature', awardedTaskIds: ['a'] });
  });

  it('repairs a stored Infinity xp and junk values instead of serialising them as null', async () => {
    users.seed(OWNER_A, emptyTree({ xp: Infinity, streakDays: -4, lastActiveDate: 'junk', awardedTaskIds: ['ok', '', 7] }));

    const res = await request(app).get('/api/tree').set(as(OWNER_A));

    expect(res.body.treeState).toMatchObject({ xp: 0, streakDays: 0, lastActiveDate: null, awardedTaskIds: ['ok'] });
  });

  it('a user with no tree gets a zero tree', async () => {
    users.seed(OWNER_A);
    const res = await request(app).get('/api/tree').set(as(OWNER_A));
    expect(res.status).toBe(200);
    expect(res.body.treeState).toMatchObject({ xp: 0, leaves: 0, stage: 'seed', awardedTaskIds: [] });
  });
});

describe('PATCH /api/tree — reward state is not client-writable', () => {
  const FORGERIES: Array<[label: string, body: string]> = [
    ['raising xp', '{"xp":999999}'],
    ['xp as 1e999 (parses to Infinity)', '{"xp":1e999}'],
    ['a float xp', '{"xp":12.5}'],
    ['a negative xp', '{"xp":-100}'],
    ['an unsafe integer xp', '{"xp":9007199254740993}'],
    ['xp as a string', '{"xp":"9999"}'],
    ['xp null', '{"xp":null}'],
    ['rolling xp back to 0', '{"xp":0}'],
    ['rolling the ledger back', '{"awardedTaskIds":[]}'],
    ['adding ledger ids', '{"awardedTaskIds":["a","b"]}'],
    ['leaves', '{"leaves":500}'],
    ['stage', '{"stage":"lush"}'],
    ['health', '{"health":"healthy"}'],
    ['streakDays', '{"streakDays":9999}'],
    ['a future lastActiveDate', '{"lastActiveDate":"2999-01-01"}'],
    ['lastCalculatedAt', '{"lastCalculatedAt":"2999-01-01T00:00:00.000Z"}'],
    ['everything at once, like the old client', '{"xp":500,"leaves":25,"streakDays":9,"lastActiveDate":"2026-10-06","health":"healthy","stage":"lush","lastCalculatedAt":"2026-10-06T00:00:00.000Z","awardedTaskIds":["x"]}'],
  ];

  it.each(FORGERIES)('%s -> 400 TREE_FIELD_NOT_WRITABLE, state untouched, nothing written', async (_label, raw) => {
    users.seed(OWNER_A, emptyTree({ xp: 50, awardedTaskIds: ['keep'] }));
    const before = users.tree(OWNER_A);

    const res = await request(app).patch('/api/tree').set(as(OWNER_A)).set('Content-Type', 'application/json').send(raw);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TREE_FIELD_NOT_WRITABLE');
    expect(res.body.fields.length).toBeGreaterThan(0);
    expect(users.tree(OWNER_A)).toEqual(before);
    expect(mutations()).toEqual([]);
  });

  it('an oversized awardedTaskIds array is refused the same way', async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
    const res = await request(app).patch('/api/tree').set(as(OWNER_A)).send({ awardedTaskIds: ids });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TREE_FIELD_NOT_WRITABLE');
    expect(ledgerOf()).toEqual([]);
  });

  it('one forged field among harmless ones still rejects the whole request', async () => {
    const res = await request(app).patch('/api/tree').set(as(OWNER_A)).send({ somethingElse: 1, xp: 5 });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['xp']);
  });

  it('an empty object is a harmless no-op that returns the server tree; unknown fields change nothing', async () => {
    users.seed(OWNER_A, emptyTree({ xp: 50, awardedTaskIds: ['keep'] }));
    const before = users.tree(OWNER_A);

    const empty = await request(app).patch('/api/tree').set(as(OWNER_A)).send({});
    const unknown = await request(app).patch('/api/tree').set(as(OWNER_A)).send({ treeState: { xp: 99999 }, note: 'hi' });

    expect(empty.status).toBe(200);
    expect(empty.body.treeState.xp).toBe(50);
    expect(unknown.status).toBe(200);
    expect(unknown.body.treeState.xp).toBe(50);
    expect(users.tree(OWNER_A)).toEqual(before);
    expect(mutations()).toEqual([]);
  });

  it('an array body keeps its existing "must be a JSON object" 400', async () => {
    const res = await request(app).patch('/api/tree').set(as(OWNER_A)).set('Content-Type', 'application/json').send('[1,2]');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Request body must be a JSON object.' });
  });

  it.each([['a string', '"xp"'], ['a number', '5'], ['null', 'null']])('a primitive body (%s) is still a 400 (rejected by the strict JSON parser)', async (_label, raw) => {
    const res = await request(app).patch('/api/tree').set(as(OWNER_A)).set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(400);
    expect(mutations()).toEqual([]);
  });

  it('XP earned by a task survives a stale client PATCH attempt (no rollback)', async () => {
    const task = tasks.seed(OWNER_A);
    await complete(String(task._id));

    const stale = await request(app).patch('/api/tree').set(as(OWNER_A)).send({ xp: 0, awardedTaskIds: [] });

    expect(stale.status).toBe(400);
    expect(xpOf()).toBe(10);
    expect(ledgerOf()).toEqual([String(task._id)]);
  });
});
