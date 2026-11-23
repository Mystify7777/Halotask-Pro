import mongoose from 'mongoose';
import type TaskModel from '../src/models/Task.model';
import type { updateTaskService as UpdateService } from '../src/services/taskMutations';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Issue #62A — the conditional write of an update that carries `base`, as the REAL Mongoose model sends it to the driver. The
// native collection methods are replaced and record the command, so this proves WHICH filter reaches MongoDB (what Mongoose
// casts, keeps and drops), not what MongoDB does with it: tests/taskConflict.realmongo.test.ts does that and needs a MongoDB binary.

mongoose.set('bufferCommands', false);

type Collection = Record<string, (...args: unknown[]) => Promise<unknown>>;
let Task: typeof TaskModel;
let update: typeof UpdateService;
let stored: Record<string, unknown>;
let findOneAndUpdate: ReturnType<typeof vi.fn>;
let findOne: ReturnType<typeof vi.fn>;

const userId = String(new mongoose.Types.ObjectId());
const taskId = String(new mongoose.Types.ObjectId());
const DATE = new Date('2026-10-20T00:00:00.000Z');

beforeAll(async () => {
  Task = ((await import('../src/models/Task.model.js')) as unknown as { default: typeof TaskModel }).default;
  update = ((await import('../src/services/taskMutations.js')) as unknown as { updateTaskService: typeof UpdateService }).updateTaskService;
  const collection = Task.collection as unknown as Collection;
  findOne = vi.fn(async () => ({ ...stored }));
  findOneAndUpdate = vi.fn(async () => ({ ...stored }));
  collection.findOne = findOne as unknown as Collection[string];
  collection.findOneAndUpdate = findOneAndUpdate as unknown as Collection[string];
});
afterEach(() => {
  findOne.mockClear();
  findOneAndUpdate.mockClear();
});

const seed = (over: Record<string, unknown> = {}) => {
  stored = { _id: new mongoose.Types.ObjectId(taskId), userId: new mongoose.Types.ObjectId(userId), title: 'Old', description: '', priority: 'medium', completed: false, tags: [], subtasks: [], estimatedMinutes: 0, reminderSent: false, ...over };
};
const run = (body: Record<string, unknown>, base?: Record<string, unknown>) =>
  update(userId, taskId, body, { mutation: { id: 'm-1234567', fp: 'f' }, ...(base ? { base } : {}) });
const filterSent = () => findOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown> & { $and?: Array<Record<string, unknown>> };

describe('the filter of an update with base', () => {
  it('an update WITHOUT base sends no $and (every mutation without base is unchanged)', async () => {
    seed();
    await run({ title: 'New' });
    expect(filterSent().$and).toBeUndefined();
  });

  it('pins a string field to the value just observed', async () => {
    seed({ title: 'Old' });
    const res = await run({ title: 'New' }, { title: 'Old' });
    expect(res.status).toBe(200);
    expect(filterSent().$and).toEqual([{ title: 'Old' }]);
  });

  it('a field that holds the REQUESTED value (not the base) is pinned to what it holds: the check is on what was observed', async () => {
    seed({ title: 'New' });
    await run({ title: 'New' }, { title: 'Old' });
    expect(filterSent().$and).toEqual([{ title: 'New' }]);
  });

  it('absent optional fields are pinned with null (which matches a missing field); a present date is kept as a Date', async () => {
    seed({});
    await run({ dueDate: DATE.toISOString(), startTime: '2026-10-20T09:30:00Z' }, { dueDate: null, startTime: null });
    expect(filterSent().$and).toEqual([{ dueDate: null }, { startTime: null }]);

    findOneAndUpdate.mockClear();
    seed({ dueDate: DATE });
    await run({ dueDate: '2026-11-01T00:00:00.000Z' }, { dueDate: DATE.toISOString() });
    const clause = (filterSent().$and as Array<Record<string, unknown>>)[0];
    expect(clause.dueDate).toBeInstanceOf(Date);
    expect((clause.dueDate as Date).toISOString()).toBe(DATE.toISOString());
  });

  it('pins a list by its length and by each element at its position (never a whole-array or whole-subdocument match)', async () => {
    seed({ tags: ['a', 'b'], subtasks: [{ id: 's1', title: 'One', completed: false }, { id: 's2', title: 'Two', completed: true }] });
    await run({ tags: ['z'], subtasks: [] }, { tags: ['a', 'b'], subtasks: [{ id: 's1', title: 'One', completed: false }, { id: 's2', title: 'Two', completed: true }] });
    expect(filterSent().$and).toEqual([
      { tags: { $size: 2 }, 'tags.0': 'a', 'tags.1': 'b' },
      {
        subtasks: { $size: 2 },
        'subtasks.0.id': 's1',
        'subtasks.0.title': 'One',
        'subtasks.0.completed': false,
        'subtasks.1.id': 's2',
        'subtasks.1.title': 'Two',
        'subtasks.1.completed': true,
      },
    ]);
  });

  it('an empty list also matches a database document that does not have the field (a legacy task)', async () => {
    seed({ tags: [], subtasks: [] });
    await run({ tags: ['x'], subtasks: [{ id: 's1', title: 'One', completed: false }] }, { tags: [], subtasks: [] });
    expect(filterSent().$and).toEqual([
      { $or: [{ tags: { $size: 0 } }, { tags: null }] },
      { $or: [{ subtasks: { $size: 0 } }, { subtasks: null }] },
    ]);
  });

  it('a field at its schema default also matches a database document that never stored it', async () => {
    seed({});
    await run({ description: 'x', priority: 'high', estimatedMinutes: 5, reminderSent: true }, { description: '', priority: 'medium', estimatedMinutes: 0, reminderSent: false });
    expect(filterSent().$and).toEqual([
      { $or: [{ description: '' }, { description: null }] },
      { $or: [{ priority: 'medium' }, { priority: null }] },
      { $or: [{ estimatedMinutes: 0 }, { estimatedMinutes: null }] },
      { $or: [{ reminderSent: false }, { reminderSent: null }] },
    ]);
  });

  it('only the fields named in base are pinned: the others stay last-write-wins', async () => {
    seed({});
    await run({ title: 'New', priority: 'high' }, { title: 'Old' });
    expect(filterSent().$and).toEqual([{ title: 'Old' }]);
  });

  it('a conflict sends NO write at all', async () => {
    seed({ title: 'Theirs' });
    const res = await run({ title: 'Mine' }, { title: 'Old' });
    expect(res.status).toBe(409);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
