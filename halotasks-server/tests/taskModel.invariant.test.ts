import mongoose from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

// Issue #10 model invariant: a dueTime needs a dueDate. These run Mongoose's REAL validation (document validation and
// update validators) without a database. With buffering off, a findOneAndUpdate that passes validation then fails with a
// "before initial connection" error, while one that fails validation rejects with a ValidationError first. So what is
// proven is Mongoose's validation behaviour, not what MongoDB stores; tests/taskTimes.realmongo.test.ts covers that.

mongoose.set('bufferCommands', false);

let Task: (typeof import('../src/models/Task.model'))['default'];
const userId = new mongoose.Types.ObjectId();
const base = { userId, title: 'x' };

beforeAll(async () => {
  Task = (await import('../src/models/Task.model.js')).default;
});

const update = (u: Record<string, unknown>) =>
  Task.findOneAndUpdate({ _id: new mongoose.Types.ObjectId() }, u, { runValidators: true, returnDocument: 'after' }).exec();

async function outcome(run: () => Promise<unknown>): Promise<'validation-error' | 'passed-validation'> {
  try {
    await run();
    return 'passed-validation';
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) return 'validation-error';
    expect(String((error as Error).message)).toMatch(/before initial connection|bufferCommands/i);
    return 'passed-validation';
  }
}

describe('document validation', () => {
  it('rejects a dueTime without a dueDate', async () => {
    await expect(new Task({ ...base, dueTime: '09:00' }).validate()).rejects.toThrow(/dueTime requires a dueDate/);
  });
  it('accepts a dueTime with a dueDate, a dueDate alone, and neither (legacy)', async () => {
    await expect(new Task({ ...base, dueDate: new Date('2026-10-20'), dueTime: '09:00' }).validate()).resolves.toBeUndefined();
    await expect(new Task({ ...base, dueDate: new Date('2026-10-20') }).validate()).resolves.toBeUndefined();
    await expect(new Task(base).validate()).resolves.toBeUndefined();
  });
  it('still rejects a malformed time', async () => {
    await expect(new Task({ ...base, dueDate: new Date('2026-10-20'), dueTime: '24:00' }).validate()).rejects.toThrow();
  });
});

describe('update validators (the existing explicit $set / $unset update shape)', () => {
  it('accepts the controller\'s shapes', async () => {
    expect(await outcome(() => update({ $set: { dueDate: new Date('2026-10-20'), dueTime: '09:00' } }))).toBe('passed-validation');
    expect(await outcome(() => update({ $set: { dueTime: '09:00' } }))).toBe('passed-validation'); // stored date: guarded by the controller
    expect(await outcome(() => update({ $set: { title: 'y' }, $unset: { dueDate: 1, dueTime: 1 } }))).toBe('passed-validation');
    expect(await outcome(() => update({ $unset: { dueTime: 1 } }))).toBe('passed-validation');
  });
  it('rejects an update that sets a time while removing or nulling the date', async () => {
    expect(await outcome(() => update({ $set: { dueTime: '09:00' }, $unset: { dueDate: 1 } }))).toBe('validation-error');
    expect(await outcome(() => update({ $set: { dueTime: '09:00', dueDate: null } }))).toBe('validation-error');
  });
});
