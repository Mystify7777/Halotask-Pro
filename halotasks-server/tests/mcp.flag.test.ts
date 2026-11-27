import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMcpEnabled } from '../src/config/env';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #66: the MCP_ENABLED opt-in, tested on its own. Every case builds exactly one app from a fresh module registry with
// the flag set to the value under test, so no enabled app is ever built in a setup hook and nothing is shared between cases.
// The SDK packages are wrapped (not replaced) with a load counter, so "never loaded" is asserted, and the "on" case proves
// the same counter really does move when the SDK is loaded.

const ORIGINAL_FLAG = process.env.MCP_ENABLED;

let sdkLoads = 0;

async function appWithFlag(value: string | undefined): Promise<Express> {
  vi.resetModules();
  sdkLoads = 0;
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  if (value === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = value;
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/node']) {
    vi.doMock(name, async (importOriginal) => {
      sdkLoads += 1;
      return importOriginal();
    });
  }
  // Inert model doubles (a fresh registry would otherwise re-register the Mongoose models): nothing below queries them, since a
  // request stops at the 404 or at the missing-token 401 before any model is used.
  for (const model of ['User', 'Task', 'CompletionRecord', 'DayHistory']) vi.doMock(`../src/models/${model}.model`, () => ({ default: {} }));
  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

beforeEach(() => {
  sdkLoads = 0;
});

afterEach(() => {
  vi.doUnmock('@modelcontextprotocol/server');
  vi.doUnmock('@modelcontextprotocol/node');
  vi.resetModules();
  if (ORIGINAL_FLAG === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = ORIGINAL_FLAG;
});

describe('isMcpEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['TRUE', false],
    ['1', false],
    ['yes', false],
    [' true', false],
    ['true ', false],
    ['true', true],
  ])('MCP_ENABLED=%j -> %s', (value, expected) => {
    expect(isMcpEnabled(value === undefined ? {} : { MCP_ENABLED: value })).toBe(expected);
  });
});

describe('opt-in flag (MCP_ENABLED)', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true'])('MCP_ENABLED=%j leaves /mcp unmounted: the standard 404, and the SDK is never loaded', async (value) => {
    const app = await appWithFlag(value);
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer not-checked-because-the-route-is-absent').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Route /mcp not found' });
    expect(sdkLoads).toBe(0);
  });

  it('exactly "true" mounts it behind authentication, and only then is the SDK loaded', async () => {
    const app = await appWithFlag('true');
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401); // reaches requireAuth, i.e. the lazily imported router is mounted and has run
    expect(sdkLoads).toBeGreaterThan(0);
  });
});
