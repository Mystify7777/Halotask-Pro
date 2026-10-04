import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #27 — what happens to existing sessions when a password is reset.
//
// Mongo-independent: the real src/app.ts (routers, requireAuth, controllers, limiters) runs against an
// in-memory User model that behaves like the database where it matters here:
//   - reads return SNAPSHOTS (a later write is invisible to a read that already happened),
//   - exists/updateOne apply a conditional match-and-modify atomically (one synchronous step),
//   - gates can hold requests at the exact points where races happen.
// The same round trip against a real MongoDB lives in api.routes.test.ts, which needs a downloaded
// mongod binary and so cannot run in every environment.

const SECRET = 'test-jwt-secret-1234567890';
const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';
const CODE = '654321';

type Doc = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  tokenVersion?: number;
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  pushSubscriptions: unknown[];
};

const users = new Map<string, Doc>();
const calls = { taskFinds: 0, authLookups: 0 };
const dbFault = { mode: null as null | 'down' | 'cast' };

// "Both requests passed the cost-guard read, neither has written yet": the first `size` exists() calls
// all wait until every one of them has arrived, forcing the interleaving that makes a
// read-then-write reset replayable. Supertest alone often finishes one request before the next starts.
const resetGate = { size: 0, arrived: 0, release: (() => undefined) as () => void, open: Promise.resolve() };
const armResetGate = (n: number) => {
  resetGate.size = n;
  resetGate.arrived = 0;
  resetGate.open = new Promise<void>((resolve) => {
    resetGate.release = resolve;
  });
};

// Holds the next login right AFTER it has read the account (so the password check and the token
// version come from that read) and BEFORE it checks the password and signs a token.
const loginGate = {
  armed: false,
  reached: Promise.resolve(),
  markReached: (() => undefined) as () => void,
  release: (() => undefined) as () => void,
  open: Promise.resolve(),
};
const armLoginGate = () => {
  loginGate.armed = true;
  loginGate.reached = new Promise<void>((resolve) => {
    loginGate.markReached = resolve;
  });
  loginGate.open = new Promise<void>((resolve) => {
    loginGate.release = resolve;
  });
};

let PASSWORD_HASH = '';
let nextId = 1;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// A read returns a copy. The controllers only ever change these three fields through save().
const makeSnapshot = (doc: Doc) => {
  const copy: Doc & { _id: { toString(): string }; save: () => Promise<void> } = {
    ...doc,
    pushSubscriptions: [...doc.pushSubscriptions],
    _id: { toString: () => doc.id },
    save: async () => {
      const live = users.get(doc.id);
      if (!live) return;
      live.passwordHash = copy.passwordHash;
      live.resetPasswordTokenHash = copy.resetPasswordTokenHash;
      live.resetPasswordExpiresAt = copy.resetPasswordExpiresAt;
    },
  };
  return copy;
};

const makeUser = (email: string, extra: Partial<Doc> = {}): Doc => {
  const id = `665f1c2e9b1e8a00000000${String(nextId++).padStart(2, '0')}`;
  const doc: Doc = {
    id,
    name: 'Test User',
    email,
    passwordHash: PASSWORD_HASH,
    tokenVersion: 0,
    pushSubscriptions: [],
    ...extra,
  };
  users.set(id, doc);
  return doc;
};

const byEmail = (email: string) => [...users.values()].find((u) => u.email === email);

type Filter = { email: string; resetPasswordTokenHash?: string; resetPasswordExpiresAt?: { $gt: Date } };

const matchLive = (q: Filter): Doc | undefined => {
  const doc = byEmail(q.email);
  return doc &&
    q.resetPasswordTokenHash !== undefined &&
    doc.resetPasswordTokenHash === q.resetPasswordTokenHash &&
    doc.resetPasswordExpiresAt !== undefined &&
    doc.resetPasswordExpiresAt > (q.resetPasswordExpiresAt?.$gt ?? new Date())
    ? doc
    : undefined;
};

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  delete process.env.SMTP_HOST;
  delete process.env.RESEND_API_KEY;
  delete process.env.TRUST_PROXY_HOPS;

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findOne: async (q: { email: string }) => {
        const doc = byEmail(q.email);
        const read = doc ? makeSnapshot(doc) : null;
        if (read && loginGate.armed) {
          loginGate.armed = false;
          loginGate.markReached();
          await loginGate.open;
        }
        return read;
      },
      create: async (d: { email: string; name: string; passwordHash: string }) =>
        makeSnapshot(makeUser(d.email, { name: d.name, passwordHash: d.passwordHash })),
      // The reset's cost guard. Decides nothing: the answer is a snapshot taken before any write.
      exists: async (q: Filter) => {
        const hit = matchLive(q);
        if (resetGate.size > 0 && resetGate.arrived < resetGate.size) {
          resetGate.arrived += 1;
          if (resetGate.arrived === resetGate.size) resetGate.release();
          await resetGate.open;
        }
        return hit ? { _id: hit.id } : null;
      },
      // The reset's single atomic write: match AND modify in one synchronous step.
      updateOne: async (
        q: Filter,
        update: { $set: Partial<Doc>; $unset: Record<string, unknown>; $inc: { tokenVersion: number } },
      ) => {
        await Promise.resolve();
        const allowed = new Set(['$set', '$unset', '$inc']);
        for (const op of Object.keys(update)) if (!allowed.has(op)) throw new Error(`unexpected operator ${op}`);
        const doc = matchLive(q);
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(doc, update.$set);
        for (const key of Object.keys(update.$unset)) delete (doc as unknown as Record<string, unknown>)[key];
        doc.tokenVersion = (doc.tokenVersion ?? 0) + update.$inc.tokenVersion;
        return { matchedCount: 1, modifiedCount: 1 };
      },
      findById: (id: string) => ({
        select: (fields: string) => ({
          lean: async () => {
            if (fields !== 'tokenVersion') throw new Error(`unexpected projection ${fields}`);
            calls.authLookups += 1;
            if (dbFault.mode === 'down') throw new Error('db down');
            if (dbFault.mode === 'cast') throw Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' });
            const doc = users.get(id);
            return doc ? { tokenVersion: doc.tokenVersion } : null;
          },
        }),
      }),
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

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const seedCode = (email: string, code = CODE, expiresInMs = 20 * 60 * 1000) => {
  const doc = byEmail(email)!;
  doc.resetPasswordTokenHash = sha256(code);
  doc.resetPasswordExpiresAt = new Date(Date.now() + expiresInMs);
};

const login = (app: Express, email: string, password: string) =>
  request(app).post('/api/auth/login').send({ email, password });

const reset = (app: Express, email: string, password = NEW_PASSWORD, code = CODE) =>
  request(app).post('/api/auth/reset-password').send({ email, token: code, password });

const protectedGet = (app: Express, token: string) =>
  request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);

const signLegacy = (doc: Doc) => jwt.sign({ userId: doc.id, email: doc.email, name: doc.name }, SECRET);
const signWith = (doc: Doc, extra: Record<string, unknown>) =>
  jwt.sign({ userId: doc.id, email: doc.email, name: doc.name, ...extra }, SECRET);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(OLD_PASSWORD, 4);
});

beforeEach(() => {
  users.clear();
  nextId = 1;
  calls.taskFinds = 0;
  calls.authLookups = 0;
  dbFault.mode = null;
  resetGate.size = 0;
  loginGate.armed = false;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a session established before the reset', () => {
  it('works until the reset, is rejected after it, and a fresh login works', async () => {
    const app = await loadApp();
    const doc = makeUser('victim@x.test');

    const before = await login(app, doc.email, OLD_PASSWORD);
    expect(before.status).toBe(200);
    const oldToken: string = before.body.token;
    expect((jwt.decode(oldToken) as { tv?: number }).tv).toBe(0);

    // There is no server-side logout: until the version changes the token simply stays valid.
    expect((await protectedGet(app, oldToken)).status).toBe(200);
    expect((await protectedGet(app, oldToken)).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${oldToken}`)).status).toBe(404);

    seedCode(doc.email);
    expect((await reset(app, doc.email)).status).toBe(200);
    expect(byEmail(doc.email)!.tokenVersion).toBe(1);

    const stale = await protectedGet(app, oldToken);
    expect(stale.status).toBe(401);
    expect(stale.body).toEqual({ message: 'Invalid or expired token' });

    // The old password is dead; the new one authenticates and yields a token under the new version.
    expect((await login(app, doc.email, OLD_PASSWORD)).status).toBe(401);
    const after = await login(app, doc.email, NEW_PASSWORD);
    expect(after.status).toBe(200);
    expect((jwt.decode(after.body.token) as { tv?: number }).tv).toBe(1);
    expect((await protectedGet(app, after.body.token)).status).toBe(200);

    // ...and the pre-reset token is still dead afterwards.
    expect((await protectedGet(app, oldToken)).status).toBe(401);
  });

  it('covers a token from registration, and a registration after the reset starts at the current generation', async () => {
    const app = await loadApp();
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'new@x.test', password: OLD_PASSWORD });
    expect(registered.status).toBe(201);
    expect((jwt.decode(registered.body.token) as { tv?: number }).tv).toBe(0);

    seedCode('new@x.test');
    expect((await reset(app, 'new@x.test')).status).toBe(200);
    expect((await protectedGet(app, registered.body.token)).status).toBe(401);
  });

  it('does not touch other accounts: their sessions stay valid', async () => {
    const app = await loadApp();
    const a = makeUser('a@x.test');
    const b = makeUser('b@x.test');
    const tokenA = (await login(app, a.email, OLD_PASSWORD)).body.token;
    const tokenB = (await login(app, b.email, OLD_PASSWORD)).body.token;

    seedCode(a.email);
    expect((await reset(app, a.email)).status).toBe(200);

    expect((await protectedGet(app, tokenA)).status).toBe(401);
    expect((await protectedGet(app, tokenB)).status).toBe(200);
    expect(byEmail(b.email)!.tokenVersion).toBe(0);
  });

  it('revokes pushSubscriptions together with the sessions', async () => {
    const app = await loadApp();
    const doc = makeUser('push@x.test', {
      pushSubscriptions: [{ endpoint: 'https://push.example/a' }, { endpoint: 'https://push.example/b' }],
    });
    seedCode(doc.email);

    expect((await reset(app, doc.email)).status).toBe(200);
    expect(byEmail(doc.email)!.pushSubscriptions).toEqual([]);
  });

  it('a pre-existing account with no tokenVersion field: legacy tokens work, then die on reset', async () => {
    const app = await loadApp();
    const doc = makeUser('legacy@x.test');
    delete doc.tokenVersion; // an account created before this field existed
    const legacyToken = signLegacy(doc); // no `tv` claim at all

    expect((await protectedGet(app, legacyToken)).status).toBe(200);
    expect((await protectedGet(app, signWith(doc, { tv: 0 }))).status).toBe(200);

    seedCode(doc.email);
    expect((await reset(app, doc.email)).status).toBe(200);
    expect(byEmail(doc.email)!.tokenVersion).toBe(1); // $inc on a missing field starts from 0

    expect((await protectedGet(app, legacyToken)).status).toBe(401);
    expect((await protectedGet(app, signWith(doc, { tv: 0 }))).status).toBe(401);
    expect((await protectedGet(app, signWith(doc, { tv: 1 }))).status).toBe(200);
  });
});

describe('reset-code single use and replay', () => {
  it('rejects replay of a consumed code and changes nothing', async () => {
    const app = await loadApp();
    const doc = makeUser('replay@x.test');
    seedCode(doc.email);

    expect((await reset(app, doc.email, NEW_PASSWORD)).status).toBe(200);
    const hashAfterFirst = byEmail(doc.email)!.passwordHash;

    const replay = await reset(app, doc.email, 'attacker-password-1');
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ message: 'Reset code is invalid or expired' });
    expect(byEmail(doc.email)!.passwordHash).toBe(hashAfterFirst);
    expect(byEmail(doc.email)!.tokenVersion).toBe(1); // not bumped a second time
    expect((await login(app, doc.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('two simultaneous resets with the same code: exactly one succeeds, the version moves once', async () => {
    const app = await loadApp();
    const doc = makeUser('race@x.test');
    seedCode(doc.email);
    armResetGate(2); // both pass the cost-guard read before either writes

    const [one, two] = await Promise.all([
      reset(app, doc.email, 'password-from-request-one'),
      reset(app, doc.email, 'password-from-request-two'),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 400]);
    expect(byEmail(doc.email)!.tokenVersion).toBe(1);
    expect(byEmail(doc.email)!.resetPasswordTokenHash).toBeUndefined();

    // Only the winner's password exists; the loser's was never stored.
    const [winner, loser] = one.status === 200
      ? ['password-from-request-one', 'password-from-request-two']
      : ['password-from-request-two', 'password-from-request-one'];
    expect((await login(app, doc.email, winner)).status).toBe(200);
    expect((await login(app, doc.email, loser)).status).toBe(401);
  });

  it('an expired code is rejected and revokes nothing', async () => {
    const app = await loadApp();
    const doc = makeUser('expired@x.test');
    seedCode(doc.email, CODE, -1000);
    const token = signLegacy(doc);

    expect((await reset(app, doc.email)).status).toBe(400);
    expect(byEmail(doc.email)!.tokenVersion).toBe(0);
    expect(byEmail(doc.email)!.passwordHash).toBe(PASSWORD_HASH);
    expect((await protectedGet(app, token)).status).toBe(200);
  });

  it('a wrong code or an invalid new password revokes nothing and does not consume the code', async () => {
    const app = await loadApp();
    const doc = makeUser('guard@x.test');
    seedCode(doc.email);
    const token = signLegacy(doc);

    expect((await reset(app, doc.email, NEW_PASSWORD, '000000')).status).toBe(400);
    expect((await reset(app, doc.email, '123')).status).toBe(400); // password too short
    expect(byEmail(doc.email)!.tokenVersion).toBe(0);
    expect(byEmail(doc.email)!.resetPasswordTokenHash).toBe(sha256(CODE)); // still redeemable
    expect((await protectedGet(app, token)).status).toBe(200);

    expect((await reset(app, doc.email)).status).toBe(200); // the right code, right password still works
  });
});

describe('a login that straddles a reset', () => {
  it('is authenticated by the old password but its token is born revoked', async () => {
    const app = await loadApp();
    const doc = makeUser('straddle@x.test');
    seedCode(doc.email);

    armLoginGate();
    const pending = login(app, doc.email, OLD_PASSWORD).then((res) => res);
    await loginGate.reached; // the login has read the account (old hash, version 0) and is held

    expect((await reset(app, doc.email)).status).toBe(200); // the reset commits in the meantime
    loginGate.release();

    const res = await pending;
    expect(res.status).toBe(200); // it read the account before the reset
    expect((jwt.decode(res.body.token) as { tv?: number }).tv).toBe(0);
    expect((await protectedGet(app, res.body.token)).status).toBe(401); // ...but cannot outlive it

    // A login that starts after the reset is unaffected.
    const fresh = await login(app, doc.email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect((await protectedGet(app, fresh.body.token)).status).toBe(200);
  });
});

describe('requireAuth contract', () => {
  it('answers every rejection with the same 401 body, and never says why', async () => {
    const app = await loadApp();
    const doc = makeUser('same@x.test');
    const stale = signWith(doc, { tv: 7 });
    const forged = jwt.sign({ userId: doc.id, email: doc.email, name: doc.name }, 'some-other-secret');
    const expired = jwt.sign({ userId: doc.id, email: doc.email, name: doc.name }, SECRET, { expiresIn: -10 });
    const ghost = jwt.sign({ userId: '665f1c2e9b1e8a00000000ff', email: 'g@x.test', name: 'G' }, SECRET);

    const bodies = [];
    for (const token of [stale, forged, expired, ghost, 'not-a-jwt']) {
      const res = await protectedGet(app, token);
      expect(res.status).toBe(401);
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ message: 'Invalid or expired token' });
    expect(calls.taskFinds).toBe(0); // none reached a handler
  });

  it('keeps the missing-header response unchanged', async () => {
    const app = await loadApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authorization token is required' });
    expect(calls.authLookups).toBe(0);
  });

  it('rejects a token for an account that no longer exists', async () => {
    const app = await loadApp();
    const doc = makeUser('gone@x.test');
    const token = signLegacy(doc);
    expect((await protectedGet(app, token)).status).toBe(200);

    users.delete(doc.id);
    expect((await protectedGet(app, token)).status).toBe(401);
  });

  it('requires the version to match exactly: a token from the future is not accepted either', async () => {
    const app = await loadApp();
    const doc = makeUser('exact@x.test');
    expect((await protectedGet(app, signWith(doc, { tv: 0 }))).status).toBe(200);
    expect((await protectedGet(app, signWith(doc, { tv: 1 }))).status).toBe(401);
  });

  it.each([
    ['a string', 'one'],
    ['a negative number', -1],
    ['a fraction', 0.5],
    ['null', null],
  ])('rejects a malformed tv claim (%s)', async (_label, tv) => {
    const app = await loadApp();
    const doc = makeUser('badtv@x.test');
    expect((await protectedGet(app, signWith(doc, { tv }))).status).toBe(401);
    expect(calls.taskFinds).toBe(0);
    expect(calls.authLookups).toBe(0); // refused from the token alone, without spending a database read
  });

  it('rejects a token whose userId is not an id at all (cast error) as a bad token', async () => {
    const app = await loadApp();
    const doc = makeUser('cast@x.test');
    dbFault.mode = 'cast';
    expect((await protectedGet(app, signLegacy(doc))).status).toBe(401);
  });

  it('fails CLOSED when the session lookup itself fails: 500, handler never reached, nothing leaked', async () => {
    const app = await loadApp();
    const doc = makeUser('down@x.test');
    const token = signLegacy(doc);
    dbFault.mode = 'down';

    const res = await protectedGet(app, token);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
    expect(calls.taskFinds).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('db down');

    dbFault.mode = null;
    expect((await protectedGet(app, token)).status).toBe(200); // recovers when the database does
  });
});
