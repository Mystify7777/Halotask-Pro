import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Task from '../src/models/Task.model';
import { executeTaskSync, type SyncResult } from '../src/services/taskSync';

// Issue #60 — the parts of batched sync that only a REAL MongoDB can show: that two requests carrying the same mutation
// id cannot both apply it (the marker and the edit are one single-document write, guarded in its filter), that `$slice`
// really keeps the last 25 markers, that the partial unique index on (userId, clientKey) really stops a second task for one
// client key, and that a replay writes nothing. tests/taskSync.routes.test.ts covers the same behaviour against strict
// in-memory doubles; this file is what proves the doubles right. Needs a MongoDB binary, like the other *.realmongo tests; it
// is not skipped when one is unavailable. Everything is read back from the raw collection.

const userId = new mongoose.Types.ObjectId().toHexString();
let mongoServer: MongoMemoryServer;

type RawTask = { _id: mongoose.Types.ObjectId; title: string; clientKey?: string; updatedAt: Date; appliedMutations?: Array<{ id: string; fp: string }> };
const raw = async (id: string): Promise<RawTask> => (await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as unknown as RawTask;
const run = async (mutations: unknown[]): Promise<SyncResult[]> => {
  const outcome = await executeTaskSync(userId, { mutations });
  expect(outcome.status).toBe(200);
  return (outcome.body as { results: SyncResult[] }).results;
};
const update = (mutationId: string, id: string, payload: Record<string, unknown>) => ({ mutationId, type: 'update', task: { id }, payload });
const seed = async (title = 'Start') => (await Task.create({ userId, title })).id as string;
const count = (results: SyncResult[], status: string) => results.filter((r) => r.status === status).length;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Task.init(); // builds the indexes, including the partial unique (userId, clientKey)
});
beforeEach(async () => {
  await Task.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('real MongoDB: update mutations are idempotent', () => {
  it('ten concurrent requests with one mutation id apply it exactly once; the rest are replays', async () => {
    const id = await seed();
    const results = (await Promise.all(Array.from({ length: 10 }, () => run([update('m-concurrent-1', id, { title: 'Once' })])))).flat();
    expect(count(results, 'applied')).toBe(1);
    expect(count(results, 'replayed')).toBe(9);
    const stored = await raw(id);
    expect(stored.title).toBe('Once');
    expect(stored.appliedMutations).toHaveLength(1);
  });

  it('a replay writes nothing: the task is not touched (updatedAt unchanged)', async () => {
    const id = await seed();
    await run([update('m-replay-0001', id, { title: 'One' })]);
    const before = await raw(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [replay] = await run([update('m-replay-0001', id, { title: 'One' })]);
    expect(replay.status).toBe('replayed');
    expect((await raw(id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('a replay of an older mutation does not undo a newer one', async () => {
    const id = await seed();
    await run([update('m-first-00001', id, { title: 'One' })]);
    await run([update('m-second-0001', id, { title: 'Two' })]);
    expect((await run([update('m-first-00001', id, { title: 'One' })]))[0].status).toBe('replayed');
    expect((await raw(id)).title).toBe('Two');
  });

  it('the same id with a different change is refused and changes nothing', async () => {
    const id = await seed();
    await run([update('m-reused-0001', id, { title: 'One' })]);
    const [reused] = await run([update('m-reused-0001', id, { title: 'Other' })]);
    expect(reused).toMatchObject({ status: 'rejected', error: { code: 'MUTATION_ID_REUSED' } });
    expect((await raw(id)).title).toBe('One');
  });

  it('$slice keeps the last 25 markers (the oldest id is forgotten, the newest is still a replay)', async () => {
    const id = await seed();
    const list = Array.from({ length: 27 }, (_, i) => update(`m-window-${String(i).padStart(3, '0')}`, id, { title: `T${i}` }));
    await run(list);
    const stored = await raw(id);
    expect(stored.appliedMutations).toHaveLength(25);
    expect(stored.appliedMutations![0].id).toBe('m-window-002');
    expect((await run([list[26]]))[0].status).toBe('replayed');
    expect((await run([list[0]]))[0].status).toBe('applied');
  });

  it('the marker never comes back through Mongoose reads or JSON', async () => {
    const id = await seed();
    const [result] = await run([update('m-hidden-0001', id, { title: 'Hidden' })]);
    expect(JSON.stringify(result)).not.toContain('appliedMutations');
    expect(JSON.stringify(await Task.findOne({ _id: id }))).not.toContain('appliedMutations');
    expect(JSON.stringify(await Task.find({ userId }))).not.toContain('appliedMutations');
    expect((await raw(id)).appliedMutations).toHaveLength(1);
  });
});

describe('real MongoDB: creates are idempotent by client key', () => {
  it('has the partial unique index on (userId, clientKey)', async () => {
    const indexes = await Task.collection.indexes();
    const index = indexes.find((i) => i.key && (i.key as Record<string, number>).clientKey === 1);
    expect(index).toMatchObject({ unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
  });

  it('ten concurrent creates with one local id leave exactly one task; the rest are replays', async () => {
    const results = (await Promise.all(Array.from({ length: 10 }, (_, i) => run([{ mutationId: `m-create-${i}00000`, type: 'create', localId: 'local-one', payload: { title: 'One' } }])))).flat();
    expect(count(results, 'applied')).toBe(1);
    expect(count(results, 'replayed')).toBe(9);
    expect(await Task.collection.countDocuments({ clientKey: 'local-one' })).toBe(1);
  });

  it('tasks without a client key never collide with each other', async () => {
    await Task.create({ userId, title: 'a' });
    await Task.create({ userId, title: 'b' });
    expect(await Task.collection.countDocuments({ userId: new mongoose.Types.ObjectId(userId) })).toBe(2);
  });
});

describe('real MongoDB: ordering within one request', () => {
  it('create, update by local id, delete by local id run in order and leave nothing behind', async () => {
    const results = await run([
      { mutationId: 'm-chain-00001', type: 'create', localId: 'local-chain', payload: { title: 'Chain' } },
      { mutationId: 'm-chain-00002', type: 'update', task: { localId: 'local-chain' }, payload: { title: 'Chain 2' } },
      { mutationId: 'm-chain-00003', type: 'delete', task: { localId: 'local-chain' } },
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(await Task.collection.countDocuments({})).toBe(0);
  });
});
