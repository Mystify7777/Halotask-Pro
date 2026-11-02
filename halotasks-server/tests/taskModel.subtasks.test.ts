import mongoose from 'mongoose';
import type TaskModel from '../src/models/Task.model';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_SUBTASKS, TITLE_MAX_LENGTH } from '../src/utils/taskValidators';

// Issue #15: the Task MODEL is the second line of defence for subtasks (the API validates strictly in
// utils/taskValidators.ts parseSubtasks). These tests run the real Mongoose model and replace only the native driver
// collection methods, recording what Mongoose would send to MongoDB. They prove which command is sent and that a bad
// value is refused BEFORE anything is sent. They cannot prove what MongoDB does with a command:
// tests/taskSubtasks.realmongo.test.ts does that, and needs a MongoDB binary.

mongoose.set('bufferCommands', false);

type Collection = Record<string, (...args: unknown[]) => Promise<unknown>>;
let Task: typeof TaskModel;
let driver: Record<string, ReturnType<typeof vi.fn>>;

const userId = new mongoose.Types.ObjectId();
const id = () => new mongoose.Types.ObjectId();
const sub = (n: number | string, extra: Record<string, unknown> = {}) => ({ id: `s${n}`, title: `step ${n}`, completed: false, ...extra });
const many = (count: number) => Array.from({ length: count }, (_, i) => sub(i));

beforeAll(async () => {
  Task = ((await import('../src/models/Task.model.js')) as unknown as { default: typeof TaskModel }).default;
  const collection = Task.collection as unknown as Collection;
  driver = {};
  for (const method of ['insertOne', 'findOneAndUpdate', 'updateOne']) {
    driver[method] = vi.fn(async () =>
      method === 'findOneAndUpdate' ? null : method === 'insertOne' ? { acknowledged: true, insertedId: id() } : { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    );
    collection[method] = driver[method] as unknown as Collection[string];
  }
});
afterEach(() => Object.values(driver).forEach((fn) => fn.mockClear()));

const nothingSent = () => Object.values(driver).forEach((fn) => expect(fn).not.toHaveBeenCalled());
const rejection = async (run: () => Promise<unknown> | unknown) => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the write to be refused');
};
// Mongoose casts the update into embedded documents; the driver serialises them (toBSON) to plain objects, so the
// serialised form is what MongoDB receives and what is compared here.
const sentUpdate = () => JSON.parse(JSON.stringify(driver.findOneAndUpdate.mock.calls[0]?.[1])) as Record<string, Record<string, unknown>>;
const update = (change: Record<string, unknown>) =>
  Task.findOneAndUpdate({ _id: id(), userId }, change, { returnDocument: 'after', runValidators: true });

describe('the document', () => {
  it('a new task has an empty checklist by default', () => {
    expect(new Task({ userId, title: 't' }).subtasks).toHaveLength(0);
  });

  it('a task stored before the field existed (no subtasks key) reads as an empty checklist', () => {
    const legacy = Task.hydrate({ _id: id(), userId, title: 'old task' });
    expect(Array.isArray(legacy.subtasks)).toBe(true);
    expect(legacy.subtasks).toHaveLength(0);
  });

  it('keeps id, title and completed, adds no _id of its own, and trims the title', () => {
    const doc = new Task({ userId, title: 't', subtasks: [{ id: 'a', title: '  Pack bag ', completed: true }] });
    expect(doc.toObject().subtasks).toEqual([{ id: 'a', title: 'Pack bag', completed: true }]);
  });

  it(`accepts ${MAX_SUBTASKS} subtasks and refuses ${MAX_SUBTASKS + 1}`, async () => {
    await new Task({ userId, title: 't', subtasks: many(MAX_SUBTASKS) }).validate();
    const error = await rejection(() => new Task({ userId, title: 't', subtasks: many(MAX_SUBTASKS + 1) }).validate());
    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(error.message).toMatch(/subtasks cannot have more than 20 entries/);
  });

  it.each([
    ['a missing id', { title: 't', completed: false }],
    ['an id with a space', { id: 'a b', title: 't', completed: false }],
    ['an id longer than 64', { id: 'a'.repeat(65), title: 't', completed: false }],
    ['a missing title', { id: 'a', completed: false }],
    ['a whitespace-only title', { id: 'a', title: '   ', completed: false }],
    [`a title over ${TITLE_MAX_LENGTH}`, { id: 'a', title: 'x'.repeat(TITLE_MAX_LENGTH + 1), completed: false }],
  ])('refuses %s', async (_label, entry) => {
    const error = await rejection(() => new Task({ userId, title: 't', subtasks: [entry] }).validate());
    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
  });

  it('a task with a checklist is stored with it, as plain id/title/completed objects', async () => {
    await Task.create({ userId, title: 't', subtasks: [sub(1), sub(2, { completed: true })] });
    const stored = driver.insertOne.mock.calls[0][0] as { subtasks: unknown[] };
    expect(stored.subtasks).toEqual([
      { id: 's1', title: 'step 1', completed: false },
      { id: 's2', title: 'step 2', completed: true },
    ]);
  });
});

describe('Task.findOneAndUpdate with validators on (the controller\'s call)', () => {
  it('replaces the whole checklist in one $set, with plain subtask objects', async () => {
    await update({ $set: { subtasks: [sub(1, { completed: true }), sub(2)] } });
    expect(sentUpdate().$set.subtasks).toEqual([
      { id: 's1', title: 'step 1', completed: true },
      { id: 's2', title: 'step 2', completed: false },
    ]);
  });

  it('clearing sends an empty list as a $set (not an $unset), so a cleared task reads as []', async () => {
    await update({ $set: { subtasks: [] } });
    expect(sentUpdate().$set.subtasks).toEqual([]);
    expect(sentUpdate().$unset).toBeUndefined();
  });

  it('an update that does not mention subtasks sends no subtasks key (an older client cannot clear the list)', async () => {
    await update({ $set: { title: 'renamed', completed: true } });
    expect(JSON.stringify(sentUpdate())).not.toContain('subtasks');
  });

  it(`refuses ${MAX_SUBTASKS + 1} subtasks and sends nothing`, async () => {
    const error = await rejection(() => update({ $set: { subtasks: many(MAX_SUBTASKS + 1) } }));
    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  });

  it.each([
    ['an invalid id', [{ id: 'bad id', title: 't', completed: false }]],
    ['an empty title', [{ id: 'a', title: '', completed: false }]],
    ['a title that is too long', [{ id: 'a', title: 'x'.repeat(TITLE_MAX_LENGTH + 1), completed: false }]],
    ['a missing id', [{ title: 't', completed: false }]],
  ])('refuses %s and sends nothing', async (_label, subtasks) => {
    const error = await rejection(() => update({ $set: { subtasks } }));
    expect(error).toBeInstanceOf(mongoose.Error.ValidationError);
    nothingSent();
  });

  it('a checklist change does not disturb the due-date/due-time guard: it adds no condition to the filter', async () => {
    await update({ $set: { subtasks: [sub(1)] } });
    const filter = driver.findOneAndUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).not.toHaveProperty('dueDate');
    expect(filter).not.toHaveProperty('$and');
  });
});
