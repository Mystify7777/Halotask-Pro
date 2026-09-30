import express, { type Express } from 'express';
import cors from 'cors';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOrigin } from '../src/config/cors';
import { isMalformedJsonBodyError, isPayloadTooLargeError } from '../src/utils/httpErrors';

// These integration tests exercise the CORS and request-body-limit
// middleware/error-handling as actually wired in src/app.ts, but build a
// standalone app from the same building blocks (resolveOrigin, the
// express.json() limit, the httpErrors guards) rather than importing
// src/app.ts directly.
//
// Reason: src/app.ts pulls in the full route tree, which imports Mongoose
// models at module-load time. Re-importing it per test (needed because
// resolveOrigin() is evaluated once at module load, keyed off env vars we
// want to vary per test) triggers Mongoose's "Cannot overwrite model once
// compiled" error on the second import. Building the middleware chain
// directly sidesteps that without touching Mongoose at all, and still
// exercises the exact same CORS/body-limit logic used in production —
// tests/api.routes.test.ts (which needs a real Mongo instance) is what
// covers full end-to-end route behavior.
const buildTestApp = (env: NodeJS.ProcessEnv): Express => {
  const app = express();
  app.use(cors({ origin: resolveOrigin(env), credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.send('ok'));
  app.post('/api/tasks', (_req, res) => res.status(200).json({ ok: true }));

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (isPayloadTooLargeError(error)) {
        res.status(413).json({ message: 'Request body is too large' });
        return;
      }
      if (isMalformedJsonBodyError(error)) {
        res.status(400).json({ message: 'Request body is not valid JSON' });
        return;
      }
      res.status(500).json({ message: 'Internal server error' });
    },
  );

  return app;
};

describe('CORS behavior', () => {
  it('reflects the configured CLIENT_ORIGIN in Access-Control-Allow-Origin', async () => {
    const app = buildTestApp({ CLIENT_ORIGIN: 'https://halotask-pro.vercel.app' });

    const response = await request(app)
      .get('/')
      .set('Origin', 'https://halotask-pro.vercel.app');

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://halotask-pro.vercel.app',
    );
  });

  it('always advertises the configured CLIENT_ORIGIN rather than reflecting the caller-supplied Origin', async () => {
    // With a single fixed origin string, the `cors` package sets
    // Access-Control-Allow-Origin to that configured value on every
    // response — it does not echo back whatever Origin header the
    // caller sent. This is what makes it safe: a browser at
    // https://evil.example.com receiving an ACAO value that doesn't
    // match its own origin will still block the response client-side,
    // even though the server responded.
    const app = buildTestApp({ CLIENT_ORIGIN: 'https://halotask-pro.vercel.app' });

    const response = await request(app).get('/').set('Origin', 'https://evil.example.com');

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://halotask-pro.vercel.app',
    );
    expect(response.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('falls back to the fixed localhost dev origins when CLIENT_ORIGIN is unset in development', async () => {
    const app = buildTestApp({ NODE_ENV: 'development' });

    const response = await request(app).get('/').set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('fails closed (no Access-Control-Allow-Origin header) in production when CLIENT_ORIGIN is missing', async () => {
    const app = buildTestApp({ NODE_ENV: 'production' });

    const response = await request(app).get('/').set('Origin', 'https://anything.example.com');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('request body size limit', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp({ CLIENT_ORIGIN: 'http://localhost:5173' });
  });

  it('rejects a request body larger than the configured limit with 413', async () => {
    // The configured limit is 1mb; send a body comfortably over it.
    const oversizedPayload = { data: 'x'.repeat(2 * 1024 * 1024) };

    const response = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send(oversizedPayload);

    expect(response.status).toBe(413);
    expect(response.body.message).toMatch(/too large/i);
  });

  it('accepts a request body comfortably within the size limit without a 413', async () => {
    const reasonablePayload = { title: 'A perfectly normal task', description: 'x'.repeat(1000) };

    const response = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send(reasonablePayload);

    expect(response.status).toBe(200);
  });

  it('returns 400 (not 500) for malformed JSON in the request body', async () => {
    const response = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json');

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/not valid json/i);
  });
});
