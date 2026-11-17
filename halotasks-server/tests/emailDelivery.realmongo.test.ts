import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import EmailDelivery from '../src/models/EmailDelivery.model';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { createEmailLedger, LEASE_MS, MAX_ATTEMPTS } from '../src/services/emailLedger';
import { runEmailReminders } from '../src/services/emailReminderRun';
import { optedInUsers, tasksForUser } from '../src/services/emailReminderStores';
import { createEmailServiceDouble } from './helpers/emailDoubles';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #29 — the delivery ledger, the preference storage and a whole reminder run against a REAL MongoDB
// (MongoMemoryServer). tests/emailLedger.test.ts and tests/emailReminderRun.test.ts prove the LOGIC against strict
// in-memory doubles; this file proves what only the database can: that the unique (userId, eventKey) index really makes one
// concurrent claimer win, that the conditional updates and upserts behave as the ledger assumes, that the TTL and partial
// indexes exist, and what is actually stored. Needs a MongoDB binary (like the other *.realmongo tests); it is not skipped
// when one is unavailable. It has NOT been run in the authoring sandbox (no MongoDB binary): typechecked only. It needs a
// run in CI before this change is merged.

let mongoServer: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId().toString();
const T0 = new Date('2026-10-05T09:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await EmailDelivery.syncIndexes();
  await User.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await EmailDelivery.deleteMany({});
  await Task.deleteMany({});
  await User.deleteMany({});
});

describe('EmailDelivery indexes', () => {
  it('has the unique (userId, eventKey) index, the TTL index and the cap-count index', async () => {
    const indexes = await EmailDelivery.collection.indexes();
    const unique = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ userId: 1, eventKey: 1 }));
    expect(unique?.unique).toBe(true);
    const ttl = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ expireAt: 1 }));
    expect(ttl?.expireAfterSeconds).toBe(0);
    expect(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ userId: 1, claimedAt: 1 }))).toBe(true);
  });

  it('User has the partial index on emailReminders.enabled used by the run', async () => {
    const indexes = await User.collection.indexes();
    const partial = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ 'emailReminders.enabled': 1 }));
    expect(partial?.partialFilterExpression).toEqual({ 'emailReminders.enabled': true });
  });
});

describe('the ledger against MongoDB', () => {
  it('exactly one of 50 concurrent claims of one event wins, and one document exists', async () => {
    const ledger = createEmailLedger();
    const user = oid();
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.claim(user, 'race', 'task', T0)));
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(await EmailDelivery.countDocuments({ userId: user, eventKey: 'race' })).toBe(1);
  });

  it('claim, settle, retry budget, unknown and lease expiry behave as the logic tests assume', async () => {
    const ledger = createEmailLedger();
    const user = oid();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(await ledger.claim(user, 'retry', 'task', later(attempt * 1000))).toEqual({ outcome: 'claimed', attempt });
      await ledger.settle(user, 'retry', { state: 'failed', code: 'smtp:EAUTH' }, later(attempt * 1000));
    }
    expect(await ledger.claim(user, 'retry', 'task', later(99_000))).toEqual({ outcome: 'exists', state: 'failed' });

    await ledger.claim(user, 'amb', 'task', T0);
    await ledger.settle(user, 'amb', { state: 'unknown', code: 'smtp:ETIMEDOUT' }, T0);
    expect(await ledger.claim(user, 'amb', 'task', later(10 * LEASE_MS))).toEqual({ outcome: 'exists', state: 'unknown' });

    await ledger.claim(user, 'dead', 'task', T0);
    expect(await ledger.claim(user, 'dead', 'task', later(LEASE_MS + 1))).toEqual({ outcome: 'exists', state: 'unknown' });
    await ledger.settle(user, 'dead', { state: 'sent', provider: 'smtp' }, later(LEASE_MS + 2));
    expect((await EmailDelivery.findOne({ userId: user, eventKey: 'dead' }).lean())?.state).toBe('unknown');
  });

  it('stores identity and outcome only, with an expiry date about 30 days out', async () => {
    const ledger = createEmailLedger();
    const user = oid();
    await ledger.claim(user, 'k', 'task', T0);
    await ledger.settle(user, 'k', { state: 'sent', provider: 'brevo' }, T0);
    const raw = (await EmailDelivery.collection.findOne({ eventKey: 'k' })) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['_id', '__v', 'attempts', 'claimedAt', 'createdAt', 'eventKey', 'expireAt', 'kind', 'leaseUntil', 'provider', 'settledAt', 'state', 'updatedAt', 'userId'].sort());
    expect((raw.expireAt as Date).getTime() - T0.getTime()).toBeGreaterThan(29 * 86_400_000);
  });
});

describe('a whole run against MongoDB', () => {
  it('reads opted-in users and their tasks, sends once, and a replay and a restart send nothing more', async () => {
    const mail = createEmailServiceDouble();
    const { insertedId } = await User.collection.insertOne({
      name: 'A', email: 'a@example.test', passwordHash: await bcrypt.hash('x', 4), tokenVersion: 0, timeZone: 'Asia/Kolkata', emailReminders: { enabled: true },
    });
    await User.collection.insertOne({ name: 'B', email: 'b@example.test', passwordHash: 'h', tokenVersion: 0, emailReminders: { enabled: false } });
    await Task.collection.insertMany([
      { userId: insertedId, title: 'Due soon', completed: false, priority: 'medium', dueDate: new Date('2026-10-05T00:00:00Z'), dueTime: '15:00', estimatedMinutes: 0 },
      { userId: insertedId, title: 'Done', completed: true, priority: 'medium', dueDate: new Date('2026-10-05T00:00:00Z'), dueTime: '15:00', estimatedMinutes: 0 },
      { userId: insertedId, title: 'No dates', completed: false, priority: 'medium', estimatedMinutes: 0 },
    ]);

    const run = () =>
      runEmailReminders({ now: () => T0, users: optedInUsers, tasksFor: tasksForUser, ledger: createEmailLedger(), email: mail.service, dailyCap: 20, budgetMs: 60_000, log: { info: () => undefined, warn: () => undefined, error: () => undefined } });

    expect(await run()).toMatchObject({ users: 1, sent: 1, errors: 0 });
    expect(await run()).toMatchObject({ sent: 0, duplicates: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].message.to).toBe('a@example.test');
    expect(await EmailDelivery.countDocuments({})).toBe(1);
  });
});

describe('preference storage', () => {
  it('PUT stores only emailReminders.* paths, the override can be removed, and nothing else on the user changes', async () => {
    const { insertedId } = await User.collection.insertOne({ name: 'A', email: 'a@example.test', passwordHash: await bcrypt.hash('x', 4), tokenVersion: 0, treeState: { xp: 42 } });
    const id = insertedId.toString();
    const token = jwt.sign({ userId: id, email: 'a@example.test', name: 'A', tv: 0 }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
    const as = { Authorization: `Bearer ${token}` };

    const put = await request(app).put('/api/user/email-reminders').set(as).send({ enabled: true, timeZone: 'Europe/Berlin', digestTime: '06:45' });
    expect(put.status).toBe(200);
    let raw = (await User.collection.findOne({ _id: insertedId })) as Record<string, unknown>;
    expect(raw.emailReminders).toEqual({ enabled: true, timeZone: 'Europe/Berlin', digestTime: '06:45' });
    expect(raw.treeState).toEqual({ xp: 42 });

    await request(app).put('/api/user/email-reminders').set(as).send({ timeZone: null });
    raw = (await User.collection.findOne({ _id: insertedId })) as Record<string, unknown>;
    expect(raw.emailReminders).toEqual({ enabled: true, digestTime: '06:45' });

    const bad = await request(app).put('/api/user/email-reminders').set(as).send({ digestTime: '25:00' });
    expect(bad.status).toBe(400);
  });
});
