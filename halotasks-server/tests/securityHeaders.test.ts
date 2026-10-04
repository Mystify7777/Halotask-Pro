import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  STRICT_TRANSPORT_SECURITY,
  securityHeaders,
} from '../src/middleware/securityHeaders';

// The middleware in isolation: exact values, and the production-only HSTS rule. That the headers actually
// reach every kind of response of the real app (preflight, errors, 429...) is securityHeadersRoutes.test.ts.

const appWith = (env: NodeJS.ProcessEnv) => {
  const app = express();
  app.use(securityHeaders(env));
  app.get('/', (_req, res) => res.json({ ok: true }));
  return app;
};

describe('securityHeaders values', () => {
  it('sets the four baseline headers to exactly the approved values', async () => {
    const res = await request(appWith({ NODE_ENV: 'production' })).get('/');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('exports the exact policy and HSTS strings', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(STRICT_TRANSPORT_SECURITY).toBe('max-age=15552000');
  });

  it('adds nothing beyond the approved set', async () => {
    const res = await request(appWith({ NODE_ENV: 'production' })).get('/');
    const names = Object.keys(res.headers);

    for (const forbidden of [
      'cache-control',
      'x-xss-protection',
      'permissions-policy',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
      'origin-agent-cluster',
      'x-dns-prefetch-control',
      'x-download-options',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('Strict-Transport-Security', () => {
  it('is exactly "max-age=15552000" in production — no includeSubDomains, no preload', async () => {
    const res = await request(appWith({ NODE_ENV: 'production' })).get('/');

    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
    expect(res.headers['strict-transport-security']).not.toMatch(/includeSubDomains|preload/i);
  });

  it('is sent in production over plain HTTP too (not gated on req.secure)', async () => {
    // supertest talks plain HTTP: req.secure is false here, as it can be behind a TLS-terminating proxy.
    const res = await request(appWith({ NODE_ENV: 'production' })).get('/');

    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['test', { NODE_ENV: 'test' }],
    ['unset', {}],
    ['empty', { NODE_ENV: '' }],
    ['"Production" (case matters, like the rest of the server)', { NODE_ENV: 'Production' }],
  ])('is absent when NODE_ENV is %s', async (_label, env) => {
    const res = await request(appWith(env)).get('/');

    expect(res.headers['strict-transport-security']).toBeUndefined();
    // …while the always-on headers are still there.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
