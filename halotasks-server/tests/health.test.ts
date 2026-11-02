import express, { type Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthRouter } from '../src/routes/health.routes';

// Issue #12: the public readiness probe the login and register pages poll while a sleeping host wakes up.

const appWith = (readyState: number) => {
  const app = express();
  app.use('/api/health', createHealthRouter(() => readyState));
  return app;
};

describe('GET /api/health (the router)', () => {
  it('answers 200 { status: "ok" } when the database connection is up', async () => {
    const res = await request(appWith(1)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it.each([
    [0, 'disconnected'],
    [2, 'connecting'],
    [3, 'disconnecting'],
    [99, 'uninitialized'],
  ])('answers 503 { status: "unavailable" } while the database state is %i (%s), never "ok"', async (state) => {
    const res = await request(appWith(state)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  it('is never cached, so a stale "ok" cannot be replayed to a client waiting for the real answer', async () => {
    for (const state of [1, 0]) {
      const res = await request(appWith(state)).get('/api/health');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('exposes nothing but the status: no user, task, version, environment or error detail', async () => {
    for (const state of [1, 0]) {
      const res = await request(appWith(state)).get('/api/health');
      expect(Object.keys(res.body)).toEqual(['status']);
    }
  });

  it('answers the current state on every request, not the state at startup', async () => {
    let state = 0;
    const app = express();
    app.use('/api/health', createHealthRouter(() => state));
    expect((await request(app).get('/api/health')).status).toBe(503);
    state = 1;
    expect((await request(app).get('/api/health')).status).toBe(200);
    state = 0;
    expect((await request(app).get('/api/health')).status).toBe(503);
  });

  it('only answers GET', async () => {
    const app = appWith(1);
    for (const method of ['post', 'put', 'delete'] as const) {
      expect((await request(app)[method]('/api/health')).status).toBe(404);
    }
  });
});

// (the dynamic import is typed as CommonJS here, so its `default` needs this cast)
const loadApp = async (): Promise<Express> => ((await import('../src/app.js')) as unknown as { default: Express }).default;

describe('GET /api/health (as mounted in src/app.ts)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is reachable without a session and without touching any authenticated route', async () => {
    const app = await loadApp();
    // No Authorization header at all: a 401 here would mean the probe sits behind requireAuth.
    const res = await request(app).get('/api/health');
    // These tests never connect to MongoDB, so the real mongoose state is "disconnected".
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  it('reports ok through the real app once the database is connected', async () => {
    const app = await loadApp();
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
