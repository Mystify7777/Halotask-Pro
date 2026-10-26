import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import app from '../src/app';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #41 — the time zone preference against a REAL MongoDB (MongoMemoryServer) through the real Express app and
// Mongoose model. tests/userPreferences.test.ts proves the route logic against an in-memory double; this file proves
// what only the database can: what is actually stored (read from the raw collection), that clearing really removes
// the field, that a legacy document with no field behaves, that nothing else on the document changes, and that the
// model rejects a bad value even when the route is bypassed. Needs a MongoDB binary (like the other *.realmongo
// tests); it is not skipped when one is unavailable.

type Account = { id: string; email: string; token: string };

let mongoServer: MongoMemoryServer;

const makeAccount = async (label: string, extra: Record<string, unknown> = {}): Promise<Account> => {
  const email = `${label}-${new mongoose.Types.ObjectId()}@mail.com`;
  // Inserted through the raw collection so the document is exactly what an account created before Issue #41 looks
  // like: no timeZone key at all (Mongoose defaults and validators are bypassed on purpose).
  const passwordHash = await bcrypt.hash('correct-horse', 4);
  const { insertedId } = await User.collection.insertOne({
    name: label,
    email,
    passwordHash,
    tokenVersion: 0,
    pushSubscriptions: [],
    treeState: { xp: 42, awardedTaskIds: ['t1'] },
    ...extra,
  });
  const id = insertedId.toString();
  const token = jwt.sign({ userId: id, email, name: label, tv: 0 }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
  return { id, email, token };
};

const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
const rawUser = async (id: string) => {
  const doc = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(doc, `user ${id} should exist`).not.toBeNull();
  return doc as Record<string, unknown>;
};

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  await User.deleteMany({});
});

afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    await mongoServer?.stop();
  }
});

describe('time zone preference, stored in MongoDB', () => {
  it('a legacy document with no field reads as null, and reading does not write the field', async () => {
    const account = await makeAccount('legacy');

    const res = await request(app).get('/api/user/preferences').set(auth(account));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
    expect(await rawUser(account.id)).not.toHaveProperty('timeZone');
  });

  it('saving stores the identifier as a plain string and a read returns it', async () => {
    const account = await makeAccount('save');

    const put = await request(app).put('/api/user/preferences').set(auth(account)).send({ timeZone: 'Asia/Kolkata' });
    const get = await request(app).get('/api/user/preferences').set(auth(account));

    expect(put.body).toEqual({ timeZone: 'Asia/Kolkata' });
    expect(get.body).toEqual({ timeZone: 'Asia/Kolkata' });
    expect((await rawUser(account.id)).timeZone).toBe('Asia/Kolkata');
  });

  it('clearing with null removes the key from the document', async () => {
    const account = await makeAccount('clear', { timeZone: 'Europe/London' });

    const res = await request(app).put('/api/user/preferences').set(auth(account)).send({ timeZone: null });

    expect(res.body).toEqual({ timeZone: null });
    expect(await rawUser(account.id)).not.toHaveProperty('timeZone');
  });

  it('changes nothing else on the document (only timeZone, plus the updatedAt that the schema\'s timestamps always bump)', async () => {
    const account = await makeAccount('only');
    const before = await rawUser(account.id);
    // Created through the raw collection, so it has no timestamps yet: the first Mongoose update adds updatedAt.
    expect(before).not.toHaveProperty('updatedAt');

    await request(app).put('/api/user/preferences').set(auth(account)).send({ timeZone: 'America/Los_Angeles', tokenVersion: 9, treeState: { xp: 1e9 } });

    const saved = await rawUser(account.id);
    expect(saved.timeZone).toBe('America/Los_Angeles');
    expect(saved.updatedAt).toBeInstanceOf(Date); // timestamps: true, as on every User update
    const { timeZone: _saved, updatedAt: _stamp, ...rest } = saved;
    expect(rest).toEqual(before); // every other field, including tokenVersion and treeState, exactly as it was

    // Clearing is the same: the key goes, the timestamp moves, nothing else changes.
    await request(app).put('/api/user/preferences').set(auth(account)).send({ timeZone: null });

    const cleared = await rawUser(account.id);
    expect(cleared).not.toHaveProperty('timeZone');
    expect(cleared.updatedAt).toBeInstanceOf(Date);
    const { updatedAt: _stamp2, ...restCleared } = cleared;
    expect(restCleared).toEqual(before);
  });

  it('is per account: saving for one leaves another untouched', async () => {
    const a = await makeAccount('a');
    const b = await makeAccount('b', { timeZone: 'America/Los_Angeles' });

    await request(app).put('/api/user/preferences').set(auth(a)).send({ timeZone: 'Asia/Kolkata' });

    expect((await rawUser(b.id)).timeZone).toBe('America/Los_Angeles');
    expect((await request(app).get('/api/user/preferences').set(auth(b))).body).toEqual({ timeZone: 'America/Los_Angeles' });
  });

  it('a rejected value leaves the stored one alone', async () => {
    const account = await makeAccount('reject', { timeZone: 'Asia/Kolkata' });

    const res = await request(app).put('/api/user/preferences').set(auth(account)).send({ timeZone: '+05:30' });

    expect(res.status).toBe(400);
    expect((await rawUser(account.id)).timeZone).toBe('Asia/Kolkata');
  });

  it('login and a later session return the saved value; a legacy account returns null', async () => {
    const saved = await makeAccount('saved', { timeZone: 'Pacific/Kiritimati' });
    const legacy = await makeAccount('old');

    const first = await request(app).post('/api/auth/login').send({ email: saved.email, password: 'correct-horse' });
    const second = await request(app).post('/api/auth/login').send({ email: saved.email, password: 'correct-horse' });
    const old = await request(app).post('/api/auth/login').send({ email: legacy.email, password: 'correct-horse' });

    expect(first.body.user.timeZone).toBe('Pacific/Kiritimati');
    expect(second.body.user.timeZone).toBe('Pacific/Kiritimati');
    expect(old.body.user.timeZone).toBeNull();
    expect(await rawUser(legacy.id)).not.toHaveProperty('timeZone');
  });

  it('registration stores no time zone', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'New', email: 'fresh@mail.com', password: 'correct-horse' });

    expect(res.status).toBe(201);
    expect(res.body.user.timeZone).toBeNull();
    expect(await rawUser(res.body.user.id)).not.toHaveProperty('timeZone');
  });

  it('the model refuses a bad zone even when the route is bypassed (create, save, and a validated update)', async () => {
    await expect(User.create({ name: 'x', email: 'x@mail.com', passwordHash: 'x', timeZone: '+05:30' })).rejects.toThrow(/timeZone/);

    const account = await makeAccount('model');
    await expect(User.updateOne({ _id: account.id }, { $set: { timeZone: 'Nowhere/Land' } }, { runValidators: true })).rejects.toThrow(/timeZone/);
    expect(await rawUser(account.id)).not.toHaveProperty('timeZone');
  });
});
