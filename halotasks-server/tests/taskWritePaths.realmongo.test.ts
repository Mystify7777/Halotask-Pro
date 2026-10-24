import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Task from '../src/models/Task.model';

// Issue #44 — the dueDate/dueTime rule on DIRECT model writes, against a REAL MongoDB (MongoMemoryServer). The
// DB-less tests/taskModel.writePaths.test.ts shows which command Mongoose sends; this file shows what MongoDB does with
// it: that a conditional write really matches nothing without a stored date, that a cascaded $unset really removes both
// fields in one atomic write, and that concurrent writers cannot leave a time behind. Everything is read back from the
// raw collection (no Mongoose casting). Needs a MongoDB binary, like the other *.realmongo tests; it is not skipped
// when one is unavailable.

type Raw = { _id: mongoose.Types.ObjectId; title: string; dueDate?: Date | null; dueTime?: string | null };
const userId = new mongoose.Types.ObjectId();
const DATE = new Date('2026-10-20T00:00:00.000Z');
let mongoServer: MongoMemoryServer;

const raw = async (id: unknown): Promise<Raw> => {
  const doc = await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  expect(doc, `task ${String(id)} should exist`).not.toBeNull();
  return doc as unknown as Raw;
};
const everything = async (): Promise<Raw[]> => (await Task.collection.find({}).toArray()) as unknown as Raw[];
/** The invariant, read from what MongoDB actually holds. */
const expectNoOrphanTime = (doc: Raw) => {
  if (doc.dueTime !== undefined && doc.dueTime !== null) expect(doc.dueDate, `${doc.title}: a stored dueTime needs a stored dueDate`).toBeInstanceOf(Date);
};
const seed = async (title: string, deadline: { dueDate?: Date; dueTime?: string } = {}) => (await Task.create({ userId, title, ...deadline })).id as string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});
beforeEach(async () => {
  await Task.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('real MongoDB: a lone dueTime is conditional on the stored dueDate', () => {
  it('updateOne / findOneAndUpdate / updateMany set the time on a task with a date, and match nothing on one without', async () => {
    const dated = await seed('dated', { dueDate: DATE });
    const undated = await seed('undated');

    expect((await Task.updateOne({ _id: undated }, { $set: { dueTime: '09:00' } })).matchedCount).toBe(0);
    expect(await Task.findOneAndUpdate({ _id: undated }, { $set: { dueTime: '09:00' } })).toBeNull();
    expect((await raw(undated)).dueTime).toBeUndefined();

    expect((await Task.updateOne({ _id: dated }, { $set: { dueTime: '09:00' } })).modifiedCount).toBe(1);
    expect((await raw(dated)).dueTime).toBe('09:00');
  });

  it('updateMany over a mixed set times only the dated tasks', async () => {
    await seed('a', { dueDate: DATE });
    await seed('b');
    await seed('c', { dueDate: DATE });

    const result = await Task.updateMany({}, { $set: { dueTime: '08:30' } });

    expect(result.matchedCount).toBe(2);
    const docs = await everything();
    expect(docs.find((d) => d.title === 'b')!.dueTime).toBeUndefined();
    expect(docs.filter((d) => d.dueTime === '08:30').map((d) => d.title).sort()).toEqual(['a', 'c']);
    docs.forEach(expectNoOrphanTime);
  });

  it('bulkWrite ops are conditional the same way', async () => {
    const dated = await seed('dated', { dueDate: DATE });
    const undated = await seed('undated');

    await Task.bulkWrite([
      { updateOne: { filter: { _id: dated }, update: { $set: { dueTime: '07:00' } } } },
      { updateOne: { filter: { _id: undated }, update: { $set: { dueTime: '07:00' } } } },
    ]);

    expect((await raw(dated)).dueTime).toBe('07:00');
    expect((await raw(undated)).dueTime).toBeUndefined();
  });
});

describe('real MongoDB: clearing the date clears the time, atomically', () => {
  it.each([
    ['$unset of the date', { $unset: { dueDate: 1 } }],
    ['$set of a null date', { $set: { dueDate: null } }],
  ])('%s through updateOne leaves neither field', async (_label, update) => {
    const id = await seed('t', { dueDate: DATE, dueTime: '09:00' });
    await Task.updateOne({ _id: id }, update);
    const doc = await raw(id);
    expect(doc.dueTime).toBeUndefined();
    expect(doc.dueDate ?? null).toBeNull();
  });

  it('through findOneAndUpdate and bulkWrite too, while unrelated fields are kept', async () => {
    const a = await seed('a', { dueDate: DATE, dueTime: '09:00' });
    const b = await seed('b', { dueDate: DATE, dueTime: '10:00' });
    await Task.findOneAndUpdate({ _id: a }, { $unset: { dueDate: 1 }, $set: { title: 'a2' } });
    await Task.bulkWrite([{ updateOne: { filter: { _id: b }, update: { $unset: { dueDate: 1 } } } }]);
    expect(await raw(a)).toMatchObject({ title: 'a2' });
    for (const id of [a, b]) {
      const doc = await raw(id);
      expect(doc.dueTime).toBeUndefined();
      expect(doc.dueDate ?? null).toBeNull();
    }
  });

  it('clearing ONLY the time keeps the date; an unrelated update keeps both', async () => {
    const id = await seed('t', { dueDate: DATE, dueTime: '09:00' });
    await Task.updateOne({ _id: id }, { $set: { title: 'renamed', completed: true } });
    expect(await raw(id)).toMatchObject({ title: 'renamed', dueDate: DATE, dueTime: '09:00' });
    await Task.updateOne({ _id: id }, { $unset: { dueTime: 1 } });
    const doc = await raw(id);
    expect(doc.dueDate).toEqual(DATE);
    expect(doc.dueTime).toBeUndefined();
  });

  it('saving a loaded task whose date was cleared stores neither field', async () => {
    const id = await seed('t', { dueDate: DATE, dueTime: '09:00' });
    const doc = (await Task.findById(id))!;
    doc.set('dueDate', undefined);
    await doc.save();
    const stored = await raw(id);
    expect(stored.dueTime).toBeUndefined();
    expect(stored.dueDate ?? null).toBeNull();
  });
});

describe('real MongoDB: refused writes change nothing', () => {
  it('a contradictory update, an upsert of a lone time, a replacement and an insertMany orphan are all refused and stored nowhere', async () => {
    const id = await seed('t', { dueDate: DATE, dueTime: '09:00' });
    const before = await raw(id);

    await expect(Task.updateOne({ _id: id }, { $set: { dueTime: '11:00' }, $unset: { dueDate: 1 } })).rejects.toThrow(/dueTime requires a dueDate/);
    await expect(Task.updateOne({ title: 'new' }, { $set: { userId, dueTime: '11:00' } }, { upsert: true })).rejects.toThrow(/dueTime requires a dueDate/);
    await expect(Task.replaceOne({ _id: id }, { userId, title: 'r', dueTime: '11:00' })).rejects.toThrow(/dueTime requires a dueDate/);
    await expect(Task.insertMany([{ userId, title: 'ok', dueDate: DATE }, { userId, title: 'orphan', dueTime: '11:00' }])).rejects.toThrow(/dueTime requires a dueDate/);

    expect(await raw(id)).toEqual(before);
    expect((await everything()).map((d) => d.title)).toEqual(['t']);
  });
});

describe('real MongoDB: concurrent direct writes cannot leave a time behind', () => {
  it('lone-time writers racing date-clearing writers: after every round the task holds no orphan time (and no write fails)', async () => {
    const rounds = 40;
    for (let round = 0; round < rounds; round += 1) {
      const id = await seed(`r${round}`, { dueDate: DATE });
      const clearers = [
        () => Task.updateOne({ _id: id }, { $unset: { dueDate: 1 } }),
        () => Task.updateOne({ _id: id }, { $set: { dueDate: null } }),
        () => Task.findOneAndUpdate({ _id: id }, { $unset: { dueDate: 1 } }),
      ];
      const timers = [
        () => Task.updateOne({ _id: id }, { $set: { dueTime: '09:00' } }),
        () => Task.findOneAndUpdate({ _id: id }, { $set: { dueTime: '10:00' } }),
        () => Task.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { dueTime: '11:00' } } } }]),
      ];
      const results = await Promise.allSettled([...timers, ...clearers, ...timers].map((run) => run()));
      expect(results.filter((r) => r.status === 'rejected'), `round ${round}`).toEqual([]);
      expectNoOrphanTime(await raw(id));
    }
  });

  it('whichever order a date change and a time change land in, the pair stays consistent', async () => {
    for (let round = 0; round < 30; round += 1) {
      const id = await seed(`s${round}`, { dueDate: DATE, dueTime: '08:00' });
      await Promise.all([
        Task.updateOne({ _id: id }, { $set: { dueDate: new Date('2026-11-01'), dueTime: '12:00' } }),
        Task.updateOne({ _id: id }, { $unset: { dueDate: 1 } }),
        Task.updateOne({ _id: id }, { $set: { dueTime: '13:00' } }),
      ]);
      expectNoOrphanTime(await raw(id));
    }
  });
});
