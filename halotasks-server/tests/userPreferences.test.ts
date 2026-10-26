import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #41 — the time zone preference and its place in the user response, against the REAL app with an in-memory User
// double. Mongo-free. The double records every update and THROWS on any shape other than a single $set / $unset of
// `timeZone`, so a regression that writes another field (or reads the id from the request) fails here. What it cannot
// prove is MongoDB's own storage and operator semantics: tests/userPreferences.realmongo.test.ts covers those.

type Row = Record<string, unknown> & { _id: string; name: string; email: string; passwordHash: string; tokenVersion: number };

const db = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; update: Record<string, unknown> }>,
  failNextUpdate: false,
}));
const users = db.users as unknown as Map<string, Row>;

const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';
const GONE = '665f1c2e9b1e8a00000000c3';
const PASSWORD = 'correct-horse';
let PASSWORD_HASH = '';

const seed = (id: string, extra: Record<string, unknown> = {}): Row => {
  const row = {
    _id: id,
    id,
    name: `User ${id.slice(-2)}`,
    email: `${id.slice(-2)}@x.test`,
    passwordHash: PASSWORD_HASH,
    tokenVersion: 0,
    treeState: { xp: 42, awardedTaskIds: ['t1'] },
    pushSubscriptions: [{ endpoint: 'https://push.example/1' }],
    ...extra,
  } as Row;
  users.set(id, row);
  return row;
};

const tokenFor = (id: string) =>
  jwt.sign({ userId: id, email: `${id.slice(-2)}@x.test`, name: 'N', tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (id: string) => ({ Authorization: `Bearer ${tokenFor(id)}` });

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;

  const project = (row: Row | undefined, fields: string[]) => {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const field of fields) if (field in row) out[field] = row[field];
    return out;
  };

  vi.doMock('../src/models/User.model', () => ({
    default: {
      // requireAuth reads the session generation; the preferences controller reads `timeZone`.
      findById: (id: string) => ({
        select: (fields: string) => ({ lean: async () => project(users.get(String(id)), fields.split(' ')) }),
      }),
      findOne: async (q: { email: string }) => [...users.values()].find((u) => u.email === q.email) ?? null,
      create: async (d: { name: string; email: string; passwordHash: string }) => {
        const row = seed(`665f1c2e9b1e8a00000000d${users.size}`.slice(0, 24), d);
        return { ...row, id: row._id, _id: { toString: () => row._id } };
      },
      findByIdAndUpdate: (id: string, update: Record<string, unknown>, options: Record<string, unknown>) => ({
        select: (fields: string) => ({
          lean: async () => {
            if (db.failNextUpdate) {
              db.failNextUpdate = false;
              throw new Error('simulated write failure');
            }
            const keys = Object.keys(update);
            const set = update.$set as Record<string, unknown> | undefined;
            const unset = update.$unset as Record<string, unknown> | undefined;
            const onlyTimeZone =
              keys.length === 1 &&
              ((keys[0] === '$set' && Object.keys(set ?? {}).join() === 'timeZone') ||
                (keys[0] === '$unset' && Object.keys(unset ?? {}).join() === 'timeZone'));
            if (!onlyTimeZone) throw new Error(`unexpected update shape ${JSON.stringify(update)}`);
            if (options.new !== true || options.runValidators !== true) throw new Error('expected new + runValidators');
            db.updates.push({ id: String(id), update });

            const row = users.get(String(id));
            if (!row) return null;
            if (set) row.timeZone = set.timeZone;
            if (unset) delete row.timeZone;
            return project(row, fields.split(' '));
          },
        }),
      }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  users.clear();
  db.updates.length = 0;
  db.failNextUpdate = false;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

describe('GET /api/user/preferences', () => {
  it('returns the saved time zone', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const res = await request(app).get('/api/user/preferences').set(as(A));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'Asia/Kolkata' });
  });

  it('a legacy account with no timeZone field reads as null (no migration needed, nothing is written)', async () => {
    seed(A);
    expect('timeZone' in users.get(A)!).toBe(false);
    const app = await loadApp();

    const res = await request(app).get('/api/user/preferences').set(as(A));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
    expect(db.updates).toEqual([]);
    expect('timeZone' in users.get(A)!).toBe(false);
  });

  it('is scoped to the caller: it returns the caller\'s zone, never another account\'s', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    seed(B, { timeZone: 'America/Los_Angeles' });
    const app = await loadApp();

    expect((await request(app).get('/api/user/preferences').set(as(A))).body).toEqual({ timeZone: 'Asia/Kolkata' });
    expect((await request(app).get('/api/user/preferences').set(as(B))).body).toEqual({ timeZone: 'America/Los_Angeles' });
  });

  it('ignores a userId in the query string', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    seed(B, { timeZone: 'America/Los_Angeles' });
    const app = await loadApp();

    const res = await request(app).get(`/api/user/preferences?userId=${B}&id=${B}`).set(as(A));

    expect(res.body).toEqual({ timeZone: 'Asia/Kolkata' });
  });

  it.each([
    ['no Authorization header', {}],
    ['a malformed header', { Authorization: 'Token abc' }],
    ['an invalid token', { Authorization: 'Bearer not.a.jwt' }],
  ])('is 401 with %s', async (_label, headers) => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const res = await request(app).get('/api/user/preferences').set(headers);

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('timeZone');
  });

  it('is 401 for a token whose account no longer exists', async () => {
    const app = await loadApp();

    const res = await request(app).get('/api/user/preferences').set(as(GONE));

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/user/preferences', () => {
  it.each(['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'])(
    'saves %s, answers with it, and a later read returns it',
    async (zone) => {
      seed(A);
      const app = await loadApp();

      const put = await request(app).put('/api/user/preferences').set(as(A)).send({ timeZone: zone });
      const get = await request(app).get('/api/user/preferences').set(as(A));

      expect(put.status).toBe(200);
      expect(put.body).toEqual({ timeZone: zone });
      expect(get.body).toEqual({ timeZone: zone });
      expect(db.updates).toEqual([{ id: A, update: { $set: { timeZone: zone } } }]);
    },
  );

  it('null clears the saved choice (the field is unset, not stored as a fallback)', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const res = await request(app).put('/api/user/preferences').set(as(A)).send({ timeZone: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
    expect('timeZone' in users.get(A)!).toBe(false);
    expect(db.updates).toEqual([{ id: A, update: { $unset: { timeZone: '' } } }]);
  });

  it('changes only timeZone: no other field of the account is touched', async () => {
    const before = JSON.stringify(seed(A, { timeZone: 'Asia/Kolkata' }));
    const app = await loadApp();

    await request(app).put('/api/user/preferences').set(as(A)).send({ timeZone: 'Europe/London' });

    const after = { ...users.get(A)! };
    expect(after.timeZone).toBe('Europe/London');
    delete after.timeZone;
    const expected = JSON.parse(before) as Record<string, unknown>;
    delete expected.timeZone;
    expect(JSON.parse(JSON.stringify(after))).toEqual(expected);
  });

  it('extra body fields are ignored: they cannot reach other fields or another account', async () => {
    seed(A);
    seed(B, { timeZone: 'America/Los_Angeles' });
    const app = await loadApp();

    const res = await request(app)
      .put('/api/user/preferences')
      .set(as(A))
      .send({ timeZone: 'Asia/Kolkata', userId: B, _id: B, tokenVersion: 99, email: 'evil@x.test', name: 'Evil', treeState: { xp: 1e9 } });

    expect(res.status).toBe(200);
    expect(users.get(B)!.timeZone).toBe('America/Los_Angeles');
    expect(users.get(A)).toMatchObject({ timeZone: 'Asia/Kolkata', tokenVersion: 0, name: `User ${A.slice(-2)}`, treeState: { xp: 42, awardedTaskIds: ['t1'] } });
    expect(db.updates.map((u) => u.id)).toEqual([A]);
  });

  it('is isolated: one account saving does not change another', async () => {
    seed(A);
    seed(B, { timeZone: 'America/Los_Angeles' });
    const app = await loadApp();

    await request(app).put('/api/user/preferences').set(as(A)).send({ timeZone: 'Asia/Kolkata' });

    expect((await request(app).get('/api/user/preferences').set(as(B))).body).toEqual({ timeZone: 'America/Los_Angeles' });
  });

  it.each([
    ['a fixed offset', { timeZone: '+05:30' }],
    ['an offset-style name', { timeZone: 'UTC+05:30' }],
    ['an unknown zone', { timeZone: 'Mars/Olympus_Mons' }],
    ['an empty string', { timeZone: '' }],
    ['a number', { timeZone: 330 }],
    ['an object', { timeZone: { $ne: null } }],
    ['an array', { timeZone: ['UTC'] }],
    ['a boolean', { timeZone: true }],
    ['an over-long value', { timeZone: `Asia/${'A'.repeat(100)}` }],
  ])('rejects %s with 400 and keeps the previous value', async (_label, body) => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const res = await request(app).put('/api/user/preferences').set(as(A)).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'timeZone must be a valid IANA time zone identifier, for example "Asia/Kolkata"' });
    expect(users.get(A)!.timeZone).toBe('Asia/Kolkata');
    expect(db.updates).toEqual([]);
  });

  it('rejects a body without timeZone (it must not silently do nothing)', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const res = await request(app).put('/api/user/preferences').set(as(A)).send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/timeZone is required/);
    expect(db.updates).toEqual([]);
  });

  // A bare JSON string is refused earlier, by the app's JSON parser (strict mode), with that parser's own message.
  it.each([
    ['no body at all', undefined, 'Request body must be a JSON object.'],
    ['a JSON array', '[1]', 'Request body must be a JSON object.'],
    ['a JSON string', '"UTC"', 'Request body is not valid JSON'],
  ])('rejects %s with the documented body message', async (_label, raw, message) => {
    seed(A);
    const app = await loadApp();

    const req = request(app).put('/api/user/preferences').set(as(A));
    const res = raw === undefined ? await req : await req.set('Content-Type', 'application/json').send(raw);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message });
    expect(db.updates).toEqual([]);
  });

  it('requires authentication and writes nothing without it', async () => {
    seed(A);
    const app = await loadApp();

    const res = await request(app).put('/api/user/preferences').send({ timeZone: 'Asia/Kolkata' });

    expect(res.status).toBe(401);
    expect(db.updates).toEqual([]);
  });

  it('a failed write is a 500 and the previous value is still what is stored', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();
    db.failNextUpdate = true;

    const res = await request(app).put('/api/user/preferences').set(as(A)).send({ timeZone: 'Europe/London' });

    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('timeZone');
    expect(users.get(A)!.timeZone).toBe('Asia/Kolkata');
  });
});

describe('authentication responses', () => {
  it('login returns the saved time zone', async () => {
    seed(A, { timeZone: 'Pacific/Kiritimati' });
    const app = await loadApp();

    const res = await request(app).post('/api/auth/login').send({ email: users.get(A)!.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: A, name: `User ${A.slice(-2)}`, email: users.get(A)!.email, timeZone: 'Pacific/Kiritimati' });
  });

  it('login for a legacy account returns timeZone: null (the field is absent in the database, not backfilled)', async () => {
    seed(A);
    const app = await loadApp();

    const res = await request(app).post('/api/auth/login').send({ email: users.get(A)!.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.timeZone).toBeNull();
    expect('timeZone' in users.get(A)!).toBe(false);
  });

  it('register returns timeZone: null for a new account and does not save a default', async () => {
    const app = await loadApp();

    const res = await request(app).post('/api/auth/register').send({ name: 'New', email: 'new@x.test', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.timeZone).toBeNull();
    expect([...users.values()].every((u) => !('timeZone' in u))).toBe(true);
  });

  it('the token carries no time zone: it is not a claim, and a token issued before a change stays valid and current', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();

    const login = await request(app).post('/api/auth/login').send({ email: users.get(A)!.email, password: PASSWORD });
    const claims = jwt.decode(login.body.token) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['email', 'exp', 'iat', 'name', 'tv', 'userId']);

    await request(app).put('/api/user/preferences').set({ Authorization: `Bearer ${login.body.token}` }).send({ timeZone: 'Europe/London' });
    const after = await request(app).get('/api/user/preferences').set({ Authorization: `Bearer ${login.body.token}` });
    expect(after.body).toEqual({ timeZone: 'Europe/London' });
  });
});
