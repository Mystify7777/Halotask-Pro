import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMITS, RATE_LIMITED_MESSAGE } from '../src/config/rateLimits';

// Real src/app.ts (real routers, auth middleware, controllers, limiters, trust-proxy wiring) with only
// the database models, web-push and the AI provider's fetch replaced. The app is re-imported per test
// (vi.resetModules) so each test starts with fresh limiter state and its own TRUST_PROXY_HOPS.

const SECRET = 'test-jwt-secret-1234567890';
const GROQ_KEY = 'gsk_test_ratelimit_key_0123456789';
const PASSWORD = 'correct-horse';
let PASSWORD_HASH = '';

const WINDOW_LOGIN = RATE_LIMITS.loginAccountIp;

type Doc = {
  id: string;
  _id: { toString(): string };
  name: string;
  email: string;
  passwordHash: string;
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  pushSubscriptions: unknown[];
  save: () => Promise<void>;
};

const users = new Map<string, Doc>();
const sent = vi.hoisted(() => ({ webpush: 0 }));
const calls = vi.hoisted(() => ({ forgotSaves: 0, taskFinds: 0 }));

const makeUser = (email: string, extra: Partial<Doc> = {}): Doc => {
  const id = `u${users.size + 1}`;
  const doc: Doc = {
    id,
    _id: { toString: () => id },
    name: 'Test User',
    email,
    passwordHash: PASSWORD_HASH,
    pushSubscriptions: [],
    save: async () => {
      calls.forgotSaves += 1;
    },
    ...extra,
  };
  users.set(email, doc);
  return doc;
};

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

const fetchMock = vi.fn();

async function loadApp(env: Record<string, string | undefined> = {}): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.GROQ_API_KEY = GROQ_KEY;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.SMTP_HOST;
  delete process.env.RESEND_API_KEY;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findOne: async (q: { email: string }) => users.get(q.email) ?? null,
      // Reset-password: the live-code match the controller uses for both its cost guard (exists) and
      // its single atomic write (updateOne), applied to the in-memory doc.
      exists: async (q: { email: string; resetPasswordTokenHash?: string }) => (matchesLiveCode(q) ? { _id: 'x' } : null),
      updateOne: async (
        q: { email: string; resetPasswordTokenHash?: string },
        update: { $set: Partial<Doc>; $unset: Record<string, unknown>; $inc: { tokenVersion: number } },
      ) => {
        const u = matchesLiveCode(q);
        if (!u) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(u, update.$set);
        for (const key of Object.keys(update.$unset)) delete (u as Record<string, unknown>)[key];
        return { matchedCount: 1, modifiedCount: 1 };
      },
      create: async (d: { email: string; name: string; passwordHash: string }) =>
        makeUser(d.email, { name: d.name, passwordHash: d.passwordHash }),
      findById: (id: string) => ({
        select: (fields: string) => ({
          // requireAuth's session-version check. This suite is about rate limiting, not accounts, so
          // any id is an account at version 0 (matching these legacy-shape tokens); account existence
          // and version mismatches are covered in sessionInvalidation.test.ts.
          lean: async () =>
            fields === 'tokenVersion'
              ? { tokenVersion: 0 }
              : { pushSubscriptions: [...users.values()].find((u) => u.id === id)?.pushSubscriptions ?? [] },
        }),
      }),
      findByIdAndUpdate: async () => null,
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: () => {
        calls.taskFinds += 1;
        const chain = { sort: () => chain, skip: () => chain, limit: async () => [] };
        return chain;
      },
      countDocuments: async () => 0,
    },
  }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: { find: vi.fn(), findOneAndUpdate: vi.fn() } }));
  vi.doMock('web-push', () => ({
    default: {
      setVapidDetails: () => undefined,
      sendNotification: async () => {
        sent.webpush += 1;
      },
    },
  }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const tokenFor = (userId: string) => jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET);
const bearer = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });

const login = (app: Express, email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
  request(app).post('/api/auth/login').set(headers).send({ email, password });

const NOW = new Date('2026-10-02T04:00:00Z');

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  users.clear();
  sent.webpush = 0;
  calls.forgotSaves = 0;
  calls.taskFinds = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('../src/models/Task.model');
  vi.doUnmock('../src/models/DayHistory.model');
  vi.doUnmock('web-push');
});

const expect429 = (res: request.Response) => {
  expect(res.status).toBe(429);
  expect(res.body).toEqual({ message: RATE_LIMITED_MESSAGE });
  expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
};

describe('login', () => {
  it('succeeds below the limit, and successful logins never use up the failure budget', async () => {
    const app = await loadApp();
    makeUser('a@x.test');
    for (let i = 0; i < RATE_LIMITS.loginAccountIp.max * 3; i += 1) {
      expect((await login(app, 'a@x.test')).status).toBe(200);
    }
  });

  it('returns 429 after the configured number of failed attempts for one account from one IP', async () => {
    const app = await loadApp();
    makeUser('a@x.test');
    for (let i = 0; i < RATE_LIMITS.loginAccountIp.max; i += 1) {
      expect((await login(app, 'a@x.test', 'wrong-password')).status).toBe(401);
    }
    expect429(await login(app, 'a@x.test', 'wrong-password'));
  });

  it('also refuses the CORRECT password while that account/IP is blocked, then recovers after the window', async () => {
    const app = await loadApp();
    makeUser('a@x.test');
    for (let i = 0; i < WINDOW_LOGIN.max; i += 1) await login(app, 'a@x.test', 'wrong-password');
    expect429(await login(app, 'a@x.test'));

    vi.setSystemTime(new Date(NOW.getTime() + WINDOW_LOGIN.windowMs - 1));
    expect429(await login(app, 'a@x.test'));

    vi.setSystemTime(new Date(NOW.getTime() + WINDOW_LOGIN.windowMs));
    expect((await login(app, 'a@x.test')).status).toBe(200);
  });

  it('is indistinguishable for an unknown account: same statuses and bodies, same point of 429', async () => {
    const app = await loadApp();
    makeUser('real@x.test');
    const run = async (email: string) => {
      const out: [number, unknown][] = [];
      for (let i = 0; i < WINDOW_LOGIN.max + 2; i += 1) {
        const r = await login(app, email, 'wrong-password');
        out.push([r.status, r.body]);
      }
      return out;
    };
    expect(await run('real@x.test')).toEqual(await run('ghost@x.test'));
  });

  it('does not let one blocked account lock out another account from the same IP', async () => {
    const app = await loadApp();
    makeUser('a@x.test');
    makeUser('b@x.test');
    for (let i = 0; i < WINDOW_LOGIN.max + 1; i += 1) await login(app, 'a@x.test', 'wrong-password');
    expect((await login(app, 'b@x.test')).status).toBe(200);
  });

  it('does not let an attacker on one IP lock the real owner out from another IP', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    makeUser('victim@x.test');
    const attacker = { 'X-Forwarded-For': '203.0.113.66' };
    const owner = { 'X-Forwarded-For': '198.51.100.7' };
    for (let i = 0; i < WINDOW_LOGIN.max + 3; i += 1) await login(app, 'victim@x.test', 'guess', attacker);
    expect429(await login(app, 'victim@x.test', 'guess', attacker));
    expect((await login(app, 'victim@x.test', PASSWORD, owner)).status).toBe(200);
  });

  it('caps a distributed guess against one account across many IPs', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    makeUser('victim@x.test');
    const max = RATE_LIMITS.loginAccount.max;
    let blockedAt = -1;
    for (let i = 0; i < max + 5; i += 1) {
      // A new IP every request: the per-IP and per-(account,IP) buckets never fill.
      const r = await login(app, 'victim@x.test', 'guess', { 'X-Forwarded-For': `198.51.100.${i + 1}` });
      if (r.status === 429 && blockedAt === -1) blockedAt = i;
    }
    expect(blockedAt).toBe(max);
  });

  it('limits one IP across many different accounts (credential spraying)', async () => {
    const app = await loadApp();
    let blockedAt = -1;
    for (let i = 0; i < RATE_LIMITS.loginIp.max + 3; i += 1) {
      const r = await login(app, `user${i}@x.test`, 'guess');
      if (r.status === 429 && blockedAt === -1) blockedAt = i;
    }
    expect(blockedAt).toBe(RATE_LIMITS.loginIp.max);
  });

  it('validation failures (400) count as attempts too', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.loginIp.max; i += 1) {
      expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
    }
    expect429(await request(app).post('/api/auth/login').send({}));
  });
});

describe('register', () => {
  const register = (app: Express, n: number, headers: Record<string, string> = {}) =>
    request(app).post('/api/auth/register').set(headers).send({ name: 'N', email: `n${n}@x.test`, password: PASSWORD });

  it('is rate limited per IP: allows the configured number, then 429, then recovers', async () => {
    const app = await loadApp();
    const { max, windowMs } = RATE_LIMITS.registerIp;
    for (let i = 0; i < max; i += 1) expect((await register(app, i)).status).toBe(201);
    expect429(await register(app, 999));

    vi.setSystemTime(new Date(NOW.getTime() + windowMs));
    expect((await register(app, 1000)).status).toBe(201);
  });

  it('keeps the existing 409 for a taken e-mail while under the limit', async () => {
    const app = await loadApp();
    expect((await register(app, 1)).status).toBe(201);
    expect((await register(app, 1)).status).toBe(409);
  });

  it('gives each IP its own budget', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    for (let i = 0; i < RATE_LIMITS.registerIp.max; i += 1) await register(app, i, { 'X-Forwarded-For': '203.0.113.1' });
    expect429(await register(app, 500, { 'X-Forwarded-For': '203.0.113.1' }));
    expect((await register(app, 501, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(201);
  });
});

describe('forgot-password', () => {
  const forgot = (app: Express, email: string, headers: Record<string, string> = {}) =>
    request(app).post('/api/auth/forgot-password').set(headers).send({ email });
  const NEUTRAL = 'If an account exists for this email, a reset link has been sent.';

  it('keeps the neutral 200 for known and unknown addresses below the limit', async () => {
    const app = await loadApp();
    makeUser('known@x.test');
    const known = await forgot(app, 'known@x.test');
    const unknown = await forgot(app, 'unknown@x.test');
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(known.body).toEqual({ message: NEUTRAL });
    expect(unknown.body).toEqual(known.body);
  });

  it('is rate limited per IP (old behaviour preserved: the 6th request in the window gets 429)', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.forgotIp.max; i += 1) expect((await forgot(app, `u${i}@x.test`)).status).toBe(200);
    expect429(await forgot(app, 'another@x.test'));
  });

  it('is rate limited per address even from many IPs (inbox flooding)', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    makeUser('victim@x.test');
    const max = RATE_LIMITS.forgotAccount.max;
    for (let i = 0; i < max; i += 1) {
      expect((await forgot(app, 'victim@x.test', { 'X-Forwarded-For': `198.51.100.${i + 1}` })).status).toBe(200);
    }
    expect429(await forgot(app, 'victim@x.test', { 'X-Forwarded-For': '198.51.100.200' }));
    expect(calls.forgotSaves).toBe(max); // the blocked request never reached the controller / sent a code
  });

  it('answers a known and an unknown address identically all the way through the limit', async () => {
    const run = async (email: string) => {
      const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
      makeUser('known@x.test');
      const out: [number, unknown][] = [];
      for (let i = 0; i < RATE_LIMITS.forgotAccount.max + 2; i += 1) {
        const r = await forgot(app, email, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
        out.push([r.status, r.body]);
      }
      return out;
    };
    expect(await run('known@x.test')).toEqual(await run('unknown@x.test'));
  });

  it('treats case/whitespace variants of an address as the same bucket', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    const variants = ['Victim@X.test', ' victim@x.test', 'VICTIM@x.TEST'];
    for (const [i, v] of variants.entries()) {
      expect((await forgot(app, v, { 'X-Forwarded-For': `198.51.100.${i + 1}` })).status).toBe(200);
    }
    expect429(await forgot(app, 'victim@x.test', { 'X-Forwarded-For': '198.51.100.99' }));
  });

  it('recovers after the window', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.forgotIp.max; i += 1) await forgot(app, `u${i}@x.test`);
    expect429(await forgot(app, 'x@x.test'));
    vi.setSystemTime(new Date(NOW.getTime() + RATE_LIMITS.forgotIp.windowMs));
    expect((await forgot(app, 'x@x.test')).status).toBe(200);
  });
});

describe('reset-password', () => {
  const reset = (app: Express, email: string, token: string, headers: Record<string, string> = {}) =>
    request(app).post('/api/auth/reset-password').set(headers).send({ email, token, password: 'brand-new-pass' });

  it('is rate limited per account: failed code guesses stop after the configured number', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    makeUser('v@x.test');
    const { max } = RATE_LIMITS.resetAccount;
    for (let i = 0; i < max; i += 1) {
      // A fresh IP per guess: only the per-account bucket can stop this.
      const r = await reset(app, 'v@x.test', String(100000 + i), { 'X-Forwarded-For': `198.51.100.${i + 1}` });
      expect(r.status).toBe(400);
    }
    expect429(await reset(app, 'v@x.test', '123456', { 'X-Forwarded-For': '198.51.100.250' }));
  });

  it('is rate limited per IP across accounts', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.resetIp.max; i += 1) {
      expect((await reset(app, `u${i}@x.test`, '000000')).status).toBe(400);
    }
    expect429(await reset(app, 'zzz@x.test', '000000'));
  });

  it('gives the same 400 for known and unknown accounts and the same 429 point', async () => {
    const run = async (email: string) => {
      const app = await loadApp();
      makeUser('known@x.test');
      const out: [number, unknown][] = [];
      for (let i = 0; i < RATE_LIMITS.resetAccount.max + 2; i += 1) {
        const r = await reset(app, email, String(100000 + i));
        out.push([r.status, r.body]);
      }
      return out;
    };
    expect(await run('known@x.test')).toEqual(await run('unknown@x.test'));
  });

  it('a correct code still works after earlier wrong guesses (below the limit), and recovers after the window', async () => {
    const app = await loadApp();
    const crypto = await import('node:crypto');
    const user = makeUser('v@x.test', {
      resetPasswordTokenHash: crypto.createHash('sha256').update('654321').digest('hex'),
      resetPasswordExpiresAt: new Date(NOW.getTime() + 20 * 60 * 1000),
    });
    for (let i = 0; i < RATE_LIMITS.resetAccount.max - 1; i += 1) await reset(app, 'v@x.test', String(100000 + i));
    const ok = await reset(app, 'v@x.test', '654321');
    expect(ok.status).toBe(200);
    expect(user.resetPasswordTokenHash).toBeUndefined();

    // Exhaust, then wait out the window.
    for (let i = 0; i < RATE_LIMITS.resetAccount.max; i += 1) await reset(app, 'w@x.test', '000000');
    expect429(await reset(app, 'w@x.test', '000000'));
    vi.setSystemTime(new Date(NOW.getTime() + RATE_LIMITS.resetAccount.windowMs));
    expect((await reset(app, 'w@x.test', '000000')).status).toBe(400);
  });
});

describe('AI parse-tasks', () => {
  const ai = (app: Express, userId: string, body: object = { prompt: 'buy milk' }, headers: Record<string, string> = {}) =>
    request(app).post('/api/ai/parse-tasks').set(bearer(userId)).set(headers).send(body);

  it('is unaffected below the limit', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.aiUser.max; i += 1) expect((await ai(app, 'u1')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMITS.aiUser.max);
  });

  it('is rate limited per user, and the refused request never reaches the provider', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.aiUser.max; i += 1) await ai(app, 'u1');
    fetchMock.mockClear();
    expect429(await ai(app, 'u1'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot be bypassed by supplying provider/model/url fields or varying the prompt', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.aiUser.max; i += 1) await ai(app, 'u1');
    for (const extra of [
      { model: 'other' },
      { provider: 'openai' },
      { url: 'https://evil.example' },
      { apiKey: 'x' },
      { user: 'u2', userId: 'u2' },
    ]) {
      expect429(await ai(app, 'u1', { prompt: `different ${Math.random()}`, ...extra }));
    }
  });

  it("does not share one user's budget with another user", async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    for (let i = 0; i < RATE_LIMITS.aiUser.max; i += 1) await ai(app, 'u1', undefined, { 'X-Forwarded-For': '203.0.113.1' });
    expect429(await ai(app, 'u1', undefined, { 'X-Forwarded-For': '203.0.113.1' }));
    expect((await ai(app, 'u2', undefined, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(200);
  });

  it('also limits one IP rotating through many accounts', async () => {
    const app = await loadApp();
    let blockedAt = -1;
    for (let i = 0; i < RATE_LIMITS.aiIp.max + 3; i += 1) {
      const r = await ai(app, `account${i}`);
      if (r.status === 429 && blockedAt === -1) blockedAt = i;
    }
    expect(blockedAt).toBe(RATE_LIMITS.aiIp.max);
  });

  it('recovers after the window', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.aiUser.max; i += 1) await ai(app, 'u1');
    expect429(await ai(app, 'u1'));
    vi.setSystemTime(new Date(NOW.getTime() + RATE_LIMITS.aiUser.windowMs));
    expect((await ai(app, 'u1')).status).toBe(200);
  });

  it('keeps authentication first: no token → 401, and unauthenticated calls use no AI budget', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.aiIp.max + 5; i += 1) {
      expect((await request(app).post('/api/ai/parse-tasks').send({ prompt: 'x' })).status).toBe(401);
    }
    expect((await ai(app, 'u1')).status).toBe(200);
  });

  it('still validates input (400) and keeps the generic provider-error behaviour under the limit', async () => {
    const app = await loadApp();
    expect((await ai(app, 'u1', { prompt: '' })).status).toBe(400);
    fetchMock.mockResolvedValueOnce(new Response(`oops ${GROQ_KEY}`, { status: 500 }));
    const res = await ai(app, 'u1');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(GROQ_KEY);
  });
});

describe('push relay', () => {
  const relay = (app: Express, userId: string) =>
    request(app).post('/api/push/relay').set(bearer(userId)).send({ title: 't', body: 'b', tag: 'x' });

  it('allows legitimate reminder bursts, then returns 429, then recovers', async () => {
    const app = await loadApp();
    const { max, windowMs } = RATE_LIMITS.pushRelayUser;
    for (let i = 0; i < max; i += 1) expect((await relay(app, 'u1')).status).toBe(200);
    expect429(await relay(app, 'u1'));

    vi.setSystemTime(new Date(NOW.getTime() + windowMs));
    expect((await relay(app, 'u1')).status).toBe(200);
  });

  it('is per user: one noisy user does not block another, even from the same IP', async () => {
    const app = await loadApp();
    for (let i = 0; i < RATE_LIMITS.pushRelayUser.max; i += 1) await relay(app, 'u1');
    expect429(await relay(app, 'u1'));
    expect((await relay(app, 'u2')).status).toBe(200);
  });

  it('refused requests send no notifications', async () => {
    const app = await loadApp();
    const user = makeUser('p@x.test');
    user.pushSubscriptions.push({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    const token = bearer(user.id);
    const call = () => request(app).post('/api/push/relay').set(token).send({ title: 't', body: 'b' });
    for (let i = 0; i < RATE_LIMITS.pushRelayUser.max; i += 1) await call();
    const before = sent.webpush;
    expect429(await call());
    expect(sent.webpush).toBe(before);
  });

  it('requires authentication before anything else', async () => {
    const app = await loadApp();
    expect((await request(app).post('/api/push/relay').send({ title: 't', body: 'b' })).status).toBe(401);
  });
});

describe('proxy / IP handling on the real app', () => {
  it('default (0 hops): X-Forwarded-For is ignored, so rotating it does not evade the IP limit', async () => {
    const app = await loadApp();
    let blockedAt = -1;
    for (let i = 0; i < RATE_LIMITS.loginIp.max + 3; i += 1) {
      const r = await login(app, `s${i}@x.test`, 'g', { 'X-Forwarded-For': `10.0.${i}.1` });
      if (r.status === 429 && blockedAt === -1) blockedAt = i;
    }
    expect(blockedAt).toBe(RATE_LIMITS.loginIp.max);
  });

  it('TRUST_PROXY_HOPS=1: buckets by the proxy-appended address; prepended spoofs are ignored', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    let blockedAt = -1;
    for (let i = 0; i < RATE_LIMITS.loginIp.max + 3; i += 1) {
      const r = await login(app, `s${i}@x.test`, 'g', { 'X-Forwarded-For': `10.0.${i}.1, 203.0.113.9` });
      if (r.status === 429 && blockedAt === -1) blockedAt = i;
    }
    expect(blockedAt).toBe(RATE_LIMITS.loginIp.max);
    // A different real client is unaffected.
    expect((await login(app, 'ok@x.test', 'g', { 'X-Forwarded-For': '10.0.0.1, 203.0.113.10' })).status).toBe(401);
  });

  it('TRUST_PROXY_HOPS=1: distinct real clients get distinct buckets', async () => {
    const app = await loadApp({ TRUST_PROXY_HOPS: '1' });
    for (let i = 0; i < RATE_LIMITS.loginIp.max + 5; i += 1) {
      const r = await login(app, `s${i}@x.test`, 'g', { 'X-Forwarded-For': `203.0.113.${i + 1}` });
      expect(r.status).toBe(401);
    }
  });

  it('an invalid TRUST_PROXY_HOPS refuses to load the app', async () => {
    await expect(loadApp({ TRUST_PROXY_HOPS: 'lots' })).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });
});

describe('ordinary task usage is not throttled', () => {
  it('serves far more task requests than any limiter allows', async () => {
    const app = await loadApp();
    const most = Math.max(...Object.values(RATE_LIMITS).map((r) => r.max));
    for (let i = 0; i < most * 3; i += 1) {
      const res = await request(app).get('/api/tasks').set(bearer('u1'));
      expect(res.status).toBe(200);
      expect(res.headers['retry-after']).toBeUndefined();
    }
    expect(calls.taskFinds).toBe(most * 3);
  });

  it('task traffic does not consume the AI, login or relay budgets', async () => {
    const app = await loadApp();
    for (let i = 0; i < 100; i += 1) await request(app).get('/api/tasks').set(bearer('u1'));
    expect((await request(app).post('/api/ai/parse-tasks').set(bearer('u1')).send({ prompt: 'x' })).status).toBe(200);
    makeUser('a@x.test');
    expect((await login(app, 'a@x.test')).status).toBe(200);
  });
});

describe('does not log sensitive request data', () => {
  it('writes no credentials, reset codes or bearer tokens to the console while limiting', async () => {
    const app = await loadApp();
    const spies = (['info', 'warn', 'error', 'log'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    makeUser('a@x.test');
    for (let i = 0; i < WINDOW_LOGIN.max + 2; i += 1) await login(app, 'a@x.test', 'my-secret-password-xyz');
    const bearerHeader = bearer('u1').Authorization;
    for (let i = 0; i < RATE_LIMITS.aiUser.max + 2; i += 1) {
      await request(app).post('/api/ai/parse-tasks').set({ Authorization: bearerHeader }).send({ prompt: 'my private prompt' });
    }
    const out = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    expect(out).not.toContain('my-secret-password-xyz');
    expect(out).not.toContain('my private prompt');
    expect(out).not.toContain(bearerHeader);
    expect(out).not.toContain(GROQ_KEY);
  });
});
