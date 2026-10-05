import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express, NextFunction, Request, Response, Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #21 — the authentication boundary, against the REAL app (real routers, middleware, controllers and
// limiters) with only the database models and web-push replaced. Mongo-free. Covers:
//   * Authorization header handling (current behaviour pinned, including the case-sensitive "Bearer ")
//   * the JWT payload shape check and the HS256 pin, and that malformed tokens are refused BEFORE any lookup
//   * every protected route still refuses unauthenticated requests
//   * the authenticated() adapter's fail-closed behaviour

const calls = vi.hoisted(() => ({ authLookups: 0, taskFinds: 0, userWrites: 0 }));
const PASSWORD = 'correct-horse';
let PASSWORD_HASH = '';
const ACCOUNT_ID = '665f1c2e9b1e8a00000000aa';

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;

  vi.doMock('../src/models/User.model', () => {
    const account = { _id: { toString: () => ACCOUNT_ID }, id: ACCOUNT_ID, name: 'A', email: 'a@x.test', passwordHash: PASSWORD_HASH, tokenVersion: 0 };
    const chain = (value: unknown) => ({
      select: () => {
        const result = Promise.resolve(value) as Promise<unknown> & { lean: () => Promise<unknown> };
        result.lean = async () => value;
        return result;
      },
    });
    return {
      default: {
        findOne: async () => account,
        findById: () => {
          calls.authLookups += 1;
          return chain({ tokenVersion: 0, treeState: {}, pushSubscriptions: [] });
        },
        updateOne: async () => {
          calls.userWrites += 1;
          return { matchedCount: 1 };
        },
        findByIdAndUpdate: async () => {
          calls.userWrites += 1;
          return null;
        },
        exists: async () => null,
      },
    };
  });
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: () => {
        calls.taskFinds += 1;
        const c: Record<string, unknown> = {};
        c.sort = () => c;
        c.skip = () => c;
        c.limit = async () => [];
        return c;
      },
      countDocuments: async () => 0,
    },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({
    default: { find: () => ({ lean: async () => [] }), findOneAndUpdate: async () => ({}) },
  }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined, sendNotification: async () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const claims = { userId: ACCOUNT_ID, email: 'a@x.test', name: 'A' };
const sign = (payload: object | string, options: jwt.SignOptions = {}, secret = SECRET) => jwt.sign(payload, secret, options);
const GENERIC = { message: 'Invalid or expired token' };
const MISSING = { message: 'Authorization token is required' };

beforeEach(() => {
  calls.authLookups = 0;
  calls.taskFinds = 0;
  calls.userWrites = 0;
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

const get = (app: Express, header?: string) => {
  const req = request(app).get('/api/tasks');
  return header === undefined ? req : req.set('Authorization', header);
};

describe('Authorization header handling (current behaviour, pinned)', () => {
  it.each([
    ['is missing', undefined, MISSING],
    ['uses another scheme (Basic)', 'Basic YWxpY2U6c2VjcmV0', MISSING],
    ['is just "Bearer"', 'Bearer', MISSING],
    ['is "Bearer " with an empty token', 'Bearer ', MISSING],
    ['is an empty string', '', MISSING],
    ['uses a lower-case scheme (the match is deliberately case-sensitive)', `bearer ${sign(claims)}`, MISSING],
    ['uses an upper-case scheme', `BEARER ${sign(claims)}`, MISSING],
    ['has no scheme, only the token', sign(claims), MISSING],
    ['has two spaces after the scheme', `Bearer  ${sign(claims)}`, GENERIC],
    ['has trailing text after the token', `Bearer ${sign(claims)} extra`, GENERIC],
    ['carries something that is not a JWT', 'Bearer not-a-jwt', GENERIC],
    ['carries a JWT with only two segments', `Bearer ${sign(claims).split('.').slice(0, 2).join('.')}`, GENERIC],
    ['carries an expired token', `Bearer ${sign(claims, { expiresIn: -10 })}`, GENERIC],
    ['carries a token signed with another secret', `Bearer ${sign(claims, {}, 'some-other-secret')}`, GENERIC],
  ])('401 — header %s', async (_label, header, body) => {
    const app = await loadApp();

    const res = await get(app, header);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(body);
    expect(calls.taskFinds).toBe(0); // never reached a handler
    expect(calls.authLookups).toBe(0); // and never cost a database read
  });

  it('accepts a well-formed header with a valid token', async () => {
    const app = await loadApp();

    const res = await get(app, `Bearer ${sign(claims)}`);

    expect(res.status).toBe(200);
    expect(calls.authLookups).toBe(1);
  });

  it('a Bearer token is read from the header only (not from query or body)', async () => {
    const app = await loadApp();

    const res = await request(app).get(`/api/tasks?token=${sign(claims)}&authorization=Bearer%20${sign(claims)}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(MISSING);
  });
});

describe('JWT payload shape and algorithm', () => {
  it.each([
    ['userId missing', { email: 'a@x.test', name: 'A' }],
    ['userId empty', { ...claims, userId: '' }],
    ['userId a number', { ...claims, userId: 5 }],
    ['userId an object', { ...claims, userId: { $ne: null } }],
    ['userId an array', { ...claims, userId: [ACCOUNT_ID] }],
    ['email missing', { userId: ACCOUNT_ID, name: 'A' }],
    ['email a number', { ...claims, email: 5 }],
    ['name missing', { userId: ACCOUNT_ID, email: 'a@x.test' }],
    ['name an object', { ...claims, name: {} }],
    ['tv a string', { ...claims, tv: '0' }],
    ['tv a fraction', { ...claims, tv: 1.5 }],
    ['tv negative', { ...claims, tv: -1 }],
    ['tv null', { ...claims, tv: null }],
    ['no identity claims at all', { sub: 'someone' }],
  ])('401 with the generic body and NO database lookup — %s', async (_label, payload) => {
    const app = await loadApp();

    const res = await get(app, `Bearer ${sign(payload)}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(calls.authLookups).toBe(0);
    expect(calls.taskFinds).toBe(0);
  });

  it('rejects a token whose payload is a bare string rather than an object', async () => {
    const app = await loadApp();

    const res = await get(app, `Bearer ${sign('just-a-string')}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(calls.authLookups).toBe(0);
  });

  it.each([
    ['without tv (issued before Issue #27)', claims],
    ['with tv 0', { ...claims, tv: 0 }],
    ['with extra, unused claims', { ...claims, role: 'admin' }],
  ])('still accepts a valid token %s', async (_label, payload) => {
    const app = await loadApp();

    const res = await get(app, `Bearer ${sign(payload)}`);

    expect(res.status).toBe(200);
    expect(calls.authLookups).toBe(1);
  });

  it.each(['HS384', 'HS512'] as const)('rejects a token signed with %s even with the right secret, before any lookup', async (algorithm) => {
    const app = await loadApp();

    const res = await get(app, `Bearer ${sign(claims, { algorithm })}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(calls.authLookups).toBe(0);
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const app = await loadApp();
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

    const res = await get(app, `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`);

    expect(res.status).toBe(401);
    expect(calls.authLookups).toBe(0);
  });

  it('tokens the server itself signs are HS256 and are accepted', async () => {
    PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
    const app = await loadApp();

    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.test', password: PASSWORD });
    expect(login.status).toBe(200);

    const decoded = jwt.decode(login.body.token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    expect((await get(app, `Bearer ${login.body.token}`)).status).toBe(200);
  });
});

describe('every protected route is still guarded', () => {
  // The complete protected surface, spelled out. The structural test below fails if a route is added to a
  // protected router and not listed here, so this table cannot silently fall behind.
  const PROTECTED: Array<[method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string]> = [
    ['get', '/api/tasks'],
    ['post', '/api/tasks'],
    ['put', '/api/tasks/665f1c2e9b1e8a00000000bb'],
    ['delete', '/api/tasks/665f1c2e9b1e8a00000000bb'],
    ['get', '/api/history'],
    ['put', '/api/history/today'],
    ['put', '/api/history/2026-10-01'],
    ['post', '/api/push/subscribe'],
    ['post', '/api/push/unsubscribe'],
    ['post', '/api/push/relay'],
    ['get', '/api/tree'],
    ['patch', '/api/tree'],
    ['post', '/api/ai/parse-tasks'],
  ];

  it.each(PROTECTED)('%s %s → 401 without a token, and no handler or model is touched', async (method, path) => {
    const app = await loadApp();

    const res = await request(app)[method](path).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual(MISSING);
    expect(calls.authLookups).toBe(0);
    expect(calls.taskFinds).toBe(0);
    expect(calls.userWrites).toBe(0);
  });

  it.each(PROTECTED)('%s %s → 401 with a malformed-payload token', async (method, path) => {
    const app = await loadApp();

    const res = await request(app)[method](path).set('Authorization', `Bearer ${sign({ userId: 5, email: 'a', name: 'A' })}`).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(calls.authLookups).toBe(0);
  });

  it('the protected routers are exactly the routes listed above, each behind requireAuth', async () => {
    vi.resetModules();
    process.env.JWT_SECRET = SECRET;
    vi.doMock('../src/models/User.model', () => ({ default: {} }));
    vi.doMock('../src/models/Task.model', () => ({ default: {} }));
    vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
    vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));
    const { requireAuth } = await import('../src/middleware/auth.middleware.js');

    type Layer = { handle: unknown; route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
    const found: string[] = [];

    const loaders = [
      ['/api/tasks', () => import('../src/routes/task.routes.js')],
      ['/api/history', () => import('../src/routes/history.routes.js')],
      ['/api/push', () => import('../src/routes/push.routes.js')],
      ['/api/tree', () => import('../src/routes/tree.routes.js')],
      ['/api/ai', () => import('../src/routes/ai.routes.js')],
    ] as const;

    for (const [prefix, load] of loaders) {
      const router = (await load() as unknown as { default: Router }).default;
      let routerLevelGuard = false;

      for (const layer of router.stack as unknown as Layer[]) {
        if (!layer.route) {
          if (layer.handle === requireAuth) routerLevelGuard = true;
          continue;
        }

        const chain = layer.route.stack.map((l) => l.handle);
        expect(routerLevelGuard || chain[0] === requireAuth, `${prefix}${layer.route.path} must be behind requireAuth`).toBe(true);
        for (const method of Object.keys(layer.route.methods)) {
          found.push(`${method} ${prefix}${layer.route.path}`.replace(/\/$/, ''));
        }
      }
    }

    const normalise = (p: string) => p.replace('665f1c2e9b1e8a00000000bb', ':id').replace('2026-10-01', ':date');
    const expected = PROTECTED.map(([m, p]) => `${m} ${normalise(p)}`);
    expect(found.sort()).toEqual(expected.sort());
  });
});

describe('authenticated() adapter', () => {
  const makeRes = () => {
    const res = { statusCode: 0, body: undefined as unknown, status: vi.fn(), json: vi.fn() };
    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json.mockImplementation((body: unknown) => {
      res.body = body;
      return res;
    });
    return res;
  };

  const adapter = async () => {
    vi.resetModules();
    vi.doMock('../src/models/User.model', () => ({ default: {} }));
    return (await import('../src/middleware/auth.middleware.js')).authenticated;
  };

  it.each([
    ['no user at all', {}],
    ['user null', { user: null }],
    ['user with no id', { user: { email: 'a', name: 'A' } }],
    ['user with an empty id', { user: { id: '', email: 'a', name: 'A' } }],
    ['user with a non-string id', { user: { id: 5, email: 'a', name: 'A' } }],
    ['user with no email', { user: { id: ACCOUNT_ID, name: 'A' } }],
    ['user with a non-string email', { user: { id: ACCOUNT_ID, email: 5, name: 'A' } }],
    ['user with no name', { user: { id: ACCOUNT_ID, email: 'a@x.test' } }],
    ['user with a non-string name', { user: { id: ACCOUNT_ID, email: 'a@x.test', name: null } }],
  ])('fails closed with 401 and never runs the handler — %s', async (_label, partial) => {
    const authenticated = await adapter();
    const handler = vi.fn();
    const res = makeRes();
    const next = vi.fn();

    await authenticated(handler)(partial as unknown as Request, res as unknown as Response, next as NextFunction);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(MISSING);
    expect(next).not.toHaveBeenCalled();
  });

  it('runs the handler with the very same request, response and next when a user is present', async () => {
    const authenticated = await adapter();
    const handler = vi.fn(async () => 'done');
    const req = { user: { id: ACCOUNT_ID, email: 'a@x.test', name: 'A' } };
    const res = makeRes();
    const next = vi.fn();

    await authenticated(handler)(req as unknown as Request, res as unknown as Response, next as NextFunction);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('propagates a rejection from an async handler (so Express 5 sends it to the error handler)', async () => {
    const authenticated = await adapter();
    const boom = new Error('boom');
    const wrapped = authenticated(async () => {
      throw boom;
    });
    const req = { user: { id: ACCOUNT_ID, email: 'a@x.test', name: 'A' } };

    await expect(wrapped(req as unknown as Request, makeRes() as unknown as Response, vi.fn() as NextFunction)).rejects.toBe(boom);
  });
});
