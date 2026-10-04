import https from 'node:https';
import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';
import {
  PUSH_BODY_MAX_LENGTH,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_SUBSCRIPTIONS_MAX_PER_USER,
  PUSH_TAG_MAX_LENGTH,
  PUSH_TITLE_MAX_LENGTH,
} from '../src/utils/pushValidators';

// Mongo-independent: the real push router, auth middleware, rate limiter, controller and validators run
// against an in-memory User model and a fake web-push. The model emulates ONLY the operations the
// controller is expected to issue (each one atomic, with an event-loop yield before it so concurrent
// requests really interleave) and THROWS on any other query shape — so a regression to a non-atomic
// pull-then-push, or to an operator-injectable query, fails here instead of being silently accepted.
// What it cannot prove is MongoDB's own operator semantics; that needs the Mongo-backed suite.

const SECRET = 'test-jwt-secret-1234567890';
const MAX = PUSH_SUBSCRIPTIONS_MAX_PER_USER;
const NOW = new Date('2026-10-02T10:00:00Z');

type Sub = { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } };
type UserRow = { _id: string; pushSubscriptions: Sub[] };

const users = new Map<string, UserRow>();
const modelCalls = { updateOne: 0, pull: 0, findById: 0 };
const authLookups = { count: 0 };
const failPull = { on: false };

// Concurrency gate: the first `size` updateOne calls all wait here until every one of them has arrived,
// then run back to back. That forces the "both requests checked, neither has written yet" interleaving
// that makes read-then-write and unguarded inserts race — supertest alone often finishes one request
// before the next arrives, which would hide such a bug.
const gate = { size: 0, arrived: 0, release: (() => undefined) as () => void, open: Promise.resolve() };
const armGate = (n: number) => {
  gate.size = n;
  gate.arrived = 0;
  gate.open = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
};

const delivery = new Map<string, 'ok' | { statusCode?: number; message?: string }>();
const sendCalls: { endpoint: string; payload: string; options: Record<string, unknown> }[] = [];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function installModels() {
  vi.doMock('../src/models/User.model', () => ({
    default: {
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        await Promise.resolve();
        modelCalls.updateOne += 1;
        if (gate.size > 0 && gate.arrived < gate.size) {
          gate.arrived += 1;
          if (gate.arrived === gate.size) gate.release();
          await gate.open;
        }

        const allowedFilterKeys = new Set(['_id', 'pushSubscriptions.endpoint']);
        for (const k of Object.keys(filter)) if (!allowedFilterKeys.has(k)) throw new Error(`unexpected filter key ${k}`);
        const row = users.get(String(filter._id));
        const cond = filter['pushSubscriptions.endpoint'];
        const matchesDoc = (r: UserRow) => {
          if (cond === undefined) return true;
          if (typeof cond === 'string') return r.pushSubscriptions.some((s) => s.endpoint === cond);
          const keys = Object.keys(cond as object);
          if (keys.length === 1 && keys[0] === '$ne' && typeof (cond as { $ne: unknown }).$ne === 'string') {
            return !r.pushSubscriptions.some((s) => s.endpoint === (cond as { $ne: string }).$ne);
          }
          throw new Error('unexpected endpoint condition');
        };
        if (!row || !matchesDoc(row)) return { matchedCount: 0, modifiedCount: 0 };

        const ops = Object.keys(update);
        if (ops.length !== 1) throw new Error('unexpected update shape');
        if (ops[0] === '$set') {
          const set = update.$set as Record<string, Sub>;
          const keys = Object.keys(set);
          if (keys.length !== 1 || keys[0] !== 'pushSubscriptions.$' || typeof cond !== 'string') {
            throw new Error('unexpected $set');
          }
          const i = row.pushSubscriptions.findIndex((s) => s.endpoint === cond);
          row.pushSubscriptions[i] = clone(set['pushSubscriptions.$']);
          return { matchedCount: 1, modifiedCount: 1 };
        }
        if (ops[0] === '$push') {
          const push = update.$push as { pushSubscriptions: { $each: Sub[]; $slice: number } };
          const spec = push.pushSubscriptions;
          if (!Array.isArray(spec.$each) || !Number.isInteger(spec.$slice) || spec.$slice >= 0) {
            throw new Error('unexpected $push (must keep the newest N)');
          }
          row.pushSubscriptions = [...row.pushSubscriptions, ...clone(spec.$each)].slice(spec.$slice);
          return { matchedCount: 1, modifiedCount: 1 };
        }
        throw new Error('unexpected update operator');
      },
      findByIdAndUpdate: async (id: string, update: { $pull: { pushSubscriptions: { endpoint: unknown } } }) => {
        await Promise.resolve();
        modelCalls.pull += 1;
        if (failPull.on) throw new Error('db down');
        const cond = update.$pull.pushSubscriptions.endpoint;
        const row = users.get(id);
        if (!row) return null;
        if (typeof cond === 'string') {
          row.pushSubscriptions = row.pushSubscriptions.filter((s) => s.endpoint !== cond);
        } else if (cond && typeof cond === 'object' && Object.keys(cond).join() === '$in' && Array.isArray((cond as { $in: unknown }).$in)) {
          const set = new Set((cond as { $in: string[] }).$in);
          row.pushSubscriptions = row.pushSubscriptions.filter((s) => !set.has(s.endpoint));
        } else {
          throw new Error('unexpected $pull condition');
        }
        return row;
      },
      findById: (id: string) => ({
        select: (fields: string) => ({
          lean: async () => {
            await Promise.resolve();
            // requireAuth's session-version check (projection 'tokenVersion'). These tokens are the
            // legacy shape (no `tv`), so an account at version 0 must keep accepting them. Counted
            // apart from `modelCalls` so the "nothing was looked up" assertions keep their meaning:
            // they are about the push controller's own reads.
            if (fields === 'tokenVersion') {
              authLookups.count += 1;
              return { tokenVersion: 0 };
            }
            modelCalls.findById += 1;
            const row = users.get(id);
            return row ? { pushSubscriptions: clone(row.pushSubscriptions) } : null;
          },
        }),
      }),
    },
  }));

  vi.doMock('web-push', () => ({
    default: {
      setVapidDetails: () => undefined,
      sendNotification: async (sub: Sub, payload: string, options: Record<string, unknown>) => {
        sendCalls.push({ endpoint: sub.endpoint, payload, options });
        const behaviour = delivery.get(sub.endpoint) ?? 'ok';
        if (behaviour === 'ok') return { statusCode: 201 };
        throw Object.assign(new Error(behaviour.message ?? 'push failed'), { statusCode: behaviour.statusCode });
      },
    },
  }));
}

async function loadApp(vapid = true): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  if (vapid) {
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
  installModels();
  const routes = ((await import('../src/routes/push.routes.js')) as unknown as { default: express.Router }).default;
  const rl = (await import('../src/middleware/rateLimit.js')) as unknown as { resetAllRateLimiters: () => void };
  rl.resetAllRateLimiters();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/push', routes);
  return app;
}

const bearer = (userId: string) => ({
  Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}`,
});

const b64 = (bytes: number, first?: number) => {
  const buf = Buffer.alloc(bytes, 7);
  if (first !== undefined) buf[0] = first;
  return buf.toString('base64url');
};
const P256 = b64(65, 4);
const AUTH = b64(16);
const ep = (id: string | number) => `https://fcm.googleapis.com/fcm/send/${id}`;
const sub = (id: string | number = 1, over: Record<string, unknown> = {}) => ({
  endpoint: ep(id),
  expirationTime: null,
  keys: { p256dh: P256, auth: AUTH },
  ...over,
});

const subscribe = (app: Express, body: unknown, user = 'u1') =>
  request(app).post('/api/push/subscribe').set(bearer(user)).send(body as object);
const unsubscribe = (app: Express, body: unknown, user = 'u1') =>
  request(app).post('/api/push/unsubscribe').set(bearer(user)).send(body as object);
const relay = (app: Express, body: unknown, user = 'u1') =>
  request(app).post('/api/push/relay').set(bearer(user)).send(body as object);

const stored = (user = 'u1') => users.get(user)?.pushSubscriptions ?? [];
const seed = (user: string, subs: Sub[] = []) => users.set(user, { _id: user, pushSubscriptions: subs });

let spies: Record<'info' | 'warn' | 'error' | 'log', ReturnType<typeof vi.spyOn>>;
const logged = () =>
  Object.values(spies)
    .flatMap((s) => s.mock.calls)
    .map((c) => c.map((x: unknown) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(' '))
    .join('\n');

beforeEach(() => {
  users.clear();
  delivery.clear();
  sendCalls.length = 0;
  modelCalls.updateOne = modelCalls.pull = modelCalls.findById = 0;
  authLookups.count = 0;
  failPull.on = false;
  gate.size = 0;
  gate.arrived = 0;
  seed('u1');
  seed('u2');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  spies = {
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../src/models/User.model');
  vi.doUnmock('web-push');
});

describe('authentication', () => {
  it('requires a token on every push route and touches nothing without one', async () => {
    const app = await loadApp();
    for (const path of ['subscribe', 'unsubscribe', 'relay']) {
      const res = await request(app).post(`/api/push/${path}`).send(sub());
      expect(res.status).toBe(401);
    }
    expect(modelCalls).toEqual({ updateOne: 0, pull: 0, findById: 0 });
  });
});

describe('POST /subscribe — valid input', () => {
  it('stores a valid subscription for the caller only, exactly as the browser sent it', async () => {
    const app = await loadApp();
    const future = NOW.getTime() + 3_600_000;
    const res = await subscribe(app, sub(1, { expirationTime: future }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(stored('u1')).toEqual([sub(1, { expirationTime: future })]);
    expect(stored('u2')).toEqual([]);
  });

  it('accepts what PushSubscription.toJSON() produces: expirationTime null, or omitted', async () => {
    const app = await loadApp();
    expect((await subscribe(app, sub(1))).status).toBe(200);
    const { expirationTime: _omit, ...withoutExpiry } = sub(2);
    expect((await subscribe(app, withoutExpiry)).status).toBe(200);
    expect(stored('u1').map((s) => s.expirationTime)).toEqual([null, null]);
  });

  it('keeps only the known fields (nothing else in the body is ever stored)', async () => {
    const app = await loadApp();
    await subscribe(app, { ...sub(1), isAdmin: true, userId: 'u2', __proto__: { x: 1 }, keys: { ...sub().keys, extra: 'x' } });
    expect(Object.keys(stored('u1')[0]).sort()).toEqual(['endpoint', 'expirationTime', 'keys']);
    expect(Object.keys(stored('u1')[0].keys).sort()).toEqual(['auth', 'p256dh']);
  });

  it('accepts an endpoint of exactly the maximum length and rejects one more character', async () => {
    const app = await loadApp();
    const base = 'https://fcm.googleapis.com/fcm/send/';
    const exact = base + 'a'.repeat(PUSH_ENDPOINT_MAX_LENGTH - base.length);
    expect(exact).toHaveLength(PUSH_ENDPOINT_MAX_LENGTH);
    expect((await subscribe(app, sub(1, { endpoint: exact }))).status).toBe(200);
    expect((await subscribe(app, sub(1, { endpoint: `${exact}a` }))).status).toBe(400);
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
  ])('accepts the real push-service endpoint shape %s', async (endpoint) => {
    const app = await loadApp();
    expect((await subscribe(app, sub(1, { endpoint }))).status).toBe(200);
  });
});

describe('POST /subscribe — malformed input is rejected with 400 and never reaches the database', () => {
  const SECRET_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/SECRET-TOKEN-VALUE';
  const bad: [string, unknown][] = [
    ['array body', [sub()]],
    ['string body', 'subscription'],
    ['null body', null],
    ['missing endpoint', { keys: sub().keys }],
    ['numeric endpoint', sub(1, { endpoint: 12345 })],
    ['object endpoint (operator injection)', sub(1, { endpoint: { $ne: 'x' } })],
    ['array endpoint', sub(1, { endpoint: [ep(1)] })],
    ['empty endpoint', sub(1, { endpoint: '' })],
    ['http endpoint', sub(1, { endpoint: 'http://fcm.googleapis.com/fcm/send/abc' })],
    ['ftp endpoint', sub(1, { endpoint: 'ftp://fcm.googleapis.com/x' })],
    ['javascript: endpoint', sub(1, { endpoint: 'javascript:alert(1)' })],
    ['file: endpoint', sub(1, { endpoint: 'file:///etc/passwd' })],
    ['not a URL', sub(1, { endpoint: 'not a url' })],
    ['scheme-relative', sub(1, { endpoint: '//fcm.googleapis.com/x' })],
    ['credentials in URL', sub(1, { endpoint: 'https://user:pass@fcm.googleapis.com/x' })],
    ['username only', sub(1, { endpoint: 'https://user@fcm.googleapis.com/x' })],
    ['non-default port', sub(1, { endpoint: 'https://fcm.googleapis.com:8443/x' })],
    ['whitespace in URL', sub(1, { endpoint: 'https://fcm.googleapis.com/a b' })],
    ['newline in URL', sub(1, { endpoint: 'https://fcm.googleapis.com/a\nb' })],
    ['IPv4 literal', sub(1, { endpoint: 'https://127.0.0.1/x' })],
    ['private IPv4 literal', sub(1, { endpoint: 'https://10.0.0.5/x' })],
    ['cloud metadata IP', sub(1, { endpoint: 'https://169.254.169.254/latest/meta-data' })],
    ['decimal IPv4', sub(1, { endpoint: 'https://2130706433/x' })],
    ['hex IPv4', sub(1, { endpoint: 'https://0x7f000001/x' })],
    ['octal-ish IPv4', sub(1, { endpoint: 'https://0177.0.0.1/x' })],
    ['IPv6 loopback', sub(1, { endpoint: 'https://[::1]/x' })],
    ['IPv4-mapped IPv6', sub(1, { endpoint: 'https://[::ffff:7f00:1]/x' })],
    ['localhost', sub(1, { endpoint: 'https://localhost/x' })],
    ['subdomain of localhost', sub(1, { endpoint: 'https://a.localhost/x' })],
    ['single-label host', sub(1, { endpoint: 'https://pushservice/x' })],
    ['.internal host', sub(1, { endpoint: 'https://metadata.google.internal/x' })],
    ['.local host', sub(1, { endpoint: 'https://printer.local/x' })],
    ['endpoint too long', sub(1, { endpoint: `https://fcm.googleapis.com/${'a'.repeat(PUSH_ENDPOINT_MAX_LENGTH)}` })],
    ['missing keys', { endpoint: ep(1) }],
    ['keys is a string', sub(1, { keys: 'keys' })],
    ['keys is an array', sub(1, { keys: [P256, AUTH] })],
    ['missing p256dh', sub(1, { keys: { auth: AUTH } })],
    ['missing auth', sub(1, { keys: { p256dh: P256 } })],
    ['numeric p256dh', sub(1, { keys: { p256dh: 1, auth: AUTH } })],
    ['object p256dh', sub(1, { keys: { p256dh: { $ne: '' }, auth: AUTH } })],
    ['numeric auth', sub(1, { keys: { p256dh: P256, auth: 1 } })],
    ['p256dh 64 bytes', sub(1, { keys: { p256dh: b64(64), auth: AUTH } })],
    ['p256dh 66 bytes', sub(1, { keys: { p256dh: b64(66), auth: AUTH } })],
    ['p256dh empty', sub(1, { keys: { p256dh: '', auth: AUTH } })],
    ['p256dh huge', sub(1, { keys: { p256dh: 'A'.repeat(100_000), auth: AUTH } })],
    ['p256dh not base64url', sub(1, { keys: { p256dh: `${P256.slice(0, -1)}!`, auth: AUTH } })],
    ['p256dh standard base64 (+ or /)', sub(1, { keys: { p256dh: Buffer.alloc(65, 0xfb).toString('base64'), auth: AUTH } })],
    ['p256dh padded', sub(1, { keys: { p256dh: `${P256}=`, auth: AUTH } })],
    ['p256dh non-canonical trailing bits', sub(1, { keys: { p256dh: `${P256.slice(0, -1)}${P256.endsWith('B') ? 'C' : 'B'}`, auth: AUTH } })],
    ['auth 15 bytes', sub(1, { keys: { p256dh: P256, auth: b64(15) } })],
    ['auth 17 bytes', sub(1, { keys: { p256dh: P256, auth: b64(17) } })],
    ['auth empty', sub(1, { keys: { p256dh: P256, auth: '' } })],
    ['auth padded', sub(1, { keys: { p256dh: P256, auth: `${AUTH}==` } })],
    ['auth not base64url', sub(1, { keys: { p256dh: P256, auth: 'not base64 url!!!!!!!!!!' } })],
    ['expirationTime string', sub(1, { expirationTime: 'soon' })],
    ['expirationTime numeric string', sub(1, { expirationTime: '99999999999999' })],
    ['expirationTime boolean', sub(1, { expirationTime: true })],
    ['expirationTime object', sub(1, { expirationTime: { $gt: 0 } })],
    ['expirationTime negative', sub(1, { expirationTime: -1 })],
    ['expirationTime fractional', sub(1, { expirationTime: NOW.getTime() + 0.5 })],
    ['expirationTime zero', sub(1, { expirationTime: 0 })],
    ['expirationTime already past', sub(1, { expirationTime: NOW.getTime() - 1 })],
    ['expirationTime exactly now', sub(1, { expirationTime: NOW.getTime() })],
    ['expirationTime beyond Date range', sub(1, { expirationTime: 8_640_000_000_000_001 })],
    ['expirationTime unsafe integer', sub(1, { expirationTime: 1e300 })],
  ];

  it.each(bad)('rejects %s', async (_name, body) => {
    const app = await loadApp();
    const res = await subscribe(app, body);
    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(modelCalls.updateOne).toBe(0);
    expect(stored('u1')).toEqual([]);
  });

  it('accepts expirationTime one millisecond in the future', async () => {
    const app = await loadApp();
    expect((await subscribe(app, sub(1, { expirationTime: NOW.getTime() + 1 }))).status).toBe(200);
  });

  it('never echoes the submitted endpoint or key material in the error response', async () => {
    const app = await loadApp();
    const res = await subscribe(app, {
      endpoint: SECRET_ENDPOINT,
      keys: { p256dh: 'SECRET-P256DH', auth: 'SECRET-AUTH' },
    });
    expect(res.status).toBe(400);
    const wire = JSON.stringify(res.body);
    for (const s of ['SECRET-TOKEN-VALUE', 'SECRET-P256DH', 'SECRET-AUTH', 'fcm.googleapis.com']) {
      expect(wire).not.toContain(s);
    }
  });
});

describe('POST /subscribe — duplicates', () => {
  it('re-subscribing the same endpoint keeps ONE entry, refreshes its keys and keeps its position', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    const newAuth = b64(16, 9);
    const res = await subscribe(app, sub(1, { keys: { p256dh: P256, auth: newAuth } }));

    expect(res.status).toBe(200);
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(1), ep(2)]);
    expect(stored('u1')[0].keys.auth).toBe(newAuth);
  });

  it('is idempotent: repeating an identical request many times never grows the list', async () => {
    const app = await loadApp();
    for (let i = 0; i < 25; i += 1) expect((await subscribe(app, sub(1))).status).toBe(200);
    expect(stored('u1')).toHaveLength(1);
  });

  it('the same endpoint on two accounts is stored for each (ownership is per user)', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1), 'u1');
    await subscribe(app, sub(1), 'u2');
    expect(stored('u1')).toHaveLength(1);
    expect(stored('u2')).toHaveLength(1);
  });

  it('concurrent identical requests for a NEW endpoint (all checking before any writes) produce exactly one entry', async () => {
    const app = await loadApp();
    armGate(8); // all 8 first-step checks happen before any insert
    const keysFor = (i: number) => ({ p256dh: P256, auth: b64(16, i) });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => subscribe(app, sub(1, { keys: keysFor(i + 1) }))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(stored('u1')).toHaveLength(1);
    expect(stored('u1')[0].endpoint).toBe(ep(1));
  });

  it('concurrent requests mixing a new and an existing endpoint never duplicate either', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    armGate(10);
    await Promise.all([
      ...Array.from({ length: 5 }, () => subscribe(app, sub(1))),
      ...Array.from({ length: 5 }, () => subscribe(app, sub(2))),
    ]);
    expect(stored('u1').map((s) => s.endpoint).sort()).toEqual([ep(1), ep(2)]);
  });

  it('concurrent distinct subscriptions at the limit still never exceed it', async () => {
    const app = await loadApp();
    for (let i = 1; i <= MAX; i += 1) await subscribe(app, sub(i));
    armGate(6);
    await Promise.all(Array.from({ length: 6 }, (_, i) => subscribe(app, sub(100 + i))));
    expect(stored('u1')).toHaveLength(MAX);
    expect(new Set(stored('u1').map((s) => s.endpoint)).size).toBe(MAX);
  });
});

describe('POST /subscribe — per-user bound', () => {
  it('keeps at most the limit: the newest subscription wins and the oldest is dropped', async () => {
    const app = await loadApp();
    for (let i = 1; i <= MAX; i += 1) await subscribe(app, sub(i));
    expect(stored('u1')).toHaveLength(MAX);

    const res = await subscribe(app, sub(MAX + 1));
    expect(res.status).toBe(200);
    expect(stored('u1')).toHaveLength(MAX);
    expect(stored('u1').map((s) => s.endpoint)).toEqual(Array.from({ length: MAX }, (_, i) => ep(i + 2)));
  });

  it('refreshing an endpoint that is already stored never evicts anything, even at the limit', async () => {
    const app = await loadApp();
    for (let i = 1; i <= MAX; i += 1) await subscribe(app, sub(i));
    await subscribe(app, sub(1, { keys: { p256dh: P256, auth: b64(16, 5) } }));
    expect(stored('u1').map((s) => s.endpoint)).toEqual(Array.from({ length: MAX }, (_, i) => ep(i + 1)));
  });

  it('a flood of distinct endpoints can never push the list past the limit', async () => {
    const app = await loadApp();
    for (let i = 1; i <= MAX * 3; i += 1) await subscribe(app, sub(i));
    expect(stored('u1')).toHaveLength(MAX);
    expect(stored('u1')[MAX - 1].endpoint).toBe(ep(MAX * 3));
  });

  it('concurrent distinct subscriptions respect the limit', async () => {
    const app = await loadApp();
    await Promise.all(Array.from({ length: MAX * 2 }, (_, i) => subscribe(app, sub(i + 1))));
    expect(stored('u1')).toHaveLength(MAX);
    expect(new Set(stored('u1').map((s) => s.endpoint)).size).toBe(MAX);
  });

  it('trims a legacy account that is already over the limit, keeping the newest', async () => {
    const app = await loadApp();
    seed('u1', Array.from({ length: MAX + 5 }, (_, i) => sub(i + 1) as unknown as Sub));
    await subscribe(app, sub(100));
    const eps = stored('u1').map((s) => s.endpoint);
    expect(eps).toHaveLength(MAX);
    expect(eps[eps.length - 1]).toBe(ep(100));
    expect(eps[0]).toBe(ep(MAX + 5 - (MAX - 1) + 1));
  });

  it("one user's subscriptions never count against, or evict, another user's", async () => {
    const app = await loadApp();
    for (let i = 1; i <= MAX; i += 1) await subscribe(app, sub(i), 'u2');
    for (let i = 1; i <= MAX * 2; i += 1) await subscribe(app, sub(`a${i}`), 'u1');
    expect(stored('u2').map((s) => s.endpoint)).toEqual(Array.from({ length: MAX }, (_, i) => ep(i + 1)));
  });
});

describe('POST /subscribe — real push-service hosts are accepted; the SSRF boundary is at connect time', () => {
  // These are the hosts real browsers produce. There is deliberately NO hostname allowlist (providers change
  // and a suffix list would be broad): any public DNS name is accepted here, and the delivery agent refuses
  // names that resolve to private addresses (see tests/pushNetworkGuard.test.ts).
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:APA91bExample',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample',
    'https://web.push.apple.com/QExample',
    'https://wns2-par02p.notify.windows.com/w/?token=BExample',
    'https://push.example.org/subscription/abc',
  ])('accepts %s', async (endpoint) => {
    const app = await loadApp();
    const res = await subscribe(app, sub(1, { endpoint }));
    expect(res.status).toBeLessThan(300);
    expect(stored().map((x) => x.endpoint)).toEqual([endpoint]);
  });

  it.each([
    'https://127.0.0.1/p', 'https://2130706433/p', 'https://0x7f.0.0.1/p', 'https://[::1]/p',
    'https://[::ffff:7f00:1]/p', 'https://169.254.169.254/latest/meta-data', 'https://localhost/p',
    'https://metadata.internal/p', 'https://printer.local/p', 'https://fcm.googleapis.com@127.0.0.1/p',
    'https://127.0.0.1#@fcm.googleapis.com/p', 'https://fcm.googleapis.com:8443/p', 'http://fcm.googleapis.com/p',
    'https://fcm.googleapis.com.localhost/p',
  ])('still rejects %s (shape-level boundary unchanged)', async (endpoint) => {
    const app = await loadApp();
    const res = await subscribe(app, sub(1, { endpoint }));
    expect(res.status).toBe(400);
    expect(stored()).toHaveLength(0);
  });
});

describe('POST /subscribe — misc', () => {
  it('answers 401 and stores nothing when the token belongs to an account that no longer exists', async () => {
    const app = await loadApp();
    const res = await subscribe(app, sub(1), 'ghost');
    expect(res.status).toBe(401);
    expect(users.has('ghost')).toBe(false);
  });

  it('logs nothing at all about subscriptions, valid or not', async () => {
    const app = await loadApp();
    await subscribe(app, sub('SECRETTOKEN1'));
    await subscribe(app, sub('SECRETTOKEN1'));
    await subscribe(app, { endpoint: 'https://fcm.googleapis.com/SECRETTOKEN2', keys: { p256dh: 'bad', auth: 'bad' } });
    const out = logged();
    for (const s of ['SECRETTOKEN', P256, AUTH, 'fcm.googleapis.com']) expect(out).not.toContain(s);
  });
});

describe('POST /unsubscribe', () => {
  it('removes the named endpoint for the caller and leaves the rest', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    const res = await unsubscribe(app, { endpoint: ep(1) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(2)]);
  });

  it('is idempotent for an unknown endpoint', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    expect((await unsubscribe(app, { endpoint: ep(99) })).status).toBe(200);
    expect(stored('u1')).toHaveLength(1);
  });

  it("cannot remove another user's subscription", async () => {
    const app = await loadApp();
    await subscribe(app, sub(1), 'u2');
    await unsubscribe(app, { endpoint: ep(1) }, 'u1');
    expect(stored('u2')).toHaveLength(1);
  });

  it('can still remove a legacy entry whose endpoint would no longer pass subscribe validation', async () => {
    const app = await loadApp();
    seed('u1', [{ endpoint: 'http://old.example/legacy', expirationTime: null, keys: sub().keys }]);
    expect((await unsubscribe(app, { endpoint: 'http://old.example/legacy' })).status).toBe(200);
    expect(stored('u1')).toEqual([]);
  });

  it('accepts an endpoint of exactly the maximum length and rejects one more character', async () => {
    const app = await loadApp();
    expect((await unsubscribe(app, { endpoint: 'a'.repeat(PUSH_ENDPOINT_MAX_LENGTH) })).status).toBe(200);
    expect((await unsubscribe(app, { endpoint: 'a'.repeat(PUSH_ENDPOINT_MAX_LENGTH + 1) })).status).toBe(400);
  });

  const bad: [string, unknown][] = [
    ['missing endpoint', {}],
    ['empty endpoint', { endpoint: '' }],
    ['numeric endpoint', { endpoint: 5 }],
    ['null endpoint', { endpoint: null }],
    ['array endpoint', { endpoint: [ep(1)] }],
    ['$ne operator (would delete every subscription)', { endpoint: { $ne: 'x' } }],
    ['$regex operator', { endpoint: { $regex: '.*' } }],
    ['$in operator', { endpoint: { $in: [ep(1)] } }],
    ['array body', [ep(1)]],
    ['string body', ep(1)],
  ];

  it.each(bad)('rejects %s with 400 before the database is touched', async (_n, body) => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    const res = await unsubscribe(app, body);
    expect(res.status).toBe(400);
    expect(modelCalls.pull).toBe(0);
    expect(stored('u1')).toHaveLength(2);
  });
});

describe('POST /relay — validation', () => {
  const ok = { title: 'Task due soon', body: 'Write report is due within the next hour.', tag: 'halotask-due-soon-1' };

  it('accepts exactly the maximum lengths and rejects one more character, for each field', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    const atMax = {
      title: 't'.repeat(PUSH_TITLE_MAX_LENGTH),
      body: 'b'.repeat(PUSH_BODY_MAX_LENGTH),
      tag: 'g'.repeat(PUSH_TAG_MAX_LENGTH),
    };
    expect((await relay(app, atMax)).status).toBe(200);
    expect((await relay(app, { ...atMax, title: `${atMax.title}t` })).status).toBe(400);
    expect((await relay(app, { ...atMax, body: `${atMax.body}b` })).status).toBe(400);
    expect((await relay(app, { ...atMax, tag: `${atMax.tag}g` })).status).toBe(400);
  });

  const bad: [string, unknown][] = [
    ['missing title', { body: 'b' }],
    ['missing body', { title: 't' }],
    ['empty title', { ...ok, title: '' }],
    ['whitespace title', { ...ok, title: '   ' }],
    ['empty body', { ...ok, body: '' }],
    ['whitespace body', { ...ok, body: ' \n ' }],
    ['numeric title', { ...ok, title: 5 }],
    ['object title', { ...ok, title: { a: 1 } }],
    ['array body', { ...ok, body: ['x'] }],
    ['numeric tag', { ...ok, tag: 5 }],
    ['empty tag', { ...ok, tag: '' }],
    ['object tag', { ...ok, tag: { a: 1 } }],
    ['tag with control characters', { ...ok, tag: 'a\u0000b' }],
    ['array body (whole request)', [ok]],
    ['string body (whole request)', 'hello'],
  ];

  it.each(bad)('rejects %s with 400; nothing is looked up or sent', async (_n, body) => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    const res = await relay(app, body);
    expect(res.status).toBe(400);
    expect(sendCalls).toHaveLength(0);
    expect(modelCalls.findById).toBe(0);
  });

  it('rejects a notification whose serialised payload exceeds the protocol limit even if each field is within its character limit', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    const heavy = {
      title: '\u0001'.repeat(PUSH_TITLE_MAX_LENGTH), // JSON-escapes to 6 bytes per character
      body: '\u0001'.repeat(PUSH_BODY_MAX_LENGTH),
      tag: '€'.repeat(PUSH_TAG_MAX_LENGTH), // 3 bytes per character
    };
    expect(Buffer.byteLength(JSON.stringify(heavy))).toBeGreaterThan(PUSH_PAYLOAD_MAX_BYTES);
    const res = await relay(app, heavy);
    expect(res.status).toBe(400);
    expect(sendCalls).toHaveLength(0);
  });

  it('defaults the tag when it is omitted or null', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await relay(app, { title: 't', body: 'b' });
    await relay(app, { title: 't', body: 'b', tag: null });
    expect(sendCalls.map((c) => JSON.parse(c.payload).tag)).toEqual(['halotask-push', 'halotask-push']);
  });

  it('validation comes first: malformed payloads are 400 even when VAPID is not configured', async () => {
    const app = await loadApp(false);
    expect((await relay(app, { title: '', body: 'b' })).status).toBe(400);
  });

  it('with VAPID unconfigured a valid relay is still the existing 200 { sent: 0, reason }', async () => {
    const app = await loadApp(false);
    const res = await relay(app, ok);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, reason: 'vapid_not_configured' });
  });
});

describe('POST /relay — delivery', () => {
  const msg = { title: 'Task due soon', body: 'Write report is due', tag: 'halotask-due-soon-1' };

  it('sends the exact payload to each of the caller\'s subscriptions, with a TTL and a timeout', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    await subscribe(app, sub(3), 'u2');

    const res = await relay(app, msg);

    expect(res.body).toEqual({ sent: 2, failed: 0, pruned: 0 });
    expect(sendCalls.map((c) => c.endpoint).sort()).toEqual([ep(1), ep(2)]); // never u2's
    for (const call of sendCalls) {
      expect(JSON.parse(call.payload)).toEqual(msg);
      expect(call.options).toMatchObject({ TTL: 3600, timeout: 10_000 });
    }
  });

  it('delivers every message through the SSRF-guarded agent (its lookup refuses non-public addresses)', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    await relay(app, msg);

    expect(sendCalls).toHaveLength(2);
    const agents = new Set<unknown>();
    for (const call of sendCalls) {
      const agent = call.options.agent as { options?: { lookup?: unknown } } | undefined;
      expect(agent).toBeInstanceOf(https.Agent);
      expect(typeof agent?.options?.lookup).toBe('function');
      agents.add(agent);
      // The configured lookup must be the guarded one: it refuses to hand back an address for a name that
      // does not resolve (it never falls through to the default resolver). Precise address rules live in
      // tests/pushNetworkGuard.test.ts, where DNS is injected.
      const result = await new Promise<{ err: Error | null; address?: unknown }>((resolve) =>
        (agent!.options!.lookup as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)(
          'localhost', {}, (err, address) => resolve({ err, address }),
        ),
      );
      expect(result.err).not.toBeNull();
      expect(result.address).toBeUndefined();
    }
    expect(agents.size).toBe(1);
  });

  it('a delivery refused by the SSRF guard counts as failed, keeps the subscription, and logs only the host', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    delivery.set(ep(1), { message: 'Push endpoint resolves to a non-public address' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await relay(app, msg);
    expect(res.body).toEqual({ sent: 0, failed: 1, pruned: 0 });
    expect(users.get('u1')!.pushSubscriptions).toHaveLength(1);
    const out = warn.mock.calls.flat().join(' ');
    expect(out).toContain('fcm.googleapis.com');
    expect(out).not.toContain('non-public');
    warn.mockRestore();
  });

  it('answers { sent: 0 } when the user has no subscriptions, and for an unknown user', async () => {
    const app = await loadApp();
    expect((await relay(app, msg)).body).toEqual({ sent: 0 });
    expect((await relay(app, msg, 'ghost')).body).toEqual({ sent: 0 });
  });

  it.each([404, 410])('prunes a subscription the push service reports gone (%i) and keeps the rest', async (statusCode) => {
    const app = await loadApp();
    for (const i of [1, 2, 3]) await subscribe(app, sub(i));
    delivery.set(ep(2), { statusCode });

    const res = await relay(app, msg);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, failed: 0, pruned: 1 });
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(1), ep(3)]);
  });

  it('prunes every stale subscription in one pass', async () => {
    const app = await loadApp();
    for (const i of [1, 2, 3, 4]) await subscribe(app, sub(i));
    delivery.set(ep(1), { statusCode: 410 });
    delivery.set(ep(3), { statusCode: 404 });
    const res = await relay(app, msg);
    expect(res.body).toEqual({ sent: 2, failed: 0, pruned: 2 });
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(2), ep(4)]);
    expect(modelCalls.pull).toBe(1);
  });

  it.each([
    ['429 rate limited', { statusCode: 429 }],
    ['500', { statusCode: 500 }],
    ['503', { statusCode: 503 }],
    ['401 (VAPID rejected)', { statusCode: 401 }],
    ['403', { statusCode: 403 }],
    ['413 payload too large', { statusCode: 413 }],
    ['network error with no status', { message: 'socket hang up' }],
  ])('keeps the subscription after a transient/other failure (%s) and counts it as failed', async (_n, behaviour) => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    delivery.set(ep(1), behaviour);
    const res = await relay(app, msg);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, failed: 1, pruned: 0 });
    expect(stored('u1')).toHaveLength(1);
  });

  it('partial failure: successes are counted, a gone endpoint is pruned, a failing one is kept', async () => {
    const app = await loadApp();
    for (const i of [1, 2, 3, 4]) await subscribe(app, sub(i));
    delivery.set(ep(2), { statusCode: 410 });
    delivery.set(ep(3), { statusCode: 500 });

    const res = await relay(app, msg);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, failed: 1, pruned: 1 });
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(1), ep(3), ep(4)]);
    expect(sendCalls).toHaveLength(4); // one bad endpoint never stops the others
  });

  it('when every delivery fails the request still completes with the counts', async () => {
    const app = await loadApp();
    for (const i of [1, 2, 3]) {
      await subscribe(app, sub(i));
      delivery.set(ep(i), { statusCode: 500 });
    }
    const res = await relay(app, msg);
    expect(res.body).toEqual({ sent: 0, failed: 3, pruned: 0 });
    expect(stored('u1')).toHaveLength(3);
  });

  it('a stored entry with unusable keys fails on its own without affecting the others', async () => {
    const app = await loadApp();
    seed('u1', [
      { endpoint: ep(1), expirationTime: null, keys: { p256dh: 'bad', auth: 'bad' } },
      sub(2) as unknown as Sub,
    ]);
    delivery.set(ep(1), { message: 'The subscription p256dh value should be 65 bytes long.' });
    const res = await relay(app, msg);
    expect(res.body).toEqual({ sent: 1, failed: 1, pruned: 0 });
  });

  it('a failure while pruning does not turn a completed relay into an error', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    await subscribe(app, sub(2));
    delivery.set(ep(1), { statusCode: 410 });
    failPull.on = true;

    const res = await relay(app, msg);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, failed: 0, pruned: 0 });
    expect(stored('u1')).toHaveLength(2); // still there; pruned on a later relay
    failPull.on = false;
    const again = await relay(app, msg);
    expect(again.body).toEqual({ sent: 1, failed: 0, pruned: 1 });
    expect(stored('u1').map((s) => s.endpoint)).toEqual([ep(2)]);
  });

  it('is still rate limited per user (Issue #23 protection is untouched)', async () => {
    const app = await loadApp();
    await subscribe(app, sub(1));
    const { RATE_LIMITS } = await import('../src/config/rateLimits.js');
    for (let i = 0; i < RATE_LIMITS.pushRelayUser.max; i += 1) expect((await relay(app, msg)).status).toBe(200);
    const res = await relay(app, msg);
    expect(res.status).toBe(429);
    expect(sendCalls).toHaveLength(RATE_LIMITS.pushRelayUser.max);
  });
});

describe('POST /relay — logging', () => {
  it('logs delivery failures with only the push host and status; never endpoints, keys, payload or error text', async () => {
    const app = await loadApp();
    await subscribe(app, sub('SECRETPATH1'));
    await subscribe(app, sub('SECRETPATH2'));
    await subscribe(app, sub('SECRETPATH3'));
    delivery.set(ep('SECRETPATH1'), { statusCode: 500, message: `upstream said no to ${ep('SECRETPATH1')} with auth ${AUTH}` });
    delivery.set(ep('SECRETPATH2'), { message: `ECONNRESET ${ep('SECRETPATH2')} ${P256}` });
    delivery.set(ep('SECRETPATH3'), { statusCode: 410 });
    failPull.on = true;

    await relay(app, { title: 'PRIVATE TITLE', body: 'PRIVATE BODY TEXT', tag: 'PRIVATE-TAG' });

    const out = logged();
    expect(out).toContain('[Push]'); // failures ARE reported...
    expect(out).toContain('fcm.googleapis.com'); // ...with the (non-secret) host
    for (const s of ['SECRETPATH', P256, AUTH, 'PRIVATE', 'upstream said', 'ECONNRESET', 'db down']) {
      expect(out).not.toContain(s);
    }
  });
});
