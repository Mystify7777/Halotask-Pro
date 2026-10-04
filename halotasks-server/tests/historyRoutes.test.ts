import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mongo-independent route tests: the real router, auth middleware, controller and
// validators run against a mocked DayHistory model. They prove user scoping,
// status codes, and that invalid input never reaches the database.
const model = vi.hoisted(() => ({
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock('../src/models/DayHistory.model', () => ({ default: model }));

// requireAuth checks the token against the account's current session version. These tokens are the
// legacy shape (no `tv`), so an account at version 0 must keep accepting them.
vi.mock('../src/models/User.model', () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => ({ tokenVersion: 0 }) }) }) },
}));

import historyRoutes from '../src/routes/history.routes';

const SECRET = 'test-jwt-secret-1234567890';
const USER_A = '665f1c2e9b1e8a0000000001';
const USER_B = '665f1c2e9b1e8a0000000002';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/history', historyRoutes);

const tokenFor = (userId: string) => jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET);
const auth = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });

// 02:00 UTC Sep 30 = 07:30 Sep 30 in India (+330), 19:00 Sep 29 in Los Angeles (-420).
const NOW = new Date('2026-09-30T02:00:00Z');
const IST = 330;
const LA = -420;

const body = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-30',
  utcOffsetMinutes: IST,
  completedCount: 1,
  workDoneMinutes: 30,
  completedTasks: [{ taskId: '665f1c2e9b1e8a0012345678', title: 'Write report', estimatedMinutes: 30 }],
  ...over,
});

const get = (qs: string, userId = USER_A) => request(app).get(`/api/history?${qs}`).set(auth(userId));
const ist = (endDate = '2026-09-30', days = 7) => `days=${days}&endDate=${endDate}&utcOffsetMinutes=${IST}`;

const storedRows: Record<string, unknown>[] = [];

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  storedRows.length = 0;
  model.find.mockReset().mockImplementation((filter: { userId: string; date: { $in: string[] } }) => ({
    lean: async () => storedRows.filter((r) => r.userId === filter.userId && filter.date.$in.includes(r.date as string)),
  }));
  model.findOneAndUpdate
    .mockReset()
    .mockImplementation(async (filter: { userId: string; date: string }, update: { $set: Record<string, unknown> }) => ({
      userId: filter.userId,
      date: filter.date,
      ...update.$set,
    }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auth', () => {
  it('requires a token on every history route', async () => {
    expect((await request(app).get(`/api/history?${ist()}`)).status).toBe(401);
    expect((await request(app).put('/api/history/today').send(body())).status).toBe(401);
    expect((await request(app).put('/api/history/2026-09-29').send(body())).status).toBe(401);
    expect(model.find).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/history — one calendar-date contract', () => {
  it('returns a window ending at the declared local today', async () => {
    const res = await get(ist('2026-09-30', 3));

    expect(res.status).toBe(200);
    expect(res.body.history.map((e: { date: string }) => e.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });

  it('the same instant yields a different window per declared offset (Los Angeles is still on Sep 29)', async () => {
    const la = await get(`days=2&endDate=2026-09-29&utcOffsetMinutes=${LA}`);
    expect(la.status).toBe(200);
    expect(la.body.history.map((e: { date: string }) => e.date)).toEqual(['2026-09-28', '2026-09-29']);

    // The UTC/India date is NOT today for a Los Angeles client.
    expect((await get(`days=2&endDate=2026-09-30&utcOffsetMinutes=${LA}`)).status).toBe(400);
  });

  it('has no UTC fallback: a call without endDate and utcOffsetMinutes is rejected', async () => {
    for (const qs of ['', 'days=7', 'days=7&endDate=2026-09-30', `days=7&utcOffsetMinutes=${IST}`]) {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(expect.any(String));
    }
    expect(model.find).not.toHaveBeenCalled();
  });

  it('marks days without a record with updatedAt null, distinct from a stored zero day', async () => {
    storedRows.push({
      userId: USER_A, date: '2026-09-29', completedCount: 0, workDoneMinutes: 0, completedTasks: [],
      updatedAt: '2026-09-29T10:00:00.000Z',
    });

    const res = await get(ist('2026-09-30', 2));

    expect(res.body.history).toEqual([
      { date: '2026-09-29', completedCount: 0, workDoneMinutes: 0, completedTasks: [], updatedAt: '2026-09-29T10:00:00.000Z' },
      { date: '2026-09-30', completedCount: 0, workDoneMinutes: 0, completedTasks: [], updatedAt: null },
    ]);
  });

  it.each([
    ['days=abc'],
    ['days='],
    ['days=0'],
    ['days=-1'],
    ['days=7.5'],
    ['days=91'],
    ['days=7&days=8'],
    ['endDate=2026-02-30'],
    ['endDate=2026-10-05'],
    ['endDate=2026-09-30&endDate=2026-09-29'],
    ['utcOffsetMinutes=900'],
    ['utcOffsetMinutes=abc'],
    ['utcOffsetMinutes=330&utcOffsetMinutes=0'],
  ])('rejects %s (merged over a valid query) with 400 and never queries the database', async (extra) => {
    const key = extra.split('=')[0];
    const base = new URLSearchParams({ days: '7', endDate: '2026-09-30', utcOffsetMinutes: String(IST) });
    base.delete(key);
    const res = await get(`${base.toString()}&${extra}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(expect.any(String));
    expect(model.find).not.toHaveBeenCalled();
  });
});

describe('user isolation', () => {
  it("only ever reads and writes the authenticated user's rows", async () => {
    storedRows.push(
      { userId: USER_A, date: '2026-09-30', completedCount: 1, workDoneMinutes: 30, completedTasks: [{ taskId: 'a1', title: 'A task', estimatedMinutes: 30 }], updatedAt: 'x' },
      { userId: USER_B, date: '2026-09-30', completedCount: 2, workDoneMinutes: 5, completedTasks: [{ taskId: 'b1', title: 'B task', estimatedMinutes: 5 }], updatedAt: 'y' },
    );

    const a = await get(ist('2026-09-30', 1), USER_A);
    const b = await get(ist('2026-09-30', 1), USER_B);

    expect(a.body.history[0].completedTasks).toEqual([{ taskId: 'a1', title: 'A task', estimatedMinutes: 30 }]);
    expect(b.body.history[0].completedTasks).toEqual([{ taskId: 'b1', title: 'B task', estimatedMinutes: 5 }]);
    expect(model.find.mock.calls.map((c) => c[0].userId)).toEqual([USER_A, USER_B]);

    await request(app).put('/api/history/today').set(auth(USER_B)).send(body({ userId: USER_A }));
    expect(model.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId: USER_B, date: '2026-09-30' });
  });
});

describe('PUT /api/history/today', () => {
  it('stores a valid payload (the offset is validated, not persisted)', async () => {
    const res = await request(app).put('/api/history/today').set(auth(USER_A)).send(body());

    expect(res.status).toBe(200);
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ userId: USER_A, date: '2026-09-30' });
    expect(update.$set).toEqual({
      completedCount: 1,
      workDoneMinutes: 30,
      completedTasks: [{ taskId: '665f1c2e9b1e8a0012345678', title: 'Write report', estimatedMinutes: 30 }],
    });
  });

  it('is idempotent: re-sending the same snapshot writes the same document (no accumulation)', async () => {
    await request(app).put('/api/history/today').set(auth(USER_A)).send(body());
    await request(app).put('/api/history/today').set(auth(USER_A)).send(body());

    const [first, second] = model.findOneAndUpdate.mock.calls;
    expect(second).toEqual(first);
    expect(Object.keys(first[1])).toEqual(['$set']); // replace, never $inc
  });

  it("accepts a Los Angeles user's local today and rejects the UTC/India date for them", async () => {
    const ok = await request(app).put('/api/history/today').set(auth(USER_A)).send(body({ date: '2026-09-29', utcOffsetMinutes: LA }));
    expect(ok.status).toBe(200);
    expect(model.findOneAndUpdate.mock.calls[0][0].date).toBe('2026-09-29');

    model.findOneAndUpdate.mockClear();
    const bad = await request(app).put('/api/history/today').set(auth(USER_A)).send(body({ date: '2026-09-30', utcOffsetMinutes: LA }));
    expect(bad.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('requires the offset: a body without utcOffsetMinutes is rejected (no UTC fallback)', async () => {
    const { utcOffsetMinutes: _omit, ...noOffset } = body();
    const res = await request(app).put('/api/history/today').set(auth(USER_A)).send(noOffset);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/utcOffsetMinutes/);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['historical date', { date: '2026-09-20' }],
    ['future date', { date: '2026-10-02' }],
    ['impossible date', { date: '2026-02-30' }],
    ['missing date', { date: undefined }],
    ['out-of-range offset', { utcOffsetMinutes: 900 }],
    ['string offset', { utcOffsetMinutes: '330' }],
    ['negative count', { completedCount: -1 }],
    ['NaN minutes sent as null', { workDoneMinutes: null }],
    ['string count', { completedCount: '1' }],
    ['non-array tasks', { completedTasks: {} }],
    ['malformed task', { completedTasks: [{ taskId: '', title: '', estimatedMinutes: -1 }] }],
  ])('rejects %s with 400 and writes nothing', async (_label, over) => {
    const res = await request(app).put('/api/history/today').set(auth(USER_A)).send(body(over));

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(expect.any(String));
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects oversized completedTasks arrays', async () => {
    const tasks = Array.from({ length: 501 }, (_, i) => ({ taskId: `t${i}`, title: 'x', estimatedMinutes: 0 }));
    const res = await request(app)
      .put('/api/history/today')
      .set(auth(USER_A))
      .send(body({ completedCount: 501, workDoneMinutes: 0, completedTasks: tasks }));

    expect(res.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is not shadowed by the :date route', async () => {
    const res = await request(app).put('/api/history/today').set(auth(USER_A)).send(body({ date: '2026-09-25' }));
    expect(res.status).toBe(400); // today semantics apply, not backfill semantics
    expect(res.body.message).toMatch(/today/i);
  });
});

describe('PUT /api/history/:date (bounded backfill)', () => {
  it('accepts a snapshot for yesterday and stores it under the path date', async () => {
    const res = await request(app)
      .put('/api/history/2026-09-29')
      .set(auth(USER_A))
      .send(body({ date: undefined }));

    expect(res.status).toBe(200);
    expect(model.findOneAndUpdate.mock.calls[0][0]).toEqual({ userId: USER_A, date: '2026-09-29' });
  });

  it('requires the offset', async () => {
    const { utcOffsetMinutes: _omit, ...noOffset } = body({ date: undefined });
    const res = await request(app).put('/api/history/2026-09-29').set(auth(USER_A)).send(noOffset);

    expect(res.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['older than the retention window', '2026-09-01'],
    ['in the future', '2026-10-03'],
    ['not a date', 'banana'],
    ['an impossible date', '2026-02-30'],
  ])('rejects a date path that is %s', async (_label, date) => {
    const res = await request(app).put(`/api/history/${date}`).set(auth(USER_A)).send(body({ date: undefined }));

    expect(res.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a body date that disagrees with the path', async () => {
    const res = await request(app).put('/api/history/2026-09-29').set(auth(USER_A)).send(body({ date: '2026-09-28' }));
    expect(res.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('strict "today" over HTTP (exactly one date, around local midnight)', () => {
  // India local midnight into Oct 1 is 2026-09-30T18:30:00Z.
  const putToday = (date: string) => request(app).put('/api/history/today').set(auth(USER_A)).send(body({ date }));
  const getEnd = (endDate: string) => get(`days=1&endDate=${endDate}&utcOffsetMinutes=${IST}`);

  it.each([
    ['23:30 Sep 30', '2026-09-30T18:00:00Z', '2026-09-30', '2026-10-01'],
    ['23:59:59 Sep 30', '2026-09-30T18:29:59Z', '2026-09-30', '2026-10-01'],
    ['00:00:00 Oct 1', '2026-09-30T18:30:00Z', '2026-10-01', '2026-09-30'],
    ['00:15 Oct 1', '2026-09-30T18:45:00Z', '2026-10-01', '2026-09-30'],
    ['00:30 Oct 1', '2026-09-30T19:00:00Z', '2026-10-01', '2026-09-30'],
  ])('at %s only the real local date is accepted (PUT /today and GET endDate)', async (_label, instant, accepted, rejected) => {
    vi.setSystemTime(new Date(instant));

    expect((await putToday(accepted)).status).toBe(200);
    expect((await getEnd(accepted)).status).toBe(200);

    model.findOneAndUpdate.mockClear();
    model.find.mockClear();
    const badPut = await putToday(rejected);
    const badGet = await getEnd(rejected);

    expect(badPut.status).toBe(400);
    expect(badGet.status).toBe(400);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.find).not.toHaveBeenCalled();
  });

  it('date rejections carry a machine-readable code so clients can retry; payload errors do not', async () => {
    const notToday = await putToday('2026-09-29');
    expect(notToday.status).toBe(400);
    expect(notToday.body).toMatchObject({ code: 'DATE_NOT_TODAY' });

    const getNotToday = await getEnd('2026-09-29');
    expect(getNotToday.body).toMatchObject({ code: 'DATE_NOT_TODAY' });

    const outOfRange = await request(app).put('/api/history/2026-09-01').set(auth(USER_A)).send(body({ date: undefined }));
    expect(outOfRange.body).toMatchObject({ code: 'DATE_OUT_OF_RANGE' });

    const badPayload = await request(app).put('/api/history/today').set(auth(USER_A)).send(body({ completedCount: -1 }));
    expect(badPayload.status).toBe(400);
    expect(badPayload.body).not.toHaveProperty('code');
  });
});
