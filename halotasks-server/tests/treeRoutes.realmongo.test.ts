import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { XP_PER_COMPLETION, needsReconcile } from '../src/utils/treeRules';
import { TEST_JWT_SECRET } from './testConfig';
// BEGIN backend imports
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { TreeAwardError } from '../src/utils/treeAward';
import { SIMULATED_FAILURE_MESSAGE, installDriverFaults } from './helpers/driverFaults';
// END backend imports

// Issue #24 — the Growth Tree award over HTTP against a REAL MongoDB (MongoMemoryServer), through the real Express
// app, auth middleware, Mongoose models and award code. tests/treeRoutes.test.ts proves the route logic against
// in-memory doubles; this file proves the same promises hold when the database itself arbitrates concurrent requests.
//
// What a response may be (docs/context.md, "Growth Tree integrity model", and controllers/task.controller.ts):
//   PUT  200  the task is completed. `growth` is present when THIS request made the incomplete -> complete transition:
//             { taskId, awarded:true, xpGained:10 } for the first award, { awarded:false, xpGained:0,
//             reason:'already_awarded' } when the id was already rewarded. A request that finds the task already
//             completed has no `growth` at all.
//   PUT  500  the ONLY documented retryable failure of an award is derived_unpersisted: the award (xp + ledger + day)
//             IS recorded, its streak copy is not, and the task is left untouched. The global handler answers
//             { message: 'Growth Tree award failure: derived_unpersisted' } (generic text in production).
//   POST 201  the task exists. A derived_unpersisted failure is handled INSIDE the controller (the task and its award are
//             kept), so POST never answers 500 for it; the response carries the persisted `growth`, or none if even the
//             read-back failed.
//   POST 500  only when the award was NOT recorded; the just-created task is then removed again.
// A concurrent burst has no injected faults, so it may produce 200s and derived_unpersisted 500s and NOTHING else. Any other
// status, body or logged error fails the test: contention is not a licence to accept unknown errors.
// The failure-path tests are deterministic: tests/helpers/driverFaults.ts rejects exactly the planned command at the
// driver and sends every other call to the real database.

let logged: unknown[][] = [];

type Account = { id: string; token: string };

// BEGIN persistence helpers (the only code that touches the database; every test goes through these)
let mongoServer: MongoMemoryServer;
let faults: ReturnType<typeof installDriverFaults>;

const setTestEnv = () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
};

/**
 * A real user document and a token requireAuth accepts. Registering through the API would only add the register rate
 * limit, which is not under test. By default the tree is exactly what registration creates (no award history yet, so the
 * first award adopts it); `adopted` seeds the history that the first award would otherwise write.
 */
const makeAccount = async (label: string, { adopted = false }: { adopted?: boolean } = {}): Promise<Account> => {
  const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x' });
  if (adopted) await User.collection.updateOne({ _id: user._id }, { $set: { 'treeState.activeDays': [] } });
  const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  return { id: user.id as string, token };
};

const makeTasks = async (account: Account, count: number): Promise<string[]> => {
  const docs = await Task.insertMany(Array.from({ length: count }, (_, i) => ({ userId: account.id, title: `task ${i}` })));
  return docs.map((doc) => String(doc._id));
};

type TaskRow = { _id: unknown; title: string; completed: boolean };
const taskDoc = async (taskId: string) => (await Task.findById(taskId).lean()) as TaskRow | null;
/** The account's tasks, oldest id first. */
const tasksOf = async (account: Account) => (await Task.find({ userId: account.id }).sort({ _id: 1 }).lean()) as TaskRow[];
const taskCountOf = async (account: Account) => Task.countDocuments({ userId: account.id });
const existingTaskCount = async (ids: string[]) => Task.countDocuments({ _id: { $in: ids } });
const userDoc = async (account: Account) => User.findById(account.id).lean();
// END persistence helpers

const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });

const complete = (account: Account, taskId: string) =>
  request(app).put(`/api/tasks/${taskId}`).set(auth(account)).send({ completed: true });

const createCompleted = (account: Account, title: string) =>
  request(app).post('/api/tasks').set(auth(account)).send({ title, completed: true });

type Res = Awaited<ReturnType<typeof complete>>;
type Outcome = { id: string; res: Res };

/** What is stored for the account right now, read in one document read (xp and ledger are always one snapshot). */
const stored = async (account: Account) => {
  const doc = await userDoc(account);
  const tree = (doc?.treeState ?? {}) as unknown as Record<string, unknown>;
  return { xp: (tree.xp ?? 0) as number, ledger: [...((tree.awardedTaskIds ?? []) as string[])], tree };
};

const completedTaskIds = async (account: Account) =>
  (await tasksOf(account)).filter((doc) => doc.completed).map((doc) => String(doc._id)).sort();

// ── The documented shapes ───────────────────────────────────────────────────────

/** GET /api/tree, as pinned by tests/treeRoutes.test.ts; the `growth.treeState` of a task response is the same minus the ledger. */
const GET_TREE_KEYS = ['awardedTaskIds', 'daysSinceActive', 'health', 'lastActiveDate', 'lastCalculatedAt', 'leaves', 'stage', 'status', 'streakDays', 'xp'];
const GROWTH_TREE_KEYS = GET_TREE_KEYS.filter((key) => key !== 'awardedTaskIds');

const RETRYABLE_500_BODY = {
  message: process.env.NODE_ENV === 'production' ? 'Internal server error' : 'Growth Tree award failure: derived_unpersisted',
};

const unhandledErrors = () => logged.filter((args) => args[0] === '[Server] Unhandled error:').map((args) => args[1]);

/** The 500 of a PUT whose award was recorded but whose derived write was not: exactly the documented body. */
const expectRetryable500 = (res: Res, context: string) => {
  expect(res.status, `${context}: unexpected ${res.status} ${JSON.stringify(res.body)}`).toBe(500);
  expect(res.body, context).toEqual(RETRYABLE_500_BODY);
};

/** Every error the global handler logged was a derived_unpersisted, and there were exactly `count` of them (the 500s). */
const expectOnlyDocumentedFailuresLogged = (count: number) => {
  const errors = unhandledErrors();
  expect(errors, `unhandled errors: ${errors.map(String).join(' | ')}`).toHaveLength(count);
  for (const error of errors) {
    expect(error).toBeInstanceOf(TreeAwardError);
    expect((error as TreeAwardError).kind).toBe('derived_unpersisted');
  }
};

/** A 500 that is NOT the documented one: the generic body, and exactly the error that was injected. */
const expectInjectedFailure500 = (res: Res, context: string) => {
  expect(res.status, context).toBe(500);
  expect(Object.keys(res.body), context).toEqual(['message']);
  const errors = unhandledErrors();
  expect(errors, context).toHaveLength(1);
  expect(String((errors[0] as Error).message), context).toContain(SIMULATED_FAILURE_MESSAGE);
};

const splitOutcomes = (outcomes: Outcome[]) => {
  const ok: Outcome[] = [];
  const retry: Outcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.res.status === 200) ok.push(outcome);
    else {
      expectRetryable500(outcome.res, `PUT ${outcome.id}`);
      retry.push(outcome);
    }
  }
  return { ok, retry };
};

/** Each task had exactly one request, so a 200 with a growth block is the first and only award for it. */
const expectFirstAward200 = ({ id, res }: Outcome) => {
  expect(res.body.task, `PUT ${id}`).toMatchObject({ _id: id, completed: true });
  expect(res.body.growth, `PUT ${id}`).toMatchObject({ taskId: id, awarded: true, xpGained: XP_PER_COMPLETION });
  expect(res.body.growth).not.toHaveProperty('reason');
  expect(Object.keys(res.body.growth.treeState).sort()).toEqual(GROWTH_TREE_KEYS);
  expect(res.body.growth.treeState.xp % XP_PER_COMPLETION).toBe(0);
  expect(res.body.growth.treeState.xp).toBeGreaterThanOrEqual(XP_PER_COMPLETION);
};

/**
 * What must be true the moment a burst of PUTs (one per task, no injected fault) has settled. Every request either
 * recorded its award and finished (200), or recorded it and failed only afterwards (the documented 500). So every task
 * is in the ledger exactly once and xp is exactly one award per task; and because the task write only follows a
 * recorded award, the completed tasks are exactly the 200s.
 */
const expectPutBurstInvariants = async (owner: Account, ids: string[], ok: Outcome[]) => {
  const burst = await stored(owner);
  expect([...burst.ledger].sort()).toEqual([...ids].sort());
  expect(burst.xp).toBe(XP_PER_COMPLETION * ids.length);
  expect(await completedTaskIds(owner)).toEqual(ok.map((outcome) => outcome.id).sort());
};

/** The client retries what failed. The award is already recorded, so the retry completes the task and pays nothing. */
const retryFailedPuts = async (owner: Account, retry: Outcome[]) => {
  for (const { id } of retry) {
    const res = await complete(owner, id);
    expect(res.status, `retry of ${id}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.task).toMatchObject({ _id: id, completed: true });
    expect(res.body.growth).toMatchObject({ taskId: id, awarded: false, xpGained: 0, reason: 'already_awarded' });
  }
};

/**
 * Proves WHICH database command a planned fault hit, from the helper's ordered trace: `failed` must appear, and the
 * very next WRAPPED command must be `next`. Scope: the trace holds only the commands the helper wraps (user
 * findOne/findOneAndUpdate, task findOneAndUpdate/findOneAndDelete), so this shows adjacency among those, not that no
 * other driver command ran in between; the source reading in treeAward.ts (a rejected derived write is followed directly
 * by the controller's read-back) is what justifies treating that as the read-back.
 */
const expectNextCommandAfter = (failed: string, next: string) => {
  const trace = faults.trace();
  const at = trace.indexOf(failed);
  expect(at, `${failed} not in trace ${JSON.stringify(trace)}`).toBeGreaterThanOrEqual(0);
  expect(trace[at + 1], `command after ${failed} in ${JSON.stringify(trace)}`).toBe(next);
};

/** Every id is rewarded once, every task exists and is completed, and the stored streak copy agrees with the history. */
const expectConverged = async (owner: Account, ids: string[]) => {
  const { xp, ledger, tree } = await stored(owner);
  expect([...ledger].sort()).toEqual([...ids].sort());
  expect(xp).toBe(XP_PER_COMPLETION * ids.length);
  expect(needsReconcile(tree, new Date())).toBe(false);
  const days = (tree.activeDays ?? []) as string[];
  expect(days.length).toBeGreaterThanOrEqual(1);
  expect(days.length).toBeLessThanOrEqual(2); // two only if the run straddled UTC midnight
  expect(tree.streakDays).toBe(days.length);

  const docs = await tasksOf(owner);
  expect(docs.map((doc) => String(doc._id)).sort()).toEqual([...ids].sort());
  expect(docs.every((doc) => doc.completed)).toBe(true);

  const read = await request(app).get('/api/tree').set(auth(owner));
  expect(read.status).toBe(200);
  expect(Object.keys(read.body.treeState).sort()).toEqual(GET_TREE_KEYS);
  expect(read.body.treeState).toMatchObject({ xp: XP_PER_COMPLETION * ids.length, streakDays: days.length, health: 'healthy' });
  expect([...read.body.treeState.awardedTaskIds].sort()).toEqual([...ids].sort());
};

// BEGIN lifecycle
beforeAll(async () => {
  setTestEnv();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  faults = installDriverFaults({ users: User.collection, tasks: Task.collection });
});

beforeEach(async () => {
  setTestEnv();
  faults.reset();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  await User.deleteMany({});
  await Task.deleteMany({});
});

afterEach(() => {
  // A planned failure that never fired means the test did not take the path it names. Capture that, then clear every
  // plan and mock BEFORE asserting, so a failing test can never leak a fault (or the console spy) into the next one.
  const unfired = faults.pending();
  faults.reset();
  vi.restoreAllMocks();
  expect(unfired, 'planned failures that never fired').toBe(0);
});

afterAll(async () => {
  // Each step runs even if an earlier one throws, so the shared collections are never left wrapped.
  try {
    faults?.restore();
  } finally {
    try {
      await mongoose.disconnect();
    } finally {
      await mongoServer?.stop();
    }
  }
});
// END lifecycle

describe('real MongoDB over HTTP: concurrent completions (no injected faults)', () => {
  const N = 12;

  describe.each<[label: string, adopted: boolean]>([
    ['an account with no award history yet (what registration creates)', false],
    ['an account whose history is already adopted', true],
  ])('PUT bursts for %s', (_label, adopted) => {
    it(`${N} concurrent completions of different tasks: each a first-award 200 or the documented retryable 500, nothing lost or doubled`, async () => {
      const owner = await makeAccount('owner', { adopted });
      const ids = await makeTasks(owner, N);

      const outcomes = await Promise.all(ids.map(async (id) => ({ id, res: await complete(owner, id) })));
      const { ok, retry } = splitOutcomes(outcomes);

      ok.forEach(expectFirstAward200);
      expectOnlyDocumentedFailuresLogged(retry.length);
      await expectPutBurstInvariants(owner, ids, ok);

      await retryFailedPuts(owner, retry);
      await expectConverged(owner, ids);
    });
  });

  it('10 concurrent duplicate completions of ONE task: one award, every response a documented outcome', async () => {
    const owner = await makeAccount('owner');
    const [taskId] = await makeTasks(owner, 1);

    const responses = await Promise.all(Array.from({ length: 10 }, () => complete(owner, taskId)));

    let retryable = 0;
    let firstAwards = 0;
    for (const res of responses) {
      if (res.status !== 200) {
        expectRetryable500(res, 'duplicate PUT');
        retryable += 1;
        continue;
      }
      expect(res.body.task).toMatchObject({ _id: taskId, completed: true });
      // No growth block: the request found the task already completed (another request had finished), so it ran no award step.
      if (res.body.growth === undefined) continue;
      expect(res.body.growth.taskId).toBe(taskId);
      if (res.body.growth.awarded === true) {
        firstAwards += 1;
        expect(res.body.growth.xpGained).toBe(XP_PER_COMPLETION);
      } else {
        expect(res.body.growth).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
      }
    }
    expect(firstAwards).toBeLessThanOrEqual(1);
    expectOnlyDocumentedFailuresLogged(retryable);

    // Every outcome above means the award was recorded, so it is in the ledger exactly once, and paid exactly once.
    const burst = await stored(owner);
    expect(burst.ledger).toEqual([taskId]);
    expect(burst.xp).toBe(XP_PER_COMPLETION);

    if (!(await taskDoc(taskId))?.completed) {
      const retry = await complete(owner, taskId);
      expect(retry.status).toBe(200);
      expect(retry.body.growth).toMatchObject({ taskId, awarded: false, xpGained: 0, reason: 'already_awarded' });
    }
    await expectConverged(owner, [taskId]);

    // Completing it yet again is the established no-op: 200, no growth block, nothing paid.
    const again = await complete(owner, taskId);
    expect(again.status).toBe(200);
    expect(again.body).not.toHaveProperty('growth');
    expect((await stored(owner)).xp).toBe(XP_PER_COMPLETION);
  });

  it(`${N} concurrent POSTs of already-completed tasks: all 201, each task rewarded exactly once, none orphaned either way`, async () => {
    const owner = await makeAccount('owner');

    const responses = await Promise.all(Array.from({ length: N }, (_, i) => createCompleted(owner, `offline ${i}`)));

    // POST never turns a derived_unpersisted into an error response (the controller keeps the task and its award), and an
    // unrecorded award would have removed the task and answered 500. So there is no 500 here, and no unhandled error.
    responses.forEach((res, i) => {
      expect(res.status, `POST ${i}: ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.task).toMatchObject({ title: `offline ${i}`, completed: true, userId: owner.id });
      expect(res.body.growth).toMatchObject({ taskId: res.body.task._id, awarded: true, xpGained: XP_PER_COMPLETION });
      expect(Object.keys(res.body.growth.treeState).sort()).toEqual(GROWTH_TREE_KEYS);
    });
    expect(unhandledErrors()).toEqual([]);

    const ids = responses.map((res) => String(res.body.task._id));
    expect(new Set(ids).size).toBe(N);
    const burst = await stored(owner);
    expect([...burst.ledger].sort()).toEqual([...ids].sort()); // every task rewarded once, every reward has its task
    expect(burst.xp).toBe(XP_PER_COMPLETION * N);
    expect((await tasksOf(owner)).map((doc) => String(doc._id)).sort()).toEqual([...ids].sort());

    // The derived copy may legitimately lag after a burst (derived_unpersisted is kept, not failed); the next completion repairs it.
    const extra = await createCompleted(owner, 'one more');
    expect(extra.status).toBe(201);
    await expectConverged(owner, [...ids, String(extra.body.task._id)]);
  });

  it(`${N} concurrent PUTs while the first 4 derived writes are made to fail: those get the documented 500, nothing is lost, retries converge`, async () => {
    const owner = await makeAccount('owner');
    const ids = await makeTasks(owner, N);
    faults.failNext('derived', 4);

    const outcomes = await Promise.all(ids.map(async (id) => ({ id, res: await complete(owner, id) })));
    const { ok, retry } = splitOutcomes(outcomes);

    // The first four derived writes belong to four different requests (a failed write ends its request), so at least four
    // responses are the 500. Contention may add more; the helper has already rejected any 500 that is not the documented one.
    expect(faults.injected('derived')).toBe(4);
    expect(retry.length).toBeGreaterThanOrEqual(4);
    ok.forEach(expectFirstAward200);
    expectOnlyDocumentedFailuresLogged(retry.length);
    await expectPutBurstInvariants(owner, ids, ok);

    // For every 500 the award is recorded and the task is not completed: retrying completes it and pays nothing.
    expect(await completedTaskIds(owner)).not.toContain(retry[0].id);
    await retryFailedPuts(owner, retry);
    await expectConverged(owner, ids);
  });
});

describe('real MongoDB over HTTP: isolation between users under concurrent load', () => {
  it("one user's completions, another user's attempts on those tasks, forged PATCHes and a bystander never cross accounts", async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const bystander = await makeAccount('carol');
    const aIds = await makeTasks(a, 10);
    const bIds = await makeTasks(b, 10);
    await makeTasks(bystander, 3);
    const bystanderUserBefore = JSON.stringify(await userDoc(bystander));
    const bystanderTasksBefore = JSON.stringify(await tasksOf(bystander));

    const [aOutcomes, bOutcomes, bOnA, forgeA, forgeB] = await Promise.all([
      Promise.all(aIds.map(async (id) => ({ id, res: await complete(a, id) }))),
      Promise.all(bIds.map(async (id) => ({ id, res: await complete(b, id) }))),
      // Bob tries to complete (and rename) Alice's tasks while Alice completes them herself.
      Promise.all(aIds.map((id) => request(app).put(`/api/tasks/${id}`).set(auth(b)).send({ completed: true, title: 'hijacked' }))),
      request(app).patch('/api/tree').set(auth(a)).send({ xp: 99999, awardedTaskIds: bIds }),
      request(app).patch('/api/tree').set(auth(b)).send({ xp: 99999, awardedTaskIds: aIds, userId: a.id }),
    ]);

    bOnA.forEach((res) => {
      expect(res.status).toBe(404); // someone else's task id is simply not found, as for any unknown id
      expect(res.body).toEqual({ message: 'Task not found' });
    });
    for (const forged of [forgeA, forgeB]) {
      expect(forged.status).toBe(400);
      expect(forged.body).toMatchObject({ code: 'TREE_FIELD_NOT_WRITABLE', fields: ['xp', 'awardedTaskIds'] });
    }

    const aSplit = splitOutcomes(aOutcomes);
    const bSplit = splitOutcomes(bOutcomes);
    aSplit.ok.forEach(expectFirstAward200);
    bSplit.ok.forEach(expectFirstAward200);
    expectOnlyDocumentedFailuresLogged(aSplit.retry.length + bSplit.retry.length);

    // Each ledger holds exactly its owner's tasks, and nothing the other account sent or forged.
    await expectPutBurstInvariants(a, aIds, aSplit.ok);
    await expectPutBurstInvariants(b, bIds, bSplit.ok);

    await retryFailedPuts(a, aSplit.retry);
    await retryFailedPuts(b, bSplit.retry);
    await expectConverged(a, aIds);
    await expectConverged(b, bIds);

    // Bob's attempts changed nothing of Alice's, and the account that took no part is byte-identical.
    expect((await tasksOf(a)).every((doc) => doc.title.startsWith('task '))).toBe(true);
    expect(await existingTaskCount(aIds)).toBe(aIds.length);
    expect(JSON.stringify(await userDoc(bystander))).toBe(bystanderUserBefore);
    expect(JSON.stringify(await tasksOf(bystander))).toBe(bystanderTasksBefore);
  });
});

describe('real MongoDB over HTTP: failure and retry paths (one planned failure, everything else the real database)', () => {
  describe('PUT /api/tasks/:id', () => {
    it('award recorded but derived write fails: documented 500, task untouched; the retry completes it without a second award and reconciles', async () => {
      const owner = await makeAccount('owner');
      const [taskId] = await makeTasks(owner, 1);
      faults.failNext('derived');

      const failed = await complete(owner, taskId);

      expect(faults.injected('derived')).toBe(1);
      expectRetryable500(failed, 'PUT with a failed derived write');
      expectOnlyDocumentedFailuresLogged(1);
      expect((await taskDoc(taskId))?.completed).toBe(false);
      const afterFailure = await stored(owner);
      expect(afterFailure.ledger).toEqual([taskId]); // the award IS recorded ...
      expect(afterFailure.xp).toBe(XP_PER_COMPLETION);
      expect(afterFailure.tree.activeDays).toHaveLength(1); // ... with its day ...
      expect(afterFailure.tree).toMatchObject({ streakDays: 0, lastActiveDate: null }); // ... but the derived copy is not
      expect(needsReconcile(afterFailure.tree, new Date())).toBe(true);

      // A read already shows the recorded completion (it folds the history in memory) and writes nothing.
      const read = await request(app).get('/api/tree').set(auth(owner));
      expect(read.status).toBe(200);
      expect(read.body.treeState).toMatchObject({ xp: XP_PER_COMPLETION, streakDays: 1, health: 'healthy', awardedTaskIds: [taskId] });
      expect((await stored(owner)).tree).toMatchObject({ streakDays: 0, lastActiveDate: null });

      const retry = await complete(owner, taskId);
      expect(retry.status).toBe(200);
      expect(retry.body.task).toMatchObject({ _id: taskId, completed: true });
      expect(retry.body.growth).toMatchObject({ taskId, awarded: false, xpGained: 0, reason: 'already_awarded' });
      expect(retry.body.growth.treeState).toMatchObject({ xp: XP_PER_COMPLETION, streakDays: 1, health: 'healthy' });
      await expectConverged(owner, [taskId]);
    });

    it('the award itself fails: 500, nothing recorded and the task untouched; the retry awards exactly once', async () => {
      const owner = await makeAccount('owner');
      const [taskId] = await makeTasks(owner, 1);
      faults.failNext('award');

      const failed = await complete(owner, taskId);

      expect(faults.injected('award')).toBe(1);
      expectInjectedFailure500(failed, 'PUT with a failed award');
      expect((await taskDoc(taskId))?.completed).toBe(false);
      expect(await stored(owner)).toMatchObject({ xp: 0, ledger: [] });

      const retry = await complete(owner, taskId);
      expect(retry.status).toBe(200);
      expect(retry.body.task).toMatchObject({ _id: taskId, completed: true });
      expect(retry.body.growth).toMatchObject({ taskId, awarded: true, xpGained: XP_PER_COMPLETION });
      await expectConverged(owner, [taskId]);
    });

    it('award recorded but the task write fails: 500; the retry completes the task and pays nothing more', async () => {
      const owner = await makeAccount('owner');
      const [taskId] = await makeTasks(owner, 1);
      faults.failNext('taskUpdate');

      const failed = await complete(owner, taskId);

      expect(faults.injected('taskUpdate')).toBe(1);
      expectInjectedFailure500(failed, 'PUT with a failed task write');
      expect((await taskDoc(taskId))?.completed).toBe(false);
      const afterFailure = await stored(owner);
      expect(afterFailure.ledger).toEqual([taskId]); // a task never yields a second award: this one holds the first while incomplete
      expect(afterFailure.xp).toBe(XP_PER_COMPLETION);
      expect(needsReconcile(afterFailure.tree, new Date())).toBe(false); // the derived write did land

      const retry = await complete(owner, taskId);
      expect(retry.status).toBe(200);
      expect(retry.body.task).toMatchObject({ _id: taskId, completed: true });
      expect(retry.body.growth).toMatchObject({ taskId, awarded: false, xpGained: 0, reason: 'already_awarded' });
      await expectConverged(owner, [taskId]);
    });

    it('derived write fails, then the task write fails, then it works: still exactly one award', async () => {
      const owner = await makeAccount('owner');
      const [taskId] = await makeTasks(owner, 1);

      faults.failNext('derived');
      expectRetryable500(await complete(owner, taskId), 'first attempt');

      faults.failNext('taskUpdate');
      const second = await complete(owner, taskId);
      expect(faults.injected('taskUpdate')).toBe(1);
      // The second 500 is the injected task-write failure, not the derived one: generic body, and the error log holds
      // exactly two entries in order: the first request's derived_unpersisted, then the simulated task-write failure.
      expect(second.status, `second attempt: ${JSON.stringify(second.body)}`).toBe(500);
      expect(Object.keys(second.body), 'second attempt body').toEqual(['message']);
      const errors = unhandledErrors();
      expect(errors, 'logged errors of both attempts').toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(TreeAwardError);
      expect((errors[0] as TreeAwardError).kind).toBe('derived_unpersisted');
      expect(errors[1]).not.toBeInstanceOf(TreeAwardError);
      expect(String((errors[1] as Error).message)).toContain(SIMULATED_FAILURE_MESSAGE);
      expect((await stored(owner)).tree).toMatchObject({ streakDays: 1 }); // the second attempt already finished the derived write
      expect((await taskDoc(taskId))?.completed).toBe(false);

      const third = await complete(owner, taskId);
      expect(third.status).toBe(200);
      expect(third.body.task).toMatchObject({ _id: taskId, completed: true });
      await expectConverged(owner, [taskId]);
    });
  });

  describe('POST /api/tasks (a task created already completed)', () => {
    it('award recorded but derived write fails: 201, the task and its award are kept; the next completion repairs the copy, losing nothing', async () => {
      const owner = await makeAccount('owner');
      faults.failNext('derived');

      const res = await createCompleted(owner, 'done offline');

      expect(faults.injected('derived')).toBe(1);
      expectNextCommandAfter('users.derived!', 'users.read'); // the read-back, passed through to the real database
      expect(res.status).toBe(201);
      expect(res.body.task).toMatchObject({ title: 'done offline', completed: true, userId: owner.id });
      const taskId = String(res.body.task._id);
      expect(res.body.growth).toMatchObject({ taskId, awarded: true, xpGained: XP_PER_COMPLETION });
      expect(res.body.growth.treeState).toMatchObject({ xp: XP_PER_COMPLETION, streakDays: 1, health: 'healthy' }); // read back, with the day folded in
      expect(Object.keys(res.body.growth.treeState).sort()).toEqual(GROWTH_TREE_KEYS);
      expect(unhandledErrors()).toEqual([]); // handled inside the controller, never an error response

      expect(await taskCountOf(owner)).toBe(1); // kept, not deleted and not duplicated
      const afterFailure = await stored(owner);
      expect(afterFailure.ledger).toEqual([taskId]);
      expect(afterFailure.xp).toBe(XP_PER_COMPLETION);
      expect(afterFailure.tree.activeDays).toHaveLength(1);
      expect(afterFailure.tree).toMatchObject({ streakDays: 0, lastActiveDate: null });
      expect(needsReconcile(afterFailure.tree, new Date())).toBe(true);

      const next = await createCompleted(owner, 'the next one');
      expect(next.status).toBe(201);
      expect(next.body.growth).toMatchObject({ awarded: true, xpGained: XP_PER_COMPLETION });
      await expectConverged(owner, [taskId, String(next.body.task._id)]);
    });

    it('derived write AND read-back both fail: 201 without a growth block, the task and its award kept', async () => {
      const owner = await makeAccount('owner');
      faults.failNext('derived');
      faults.failNext('readback');

      const res = await createCompleted(owner, 'offline done');

      expect(faults.injected('derived')).toBe(1);
      expect(faults.injected('readback')).toBe(1);
      expectNextCommandAfter('users.derived!', 'users.read!'); // the failed read is the one directly after the failed write
      expect(res.status).toBe(201); // a retry must not create a second task, so this is not an error
      expect(res.body.task).toMatchObject({ title: 'offline done', completed: true });
      expect(res.body).not.toHaveProperty('growth');
      expect(unhandledErrors()).toEqual([]);

      const taskId = String(res.body.task._id);
      expect(await taskCountOf(owner)).toBe(1);
      const afterFailure = await stored(owner);
      expect(afterFailure.ledger).toEqual([taskId]);
      expect(afterFailure.xp).toBe(XP_PER_COMPLETION);

      const read = await request(app).get('/api/tree').set(auth(owner));
      expect(read.status).toBe(200);
      expect(read.body.treeState).toMatchObject({ xp: XP_PER_COMPLETION, streakDays: 1, awardedTaskIds: [taskId] });
    });

    it('the award fails: 500 and the just-created task is removed; a retry creates and rewards once', async () => {
      const owner = await makeAccount('owner');
      faults.failNext('award');

      const failed = await createCompleted(owner, 'x');

      expect(faults.injected('award')).toBe(1);
      expectInjectedFailure500(failed, 'POST with a failed award');
      expect(await taskCountOf(owner)).toBe(0); // no completed task left without its reward
      expect(await stored(owner)).toMatchObject({ xp: 0, ledger: [] });

      const retry = await createCompleted(owner, 'x');
      expect(retry.status).toBe(201);
      expect(retry.body.growth).toMatchObject({ taskId: retry.body.task._id, awarded: true, xpGained: XP_PER_COMPLETION });
      await expectConverged(owner, [String(retry.body.task._id)]);
    });

    // KNOWN GAP, characterised here, NOT endorsed: if the award cannot be recorded and the cleanup delete also fails, a
    // completed task without an award remains, and the client's retry creates a second task (docs/context.md accepts
    // this as "rare, visible in the log"). This test pins today's behaviour so a change is noticed; it must be inverted
    // (leftover rewarded or removed, no duplicate) when the remediation tracked in its own issue lands.
    it.todo('KNOWN GAP (own issue): a failed award plus a failed cleanup should not leave an unrewarded completed task or a duplicate on retry');

    it('KNOWN GAP (characterisation): the award fails AND the cleanup fails: 500, logged, a completed task stays unrewarded, the retry makes a second task', async () => {
      const owner = await makeAccount('owner');
      faults.failNext('award');
      faults.failNext('taskDelete');

      const failed = await createCompleted(owner, 'x');

      expect(faults.injected('award')).toBe(1);
      expect(faults.injected('taskDelete')).toBe(1);
      expectInjectedFailure500(failed, 'POST with a failed award and a failed cleanup');
      expect(logged.some((args) => typeof args[0] === 'string' && args[0].includes('could not be removed'))).toBe(true);

      // docs/context.md: "a completed task without an award then remains (accepted, rare, visible in the log)".
      const leftover = await tasksOf(owner);
      expect(leftover).toHaveLength(1);
      expect(leftover[0].completed).toBe(true);
      expect(await stored(owner)).toMatchObject({ xp: 0, ledger: [] });

      // The client's retry creates a NEW task and rewards that one; the leftover is not rewarded retroactively.
      const retry = await createCompleted(owner, 'x');
      expect(retry.status).toBe(201);
      const retryId = String(retry.body.task._id);
      expect(retryId).not.toBe(String(leftover[0]._id));
      const after = await stored(owner);
      expect(after.ledger).toEqual([retryId]);
      expect(after.xp).toBe(XP_PER_COMPLETION);
      expect(await taskCountOf(owner)).toBe(2);
    });
  });
});
