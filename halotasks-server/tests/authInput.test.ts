import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #21 — input boundaries of the four auth handlers, and the forgot-password flow, against the REAL app
// with an in-memory User double. Mongo-free and independent of any email provider: no transport is
// configured, so the controller's demo mode applies and nothing is ever sent.
//
// Not duplicated here (already covered Mongo-free in tests/sessionInvalidation.test.ts): reset-code replay,
// two simultaneous resets with one code, an expired code, a wrong code or weak password not consuming the code,
// and session revocation by the reset. This file adds the issuing side (forgot-password) and the input types.

type Doc = {
  id: string;
  _id: { toString(): string };
  name: string;
  email: string;
  passwordHash: string;
  tokenVersion: number;
  pushSubscriptions: unknown[];
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  save: () => Promise<void>;
};

const db = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  calls: { findOne: 0, create: 0, exists: 0, updateOne: 0, saves: 0 },
}));
const users = db.users as unknown as Map<string, Doc>;
const calls = db.calls;

const PASSWORD = 'correct-horse';
let PASSWORD_HASH = '';
const NOW = new Date('2026-10-05T08:00:00Z');
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const makeUser = (email: string): Doc => {
  const id = `665f1c2e9b1e8a0000000${users.size + 1}0`.slice(0, 24);
  const doc: Doc = {
    id,
    _id: { toString: () => id },
    name: 'Test User',
    email,
    passwordHash: PASSWORD_HASH,
    tokenVersion: 0,
    pushSubscriptions: [],
    save: async () => {
      calls.saves += 1;
    },
  };
  users.set(email, doc);
  return doc;
};

async function loadApp(env: Record<string, string | undefined> = {}): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.RESET_TOKEN_TTL_MINUTES;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const matchesLiveCode = (q: { email: string; resetPasswordTokenHash?: string }): Doc | null => {
    const u = users.get(q.email) ?? null;
    return u &&
      q.resetPasswordTokenHash !== undefined &&
      u.resetPasswordTokenHash === q.resetPasswordTokenHash &&
      u.resetPasswordExpiresAt &&
      u.resetPasswordExpiresAt > new Date()
      ? u
      : null;
  };

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findOne: async (q: { email: string }) => {
        calls.findOne += 1;
        return users.get(q.email) ?? null;
      },
      create: async (d: { name: string; email: string; passwordHash: string }) => {
        calls.create += 1;
        const doc = makeUser(d.email);
        doc.name = d.name;
        doc.passwordHash = d.passwordHash;
        return doc;
      },
      exists: async (q: { email: string; resetPasswordTokenHash?: string }) => {
        calls.exists += 1;
        return matchesLiveCode(q) ? { _id: 'x' } : null;
      },
      updateOne: async (
        q: { email: string; resetPasswordTokenHash?: string },
        update: { $set: Partial<Doc>; $unset: Record<string, unknown>; $inc: { tokenVersion: number } },
      ) => {
        calls.updateOne += 1;
        const u = matchesLiveCode(q);
        if (!u) return { matchedCount: 0 };
        Object.assign(u, update.$set);
        for (const key of Object.keys(update.$unset)) delete (u as unknown as Record<string, unknown>)[key];
        u.tokenVersion += update.$inc.tokenVersion;
        return { matchedCount: 1 };
      },
      findById: () => ({ select: () => ({ lean: async () => ({ tokenVersion: 0 }) }) }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  users.clear();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

const BODY_MESSAGE = 'Request body must be a JSON object.';
const ENDPOINTS = [
  { path: '/api/auth/register', required: 'name, email, and password are required', strings: 'name, email, and password must be strings', good: { name: 'A', email: 'a@x.test', password: PASSWORD } },
  { path: '/api/auth/login', required: 'email and password are required', strings: 'email and password must be strings', good: { email: 'a@x.test', password: PASSWORD } },
  { path: '/api/auth/forgot-password', required: 'email is required', strings: 'email must be a string', good: { email: 'a@x.test' } },
  { path: '/api/auth/reset-password', required: 'email, token, and password are required', strings: 'email, token, and password must be strings', good: { email: 'a@x.test', token: '123456', password: PASSWORD } },
] as const;

const touchedDatabase = () => calls.findOne + calls.create + calls.exists + calls.updateOne + calls.saves;

describe.each(ENDPOINTS)('$path — request body boundary', ({ path, required, strings, good }) => {
  it('a request with no body is 400 "Request body must be a JSON object." (was a 500), touching nothing', async () => {
    const app = await loadApp();

    const res = await request(app).post(path);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: BODY_MESSAGE });
    expect(touchedDatabase()).toBe(0);
  });

  it.each([
    ['text/plain', () => 'a=1'],
    ['a JSON array', () => '[1]'],
  ])('%s body is 400, touching nothing', async (kind, raw) => {
    const app = await loadApp();
    const req = request(app).post(path);

    const res = await (kind === 'text/plain' ? req.type('text').send(raw()) : req.set('Content-Type', 'application/json').send(raw()));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: BODY_MESSAGE });
    expect(touchedDatabase()).toBe(0);
  });

  it('an empty object keeps the existing "required" message', async () => {
    const app = await loadApp();

    const res = await request(app).post(path).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: required });
  });

  it.each(Object.keys(good))('a missing or empty %s keeps the existing "required" message', async (field) => {
    const app = await loadApp();

    const missing = await request(app).post(path).send({ ...good, [field]: undefined });
    const empty = await request(app).post(path).send({ ...good, [field]: '' });

    expect(missing.body).toEqual({ message: required });
    expect(empty.body).toEqual({ message: required });
    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it.each(Object.keys(good).flatMap((field) => [[field, 5], [field, true], [field, { $ne: null }], [field, ['x']]] as Array<[string, unknown]>))(
    'a non-string %s (%j) is 400 "must be strings" — not a 500 — and touches nothing',
    async (field, value) => {
      const app = await loadApp();

      const res = await request(app).post(path).send({ ...good, [field]: value });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: strings });
      expect(touchedDatabase()).toBe(0);
    },
  );
});

describe('valid inputs behave exactly as before', () => {
  it('register → 201 with a token; login → 200; both with the same normalisation', async () => {
    const app = await loadApp();

    const registered = await request(app).post('/api/auth/register').send({ name: '  Aryan   K ', email: ' New@X.test ', password: PASSWORD });
    expect(registered.status).toBe(201);
    expect(registered.body.user).toMatchObject({ name: 'Aryan K', email: 'new@x.test' });

    const login = await request(app).post('/api/auth/login').send({ email: 'NEW@x.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe('string');
  });

  it('login with a wrong password is still the generic 401', async () => {
    const app = await loadApp();
    makeUser('a@x.test');

    const res = await request(app).post('/api/auth/login').send({ email: 'a@x.test', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Invalid email or password' });
  });

  it('register still rejects a short password and a bad email with their own messages', async () => {
    const app = await loadApp();

    const short = await request(app).post('/api/auth/register').send({ name: 'A', email: 'a@x.test', password: '123' });
    const bad = await request(app).post('/api/auth/register').send({ name: 'A', email: 'nope', password: PASSWORD });

    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/at least 6 characters/);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/valid email/);
  });

  it('reset-password still rejects a short new password before looking the code up', async () => {
    const app = await loadApp();

    const res = await request(app).post('/api/auth/reset-password').send({ email: 'a@x.test', token: '123456', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 6 characters/);
    expect(calls.exists).toBe(0);
  });
});

describe('forgot-password', () => {
  const NEUTRAL = { message: 'If an account exists for this email, a reset link has been sent.' };

  /** Make the generated codes known (and so assertable) without touching the production code. */
  const fixCodes = (...codes: number[]) => {
    const queue = [...codes];
    vi.spyOn(crypto, 'randomInt').mockImplementation((() => queue.shift() ?? 999999) as never);
  };

  const forgot = (app: Express, email: string) => request(app).post('/api/auth/forgot-password').send({ email });
  const reset = (app: Express, email: string, token: string) =>
    request(app).post('/api/auth/reset-password').send({ email, token, password: 'a-brand-new-password' });

  it('stores a SHA-256 hash of the code, never the code itself', async () => {
    fixCodes(424242);
    const app = await loadApp();
    const user = makeUser('a@x.test');

    const res = await forgot(app, 'a@x.test');

    expect(res.status).toBe(200);
    expect(user.resetPasswordTokenHash).toBe(sha256('424242'));
    expect(user.resetPasswordTokenHash).not.toBe('424242');
    expect(JSON.stringify(user)).not.toContain('424242');
    expect(JSON.stringify(res.body)).not.toContain('424242'); // and the response never carries it
    expect(calls.saves).toBe(1);
  });

  it('stores an expiry TTL minutes ahead (default 20)', async () => {
    fixCodes(111111);
    const app = await loadApp();
    const user = makeUser('a@x.test');

    await forgot(app, 'a@x.test');

    expect(user.resetPasswordExpiresAt).toEqual(new Date(NOW.getTime() + 20 * 60 * 1000));
  });

  it('honours RESET_TOKEN_TTL_MINUTES', async () => {
    fixCodes(111111);
    const app = await loadApp({ RESET_TOKEN_TTL_MINUTES: '5' });
    const user = makeUser('a@x.test');

    await forgot(app, 'a@x.test');

    expect(user.resetPasswordExpiresAt).toEqual(new Date(NOW.getTime() + 5 * 60 * 1000));
  });

  it('a second request replaces the first code: the old one stops working, the new one works', async () => {
    fixCodes(111111, 222222);
    const app = await loadApp();
    const user = makeUser('a@x.test');

    await forgot(app, 'a@x.test');
    const firstHash = user.resetPasswordTokenHash;
    await forgot(app, 'a@x.test');

    expect(user.resetPasswordTokenHash).toBe(sha256('222222'));
    expect(user.resetPasswordTokenHash).not.toBe(firstHash);

    const old = await reset(app, 'a@x.test', '111111');
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ message: 'Reset code is invalid or expired' });

    const current = await reset(app, 'a@x.test', '222222');
    expect(current.status).toBe(200);
  });

  it('a second request also restarts the expiry window', async () => {
    fixCodes(111111, 222222);
    const app = await loadApp();
    const user = makeUser('a@x.test');

    await forgot(app, 'a@x.test');
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60 * 1000));
    await forgot(app, 'a@x.test');

    expect(user.resetPasswordExpiresAt).toEqual(new Date(NOW.getTime() + 35 * 60 * 1000));
  });

  it('an unknown email creates no record, saves nothing and never produces a code', async () => {
    fixCodes(333333);
    const app = await loadApp();

    const res = await forgot(app, 'nobody@x.test');

    expect(res.status).toBe(200);
    expect(users.size).toBe(0);
    expect(calls.saves).toBe(0);
    expect(calls.create).toBe(0);
    expect(crypto.randomInt).not.toHaveBeenCalled();
    expect([...info.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('333333');
  });

  it('answers a known and an unknown address identically (status and body)', async () => {
    const app = await loadApp();
    makeUser('known@x.test');

    const known = await forgot(app, 'known@x.test');
    const unknown = await forgot(app, 'unknown@x.test');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(NEUTRAL);
    expect(unknown.body).toEqual(NEUTRAL);
  });

  it('normalises the address (case and surrounding spaces) before the lookup', async () => {
    fixCodes(555555);
    const app = await loadApp();
    const user = makeUser('a@x.test');

    const res = await forgot(app, '  A@X.Test ');

    expect(res.body).toEqual(NEUTRAL);
    expect(user.resetPasswordTokenHash).toBe(sha256('555555'));
  });

  it('never writes a reset code to the log when a mail transport IS configured but fails', async () => {
    // Transports configured => the demo-mode log line (which does print the code, by design, for local
    // development only) must not run. Resend is "configured" here; its network call is replaced to fail.
    fixCodes(777777);
    vi.doMock('resend', () => ({ Resend: class { emails = { send: async () => ({ error: { message: 'provider down' } }) }; } }));
    const app = await loadApp({ RESEND_API_KEY: 're_test_placeholder' });
    makeUser('a@x.test');

    const res = await forgot(app, 'a@x.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(NEUTRAL);
    const logged = [...info.mock.calls, ...warn.mock.calls, ...(console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls].flat().join(' ');
    expect(logged).not.toContain('777777');
    vi.doUnmock('resend');
  });

  it('end to end: the code it issues resets the password, once, and the new password logs in', async () => {
    fixCodes(246810);
    const app = await loadApp();
    makeUser('a@x.test');

    await forgot(app, 'a@x.test');
    const first = await reset(app, 'a@x.test', '246810');
    const second = await reset(app, 'a@x.test', '246810');
    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.test', password: 'a-brand-new-password' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400); // single use (the concurrent case lives in sessionInvalidation.test.ts)
    expect(login.status).toBe(200);
  });

  it('a code issued here is refused once its window has passed', async () => {
    fixCodes(135790);
    const app = await loadApp();
    makeUser('a@x.test');

    await forgot(app, 'a@x.test');
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60 * 1000 + 1));
    const res = await reset(app, 'a@x.test', '135790');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Reset code is invalid or expired' });
  });
});
