import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #21 — a missing or non-object request body is a 400 everywhere, never a 500. Express 5 leaves
// `req.body` undefined when no JSON body was sent, so any handler that casts it and reads a field used to
// throw. Real app, models replaced, Mongo-free. Task and auth bodies have their own suites
// (taskRoutes.test.ts, authInput.test.ts); this file covers the tree endpoint, pins the endpoints that
// already answered 400 (they now share the helper), and runs a cross-cutting sweep.

const calls = vi.hoisted(() => ({ treeReads: 0, writes: 0 }));
const BODY_MESSAGE = { message: 'Request body must be a JSON object.' };

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: () => ({
        select: (fields: string) => {
          if (fields !== 'tokenVersion') calls.treeReads += 1;
          const value = fields === 'tokenVersion' ? { tokenVersion: 0 } : { treeState: { xp: 10 } };
          const result = Promise.resolve(value) as Promise<unknown> & { lean: () => Promise<unknown> };
          result.lean = async () => value;
          return result;
        },
      }),
      findByIdAndUpdate: async () => {
        calls.writes += 1;
        return { treeState: {} };
      },
      updateOne: async () => {
        calls.writes += 1;
        return { matchedCount: 1 };
      },
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({
    default: { create: async () => { calls.writes += 1; return {}; }, findOne: async () => { calls.writes += 1; return null; } },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({
    default: { find: () => ({ lean: async () => [] }), findOneAndUpdate: async () => { calls.writes += 1; return {}; } },
  }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined, sendNotification: async () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const auth = { Authorization: `Bearer ${jwt.sign({ userId: '665f1c2e9b1e8a00000000aa', email: 'a@x.test', name: 'A' }, SECRET)}` };

beforeEach(() => {
  calls.treeReads = 0;
  calls.writes = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

describe('PATCH /api/tree', () => {
  it('rejects a request with no body: 400, and nothing is read or written', async () => {
    const app = await loadApp();

    const res = await request(app).patch('/api/tree').set(auth);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(BODY_MESSAGE);
    expect(calls.treeReads).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it.each([
    ['an array', '[1,2]'],
    ['a JSON string', '"xp"'],
    ['a number', '5'],
    ['null', 'null'],
  ])('rejects %s as the body', async (_label, raw) => {
    const app = await loadApp();

    const res = await request(app).patch('/api/tree').set(auth).set('Content-Type', 'application/json').send(raw);

    expect(res.status).toBe(400);
    expect(calls.treeReads).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it('rejects a text/plain body', async () => {
    const app = await loadApp();

    const res = await request(app).patch('/api/tree').set(auth).type('text').send('xp=5');

    expect(res.status).toBe(400);
    expect(res.body).toEqual(BODY_MESSAGE);
  });

  it('still accepts a normal JSON object (an empty one is a valid, no-op patch)', async () => {
    const app = await loadApp();

    const res = await request(app).patch('/api/tree').set(auth).send({ xp: 20, health: 'healthy' });

    expect(res.status).toBe(200);
    expect(calls.writes).toBe(1);
  });
});

describe('every body-taking endpoint answers a missing body with a 4xx, never a 500', () => {
  const ENDPOINTS: Array<[method: 'post' | 'put' | 'patch', path: string, authed: boolean]> = [
    ['post', '/api/auth/register', false],
    ['post', '/api/auth/login', false],
    ['post', '/api/auth/forgot-password', false],
    ['post', '/api/auth/reset-password', false],
    ['post', '/api/tasks', true],
    ['put', '/api/tasks/665f1c2e9b1e8a00000000bb', true],
    ['patch', '/api/tree', true],
    ['put', '/api/history/today', true],
    ['put', '/api/history/2026-10-01', true],
    ['post', '/api/push/subscribe', true],
    ['post', '/api/push/unsubscribe', true],
    ['post', '/api/push/relay', true],
    ['post', '/api/ai/parse-tasks', true],
  ];

  it.each(ENDPOINTS)('%s %s with no body', async (method, path, authed) => {
    const app = await loadApp();
    const req = request(app)[method](path);
    if (authed) req.set(auth);

    const res = await req;

    expect(res.status).toBe(400);
    expect(res.body).toEqual(BODY_MESSAGE);
    expect(calls.writes).toBe(0);
  });

  it.each(ENDPOINTS)('%s %s with a JSON array body', async (method, path, authed) => {
    const app = await loadApp();
    const req = request(app)[method](path).send([{ a: 1 }]);
    if (authed) req.set(auth);

    const res = await req;

    expect(res.status).toBe(400);
    expect(res.body).toEqual(BODY_MESSAGE);
    expect(calls.writes).toBe(0);
  });
});
