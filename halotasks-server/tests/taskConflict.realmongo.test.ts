import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Task from '../src/models/Task.model';
import { executeTaskSync, type SyncResult } from '../src/services/taskSync';

// Issue #62A — the HARD GATE for conflict detection: what only a REAL MongoDB can show.
//   1. EQUALITY: the conditional write (the observed value of every checked field in the filter) matches exactly when it should,
//      for strings, dates, absent fields, lists and subdocument lists (whatever their stored key order), and for documents that
//      lack a field the schema would default (legacy tasks). tests/taskConflict.writePaths.test.ts records the command Mongoose
//      sends; only this file proves what MongoDB does with it.
//   2. CONCURRENCY: of several requests that all expect the same value, exactly one applies and the rest conflict (or, when they
//      ask for the same value, none conflicts); different fields never collide; one mutation id raced against itself is applied once.
// If subtask equality turned out unreliable, subtasks would fall back to last-write-wins (Issue #62 D6): the subtask tests below
// are the ones that decide it. Needs a MongoDB binary, like the other *.realmongo tests; it is not skipped when one is unavailable.

const userId = new mongoose.Types.ObjectId().toHexString();
const uid = new mongoose.Types.ObjectId(userId);
let mongoServer: MongoMemoryServer;

type Raw = Record<string, unknown> & { appliedMutations?: Array<{ id: string; fp: string }> };
const raw = async (id: string): Promise<Raw> => (await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as unknown as Raw;
const run = async (mutations: unknown[]): Promise<Array<SyncResult & Record<string, any>>> => {
  const outcome = await executeTaskSync(userId, { mutations });
  expect(outcome.status).toBe(200);
  return (outcome.body as { results: Array<SyncResult & Record<string, any>> }).results;
};
const based = (mutationId: string, id: string, payload: Record<string, unknown>, base: Record<string, unknown>) => ({ mutationId, type: 'update', task: { id }, payload, base });
const one = async (m: ReturnType<typeof based>) => (await run([m]))[0];
const seed = async (fields: Record<string, unknown> = {}) => (await Task.create({ userId, title: 'Old', ...fields })).id as string;
/** A task written straight to the collection, so it can lack fields or hold keys in an order Mongoose would never write. */
const seedRaw = async (doc: Record<string, unknown>) => {
  const _id = new mongoose.Types.ObjectId();
  await Task.collection.insertOne({ _id, userId: uid, createdAt: new Date(), updatedAt: new Date(), ...doc });
  return String(_id);
};
const count = (results: SyncResult[], status: string) => results.filter((r) => r.status === status).length;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Task.init();
});
beforeEach(async () => {
  await Task.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('real MongoDB: equality of the conditional write', () => {
  it('strings: applies on equal, conflicts on different (including case and unicode)', async () => {
    const id = await seed({ title: 'Café ☕ Old' });
    expect((await one(based('m-str-000001', id, { title: 'Mine' }, { title: 'cafÉ ☕ old' }))).status).toBe('conflict');
    expect((await one(based('m-str-000002', id, { title: 'Mine' }, { title: 'Café ☕ Old' }))).status).toBe('applied');
    expect((await raw(id)).title).toBe('Mine');
  });

  it('dates: equal instants match whatever the written form; one millisecond off is a conflict; absent matches a missing field', async () => {
    const id = await seed({ dueDate: new Date('2026-11-01T00:00:00.123Z') });
    expect((await one(based('m-date-00001', id, { dueDate: '2026-12-01T00:00:00Z' }, { dueDate: '2026-11-01T00:00:00.124Z' }))).status).toBe('conflict');
    expect((await one(based('m-date-00002', id, { dueDate: '2026-12-01T00:00:00Z' }, { dueDate: '2026-11-01T05:30:00.123+05:30' }))).status).toBe('applied');
    expect((await raw(id)).dueDate).toEqual(new Date('2026-12-01T00:00:00Z'));

    const bare = await seed();
    expect((await one(based('m-date-00003', bare, { dueDate: '2026-12-01T00:00:00Z' }, { dueDate: null }))).status).toBe('applied');
    expect((await one(based('m-date-00004', bare, { dueDate: '2027-01-01T00:00:00Z' }, { dueDate: null }))).status).toBe('conflict');
  });

  it('clearing an optional field: expected value present -> applied and the field is gone; expected absent but present -> conflict', async () => {
    const id = await seed({ dueDate: new Date('2026-11-01T00:00:00Z'), dueTime: '09:00', startTime: new Date('2026-11-01T03:00:00Z') });
    expect((await one(based('m-clr-000001', id, { startTime: null }, { startTime: null }))).status).toBe('conflict');
    expect((await one(based('m-clr-000002', id, { startTime: null, dueTime: null }, { startTime: '2026-11-01T03:00:00Z', dueTime: '09:00' }))).status).toBe('applied');
    const stored = await raw(id);
    expect('startTime' in stored).toBe(false);
    expect('dueTime' in stored).toBe(false);
  });

  it('tags: exact list incl. order, length and an empty list', async () => {
    const id = await seed({ tags: ['a', 'b'] });
    expect((await one(based('m-tag-000001', id, { tags: ['x'] }, { tags: ['b', 'a'] }))).status).toBe('conflict'); // order
    expect((await one(based('m-tag-000002', id, { tags: ['x'] }, { tags: ['a'] }))).status).toBe('conflict'); // shorter
    expect((await one(based('m-tag-000003', id, { tags: ['x'] }, { tags: ['a', 'b', 'c'] }))).status).toBe('conflict'); // longer
    expect((await one(based('m-tag-000004', id, { tags: [] }, { tags: ['a', 'b'] }))).status).toBe('applied');
    expect((await one(based('m-tag-000005', id, { tags: ['y'] }, { tags: [] }))).status).toBe('applied'); // the stored list is now [], an empty list matches
    expect((await one(based('m-tag-000006', id, { tags: ['z'] }, { tags: [] }))).status).toBe('conflict'); // ...and ['y'] is not []
  });

  it('subtasks: id, title and completed each decide equality', async () => {
    const s = (sid: string, title: string, completed = false) => ({ id: sid, title, completed });
    const id = await seed({ subtasks: [s('s1', 'One'), s('s2', 'Two', true)] });
    const mine = [s('s9', 'Mine')];
    expect((await one(based('m-sub-000001', id, { subtasks: mine }, { subtasks: [s('s1', 'One'), s('s2', 'Two', false)] }))).status).toBe('conflict'); // flag
    expect((await one(based('m-sub-000002', id, { subtasks: mine }, { subtasks: [s('s1', 'One'), s('s2', 'TWO', true)] }))).status).toBe('conflict'); // title
    expect((await one(based('m-sub-000003', id, { subtasks: mine }, { subtasks: [s('s1', 'One'), s('sX', 'Two', true)] }))).status).toBe('conflict'); // id
    expect((await one(based('m-sub-000004', id, { subtasks: mine }, { subtasks: [s('s2', 'Two', true), s('s1', 'One')] }))).status).toBe('conflict'); // order
    expect((await one(based('m-sub-000005', id, { subtasks: mine }, { subtasks: [s('s1', 'One')] }))).status).toBe('conflict'); // length
    expect((await one(based('m-sub-000006', id, { subtasks: mine }, { subtasks: [s('s1', 'One'), s('s2', 'Two', true)] }))).status).toBe('applied');
    expect((await raw(id)).subtasks).toEqual([s('s9', 'Mine')]);
  });

  it('subtasks stored with a DIFFERENT key order still match (positional paths do not depend on it)', async () => {
    const id = await seedRaw({ title: 'Old', completed: false, subtasks: [{ completed: true, title: 'Two', id: 's2' }, { title: 'One', id: 's1', completed: false }] });
    const res = await one(based('m-ord-000001', id, { subtasks: [] }, { subtasks: [{ id: 's2', title: 'Two', completed: true }, { id: 's1', title: 'One', completed: false }] }));
    expect(res.status).toBe('applied');
    expect((await raw(id)).subtasks).toEqual([]);
  });

  it('a legacy task that lacks the fields the schema defaults still matches those defaults', async () => {
    const id = await seedRaw({ title: 'Old', completed: false }); // no description, priority, tags, subtasks, estimatedMinutes, reminderSent
    const res = await one(
      based('m-leg-000001', id, { description: 'd', priority: 'high', tags: ['t'], subtasks: [{ id: 's1', title: 'One', completed: false }], estimatedMinutes: 15, reminderSent: true }, { description: '', priority: 'medium', tags: [], subtasks: [], estimatedMinutes: 0, reminderSent: false }),
    );
    expect(res.status).toBe('applied');
    expect(await raw(id)).toMatchObject({ description: 'd', priority: 'high', tags: ['t'], estimatedMinutes: 15, reminderSent: true });
  });

  it('numbers and booleans', async () => {
    const id = await seed({ estimatedMinutes: 30, reminderSent: true });
    expect((await one(based('m-num-000001', id, { estimatedMinutes: 45 }, { estimatedMinutes: 31 }))).status).toBe('conflict');
    expect((await one(based('m-num-000002', id, { estimatedMinutes: 45, reminderSent: false }, { estimatedMinutes: 30, reminderSent: true }))).status).toBe('applied');
  });
});

describe('real MongoDB: the marker and conflicts', () => {
  it('a conflict leaves no marker and writes nothing (updatedAt unchanged); a replay of it is judged again', async () => {
    const id = await seed({ title: 'Theirs' });
    const before = await raw(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const m = based('m-cf-0000001', id, { title: 'Mine' }, { title: 'Old' });
    expect((await one(m)).status).toBe('conflict');
    expect((await one(m)).status).toBe('conflict');
    const after = await raw(id);
    expect(after.appliedMutations).toBeUndefined();
    expect((after.updatedAt as Date).getTime()).toBe((before.updatedAt as Date).getTime());
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { title: 'Old' } });
    expect((await one(m)).status).toBe('applied');
    expect((await one(m)).status).toBe('replayed');
  });

  it('$slice still keeps the last 25 markers for updates that carry base', async () => {
    const id = await seed({ title: 'T0' });
    for (let i = 0; i < 27; i += 1) {
      const res = await one(based(`m-win-${String(i).padStart(4, '0')}`, id, { title: `T${i + 1}` }, { title: `T${i}` }));
      expect(res.status).toBe('applied');
    }
    const ids = ((await raw(id)).appliedMutations ?? []).map((row) => row.id);
    expect(ids).toHaveLength(25);
    expect(ids[0]).toBe('m-win-0002');
    expect(ids[24]).toBe('m-win-0026');
  });
});

describe('real MongoDB: concurrency', () => {
  it('ten requests that all expect the same title and ask for different ones: exactly one applies, nine conflict, none is lost or doubled', async () => {
    const id = await seed({ title: 'Old' });
    const results = (await Promise.all(Array.from({ length: 10 }, (_, i) => run([based(`m-race-a-${String(i).padStart(4, '0')}`, id, { title: `Mine ${i}` }, { title: 'Old' })])))).flat();
    expect(count(results, 'applied')).toBe(1);
    expect(count(results, 'conflict')).toBe(9);
    const stored = await raw(id);
    expect(stored.appliedMutations).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 'applied');
    expect(stored.title).toBe(`Mine ${winner}`);
    // every loser is told what the winner wrote
    for (const loser of results.filter((r) => r.status === 'conflict')) expect(loser.conflicts[0]).toMatchObject({ field: 'title', base: 'Old', current: `Mine ${winner}` });
  });

  it('the same race on a list (tags) and on a subtask list', async () => {
    const tagId = await seed({ tags: ['a'] });
    const tagRes = (await Promise.all(Array.from({ length: 8 }, (_, i) => run([based(`m-race-t-${i}00000`, tagId, { tags: [`n${i}`] }, { tags: ['a'] })])))).flat();
    expect(count(tagRes, 'applied')).toBe(1);
    expect(count(tagRes, 'conflict')).toBe(7);

    const s = (sid: string) => ({ id: sid, title: sid, completed: false });
    const subId = await seed({ subtasks: [s('s1')] });
    const subRes = (await Promise.all(Array.from({ length: 8 }, (_, i) => run([based(`m-race-s-${i}00000`, subId, { subtasks: [s(`n${i}`)] }, { subtasks: [s('s1')] })])))).flat();
    expect(count(subRes, 'applied')).toBe(1);
    expect(count(subRes, 'conflict')).toBe(7);
  });

  it('requests that ask for the SAME value never conflict with each other (D5)', async () => {
    const id = await seed({ title: 'Old' });
    const results = (await Promise.all(Array.from({ length: 10 }, (_, i) => run([based(`m-race-s-${String(i).padStart(4, '0')}`, id, { title: 'Same' }, { title: 'Old' })])))).flat();
    expect(count(results, 'applied')).toBe(10);
    expect((await raw(id)).title).toBe('Same');
  });

  it('requests on DIFFERENT fields never collide: all apply and every field lands', async () => {
    const id = await seed({ title: 'Old', priority: 'low', estimatedMinutes: 0 });
    const results = (
      await Promise.all([
        run([based('m-race-f-0001', id, { title: 'New' }, { title: 'Old' })]),
        run([based('m-race-f-0002', id, { priority: 'high' }, { priority: 'low' })]),
        run([based('m-race-f-0003', id, { estimatedMinutes: 20 }, { estimatedMinutes: 0 })]),
        run([based('m-race-f-0004', id, { tags: ['x'] }, { tags: [] })]),
      ])
    ).flat();
    expect(count(results, 'applied')).toBe(4);
    expect(await raw(id)).toMatchObject({ title: 'New', priority: 'high', estimatedMinutes: 20, tags: ['x'] });
  });

  it('one mutation id raced against itself (with base): applied once, the rest are replays, none is a conflict', async () => {
    const id = await seed({ title: 'Old' });
    const results = (await Promise.all(Array.from({ length: 10 }, () => run([based('m-race-same-1', id, { title: 'Once' }, { title: 'Old' })])))).flat();
    expect(count(results, 'applied')).toBe(1);
    expect(count(results, 'replayed')).toBe(9);
    expect(count(results, 'conflict')).toBe(0);
    expect((await raw(id)).appliedMutations).toHaveLength(1);
  });

  it('an unbased update racing a based one stays last-write-wins for the unbased one; the based one applies or reports the conflict, and the title is one of the two written values', async () => {
    const id = await seed({ title: 'Old' });
    const [plain, checked] = (
      await Promise.all([run([{ mutationId: 'm-race-p-0001', type: 'update', task: { id }, payload: { title: 'Plain' } }]), run([based('m-race-p-0002', id, { title: 'Checked' }, { title: 'Old' })])])
    ).flat();
    expect(plain.status).toBe('applied');
    expect(['applied', 'conflict']).toContain(checked.status);
    const title = (await raw(id)).title;
    expect(checked.status === 'conflict' ? title === 'Plain' : title === 'Plain' || title === 'Checked').toBe(true);
  });
});
