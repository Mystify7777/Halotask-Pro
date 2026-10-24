import mongoose from 'mongoose';
import type TaskModel from '../src/models/Task.model';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Issue #44: the dueDate/dueTime rule is kept in the Task MODEL, so every Mongoose write path enforces it, not only the
// controller. These tests run the real Mongoose model and middleware and replace only the native driver collection
// methods, recording exactly what Mongoose would send to MongoDB. So they prove WHICH command is sent (the extra
// filter, the cascaded $unset) or that nothing is sent (the write is refused). They cannot prove what MongoDB does with
// the command: tests/taskWritePaths.realmongo.test.ts does that, and needs a MongoDB binary.

mongoose.set('bufferCommands', false);

type Collection = Record<string, (...args: unknown[]) => Promise<unknown>>;
let Task: typeof TaskModel;
let driver: Record<string, ReturnType<typeof vi.fn>>;

const userId = new mongoose.Types.ObjectId();
const id = () => new mongoose.Types.ObjectId();
const DATE = new Date('2026-10-20T00:00:00.000Z');
const STORED_DATE = { dueDate: { $exists: true, $ne: null } };

beforeAll(async () => {
  // (the dynamic import is typed as CommonJS here, so its `default` needs this cast)
  Task = ((await import('../src/models/Task.model.js')) as unknown as { default: typeof TaskModel }).default;
  const collection = Task.collection as unknown as Collection;
  driver = {};
  for (const method of ['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace', 'bulkWrite', 'insertMany', 'insertOne']) {
    driver[method] = vi.fn(async () =>
      method === 'findOneAndUpdate' || method === 'findOneAndReplace' ? null : method === 'insertOne' ? { acknowledged: true, insertedId: id() } : method === 'insertMany' ? { insertedCount: 0, insertedIds: {} } : { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 },
    );
    collection[method] = driver[method] as unknown as Collection[string];
  }
});
afterEach(() => Object.values(driver).forEach((fn) => fn.mockClear()));

const sent = (method: string) => ({ filter: driver[method].mock.calls[0]?.[0] as Record<string, unknown>, update: driver[method].mock.calls[0]?.[1] as Record<string, Record<string, unknown>> });
const nothingSent = () => Object.values(driver).forEach((fn) => expect(fn).not.toHaveBeenCalled());
const rejection = async (run: () => Promise<unknown> | unknown) => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the write to be refused');
};

describe('documents (create / save / insertMany)', () => {
  it('rejects a new task with a dueTime and no dueDate; accepts date+time, date only, and neither', async () => {
    const base = { userId, title: 'x' };
    expect(await rejection(() => new Task({ ...base, dueTime: '09:00' }).validate())).toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(new Task({ ...base, dueDate: DATE, dueTime: '09:00' }).validate()).resolves.toBeUndefined();
    await expect(new Task({ ...base, dueDate: DATE }).validate()).resolves.toBeUndefined();
    await expect(new Task(base).validate()).resolves.toBeUndefined();
  });

  it('clearing the dueDate of a LOADED task clears its dueTime with it (Mongoose would not re-validate the untouched time)', async () => {
    for (const cleared of [undefined, null]) {
      const doc = Task.hydrate({ _id: id(), userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
      doc.set('dueDate', cleared);
      await doc.validate();
      expect(doc.dueTime).toBeUndefined();
      expect(doc.$getChanges()).toMatchObject({ $unset: { dueTime: 1 } });
    }
  });

  it('rejects setting a dueTime on a loaded task that has no dueDate; keeps a date-plus-time task saveable', async () => {
    const noDate = Task.hydrate({ _id: id(), userId, title: 'x' });
    noDate.set('dueTime', '09:00');
    expect(await rejection(() => noDate.validate())).toBeInstanceOf(mongoose.Error.ValidationError);

    const timed = Task.hydrate({ _id: id(), userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
    timed.set('title', 'renamed');
    await timed.validate();
    expect(timed.dueTime).toBe('09:00');
    expect(timed.dueDate).toEqual(DATE);
  });

  it('a LOADED task that already holds an orphan time cannot be saved at all (every save checks the rule)', async () => {
    const orphan = Task.hydrate({ _id: id(), userId, title: 'x', dueTime: '09:00' }); // as if written around the model
    orphan.set('title', 'renamed');
    expect(await rejection(() => orphan.validate())).toBeInstanceOf(mongoose.Error.ValidationError);
    // Mongoose's own field validator is skipped for an unmodified path when validation is limited to modified paths;
    // the model's rule must hold there too.
    expect(await rejection(() => orphan.validate(undefined, { validateModifiedOnly: true }))).toBeInstanceOf(mongoose.Error.ValidationError);
  });

  it('clearing the date of a loaded task clears the time even when validation is limited to modified paths', async () => {
    const doc = Task.hydrate({ _id: id(), userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
    doc.set('dueDate', undefined);
    await doc.validate(undefined, { validateModifiedOnly: true });
    expect(doc.dueTime).toBeUndefined();
  });

  it('insertMany refuses a batch containing an orphan time, and sends nothing', async () => {
    const error = await rejection(() => Task.insertMany([{ userId, title: 'ok', dueDate: DATE, dueTime: '09:00' }, { userId, title: 'orphan', dueTime: '09:00' }]));
    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  });
});

describe.each(['findOneAndUpdate', 'updateOne', 'updateMany'] as const)('Task.%s (direct model write, validators NOT requested)', (method) => {
  const run = (update: unknown, options: Record<string, unknown> = {}) =>
    (Task[method] as unknown as (f: object, u: unknown, o: object) => Promise<unknown>)({ title: 'x' }, update, options);

  it('a lone dueTime is made conditional on the stored dueDate (matches nothing if there is none)', async () => {
    await run({ $set: { dueTime: '09:00' } });
    expect(sent(method).filter).toEqual({ title: 'x', $and: [STORED_DATE] });
    expect(sent(method).update.$set).toMatchObject({ dueTime: '09:00' });
  });

  it('the top-level (non-$set) shape is guarded the same way', async () => {
    await run({ dueTime: '09:00' });
    expect(sent(method).filter).toEqual({ title: 'x', $and: [STORED_DATE] });
  });

  it('date and time together need no condition (the update itself carries the date)', async () => {
    await run({ $set: { dueDate: DATE, dueTime: '09:00' } });
    expect(sent(method).filter).toEqual({ title: 'x' });
  });

  it.each([
    ['$unset of the date', { $unset: { dueDate: 1 } }],
    ['$set of a null date', { $set: { dueDate: null } }],
    ['a top-level null date', { dueDate: null }],
  ])('%s also clears the time, in the same atomic write', async (_label, update) => {
    await run(update);
    expect(sent(method).update.$unset).toMatchObject({ dueTime: 1 });
    expect(sent(method).filter).toEqual({ title: 'x' });
  });

  it('a cleared date next to a null time folds into one $unset (no conflicting paths)', async () => {
    await run({ $set: { dueDate: null, dueTime: null, title: 'y' } });
    const update = sent(method).update;
    expect(update.$unset).toMatchObject({ dueTime: 1 });
    expect(update.$set).not.toHaveProperty('dueTime');
    expect(update.$set).toMatchObject({ title: 'y' });
  });

  it('clearing ONLY the time keeps the date, and the write is unconditional', async () => {
    await run({ $unset: { dueTime: 1 } });
    expect(sent(method).update.$unset).toEqual({ dueTime: 1 });
    expect(sent(method).filter).toEqual({ title: 'x' });
    driver[method].mockClear();
    await run({ $set: { dueTime: null } });
    expect(sent(method).update.$set).toMatchObject({ dueTime: null });
    expect(sent(method).filter).toEqual({ title: 'x' });
  });

  it('an update that does not touch the deadline fields is sent unchanged', async () => {
    await run({ $set: { title: 'y', completed: true } });
    expect(sent(method).update.$set).toMatchObject({ title: 'y', completed: true });
    expect(sent(method).update).not.toHaveProperty('$unset'); // (Mongoose's own timestamps are the only additions)
    expect(sent(method).filter).toEqual({ title: 'x' });
  });

  it.each([
    ['sets a time while removing the date', { $set: { dueTime: '09:00' }, $unset: { dueDate: 1 } }],
    ['sets a time while nulling the date', { $set: { dueTime: '09:00', dueDate: null } }],
  ])('refuses an update that %s, and sends nothing', async (_label, update) => {
    expect(await rejection(() => run(update))).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  });

  it('refuses an upsert that would insert a time with no date', async () => {
    expect(await rejection(() => run({ $set: { dueTime: '09:00' } }, { upsert: true }))).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  });

  it.each([
    ['an aggregation-pipeline update (Mongoose only allows it with updatePipeline)', [{ $set: { dueTime: '09:00' } }]],
    ['$setOnInsert on the time', { $setOnInsert: { dueTime: '09:00' } }],
    ['$rename onto the time', { $rename: { legacyTime: 'dueTime' } }],
    ['$rename away from the date', { $rename: { dueDate: 'legacyDate' } }],
    ['$min on the date', { $min: { dueDate: DATE } }],
  ])('refuses %s, which the rule cannot be enforced on, and sends nothing', async (_label, update) => {
    expect(await rejection(() => run(update, { updatePipeline: true }))).toBeInstanceOf(Error);
    nothingSent();
  });
});

describe('replacements', () => {
  it.each(['replaceOne', 'findOneAndReplace'] as const)('Task.%s refuses a replacement with a time and no date, and passes one with both', async (method) => {
    const call = (replacement: object) => (Task[method] as unknown as (f: object, r: object) => Promise<unknown>)({ title: 'x' }, replacement);
    expect(await rejection(() => call({ userId, title: 'x', dueTime: '09:00' }))).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
    await call({ userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
    expect(driver[method]).toHaveBeenCalledTimes(1);
  });
});

describe('Task.bulkWrite', () => {
  const ops = (...operations: object[]) => Task.bulkWrite(operations as never);
  const command = () => driver.bulkWrite.mock.calls[0][0] as Record<string, Record<string, unknown>>[];

  it('a lone dueTime in an updateOne / updateMany op is conditional on the stored date', async () => {
    await ops(
      { updateOne: { filter: { title: 'a' }, update: { $set: { dueTime: '09:00' } } } },
      { updateMany: { filter: { title: 'b' }, update: { $set: { dueTime: '10:00' } } } },
    );
    expect(command().map((op) => Object.values(op)[0].filter)).toEqual([
      { $and: [{ title: 'a' }, STORED_DATE] },
      { $and: [{ title: 'b' }, STORED_DATE] },
    ]);
  });

  it('clearing the date in an op clears the time too; date-less updates and time clears pass through', async () => {
    await ops(
      { updateOne: { filter: { title: 'a' }, update: { $unset: { dueDate: 1 } } } },
      { updateOne: { filter: { title: 'b' }, update: { $set: { title: 'y' } } } },
      { updateOne: { filter: { title: 'c' }, update: { $unset: { dueTime: 1 } } } },
    );
    const [cleared, unrelated, timeOnly] = command().map((op) => Object.values(op)[0]);
    expect((cleared.update as Record<string, unknown>).$unset).toMatchObject({ dueDate: 1, dueTime: 1 });
    expect(unrelated.filter).toEqual({ title: 'b' });
    expect(timeOnly.filter).toEqual({ title: 'c' });
  });

  it.each([
    ['a contradictory update', { updateOne: { filter: {}, update: { $set: { dueTime: '09:00' }, $unset: { dueDate: 1 } } } }],
    ['an upsert of a lone time', { updateOne: { filter: {}, update: { $set: { dueTime: '09:00' } }, upsert: true } }],
    ['a replacement with an orphan time', { replaceOne: { filter: {}, replacement: { userId, title: 'x', dueTime: '09:00' } } }],
    ['an insert with an orphan time', { insertOne: { document: { userId, title: 'x', dueTime: '09:00' } } }],
  ])('refuses %s, and sends nothing', async (_label, operation) => {
    expect(await rejection(() => ops({ updateOne: { filter: {}, update: { $set: { title: 'fine' } } } }, operation))).toBeInstanceOf(Error);
    nothingSent();
  });

  it('accepts an insert with date and time', async () => {
    await ops({ insertOne: { document: { userId, title: 'x', dueDate: DATE, dueTime: '09:00' } } });
    expect(driver.bulkWrite).toHaveBeenCalledTimes(1);
  });
});

// The rule must hold when Mongoose's OWN validation is switched off, which is what these options do. A test that only
// passes because default validation catches the write proves nothing about the model guard, so each case below uses the
// option that disables it and the DB-less driver shows nothing was sent.
describe('validation switched off', () => {
  const orphan = () => ({ userId, title: 'Orphan deadline', dueTime: '09:00' });
  const dated = () => ({ userId, title: 'ok', dueDate: DATE, dueTime: '09:00' });
  const refused = async (run: () => Promise<unknown>) => {
    expect(await rejection(run)).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  };

  describe('bulkWrite({ skipValidation: true })', () => {
    const skip = { skipValidation: true };

    it('refuses an insertOne with an orphan time, and sends nothing', async () => {
      await refused(() => Task.bulkWrite([{ insertOne: { document: orphan() } }] as never, skip));
    });
    it('refuses it when it is not the first operation, and when the date is not a date', async () => {
      await refused(() => Task.bulkWrite([{ insertOne: { document: dated() } }, { insertOne: { document: orphan() } }] as never, skip));
      await refused(() => Task.bulkWrite([{ insertOne: { document: { ...orphan(), dueDate: 'banana' } } }] as never, skip));
      await refused(() => Task.bulkWrite([{ insertOne: { document: { ...orphan(), dueDate: null } } }] as never, skip));
    });
    it('refuses a replaceOne with an orphan time', async () => {
      await refused(() => Task.bulkWrite([{ replaceOne: { filter: {}, replacement: orphan() } }] as never, skip));
    });
    it('still makes a lone time conditional on the stored date in update ops', async () => {
      await Task.bulkWrite([{ updateOne: { filter: { title: 'a' }, update: { $set: { dueTime: '09:00' } } } }] as never, skip);
      expect((driver.bulkWrite.mock.calls[0][0] as { updateOne: { filter: unknown } }[])[0].updateOne.filter).toEqual({ $and: [{ title: 'a' }, STORED_DATE] });
    });
    it('still refuses a contradictory update op', async () => {
      await refused(() => Task.bulkWrite([{ updateOne: { filter: {}, update: { $set: { dueTime: '09:00' }, $unset: { dueDate: 1 } } } }] as never, skip));
    });
    it('lets valid inserts through', async () => {
      await Task.bulkWrite([{ insertOne: { document: dated() } }, { insertOne: { document: { userId, title: 'no deadline' } } }, { insertOne: { document: { userId, title: 'date only', dueDate: DATE } } }] as never, skip);
      expect(driver.bulkWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('insertMany({ lean: true })', () => {
    const lean = { lean: true };

    it('refuses an orphan time, alone, in a batch, unordered, and as a single object', async () => {
      await refused(() => Task.insertMany([orphan()], lean));
      await refused(() => Task.insertMany([dated(), orphan()], lean));
      await refused(() => Task.insertMany([dated(), orphan()], { lean: true, ordered: false }));
      await refused(() => Task.insertMany(orphan() as never, lean));
    });
    it('refuses a time next to a value that is not a date', async () => {
      await refused(() => Task.insertMany([{ ...orphan(), dueDate: 'banana' }], lean));
      await refused(() => Task.insertMany([{ ...orphan(), dueDate: new Date('nope') }], lean));
    });
    it('lets valid raw documents through, untouched (no deadline, date only, date and time)', async () => {
      await Task.insertMany([{ userId, title: 'a' }, { userId, title: 'b', dueDate: DATE }, dated()], lean);
      expect(driver.insertMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('Model.bulkSave', () => {
    it.each([{}, { validateBeforeSave: false }, { skipValidation: true } as never])('refuses a NEW document with an orphan time (%j)', async (options) => {
      await refused(() => Task.bulkSave([new Task(orphan())], options));
    });
    it.each([{}, { validateBeforeSave: false }, { skipValidation: true } as never])('refuses a loaded document given a time while it has no date (%j)', async (options) => {
      const doc = Task.hydrate({ _id: id(), userId, title: 'x' });
      doc.set('dueTime', '09:00');
      await refused(() => Task.bulkSave([doc], options));
    });
    it.each([{}, { validateBeforeSave: false }, { skipValidation: true } as never])('clearing the date of a loaded document clears the time in the bulk update (%j)', async (options) => {
      const doc = Task.hydrate({ _id: id(), userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
      doc.set('dueDate', undefined);
      await Task.bulkSave([doc], options).catch(() => undefined); // the stubbed driver's reply is not what is under test
      const [operation] = driver.bulkWrite.mock.calls[0][0] as { updateOne: { update: { $unset: Record<string, unknown> } } }[];
      expect(operation.updateOne.update.$unset).toMatchObject({ dueDate: 1, dueTime: 1 });
    });
  });

  describe('validateBeforeSave: false', () => {
    const off = { validateBeforeSave: false };

    it('save() refuses a new task with an orphan time', async () => {
      await refused(() => new Task(orphan()).save(off));
    });
    it('Task.create / Task.insertOne refuse it too', async () => {
      await refused(() => Task.create([orphan()], off));
      await refused(() => Task.insertOne(orphan() as never, off as never));
    });
    it('save() refuses a loaded task given a time without a date', async () => {
      const doc = Task.hydrate({ _id: id(), userId, title: 'x' });
      doc.set('dueTime', '09:00');
      await refused(() => doc.save(off));
    });
    it('save() on a loaded task whose date was cleared sends the time away with it', async () => {
      const doc = Task.hydrate({ _id: id(), userId, title: 'x', dueDate: DATE, dueTime: '09:00' });
      doc.set('dueDate', undefined);
      await doc.save(off).catch(() => undefined);
      const { update } = sent('updateOne');
      expect(update.$unset).toMatchObject({ dueDate: 1, dueTime: 1 });
    });
    it('a valid save still goes through', async () => {
      await new Task(dated()).save(off);
      expect(driver.insertOne).toHaveBeenCalledTimes(1);
    });
  });
});
