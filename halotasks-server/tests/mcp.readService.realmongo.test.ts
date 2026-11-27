import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';
import { getProjectContextForUser, getProjectSummaryForUser, getTaskForUser, listSubtasksForUser, listTasksForUser } from '../src/mcp/readService';
import { personalScope } from '../src/mcp/scope';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';

// Issue #66 (MCP Phase 1) against a REAL MongoDB (MongoMemoryServer): what tests/mcp.routes.test.ts cannot prove with its
// in-memory Task double, namely that the real filters, projections, aggregations and the real due-date range queries behave
// as the read service assumes, and that the whole stack (real requireAuth, real models) is owner-scoped. Needs a MongoDB
// binary (like the other *.realmongo tests); CI is the gate, it is not skipped when one is unavailable.

let mongoServer: MongoMemoryServer;
let app: import('express').Express;
let a: { id: string; token: string };
let b: { id: string; token: string };

const makeUser = async (label: string, timeZone?: string) => {
  const user = await User.create({ name: label, email: `${label}-${new mongoose.Types.ObjectId()}@mail.com`, passwordHash: 'x', ...(timeZone ? { timeZone } : {}) });
  const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
  return { id: user.id as string, token };
};
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  process.env.MCP_ENABLED = 'true';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = ((await import('../src/app.js')) as unknown as { default: import('express').Express }).default;
});

beforeEach(async () => {
  await User.deleteMany({});
  await Task.deleteMany({});
  resetAllRateLimiters();
  a = await makeUser('a', 'Asia/Kolkata');
  b = await makeUser('b');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('read service on a real database', () => {
  it('lists, gets and reads subtasks only for the owner; another user\'s id is "not found"', async () => {
    const mine = await Task.create({ userId: a.id, title: 'mine', tags: ['x'], subtasks: [{ id: 's1', title: 's', completed: false }] });
    const theirs = await Task.create({ userId: b.id, title: 'theirs', tags: ['x'], subtasks: [{ id: 's2', title: 't', completed: false }] });
    const list = await listTasksForUser(personalScope(a.id), { tag: 'x' });
    expect(list.tasks.map((task) => String(task._id))).toEqual([String(mine._id)]);
    expect(list.total).toBe(1);
    expect(await getTaskForUser(personalScope(a.id), String(theirs._id))).toBeNull();
    expect(await listSubtasksForUser(personalScope(a.id), String(theirs._id))).toBeNull();
    expect((await listSubtasksForUser(personalScope(b.id), String(theirs._id)))?.subtasks).toHaveLength(1);
    const context = await getProjectContextForUser(personalScope(a.id));
    expect(context.taskCounts.total).toBe(1);
    expect(context.tags).toEqual([{ tag: 'x', count: 1 }]);
  });

  it('the projection is an allow-list on a real stored document: internal fields never come back', async () => {
    const task = await Task.create({ userId: a.id, title: 'visible' });
    await Task.collection.updateOne(
      { _id: task._id },
      { $set: { reminderSent: true, completionId: 'srv-secret', clientKey: 'local-secret', appliedMutations: [{ id: 'm', fp: 'f' }] } },
    );
    const got = (await getTaskForUser(personalScope(a.id), String(task._id))) as Record<string, unknown>;
    const listed = (await listTasksForUser(personalScope(a.id))).tasks[0] as Record<string, unknown>;
    for (const doc of [got, listed]) {
      expect(doc.title).toBe('visible');
      for (const secret of ['userId', 'reminderSent', 'completionId', 'clientKey', 'appliedMutations', '__v']) expect(Object.keys(doc), secret).not.toContain(secret);
    }
  });

  it('pages newest first and, with identical createdAt, by _id, so a page boundary never repeats or skips', async () => {
    const stamp = new Date('2026-01-01T00:00:00Z');
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) ids.push(String((await Task.create({ userId: a.id, title: `t${n}`, createdAt: stamp }))._id));
    const seen: string[] = [];
    for (const page of [1, 2, 3]) seen.push(...(await listTasksForUser(personalScope(a.id), { page, limit: 2 })).tasks.map((task) => String(task._id)));
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('search is literal against the real regex engine (metacharacters escaped)', async () => {
    await Task.create({ userId: a.id, title: 'a.c' });
    await Task.create({ userId: a.id, title: 'abc' });
    await Task.create({ userId: a.id, title: 'price (usd)' });
    expect((await listTasksForUser(personalScope(a.id), { search: 'a.c' })).tasks.map((task) => task.title)).toEqual(['a.c']);
    expect((await listTasksForUser(personalScope(a.id), { search: '(usd' })).tasks).toHaveLength(1);
    expect((await listTasksForUser(personalScope(a.id), { search: '.*' })).tasks).toHaveLength(0);
  });

  it('the summary judges due dates as calendar days in the account zone, with the real range queries', async () => {
    await Task.create({ userId: a.id, title: 'today date-only', dueDate: day('2026-11-26') });
    await Task.create({ userId: a.id, title: 'yesterday', dueDate: day('2026-11-25') });
    await Task.create({ userId: a.id, title: 'tomorrow', dueDate: day('2026-11-27') });
    await Task.create({ userId: a.id, title: 'timed early', dueDate: day('2026-11-26'), dueTime: '09:00' }); // 03:30Z in India
    await Task.create({ userId: a.id, title: 'timed late', dueDate: day('2026-11-26'), dueTime: '18:00' }); // 12:30Z
    await Task.create({ userId: a.id, title: 'done', dueDate: day('2026-11-25'), completed: true });
    await Task.create({ userId: b.id, title: 'other user', dueDate: day('2026-11-25') });
    const out = await getProjectSummaryForUser(personalScope(a.id), new Date('2026-11-26T04:00:00Z')); // 09:30 in India
    expect(out.today).toBe('2026-11-26');
    expect(out.timeZone).toBe('Asia/Kolkata');
    expect(out.overdueOpenTasks).toBe(2); // yesterday + the 09:00 task whose deadline has passed
    expect(out.dueTodayOpenTasks).toBe(2); // the date-only task + the 18:00 task
    expect(out.upcomingDueTasks).toBe(1);
    expect(out.totalTasks).toBe(6);
    const late = await getProjectSummaryForUser(personalScope(a.id), new Date('2026-11-26T20:00:00Z')); // 01:30 on the 27th in India
    expect(late.today).toBe('2026-11-27');
    expect(late.overdueOpenTasks).toBe(4); // everything due on the 26th or earlier that is still open
  });

  it('context caps the tag list and orders it by count then name', async () => {
    for (let n = 0; n < 60; n += 1) await Task.create({ userId: a.id, title: `t${n}`, tags: [`tag${String(n).padStart(2, '0')}`] });
    await Task.create({ userId: a.id, title: 'popular', tags: ['tag59'] });
    const context = await getProjectContextForUser(personalScope(a.id));
    expect(context.tags).toHaveLength(50);
    expect(context.tags[0]).toEqual({ tag: 'tag59', count: 2 });
  });
});

describe('through the real app with the real auth', () => {
  const rpc = (token: string, body: object) =>
    request(app).post('/mcp').set({ Authorization: `Bearer ${token}` }).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').send(body);
  const data = (res: { text: string }) => JSON.parse(res.text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)).result;

  it('an authenticated user reads their own tasks over Streamable HTTP and never another user\'s', async () => {
    const mine = await Task.create({ userId: a.id, title: 'mine' });
    const theirs = await Task.create({ userId: b.id, title: 'theirs' });
    const list = data(await rpc(a.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'halo_list_tasks', arguments: {} } }));
    expect(JSON.parse(list.content[0].text).tasks.map((task: { _id: string }) => task._id)).toEqual([String(mine._id)]);
    const other = data(await rpc(a.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'halo_get_task', arguments: { taskId: String(theirs._id) } } }));
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toBe('Task not found.');
  });

  it('a session revoked by a password change (tokenVersion bump) stops working', async () => {
    await User.updateOne({ _id: a.id }, { $inc: { tokenVersion: 1 } });
    const res = await rpc(a.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });
});
