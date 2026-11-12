import jwt from 'jsonwebtoken';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import CompletionRecord from '../src/models/CompletionRecord.model';
import DayHistory from '../src/models/DayHistory.model';
import User from '../src/models/User.model';
import { addDays, getToday } from '../src/utils/calendarDate';
import { migrateDayHistory, migratedCompletionId, supportsTransactions } from '../src/utils/completionMigration';
import { recordCompletion } from '../src/utils/completionRecords';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #47, Phase 2B — the migration against a REAL MongoDB (MongoMemoryServer): the real unique indexes, Mongoose's own
// validation of a record with a null instant, a real DayHistory cursor, real concurrent runs, and the ATOMICITY of a day (one
// real transaction per day, on a one-node replica set). Needs a MongoDB binary like the other *.realmongo tests (typechecked,
// not run, in the sandbox that produced it).

// Transactions (the atomicity mechanism of the migration) need a replica set, so this suite starts a one-node replica set.
let mongoServer: MongoMemoryReplSet;
const IST = 330;
const OLD = addDays(getToday(IST), -30);
const OLDER = addDays(getToday(IST), -45);

const rawRecords = async () => (await CompletionRecord.collection.find({}).toArray()) as unknown as Record<string, unknown>[];
const cursorOf = () => DayHistory.find({}).sort({ userId: 1, date: 1 }).lean().cursor();

const account = async (label: string) => {
  const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x' });
  const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
  return { id: user.id as string, auth: { Authorization: `Bearer ${token}` } };
};
const legacyDay = (userId: string, date: string, tasks: { taskId: string; title: string; estimatedMinutes: number }[]) =>
  DayHistory.create({ userId, date, completedCount: tasks.length, workDoneMinutes: tasks.reduce((s, t) => s + t.estimatedMinutes, 0), completedTasks: tasks });

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await CompletionRecord.syncIndexes();
  await DayHistory.syncIndexes();
});
beforeEach(async () => {
  await CompletionRecord.collection.deleteMany({});
  await DayHistory.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('real MongoDB: migrating DayHistory', () => {
  it('stores records that pass the model validation with a null instant, and an immediate rerun creates nothing', async () => {
    const owner = await account('m1');
    await legacyDay(owner.id, OLD, [
      { taskId: 'a', title: 'Alpha', estimatedMinutes: 25 },
      { taskId: 'b', title: 'Beta', estimatedMinutes: 5 },
    ]);

    const first = await migrateDayHistory(cursorOf(), { apply: true });
    const stored = await rawRecords();

    expect(first.recordsCreated).toBe(2);
    expect(stored).toHaveLength(2);
    for (const doc of stored) {
      expect(doc).toMatchObject({ localDate: OLD, completedAt: null, utcOffsetMinutes: null, status: 'active', source: 'migrated', completedAtSource: 'migrated' });
      expect(String(doc.userId)).toBe(owner.id);
    }
    expect(stored.map((d) => d.completionId).sort()).toEqual(['a', 'b'].map((t) => migratedCompletionId(owner.id, OLD, t)).sort());

    const second = await migrateDayHistory(cursorOf(), { apply: true });
    expect(second.recordsCreated).toBe(0);
    expect(await rawRecords()).toHaveLength(2);
  });

  it('two runs at the same time still leave exactly one record per snapshot entry (the unique index decides)', async () => {
    const owner = await account('m2');
    const tasks = Array.from({ length: 25 }, (_, i) => ({ taskId: `t${i}`, title: `Task ${i}`, estimatedMinutes: 5 }));
    await legacyDay(owner.id, OLD, tasks);
    await legacyDay(owner.id, OLDER, tasks.slice(0, 10));

    const [r1, r2] = await Promise.all([migrateDayHistory(cursorOf(), { apply: true }), migrateDayHistory(cursorOf(), { apply: true })]);

    expect(await rawRecords()).toHaveLength(35);
    expect(r1.recordsCreated + r2.recordsCreated).toBe(35);
    expect(r1.rowsFailed + r2.rowsFailed).toBe(0);
  });

  it('migrated records do not collide with the single-active-live-completion index, before or after a live completion of the same task', async () => {
    const owner = await account('m3');
    await legacyDay(owner.id, OLD, [{ taskId: 'shared-task', title: 'Old completion', estimatedMinutes: 5 }]);
    await legacyDay(owner.id, OLDER, [{ taskId: 'shared-task', title: 'Older completion', estimatedMinutes: 5 }]);

    await migrateDayHistory(cursorOf(), { apply: true });
    const live = await recordCompletion(owner.id, {
      completionId: 'live-1',
      taskId: 'shared-task',
      titleSnapshot: 'Live',
      estimatedMinutesSnapshot: 5,
      completedAt: new Date(Date.now() - 60_000),
      utcOffsetMinutes: IST,
      localDate: addDays(getToday(IST), 0),
    });

    expect(live.outcome).toBe('recorded');
    expect((await rawRecords()).filter((d) => d.taskId === 'shared-task')).toHaveLength(3);
  });

  it('repairs a day that has records PER TASK (Phase 2F): covered tasks (active or revoked) are untouched, uncovered ones are imported, DayHistory is never modified, writable days are skipped', async () => {
    const owner = await account('m4');
    const today = getToday(IST);
    const REVOKED_DAY = addDays(getToday(IST), -50);
    await legacyDay(owner.id, OLD, [{ taskId: 'x', title: 'Snapshot', estimatedMinutes: 5 }]);
    await legacyDay(owner.id, REVOKED_DAY, [{ taskId: 'a', title: 'A', estimatedMinutes: 5 }, { taskId: 'b', title: 'B', estimatedMinutes: 5 }]);
    await legacyDay(owner.id, addDays(today, -2), [{ taskId: 'y', title: 'Recent', estimatedMinutes: 5 }]);
    const base = { userId: owner.id, titleSnapshot: 'Live', estimatedMinutesSnapshot: 1, receivedAt: new Date(), source: 'live', completedAtSource: 'client', utcOffsetMinutes: 0 };
    await CompletionRecord.create({ ...base, completionId: 'live-old', taskId: 'z', completedAt: new Date(`${OLD}T05:00:00Z`), localDate: OLD, status: 'active' });
    await CompletionRecord.create({
      ...base, completionId: 'rev-1', taskId: 'a', completedAt: new Date(`${REVOKED_DAY}T05:00:00Z`), localDate: REVOKED_DAY,
      status: 'revoked', revokedReason: 'uncompleted', revokeReceivedAt: new Date(),
    });
    const legacyBefore = JSON.stringify(await DayHistory.find({}).sort({ date: 1 }).lean());

    const report = await migrateDayHistory(cursorOf(), { apply: true });

    expect(report.rowsSkippedExistingRecords).toBe(0);
    expect(report.rowsMixedToRepair).toBe(2);
    expect(report.recordsCoveredByCanonical).toBe(1); // 'a' on REVOKED_DAY (revoked records still cover their task)
    expect(report.rowsSkippedWritable).toBe(1);
    const ids = (await rawRecords()).map((d) => d.completionId).sort();
    expect(ids).toEqual(['live-old', 'rev-1', migratedCompletionId(owner.id, OLD, 'x'), migratedCompletionId(owner.id, REVOKED_DAY, 'b')].sort());
    expect(JSON.stringify(await DayHistory.find({}).sort({ date: 1 }).lean())).toBe(legacyBefore);

    const again = await migrateDayHistory(cursorOf(), { apply: true }); // idempotent against the real unique index
    expect(again.recordsCreated).toBe(0);
    expect(await rawRecords()).toHaveLength(4);
  });

  it('ATOMIC (real transaction): a failing import in a MIXED day rolls back the whole repair and leaves the canonical record alone', async () => {
    const owner = await account('m4b');
    await legacyDay(owner.id, OLD, ['a', 'b', 'c'].map((taskId) => ({ taskId, title: taskId, estimatedMinutes: 5 })));
    await CompletionRecord.create({
      userId: owner.id, completionId: 'live-a', taskId: 'a', titleSnapshot: 'a', estimatedMinutesSnapshot: 5, completedAt: new Date(`${OLD}T05:00:00Z`),
      utcOffsetMinutes: 0, localDate: OLD, receivedAt: new Date(), status: 'active', source: 'live', completedAtSource: 'client',
    });
    // the id of c's import is taken by a record of ANOTHER day: b is inserted, then c violates the unique index and aborts the transaction
    await CompletionRecord.create({
      userId: owner.id, completionId: migratedCompletionId(owner.id, OLD, 'c'), taskId: 'c', titleSnapshot: 'c', estimatedMinutesSnapshot: 5,
      completedAt: null, utcOffsetMinutes: null, localDate: addDays(OLD, -20), receivedAt: new Date(), status: 'active', source: 'migrated', completedAtSource: 'migrated',
    });

    await migrateDayHistory(cursorOf(), { apply: true });

    expect((await rawRecords()).filter((d) => d.localDate === OLD).map((d) => d.completionId)).toEqual(['live-a']);
  });

  it('ATOMIC (real transaction): when a write in the MIDDLE of a day fails, the records already inserted by that transaction are rolled back, so no partial day exists', async () => {
    const owner = await account('m6');
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((taskId) => ({ taskId, title: taskId, estimatedMinutes: 5 }));
    await legacyDay(owner.id, OLD, tasks);
    // The 3rd record's id is already taken (by a record of ANOTHER day, so the day check does not see it): a, b are inserted,
    // c violates the unique (userId, completionId) index, and MongoDB must abort the transaction and take a, b back.
    await CompletionRecord.create({
      userId: owner.id, completionId: migratedCompletionId(owner.id, OLD, 'c'), taskId: 'c', titleSnapshot: 'c', estimatedMinutesSnapshot: 5,
      completedAt: null, utcOffsetMinutes: null, localDate: addDays(OLD, -20), receivedAt: new Date(), status: 'active', source: 'migrated', completedAtSource: 'migrated',
    });

    await migrateDayHistory(cursorOf(), { apply: true });

    expect((await rawRecords()).filter((d) => d.localDate === OLD)).toHaveLength(0);
    expect(await rawRecords()).toHaveLength(1); // only the seeded one
  });

  it('ATOMIC (real transaction): an invalid record in a day rejects the whole day, and the real model validation still applies', async () => {
    const owner = await account('m7');
    await DayHistory.collection.insertOne({
      userId: new mongoose.Types.ObjectId(owner.id), date: OLD, completedCount: 2, workDoneMinutes: 10,
      completedTasks: [{ taskId: 'ok', title: 'Fine', estimatedMinutes: 5 }, { taskId: 'bad id', title: 'Bad', estimatedMinutes: 5 }],
      createdAt: new Date(), updatedAt: new Date(),
    });

    const report = await migrateDayHistory(cursorOf(), { apply: true });

    expect(report.rowsSkippedInvalid).toBe(1);
    expect(await rawRecords()).toHaveLength(0);
  });

  it('the connected deployment reports a replica set, which the CLI requires before --apply', async () => {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    expect(supportsTransactions(hello)).toBe(true);
  });

  it('GET /api/history reads the same tasks, count and minutes after the migration', async () => {
    const owner = await account('m5');
    await legacyDay(owner.id, OLD, [{ taskId: 'a', title: 'Alpha', estimatedMinutes: 25 }, { taskId: 'b', title: 'Beta', estimatedMinutes: 5 }]);
    const get = async () =>
      (await request(app).get(`/api/history?days=60&endDate=${getToday(IST)}&utcOffsetMinutes=${IST}`).set(owner.auth)).body.history as {
        date: string; completedCount: number; workDoneMinutes: number; completedTasks: { taskId: string }[]; updatedAt: string | null;
      }[];
    const shape = (h: Awaited<ReturnType<typeof get>>) =>
      h.map((e) => ({ date: e.date, n: e.completedCount, m: e.workDoneMinutes, ids: e.completedTasks.map((t) => t.taskId).sort(), exists: e.updatedAt !== null }));

    const before = shape(await get());
    await migrateDayHistory(cursorOf(), { apply: true });
    const after = shape(await get());

    expect(after).toEqual(before);
    expect(after.find((e) => e.date === OLD)).toMatchObject({ n: 2, m: 30, ids: ['a', 'b'], exists: true });
  });
});
