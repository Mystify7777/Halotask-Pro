import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';
import { RATE_LIMITS } from '../src/config/rateLimits';

// Issue #66 (MCP Phase 1): the REAL app (requireAuth, the MCP limiter, the SDK's Streamable HTTP handler, the tool layer and
// readService) over strict in-memory User and Task doubles. The Task double interprets only the filter and pipeline shapes
// the read service is meant to use and THROWS on anything else, and it records every filter so a test can prove each query
// carried the owner. What it cannot prove is MongoDB's own filter/aggregation semantics: tests/mcp.readService.realmongo.test.ts
// covers that (needs a database; CI is the gate).

const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';
const T = (n: number) => `665f1c2e9b1e8a0000000${String(n).padStart(3, '0')}`; // 24-hex task ids

type Row = Record<string, unknown> & { _id: string; userId: string };

const db = vi.hoisted(() => ({
  users: new Map<string, { tokenVersion?: number; timeZone?: string }>(),
  tasks: [] as unknown[],
  filters: [] as Array<Record<string, unknown>>,
}));
const users = db.users;
const tasks = db.tasks as Row[];

const sign = (id: string, tv = 0) => jwt.sign({ userId: id, email: `${id.slice(-2)}@x.test`, name: 'U', tv }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (id: string, tv = 0) => ({ Authorization: `Bearer ${sign(id, tv)}` });

const ALLOWED_KEYS = ['userId', '_id', 'completed', 'priority', 'tags', '$or', 'dueDate'];
const idOf = (value: unknown) => String(value);

/** One filter the way MongoDB would apply it to one row, for exactly the shapes readService builds. */
const matches = (row: Row, filter: Record<string, unknown>): boolean => {
  for (const key of Object.keys(filter)) if (!ALLOWED_KEYS.includes(key)) throw new Error(`unexpected filter key ${key}`);
  if (!('userId' in filter)) throw new Error('a task query without an owner');
  if (idOf(filter.userId) !== row.userId) return false;
  if ('_id' in filter && idOf(filter._id) !== row._id) return false;
  if ('completed' in filter && filter.completed !== row.completed) return false;
  if ('priority' in filter && filter.priority !== row.priority) return false;
  if ('tags' in filter) {
    const want = filter.tags as string | { $regex: string; $options: string };
    const have = (row.tags as string[]) ?? [];
    if (typeof want === 'string') {
      if (!have.includes(want)) return false;
    } else throw new Error('unexpected tags filter');
  }
  if ('$or' in filter) {
    const clauses = filter.$or as Array<Record<string, { $regex: string; $options: string }>>;
    const ok = clauses.some((clause) => {
      const [field] = Object.keys(clause);
      const rx = new RegExp(clause[field].$regex, clause[field].$options);
      const value = row[field];
      return Array.isArray(value) ? value.some((v) => rx.test(String(v))) : rx.test(String(value ?? ''));
    });
    if (!ok) return false;
  }
  if ('dueDate' in filter) {
    const range = filter.dueDate as { $lt?: Date; $gte?: Date };
    const due = row.dueDate as Date | undefined;
    if (!due) return false;
    if (range.$lt && !(due.getTime() < range.$lt.getTime())) return false;
    if (range.$gte && !(due.getTime() >= range.$gte.getTime())) return false;
  }
  return true;
};

const project = (row: Row, fields: string | Record<string, 1>) => {
  const names = typeof fields === 'string' ? fields.split(' ') : Object.keys(fields);
  const out: Record<string, unknown> = {};
  for (const name of names) if (name in row) out[name] = row[name];
  return out;
};

const taskDouble = {
  find: (filter: Record<string, unknown>) => {
    db.filters.push(filter);
    let rows = tasks.filter((row) => matches(row, filter));
    let selected: string | Record<string, 1> | null = null;
    const q = {
      select: (fields: string | Record<string, 1>) => ((selected = fields), q),
      sort: (spec: Record<string, 1 | -1>) => {
        const keys = Object.keys(spec);
        rows = [...rows].sort((x, y) => {
          for (const k of keys) {
            const xv = x[k] instanceof Date ? (x[k] as Date).getTime() : (x[k] as string);
            const yv = y[k] instanceof Date ? (y[k] as Date).getTime() : (y[k] as string);
            if (xv < yv) return -spec[k];
            if (xv > yv) return spec[k];
          }
          return 0;
        });
        return q;
      },
      skip: (n: number) => ((rows = rows.slice(n)), q),
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      lean: async () => rows.map((row) => (selected ? project(row, selected) : { ...row })),
    };
    return q;
  },
  findOne: (filter: Record<string, unknown>) => {
    db.filters.push(filter);
    const row = tasks.find((candidate) => matches(candidate, filter));
    return { select: (fields: Record<string, 1>) => ({ lean: async () => (row ? project(row, fields) : null) }) };
  },
  countDocuments: async (filter: Record<string, unknown>) => {
    db.filters.push(filter);
    return tasks.filter((row) => matches(row, filter)).length;
  },
  aggregate: async (pipeline: Array<Record<string, unknown>>) => {
    const match = pipeline[0].$match as Record<string, unknown>;
    db.filters.push(match);
    const rows = tasks.filter((row) => matches(row, match));
    const group = pipeline.find((stage) => '$group' in stage)?.$group as { _id: string };
    const unwind = pipeline.some((stage) => '$unwind' in stage);
    const bucket = new Map<unknown, number>();
    for (const row of rows) {
      if (group._id === '$priority') bucket.set(row.priority, (bucket.get(row.priority) ?? 0) + 1);
      else if (group._id === '$completed') bucket.set(row.completed, (bucket.get(row.completed) ?? 0) + 1);
      else if (group._id === '$tags' && unwind) for (const tag of (row.tags as string[]) ?? []) bucket.set(tag, (bucket.get(tag) ?? 0) + 1);
      else throw new Error('unexpected pipeline');
    }
    const out = [...bucket.entries()].map(([key, count]) => ({ _id: key, count }));
    if (group._id === '$tags') out.sort((x, y) => y.count - x.count || String(x._id).localeCompare(String(y._id)));
    return out;
  },
};

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  process.env.MCP_ENABLED = 'true'; // the flag itself is tested, in isolation, in tests/mcp.flag.test.ts
  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: (id: unknown) => ({
        select: (fields: string) => ({
          lean: async () => {
            if (!['tokenVersion', 'timeZone'].includes(fields)) throw new Error(`unexpected user projection ${fields}`);
            const doc = users.get(idOf(id));
            if (!doc) return null;
            return fields === 'timeZone' ? { _id: idOf(id), timeZone: doc.timeZone } : { _id: idOf(id), tokenVersion: doc.tokenVersion };
          },
        }),
      }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: taskDouble }));
  vi.doMock('../src/models/CompletionRecord.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

let app: Express;
const mcp = (headers: Record<string, string>, body: object) =>
  request(app).post('/mcp').set(headers).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').send(body);

/** The SDK answers over Streamable HTTP as one SSE message; this reads its JSON payload. */
const payload = (res: { text: string }) => {
  const line = res.text.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) throw new Error(`no data line in: ${res.text.slice(0, 200)}`);
  return JSON.parse(line.slice(6)) as { result?: { tools?: Array<Record<string, unknown>>; content?: Array<{ text: string }>; isError?: boolean }; error?: unknown };
};
let rpcId = 0;
const call = async (id: string, name: string, args: object = {}) => {
  const res = await mcp(as(id), { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const result = payload(res).result!;
  return { isError: result.isError === true, text: result.content![0].text, json: () => JSON.parse(result.content![0].text) };
};

const seedTask = (owner: string, n: number, extra: Record<string, unknown> = {}): Row => {
  const row: Row = {
    _id: T(n),
    userId: owner,
    title: `Task ${n}`,
    description: '',
    completed: false,
    priority: 'medium',
    tags: [],
    subtasks: [],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
    // Internal fields that must NEVER reach an AI client:
    reminderSent: true,
    completionId: 'secret-completion-id',
    appliedMutations: [{ id: 'm1', fp: 'x' }],
    clientKey: 'local-secret',
    ...extra,
  };
  tasks.push(row);
  return row;
};

beforeEach(async () => {
  users.clear();
  tasks.length = 0;
  db.filters.length = 0;
  users.set(A, { tokenVersion: 0, timeZone: 'UTC' });
  users.set(B, { tokenVersion: 0 });
  app = await loadApp();
  resetAllRateLimiters();
});

describe('authentication', () => {
  it('rejects every method without a token', async () => {
    for (const method of ['post', 'get', 'delete', 'put'] as const) {
      const res = await request(app)[method]('/mcp');
      expect(res.status, method).toBe(401);
    }
  });

  it('rejects a bad signature, a revoked session (old tokenVersion) and a deleted account with the same 401', async () => {
    const forged = jwt.sign({ userId: A, email: 'a@x.test', name: 'U', tv: 0 }, 'not-the-secret', { algorithm: 'HS256' });
    users.get(A)!.tokenVersion = 1; // the user reset or changed the password: tv 0 tokens are revoked
    const stale = await mcp(as(A, 0), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const bad = await mcp({ Authorization: `Bearer ${forged}` }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    users.delete(B);
    const gone = await mcp(as(B), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    for (const res of [stale, bad, gone]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ message: 'Invalid or expired token' });
    }
  });

  it('a current token is accepted', async () => {
    const res = await mcp(as(A), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
  });
});

describe('tool surface', () => {
  it('lists exactly the five Phase 1 read tools, all annotated read-only, with no write tool and no scope/user argument', async () => {
    const res = await mcp(as(A), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = payload(res).result!.tools!;
    expect(tools.map((tool) => tool.name).sort()).toEqual(['halo_get_project_context', 'halo_get_project_summary', 'halo_get_task', 'halo_list_subtasks', 'halo_list_tasks']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      const properties = Object.keys(((tool.inputSchema as { properties?: object }).properties ?? {}));
      expect(properties).not.toContain('userId');
      expect(properties).not.toContain('scope');
      expect(properties).not.toContain('projectId');
    }
  });

  it('GET is not allowed (stateless, no standing stream)', async () => {
    const res = await request(app).get('/mcp').set(as(A));
    expect(res.status).toBe(405);
  });

  it.each([
    ['halo_list_tasks', { limit: 101 }],
    ['halo_list_tasks', { limit: 0 }],
    ['halo_list_tasks', { page: 0 }],
    ['halo_list_tasks', { priority: 'urgent' }],
    ['halo_list_tasks', { completed: 'yes' }],
    ['halo_list_tasks', { search: 'x'.repeat(201) }],
    ['halo_get_task', {}],
    ['halo_get_task', { taskId: '' }],
    ['halo_get_task', { taskId: 'x'.repeat(101) }],
    ['halo_list_subtasks', { taskId: 42 }],
  ])('rejects invalid input for %s %j without touching the database', async (name, args) => {
    const result = await call(A, name, args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Input validation error/);
    expect(db.filters).toHaveLength(0);
  });
});

describe('user isolation', () => {
  beforeEach(() => {
    seedTask(A, 1, { title: 'A one', tags: ['x'], priority: 'high', description: 'alpha' });
    seedTask(A, 2, { title: 'A two', completed: true });
    seedTask(B, 3, { title: 'B secret', tags: ['x'], priority: 'high', description: 'alpha', subtasks: [{ id: 's1', title: 'b sub', completed: false }] });
  });

  it('list never returns another user\'s task, whatever the filter, and the count is the owner\'s', async () => {
    for (const args of [{}, { tag: 'x' }, { priority: 'high' }, { search: 'alpha' }, { search: 'secret' }, { completed: false }]) {
      const result = await call(A, 'halo_list_tasks', args);
      const body = result.json();
      expect(JSON.stringify(body.tasks)).not.toContain('B secret');
      expect(body.tasks.every((task: { _id: string }) => [T(1), T(2)].includes(task._id))).toBe(true);
    }
    expect((await call(A, 'halo_list_tasks')).json().total).toBe(2);
    expect((await call(B, 'halo_list_tasks')).json().total).toBe(1);
  });

  it('getting or listing the subtasks of another user\'s task by id is "not found", the same answer as a nonexistent id', async () => {
    const other = await call(A, 'halo_get_task', { taskId: T(3) });
    const missing = await call(A, 'halo_get_task', { taskId: T(999) });
    const malformed = await call(A, 'halo_get_task', { taskId: 'not-an-object-id' });
    for (const result of [other, missing, malformed]) {
      expect(result.isError).toBe(true);
      expect(result.text).toBe('Task not found.');
    }
    const subs = await call(A, 'halo_list_subtasks', { taskId: T(3) });
    expect(subs.isError).toBe(true);
    expect(subs.text).toBe('Task not found.');
    expect((await call(B, 'halo_list_subtasks', { taskId: T(3) })).json().subtasks).toHaveLength(1);
  });

  it('context and summary count only the owner\'s tasks', async () => {
    const context = (await call(A, 'halo_get_project_context')).json();
    expect(context.taskCounts).toEqual({ total: 2, completed: 1, open: 1 });
    expect(context.tags).toEqual([{ tag: 'x', count: 1 }]);
    const summary = (await call(A, 'halo_get_project_summary')).json();
    expect(summary.totalTasks).toBe(2);
    expect(JSON.stringify(summary)).not.toContain('B secret');
  });

  it('a userId (or any identity) passed as a tool ARGUMENT changes nothing: the scope comes from the token', async () => {
    const result = await call(A, 'halo_list_tasks', { userId: B, scope: { kind: 'personal', userId: B } });
    const ids = result.json().tasks.map((task: { _id: string }) => task._id);
    expect(ids.sort()).toEqual([T(1), T(2)]);
  });

  it('EVERY task query the tools make carries the authenticated owner (the double throws on one that does not)', async () => {
    await call(A, 'halo_list_tasks', { search: 'a', tag: 'x', completed: false });
    await call(A, 'halo_get_task', { taskId: T(1) });
    await call(A, 'halo_list_subtasks', { taskId: T(1) });
    await call(A, 'halo_get_project_context');
    await call(A, 'halo_get_project_summary');
    expect(db.filters.length).toBeGreaterThan(8);
    for (const filter of db.filters) expect(String(filter.userId)).toBe(A);
  });
});

describe('what reaches the client', () => {
  it('projects an allow-list: no userId, no internal fields, in tasks, one task, or the context', async () => {
    seedTask(A, 1, { title: 'visible', subtasks: [{ id: 's', title: 'sub', completed: false }] });
    const outputs = [
      (await call(A, 'halo_list_tasks')).text,
      (await call(A, 'halo_get_task', { taskId: T(1) })).text,
      (await call(A, 'halo_list_subtasks', { taskId: T(1) })).text,
      (await call(A, 'halo_get_project_context')).text,
      (await call(A, 'halo_get_project_summary')).text,
    ];
    for (const text of outputs) {
      for (const secret of ['userId', 'reminderSent', 'completionId', 'secret-completion-id', 'appliedMutations', 'clientKey', 'local-secret', A]) {
        expect(text, secret).not.toContain(secret);
      }
    }
    expect((await call(A, 'halo_get_task', { taskId: T(1) })).json().title).toBe('visible');
  });
});

describe('listing', () => {
  it('pages newest first with a stable order, reports total and hasMore, and clamps nothing silently', async () => {
    for (let n = 1; n <= 5; n += 1) seedTask(A, n, { createdAt: new Date(Date.UTC(2026, 0, 1)) }); // identical createdAt: _id breaks the tie
    const first = (await call(A, 'halo_list_tasks', { limit: 2, page: 1 })).json();
    const second = (await call(A, 'halo_list_tasks', { limit: 2, page: 2 })).json();
    const third = (await call(A, 'halo_list_tasks', { limit: 2, page: 3 })).json();
    const ids = [...first.tasks, ...second.tasks, ...third.tasks].map((task: { _id: string }) => task._id);
    expect(ids).toEqual([T(5), T(4), T(3), T(2), T(1)]); // each exactly once
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect(first.total).toBe(5);
  });

  it('defaults to 20 per page', async () => {
    for (let n = 1; n <= 25; n += 1) seedTask(A, n);
    const body = (await call(A, 'halo_list_tasks')).json();
    expect(body.limit).toBe(20);
    expect(body.tasks).toHaveLength(20);
    expect(body.hasMore).toBe(true);
  });

  it('search is a literal match: regex metacharacters are escaped, not interpreted', async () => {
    seedTask(A, 1, { title: 'a.c' });
    seedTask(A, 2, { title: 'abc' });
    seedTask(A, 3, { title: 'price (usd)' });
    const dot = (await call(A, 'halo_list_tasks', { search: 'a.c' })).json();
    expect(dot.tasks.map((task: { title: string }) => task.title)).toEqual(['a.c']);
    const paren = await call(A, 'halo_list_tasks', { search: '(usd' });
    expect(paren.isError).toBe(false);
    expect(paren.json().tasks.map((task: { title: string }) => task.title)).toEqual(['price (usd)']);
    expect((await call(A, 'halo_list_tasks', { search: '.*' })).json().tasks).toHaveLength(0);
  });
});

describe('summary dates (due dates are calendar days in the user\'s zone, Issues #41/#42)', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`); // a stored dueDate names its UTC date part
  const summary = async (now: string) => {
    const { getProjectSummaryForUser } = (await import('../src/mcp/readService.js')) as typeof import('../src/mcp/readService');
    return getProjectSummaryForUser({ kind: 'personal', userId: A }, new Date(now));
  };

  it('a date-only task due TODAY is not overdue, however late in the day; yesterday is overdue; tomorrow is upcoming', async () => {
    seedTask(A, 1, { dueDate: day('2026-11-26') });
    seedTask(A, 2, { dueDate: day('2026-11-25') });
    seedTask(A, 3, { dueDate: day('2026-11-27') });
    seedTask(A, 4, { dueDate: day('2026-11-26'), completed: true }); // completed tasks are never open work
    for (const now of ['2026-11-26T00:00:01Z', '2026-11-26T12:00:00Z', '2026-11-26T23:59:59Z']) {
      const out = await summary(now);
      expect(out.today, now).toBe('2026-11-26');
      expect([out.overdueOpenTasks, out.dueTodayOpenTasks, out.upcomingDueTasks], now).toEqual([1, 1, 1]);
    }
  });

  it('a timed task due today is overdue only once its exact deadline in the user\'s zone has passed', async () => {
    users.get(A)!.timeZone = 'Asia/Kolkata'; // UTC+5:30
    seedTask(A, 1, { dueDate: day('2026-11-26'), dueTime: '09:00' }); // 03:30Z
    seedTask(A, 2, { dueDate: day('2026-11-26'), dueTime: '18:00' }); // 12:30Z
    const before = await summary('2026-11-26T03:00:00Z');
    expect([before.overdueOpenTasks, before.dueTodayOpenTasks]).toEqual([0, 2]);
    const between = await summary('2026-11-26T04:00:00Z');
    expect([between.overdueOpenTasks, between.dueTodayOpenTasks]).toEqual([1, 1]);
    const after = await summary('2026-11-26T13:00:00Z');
    expect([after.overdueOpenTasks, after.dueTodayOpenTasks]).toEqual([2, 0]);
  });

  it('"today" is the day in the account\'s zone, not UTC: 20:00Z is already the next day in India', async () => {
    users.get(A)!.timeZone = 'Asia/Kolkata';
    seedTask(A, 1, { dueDate: day('2026-11-26') });
    const out = await summary('2026-11-26T20:00:00Z'); // 01:30 on the 27th in India
    expect(out.today).toBe('2026-11-27');
    expect(out.timeZone).toBe('Asia/Kolkata');
    expect(out.overdueOpenTasks).toBe(1);
  });

  it('an account without a (valid) time zone is read as UTC and the answer says so', async () => {
    delete users.get(A)!.timeZone;
    expect((await summary('2026-11-26T12:00:00Z')).timeZone).toBe('UTC');
    users.get(A)!.timeZone = 'Mars/Olympus';
    expect((await summary('2026-11-26T12:00:00Z')).timeZone).toBe('UTC');
  });

  it('refuses a scope that is not a personal scope with a valid id', async () => {
    const { getProjectSummaryForUser, listTasksForUser } = (await import('../src/mcp/readService.js')) as typeof import('../src/mcp/readService');
    await expect(listTasksForUser({ kind: 'project', userId: A } as never)).rejects.toThrow('Invalid MCP scope');
    await expect(getProjectSummaryForUser({ kind: 'personal', userId: 'nope' })).rejects.toThrow('Invalid MCP scope');
    expect(db.filters).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('limits per user after authentication: the 121st request in a minute is 429, and an unauthenticated one never counts', async () => {
    for (let i = 0; i < 20; i += 1) await request(app).get('/mcp'); // no token: 401, not counted against anyone
    const max = RATE_LIMITS.mcpUser.max;
    for (let i = 0; i < max; i += 1) {
      const res = await request(app).get('/mcp').set(as(A));
      expect(res.status).toBe(405);
    }
    const limited = await request(app).get('/mcp').set(as(A));
    expect(limited.status).toBe(429);
    const other = await request(app).get('/mcp').set(as(B)); // another user is unaffected (same IP, well under the IP limit)
    expect(other.status).toBe(405);
  });
});

describe('structure (no direct database access from the MCP handlers, no write surface)', () => {
  const src = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

  it('the route and the tool layer import no model and no mongoose; only readService does', () => {
    for (const file of ['routes/mcp.routes.ts', 'mcp/server.ts', 'mcp/scope.ts']) {
      expect(src(file), file).not.toMatch(/models\//);
      expect(src(file), file).not.toMatch(/from ['"]mongoose['"]/);
    }
    expect(src('mcp/readService.ts')).toMatch(/models\/Task\.model/);
  });

  it('readService contains no write operation', () => {
    expect(src('mcp/readService.ts')).not.toMatch(/\.(create|insertMany|insertOne|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|deleteOne|deleteMany|findOneAndDelete|save|bulkWrite)\(/);
  });

  it('the MCP route authenticates and rate-limits BEFORE the handler, in that order', () => {
    const route = src('routes/mcp.routes.ts');
    expect(route.indexOf('router.use(requireAuth)')).toBeGreaterThan(-1);
    expect(route.indexOf('router.use(requireAuth)')).toBeLessThan(route.indexOf('router.use(mcpLimiter)'));
    expect(route.indexOf('router.use(mcpLimiter)')).toBeLessThan(route.indexOf("router.all("));
  });
});
