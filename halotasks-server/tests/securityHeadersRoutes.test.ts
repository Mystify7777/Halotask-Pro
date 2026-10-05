import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMITS } from '../src/config/rateLimits';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// The REAL src/app.ts — real middleware order, CORS, body limit, routers, limiters and error handler —
// with only the database models and web-push replaced. This is what proves the headers reach every kind
// of response and that the placement before cors() is what makes preflights carry them.

const ORIGIN = 'https://halotask-pro.vercel.app';

const BASELINE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
} as const;
const HSTS = 'max-age=15552000';

const taskFind = vi.hoisted(() => ({ fail: false }));
const savedEnv = { ...process.env };

async function loadApp(env: Record<string, string | undefined>): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = ORIGIN;
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.NODE_ENV;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findOne: async () => null,
      exists: async () => null,
      updateOne: async () => ({ matchedCount: 0 }),
      findById: () => ({ select: () => ({ lean: async () => ({ tokenVersion: 0 }) }) }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: () => {
        if (taskFind.fail) throw new Error('database exploded');
        const chain = { sort: () => chain, skip: () => chain, limit: async () => [] };
        return chain;
      },
      countDocuments: async () => 0,
    },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: { find: vi.fn(), findOneAndUpdate: vi.fn() } }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined, sendNotification: async () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const expectBaseline = (res: request.Response) => {
  for (const [name, value] of Object.entries(BASELINE)) expect(res.headers[name], name).toBe(value);
  expect(res.headers['x-powered-by']).toBeUndefined();
};

const bearer = () => ({ Authorization: `Bearer ${jwt.sign({ userId: 'u1', email: 'u@x.test', name: 'U' }, SECRET)}` });

beforeEach(() => {
  taskFind.fail = false;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

describe.each([
  ['production', { NODE_ENV: 'production' }, HSTS],
  ['development', { NODE_ENV: 'development' }, undefined],
  ['unset NODE_ENV', {}, undefined],
])('real app, %s', (_label, env, hsts) => {
  const expectEnvHeaders = (res: request.Response) => {
    expectBaseline(res);
    expect(res.headers['strict-transport-security']).toBe(hsts);
  };

  it('GET / — success, and its body and content type are unchanged', async () => {
    const res = await request(await loadApp(env)).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toBe('HaloTasks API running');
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expectEnvHeaders(res);
  });

  it('404', async () => {
    const res = await request(await loadApp(env)).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Route /nope not found' });
    expectEnvHeaders(res);
  });

  it('CORS preflight 204 — regression guard for mounting the headers BEFORE cors()', async () => {
    const res = await request(await loadApp(env))
      .options('/api/tasks')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBe(204);
    expectEnvHeaders(res);
    // …and the CORS answer itself is exactly what it was.
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('authorization,content-type');
  });

  it('401 — missing token, and invalid token', async () => {
    const app = await loadApp(env);
    const missing = await request(app).get('/api/tasks');
    const invalid = await request(app).get('/api/tasks').set('Authorization', 'Bearer nonsense');

    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ message: 'Authorization token is required' });
    expectEnvHeaders(missing);
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ message: 'Invalid or expired token' });
    expectEnvHeaders(invalid);
  });

  it('400 — malformed JSON', async () => {
    const res = await request(await loadApp(env))
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Request body is not valid JSON' });
    expectEnvHeaders(res);
  });

  it('413 — body over the 1mb limit', async () => {
    const res = await request(await loadApp(env))
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send({ data: 'x'.repeat(2 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ message: 'Request body is too large' });
    expectEnvHeaders(res);
  });

  it('429 — rate limited, with Retry-After still present', async () => {
    const app = await loadApp(env);
    const attempt = () => request(app).post('/api/auth/login').send({ email: 'a@x.test', password: 'wrong-password' });

    for (let i = 0; i < RATE_LIMITS.loginAccountIp.max; i += 1) expect((await attempt()).status).toBe(401);
    const res = await attempt();

    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expectEnvHeaders(res);
  });

  it('500 — the global error handler', async () => {
    taskFind.fail = true;
    const res = await request(await loadApp(env)).get('/api/tasks').set(bearer());

    expect(res.status).toBe(500);
    expectEnvHeaders(res);
  });

  it('an authenticated success response carries them too', async () => {
    const res = await request(await loadApp(env)).get('/api/tasks').set(bearer());

    expect(res.status).toBe(200);
    expectEnvHeaders(res);
  });
});

describe('existing behaviour is untouched', () => {
  it('keeps CORS (ACAO + credentials + Vary) on ordinary responses', async () => {
    const res = await request(await loadApp({ NODE_ENV: 'production' })).get('/').set('Origin', ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toMatch(/Origin/);
  });

  it('still fails closed in production without CLIENT_ORIGIN: no ACAO — but the security headers are there', async () => {
    const res = await request(await loadApp({ NODE_ENV: 'production', CLIENT_ORIGIN: undefined }))
      .get('/')
      .set('Origin', 'https://anything.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expectBaseline(res);
    expect(res.headers['strict-transport-security']).toBe(HSTS);
  });

  it('keeps ETag / 304 revalidation (no Cache-Control added), and the 304 carries the headers', async () => {
    const app = await loadApp({ NODE_ENV: 'production' });
    const first = await request(app).get('/');
    const etag = first.headers['etag'];

    expect(etag).toBeTruthy();
    expect(first.headers['cache-control']).toBeUndefined();

    const second = await request(app).get('/').set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.headers['cache-control']).toBeUndefined();
    expectBaseline(second);
  });
});
