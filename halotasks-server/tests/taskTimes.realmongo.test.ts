import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';

// Issues #9 and #10 — optional start time and due time, against a REAL MongoDB (MongoMemoryServer) through the real
// Express app and Mongoose model. tests/taskRoutes.test.ts proves the route logic against an in-memory double; this
// file proves what only the database can: what is actually stored (read from the raw collection, not through
// Mongoose), that clearing really removes the fields, that the model rejects a bad value even when the API is
// bypassed, and that the due-time/due-date rule holds when requests race. Needs a MongoDB binary (like
// api.routes.test.ts and the other *.realmongo tests); it is not skipped when one is unavailable.

type Account = { id: string; token: string };
type RawTask = { _id: mongoose.Types.ObjectId; dueDate?: Date; dueTime?: string; startTime?: Date; title: string } & Record<string, unknown>;

let mongoServer: MongoMemoryServer;

const setTestEnv = () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
};

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

/** The stored document exactly as MongoDB holds it: no Mongoose casting, defaults or getters in between. */
const raw = async (id: string): Promise<RawTask> => {
  const doc = await Task.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(doc, `task ${id} should exist`).not.toBeNull();
  return doc as unknown as RawTask;
};

/** The invariant of Issue #10: a due time is never stored without the due date it belongs to. */
const expectNoOrphanDueTime = (doc: RawTask) => {
  if ('dueTime' in doc) expect(doc.dueDate, 'a stored dueTime needs a stored dueDate').toBeInstanceOf(Date);
};

beforeAll(async () => {
  setTestEnv();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  setTestEnv();
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

type Expected = { dueDate?: string; dueTime?: string; startTime?: string };

describe('real MongoDB: what is stored', () => {
  it.each<[label: string, body: Record<string, unknown>, expected: Expected]>([
    ['neither time', {}, { dueDate: undefined, dueTime: undefined, startTime: undefined }],
    ['a due date only', { dueDate: '2026-10-20' }, { dueDate: '2026-10-20T00:00:00.000Z', dueTime: undefined, startTime: undefined }],
    [
      'a due date and a due time',
      { dueDate: '2026-10-20', dueTime: '17:30' },
      { dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', startTime: undefined },
    ],
    [
      'a start time only',
      { startTime: '2026-10-20T09:30:00+05:30' },
      { dueDate: undefined, dueTime: undefined, startTime: '2026-10-20T04:00:00.000Z' },
    ],
    [
      'all three',
      { dueDate: '2026-10-20', dueTime: '00:00', startTime: '2026-10-19T23:00:00Z' },
      { dueDate: '2026-10-20T00:00:00.000Z', dueTime: '00:00', startTime: '2026-10-19T23:00:00.000Z' },
    ],
  ])('create with %s persists exactly that, and GET returns it', async (_label, body, expected) => {
    const owner = await makeAccount('owner');

    const res = await create(owner, body);
    expect(res.status).toBe(201);
    const id = res.body.task._id as string;

    const doc = await raw(id);
    expect(doc.dueDate?.toISOString()).toBe(expected.dueDate);
    expect(doc.dueTime).toBe(expected.dueTime);
    expect(doc.startTime?.toISOString()).toBe(expected.startTime);
    // A field that was not set is absent from the document, not stored as null or a default.
    for (const field of ['dueDate', 'dueTime', 'startTime'] as const) {
      if (expected[field] === undefined) expect(field in doc, `${field} should not be stored`).toBe(false);
    }
    // A date-only deadline is never given a time, and is never turned into anything but its UTC-midnight day.
    if (body.dueDate && !body.dueTime) expect('dueTime' in doc).toBe(false);

    const listed = await request(app).get('/api/tasks').set(auth(owner));
    const found = listed.body.tasks.find((task: { _id: string }) => task._id === id);
    expect(found.dueTime).toBe(expected.dueTime);
    expect(found.startTime).toBe(expected.startTime);
  });

  it('a legacy document (no time fields at all) is listed and edited without ever gaining them', async () => {
    const owner = await makeAccount('owner');
    const inserted = await Task.collection.insertOne({
      userId: new mongoose.Types.ObjectId(owner.id),
      title: 'legacy',
      completed: false,
      priority: 'medium',
      tags: [],
      dueDate: new Date('2026-04-21'),
      estimatedMinutes: 0,
      reminderSent: false,
      completedAt: null,
    });
    const id = String(inserted.insertedId);

    const listed = await request(app).get('/api/tasks').set(auth(owner));
    expect(listed.status).toBe(200);
    expect(listed.body.tasks).toHaveLength(1);
    expect(listed.body.tasks[0]).toMatchObject({ title: 'legacy', dueDate: '2026-04-21T00:00:00.000Z' });

    const edited = await update(owner, id, { title: 'legacy, edited', priority: 'high' });
    expect(edited.status).toBe(200);
    const doc = await raw(id);
    expect(doc.title).toBe('legacy, edited');
    expect('dueTime' in doc).toBe(false);
    expect('startTime' in doc).toBe(false);
    expect(doc.dueDate?.toISOString()).toBe('2026-04-21T00:00:00.000Z');
  });
});

describe('real MongoDB: updating and clearing', () => {
  const createTimed = async (owner: Account) => {
    const res = await create(owner, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:00Z' });
    expect(res.status).toBe(201);
    return res.body.task._id as string;
  };

  it('unrelated edits leave both times untouched in the stored document', async () => {
    const owner = await makeAccount('owner');
    const id = await createTimed(owner);

    const res = await update(owner, id, { title: 'renamed', priority: 'high', estimatedMinutes: 25, tags: ['x'] });

    expect(res.status).toBe(200);
    const doc = await raw(id);
    expect(doc.title).toBe('renamed');
    expect(doc.dueTime).toBe('17:30');
    expect(doc.startTime?.toISOString()).toBe('2026-10-20T09:30:00.000Z');
    expect(doc.dueDate?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it.each([null, ''])('clearing the due time with %j removes the field from the document', async (clear) => {
    const owner = await makeAccount('owner');
    const id = await createTimed(owner);

    expect((await update(owner, id, { dueTime: clear })).status).toBe(200);

    const doc = await raw(id);
    expect('dueTime' in doc).toBe(false);
    expect(doc.dueDate).toBeInstanceOf(Date);
    expect(doc.startTime).toBeInstanceOf(Date);
  });

  it.each([null, ''])('clearing the start time with %j removes the field from the document', async (clear) => {
    const owner = await makeAccount('owner');
    const id = await createTimed(owner);

    expect((await update(owner, id, { startTime: clear })).status).toBe(200);

    const doc = await raw(id);
    expect('startTime' in doc).toBe(false);
    expect(doc.dueTime).toBe('17:30');
  });

  it.each([null, ''])('clearing the due date with %j removes it AND its due time from the document, and keeps the start time', async (clear) => {
    const owner = await makeAccount('owner');
    const id = await createTimed(owner);

    expect((await update(owner, id, { dueDate: clear })).status).toBe(200);

    const doc = await raw(id);
    expect('dueDate' in doc).toBe(false);
    expect('dueTime' in doc).toBe(false);
    expect(doc.startTime).toBeInstanceOf(Date);
  });

  it('a populated field can be cleared and set again', async () => {
    const owner = await makeAccount('owner');
    const id = await createTimed(owner);

    await update(owner, id, { dueDate: null });
    const reset = await update(owner, id, { dueDate: '2026-11-02', dueTime: '08:05' });

    expect(reset.status).toBe(200);
    const doc = await raw(id);
    expect(doc.dueDate?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(doc.dueTime).toBe('08:05');
  });

  it.each([
    ['a due time on a task with no due date', async (owner: Account) => (await create(owner, {})).body.task._id as string, { dueTime: '09:00' }],
    ['a cleared due date with a due time', async (owner: Account) => createTimed(owner), { dueDate: null, dueTime: '09:00' }],
    ['a malformed due time', async (owner: Account) => createTimed(owner), { dueTime: '9am' }],
    ['a zone-less start time', async (owner: Account) => createTimed(owner), { startTime: '2026-10-20T09:30:00' }],
    ['an impossible start time', async (owner: Account) => createTimed(owner), { startTime: '2026-02-30T09:30:00Z' }],
  ])('rejects %s with a 400 and leaves the stored document exactly as it was', async (_label, seed, body) => {
    const owner = await makeAccount('owner');
    const id = await seed(owner);
    const before = await raw(id);

    const res = await update(owner, id, body);

    expect(res.status).toBe(400);
    expect(await raw(id)).toEqual(before);
  });

  it("another user's request can neither read nor change the times (404, document untouched)", async () => {
    const owner = await makeAccount('owner');
    const intruder = await makeAccount('intruder');
    const id = await createTimed(owner);
    const before = await raw(id);

    const res = await update(intruder, id, { dueTime: '01:00', startTime: '2026-01-01T00:00:00Z', dueDate: null });

    expect(res.status).toBe(404);
    expect(await raw(id)).toEqual(before);
  });
});

describe('real MongoDB: the model is a second line of defence', () => {
  it.each(['25:00', '9:30', '12:60', 'noon', '09:30:00'])('rejects dueTime %j even when the API is bypassed (create)', async (dueTime) => {
    const owner = await makeAccount('owner');

    await expect(Task.create({ userId: owner.id, title: 't', dueDate: new Date('2026-10-20'), dueTime })).rejects.toThrow(/dueTime/);
    expect(await Task.countDocuments({})).toBe(0);
  });

  it('rejects a bad dueTime on a validated update too', async () => {
    const owner = await makeAccount('owner');
    const task = await Task.create({ userId: owner.id, title: 't', dueDate: new Date('2026-10-20'), dueTime: '10:00' });

    await expect(
      Task.findOneAndUpdate({ _id: task._id }, { $set: { dueTime: '99:99' } }, { runValidators: true }),
    ).rejects.toThrow(/dueTime/);
    expect((await raw(String(task._id))).dueTime).toBe('10:00');
  });

  it('rejects a dueTime without a dueDate on create, and an update that removes the date while setting a time', async () => {
    const owner = await makeAccount('owner');

    await expect(Task.create({ userId: owner.id, title: 't', dueTime: '10:00' })).rejects.toThrow(/dueTime requires a dueDate/);
    expect(await Task.countDocuments({})).toBe(0);

    const task = await Task.create({ userId: owner.id, title: 't', dueDate: new Date('2026-10-20'), dueTime: '10:00' });
    await expect(
      Task.findOneAndUpdate({ _id: task._id }, { $set: { dueTime: '11:00' }, $unset: { dueDate: 1 } }, { runValidators: true }),
    ).rejects.toThrow(/dueTime requires a dueDate/);
    const stored = await raw(String(task._id));
    expect(stored.dueTime).toBe('10:00');
    expect(stored.dueDate).toBeInstanceOf(Date);
  });

  it('the controller\'s own update shapes (set time on a stored date, clear date and time) pass the validators in a real update', async () => {
    const owner = await makeAccount('owner');
    const created = await create(owner, { dueDate: '2026-10-20' });
    expect((await update(owner, created.body.task._id, { dueTime: '08:15' })).status).toBe(200);
    expect((await raw(created.body.task._id)).dueTime).toBe('08:15');
    expect((await update(owner, created.body.task._id, { dueDate: null })).status).toBe(200);
    const stored = await raw(created.body.task._id);
    expect('dueDate' in stored).toBe(false);
    expect('dueTime' in stored).toBe(false);
  });
});

describe('real MongoDB: concurrent requests', () => {
  it('a due time is never left without its due date when one request clears the date while another sets the time', async () => {
    const owner = await makeAccount('owner');
    const outcomes = new Set<string>();

    for (let round = 0; round < 40; round += 1) {
      const task = await Task.create({ userId: owner.id, title: `race ${round}`, dueDate: new Date('2026-10-20') });
      const id = String(task._id);

      const [cleared, timed] = await Promise.all([update(owner, id, { dueDate: null }), update(owner, id, { dueTime: '10:00' })]);

      // Clearing never fails. Setting the time is accepted (it ran first and the clear then removed it), or refused
      // because the date was already gone: 400 if it saw that when it read, 409 if it changed between read and write.
      expect(cleared.status, `round ${round}: clear -> ${JSON.stringify(cleared.body)}`).toBe(200);
      expect([200, 400, 409], `round ${round}: set time -> ${timed.status} ${JSON.stringify(timed.body)}`).toContain(timed.status);
      outcomes.add(String(timed.status));

      const doc = await raw(id);
      expect('dueDate' in doc, `round ${round}: the clear always wins eventually`).toBe(false);
      expectNoOrphanDueTime(doc);
    }
    // Informational only (which interleavings happened is up to the scheduler): never fails the test.
    console.info(`[taskTimes.realmongo] set-time outcomes seen across 40 races: ${[...outcomes].sort().join(', ')}`);
  });

  it('many concurrent unrelated updates never erase either time, and every one succeeds', async () => {
    const owner = await makeAccount('owner');
    const created = await create(owner, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:00Z' });
    const id = created.body.task._id as string;

    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, i) => update(owner, id, i % 2 === 0 ? { title: `title ${i}` } : { estimatedMinutes: i })),
    );

    for (const res of responses) expect(res.status).toBe(200);
    const doc = await raw(id);
    expect(doc.dueTime).toBe('17:30');
    expect(doc.startTime?.toISOString()).toBe('2026-10-20T09:30:00.000Z');
    expect(doc.dueDate?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('concurrent creates with times each persist their own values', async () => {
    const owner = await makeAccount('owner');
    const times = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}:15`);

    const responses = await Promise.all(times.map((dueTime) => create(owner, { title: dueTime, dueDate: '2026-10-20', dueTime })));

    for (const res of responses) expect(res.status).toBe(201);
    const stored = await Task.collection.find({ userId: new mongoose.Types.ObjectId(owner.id) }).toArray();
    expect(stored).toHaveLength(12);
    for (const doc of stored) expect(doc.dueTime).toBe(doc.title);
  });
});

