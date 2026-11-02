import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #15 (Phase 1) — subtasks against a REAL MongoDB (MongoMemoryServer) through the real Express app and Mongoose
// model. tests/taskSubtasks.test.ts proves the controller logic against an in-memory double and
// tests/taskModel.subtasks.test.ts proves the command Mongoose sends; this file proves what only the database can: what
// is actually stored (read from the raw collection, no Mongoose casting or defaults), that a task stored before the
// field existed still works, that the checklist is replaced WHOLE even when requests race, and that a refused write
// leaves the stored document byte-for-byte as it was. Needs a MongoDB binary (like the other *.realmongo tests); it is
// not skipped when one is unavailable.

type Account = { id: string; token: string };
type Sub = { id: string; title: string; completed: boolean };
type RawTask = { _id: mongoose.Types.ObjectId; title: string; subtasks?: unknown } & Record<string, unknown>;

let mongoServer: MongoMemoryServer;

const makeAccount = async (label: string): Promise<Account> => {
  const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x' });
  const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  return { id: user.id as string, token };
};

const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
const create = (account: Account, body: Record<string, unknown>) =>
  request(app).post('/api/tasks').set(auth(account)).send({ title: 't', ...body });
const update = (account: Account, id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/tasks/${id}`).set(auth(account)).send(body);

/** The stored document exactly as MongoDB holds it. */
const raw = async (id: string): Promise<RawTask> => {
  const doc = await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(doc, `task ${id} should exist`).not.toBeNull();
  return doc as unknown as RawTask;
};

const sub = (id: string, extra: Partial<Sub> = {}): Sub => ({ id, title: `step ${id}`, completed: false, ...extra });
const list = (prefix: string, count: number): Sub[] => Array.from({ length: count }, (_, i) => sub(`${prefix}${i}`));

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  await User.deleteMany({});
  await Task.deleteMany({});
});

afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    await mongoServer?.stop();
  }
});

describe('real MongoDB: what is stored', () => {
  it('a checklist is stored as plain { id, title, completed } objects in order, with no _id of their own', async () => {
    const account = await makeAccount('a');
    const res = await create(account, { subtasks: [sub('b', { completed: true }), sub('a')] });
    expect(res.status).toBe(201);

    const doc = await raw(res.body.task._id);
    expect(doc.subtasks).toEqual([
      { id: 'b', title: 'step b', completed: true },
      { id: 'a', title: 'step a', completed: false },
    ]);
  });

  it('a task created without subtasks stores an empty list', async () => {
    const account = await makeAccount('a');
    const res = await create(account, {});
    expect((await raw(res.body.task._id)).subtasks).toEqual([]);
  });

  it('replaces the whole list, and clearing stores an empty list (the key stays, it is not removed)', async () => {
    const account = await makeAccount('a');
    const id = (await create(account, { subtasks: list('x', 3) })).body.task._id as string;

    expect((await update(account, id, { subtasks: [sub('only')] })).status).toBe(200);
    expect((await raw(id)).subtasks).toEqual([sub('only')]);

    expect((await update(account, id, { subtasks: [] })).status).toBe(200);
    expect((await raw(id)).subtasks).toEqual([]);

    expect((await update(account, id, { subtasks: [sub('back')] })).status).toBe(200);
    expect((await update(account, id, { subtasks: null })).status).toBe(200);
    expect((await raw(id)).subtasks).toEqual([]);
  });

  it('an update that does not send subtasks leaves the stored list exactly as it was (an older client)', async () => {
    const account = await makeAccount('a');
    const id = (await create(account, { subtasks: [sub('a', { completed: true }), sub('b')] })).body.task._id as string;
    const before = (await raw(id)).subtasks;

    for (const body of [{ title: 'renamed' }, { completed: true }, { completed: false }, { tags: ['x'], priority: 'high' }, {}]) {
      expect((await update(account, id, body)).status).toBe(200);
      expect((await raw(id)).subtasks).toEqual(before);
    }
  });
});

describe('real MongoDB: a task stored before the field existed', () => {
  it('is listed with an empty checklist and can be updated without gaining a stored field it was not given', async () => {
    const account = await makeAccount('a');
    const inserted = await Task.collection.insertOne({
      userId: new mongoose.Types.ObjectId(account.id),
      title: 'legacy',
      description: '',
      completed: false,
      priority: 'medium',
      tags: [],
      estimatedMinutes: 0,
      reminderSent: false,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const id = String(inserted.insertedId);
    expect('subtasks' in (await raw(id))).toBe(false);

    const listed = await request(app).get('/api/tasks').set(auth(account));
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.find((t: { _id: string }) => t._id === id).subtasks).toEqual([]);

    expect((await update(account, id, { title: 'renamed' })).status).toBe(200);
    expect('subtasks' in (await raw(id))).toBe(false);

    expect((await update(account, id, { subtasks: [sub('new')] })).status).toBe(200);
    expect((await raw(id)).subtasks).toEqual([sub('new')]);
  });
});

describe('real MongoDB: refused writes change nothing', () => {
  it('an update the API refuses leaves the stored document byte-for-byte unchanged', async () => {
    const account = await makeAccount('a');
    const id = (await create(account, { title: 'keep me', subtasks: [sub('a')] })).body.task._id as string;
    const before = await raw(id);

    for (const body of [
      { title: 'changed', subtasks: list('x', 21) },
      { title: 'changed', subtasks: [sub('a'), sub('a')] },
      { title: 'changed', subtasks: [{ id: 'bad id', title: 't', completed: false }] },
      { title: 'changed', subtasks: 'nope' },
    ]) {
      expect((await update(account, id, body)).status).toBe(400);
      expect(await raw(id)).toEqual(before);
    }
  });

  it('a direct model update that skips the API is still refused by the schema, and stores nothing', async () => {
    const account = await makeAccount('a');
    const id = (await create(account, { subtasks: [sub('a')] })).body.task._id as string;
    const before = await raw(id);

    await expect(
      Task.findOneAndUpdate({ _id: id }, { $set: { subtasks: list('x', 21) } }, { runValidators: true }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(
      Task.findOneAndUpdate({ _id: id }, { $set: { subtasks: [{ id: 'bad id', title: 't', completed: false }] } }, { runValidators: true }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);

    expect(await raw(id)).toEqual(before);
  });

  it("another account cannot change a task's checklist", async () => {
    const owner = await makeAccount('owner');
    const other = await makeAccount('other');
    const id = (await create(owner, { subtasks: [sub('a')] })).body.task._id as string;
    const before = await raw(id);

    expect((await update(other, id, { subtasks: [sub('hijack')] })).status).toBe(404);
    expect(await raw(id)).toEqual(before);
  });
});

describe('real MongoDB: the list is replaced whole, even when requests race', () => {
  it('two concurrent writers: the stored list is always exactly one of the two lists, never a mix', async () => {
    const account = await makeAccount('a');
    for (let round = 0; round < 25; round += 1) {
      const id = (await create(account, { subtasks: [sub('seed')] })).body.task._id as string;
      const a = list('a', 5);
      const b = list('b', 3);

      const results = await Promise.all([update(account, id, { subtasks: a }), update(account, id, { subtasks: b })]);
      expect(results.map((r) => r.status), `round ${round}`).toEqual([200, 200]);

      const stored = (await raw(id)).subtasks;
      expect([a, b], `round ${round}: ${JSON.stringify(stored)}`).toContainEqual(stored);
    }
  });

  it('a checklist write racing an unrelated write loses neither: the title lands and the list is whole', async () => {
    const account = await makeAccount('a');
    for (let round = 0; round < 25; round += 1) {
      const id = (await create(account, { subtasks: [sub('seed')] })).body.task._id as string;
      const next = list('n', 4);

      const results = await Promise.all([update(account, id, { subtasks: next }), update(account, id, { title: `t${round}` })]);
      expect(results.map((r) => r.status), `round ${round}`).toEqual([200, 200]);

      const doc = await raw(id);
      expect(doc.title).toBe(`t${round}`);
      expect(doc.subtasks).toEqual(next);
    }
  });
});
