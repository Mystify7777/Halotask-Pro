import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';
import type { EmailMessage, EmailService, FallbackPolicy, SendResult } from '../src/services/emailService';

// Issue #46: PUT /api/user/password against the REAL app (routers, requireAuth, limiter, controller) with an in-memory User
// double. The double reads SNAPSHOTS and applies findOneAndUpdate's filter-and-modify in one synchronous step, and it THROWS
// on any operator or field the controller is not meant to use. What it cannot prove is MongoDB's own filter semantics:
// tests/changePassword.realmongo.test.ts covers that (needs a database; CI is the gate).

const OLD = 'old-password-123';
const NEW = 'new-password-456';
const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';

type Doc = {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  tokenVersion?: number;
  timeZone?: string;
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  pushSubscriptions: unknown[];
};

const db = vi.hoisted(() => ({ users: new Map<string, unknown>() }));
const users = db.users as unknown as Map<string, Doc>;
const writes: Array<{ filter: Record<string, unknown>; update: Record<string, Record<string, unknown>>; options: unknown }> = [];
const gate = { beforeWrite: null as null | (() => Promise<void> | void) };
const fault = { down: false };
let HASH = '';
const sent: Array<{ message: EmailMessage; policy: FallbackPolicy }> = [];
let outcome: SendResult | 'throw' = { status: 'sent', provider: 'smtp' };

beforeAll(async () => {
  HASH = await bcrypt.hash(OLD, 4);
});

const seed = (id: string, extra: Partial<Doc> = {}) => {
  const doc: Doc = { _id: id, name: 'Test User', email: `${id.slice(-2)}@x.test`, passwordHash: HASH, tokenVersion: 0, pushSubscriptions: [{ endpoint: 'e' }], ...extra };
  users.set(id, doc);
  return doc;
};
const sign = (id: string, tv = 0) => jwt.sign({ userId: id, email: `${id.slice(-2)}@x.test`, name: 'Test User', tv }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (id: string, tv = 0) => ({ Authorization: `Bearer ${sign(id, tv)}` });

const pick = (doc: Doc | undefined, fields: string) => {
  if (!doc) return null;
  const out: Record<string, unknown> = { _id: doc._id };
  for (const f of fields.split(' ')) if (f in doc) out[f] = (doc as unknown as Record<string, unknown>)[f];
  return out;
};

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: (id: string) => ({
        select: (fields: string) => ({
          lean: async () => {
            if (fault.down) throw new Error('db down');
            if (!['tokenVersion', 'passwordHash tokenVersion'].includes(fields)) throw new Error(`unexpected projection ${fields}`);
            return pick(users.get(id), fields);
          },
        }),
      }),
      findOneAndUpdate: (filter: { _id: string; passwordHash: string; tokenVersion: number | { $in: unknown[] } }, update: Record<string, Record<string, unknown>>, options: unknown) => ({
        select: (fields: string) => ({
          lean: async () => {
            await gate.beforeWrite?.();
            for (const op of Object.keys(update)) if (!['$set', '$unset', '$inc'].includes(op)) throw new Error(`unexpected operator ${op}`);
            for (const key of Object.keys(filter)) if (!['_id', 'passwordHash', 'tokenVersion'].includes(key)) throw new Error(`unexpected filter key ${key}`);
            for (const key of Object.keys(update.$set)) if (!['passwordHash', 'pushSubscriptions'].includes(key)) throw new Error(`unexpected $set ${key}`);
            writes.push({ filter, update, options });
            const doc = users.get(filter._id);
            if (!doc || doc.passwordHash !== filter.passwordHash) return null; // the conditional match
            const wanted = filter.tokenVersion;
            const stored = doc.tokenVersion; // absent on a legacy account
            if (typeof wanted === 'number') {
              if (stored !== wanted) return null;
            } else if (!(typeof wanted === 'object' && Array.isArray(wanted.$in) && wanted.$in.length === 2 && wanted.$in[0] === 0 && wanted.$in[1] === null)) {
              throw new Error('unexpected tokenVersion filter');
            } else if (!(stored === 0 || stored === undefined || stored === null)) {
              return null; // $in [0, null] matches 0 and an absent field only
            }
            Object.assign(doc, update.$set);
            for (const key of Object.keys(update.$unset)) delete (doc as unknown as Record<string, unknown>)[key];
            doc.tokenVersion = (doc.tokenVersion ?? 0) + (update.$inc.tokenVersion as number);
            return pick(doc, fields);
          },
        }),
      }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: { find: () => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) }), countDocuments: async () => 0 } }));
  vi.doMock('../src/models/CompletionRecord.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));

  const app = ((await import('../src/app.js')) as unknown as { default: Express }).default;
  const emailModule = await import('../src/services/emailService.js');
  const stub: EmailService = {
    isConfigured: () => true,
    send: async (message, policy) => {
      sent.push({ message, policy });
      if (outcome === 'throw') throw new Error('provider exploded');
      return outcome;
    },
  };
  emailModule.setEmailService(stub);
  return app;
}

let app: Express;
let consoleLines: string[];
const change = (id: string, body: unknown, tv = 0) => request(app).put('/api/user/password').set(as(id, tv)).send(body as object);
const ok = { currentPassword: OLD, newPassword: NEW };
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  users.clear();
  writes.length = 0;
  sent.length = 0;
  outcome = { status: 'sent', provider: 'smtp' };
  gate.beforeWrite = null;
  fault.down = false;
  consoleLines = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...args) => void consoleLines.push(args.join(' ')));
  seed(A);
  seed(B, { passwordHash: HASH });
  app = await loadApp();
  resetAllRateLimiters();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('who may call it', () => {
  it('needs a session: no token, and a token from before a revocation, are both 401', async () => {
    expect((await request(app).put('/api/user/password').send(ok)).status).toBe(401);
    users.get(A)!.tokenVersion = 3;
    const stale = await change(A, ok, 0);
    expect(stale.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it('changes only the authenticated account, whatever the body names', async () => {
    const res = await change(A, { ...ok, userId: B, email: 'b@x.test', _id: B });
    expect(res.status).toBe(200);
    expect(writes[0].filter._id).toBe(A);
    expect(await bcrypt.compare(NEW, users.get(A)!.passwordHash)).toBe(true);
    expect(users.get(B)!.passwordHash).toBe(HASH);
  });
});

describe('input', () => {
  it.each([
    ['no body', undefined],
    ['an array', []],
    ['a missing current password', { newPassword: NEW }],
    ['a missing new password', { currentPassword: OLD }],
    ['an empty current password', { currentPassword: '', newPassword: NEW }],
  ])('%s is 400 and writes nothing', async (_name, body) => {
    const res = await change(A, body);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it.each([[{ currentPassword: 5, newPassword: NEW }], [{ currentPassword: OLD, newPassword: { $ne: 1 } }], [{ currentPassword: ['x'], newPassword: NEW }]])('non-string values are 400 (%j)', async (body) => {
    const res = await change(A, body);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('a new password under the minimum is 400 PASSWORD_TOO_SHORT, using the shared rule', async () => {
    const res = await change(A, { currentPassword: OLD, newPassword: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_TOO_SHORT');
    expect(writes).toHaveLength(0);
  });

  it('a wrong current password is 403 INVALID_CURRENT_PASSWORD, never 401 (the client signs out on 401), and writes nothing', async () => {
    const res = await change(A, { currentPassword: 'not-it-at-all', newPassword: NEW });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(writes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('a new password equal to the current one is 400 PASSWORD_UNCHANGED', async () => {
    const res = await change(A, { currentPassword: OLD, newPassword: OLD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_UNCHANGED');
    expect(writes).toHaveLength(0);
  });

  it('"unchanged" is decided by bcrypt, so a password sharing the first 72 bytes counts as the same one', async () => {
    const long = 'x'.repeat(72);
    users.get(A)!.passwordHash = await bcrypt.hash(long, 4);
    const res = await change(A, { currentPassword: long, newPassword: `${long}-and-more` });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_UNCHANGED');
  });
});

describe('a successful change', () => {
  it('sets the new hash, revokes older sessions, and answers with a token for the NEW generation', async () => {
    const res = await change(A, ok);
    expect(res.status).toBe(200);
    expect(await bcrypt.compare(NEW, users.get(A)!.passwordHash)).toBe(true);
    expect(users.get(A)!.tokenVersion).toBe(1);

    const claims = jwt.verify(res.body.token, SECRET) as { userId: string; tv: number };
    expect(claims).toMatchObject({ userId: A, tv: 1 });
    expect(res.body.user).toEqual({ id: A, name: 'Test User', email: '01@x.test'.replace('01', A.slice(-2)), timeZone: null });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    // the old token is refused afterwards, the new one is accepted
    expect((await change(A, { currentPassword: NEW, newPassword: 'another-one-789' }, 0)).status).toBe(401);
    const again = await request(app).put('/api/user/password').set('Authorization', `Bearer ${res.body.token}`).send({ currentPassword: NEW, newPassword: 'another-one-789' });
    expect(again.status).toBe(200);
  });

  it('an account that predates tokenVersion (field absent) moves from 0 to 1 and gets a tv=1 token; the filter matches the absent field', async () => {
    delete users.get(A)!.tokenVersion;
    const res = await change(A, ok);
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ tv: 1 });
    expect(writes[0].filter.tokenVersion).toEqual({ $in: [0, null] });
  });

  it('a non-zero observed tokenVersion is pinned as that exact number', async () => {
    users.get(A)!.tokenVersion = 4;
    const res = await change(A, ok, 4);
    expect(res.status).toBe(200);
    expect(writes[0].filter).toEqual({ _id: A, passwordHash: HASH, tokenVersion: 4 });
    expect(users.get(A)!.tokenVersion).toBe(5);
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ tv: 5 });
  });

  it('is one conditional write: filtered on the hash that was verified, and it also clears the reset code and the push subscriptions', async () => {
    users.get(A)!.resetPasswordTokenHash = 'abc';
    users.get(A)!.resetPasswordExpiresAt = new Date(Date.now() + 60_000);
    const res = await change(A, ok);
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].filter).toEqual({ _id: A, passwordHash: HASH, tokenVersion: { $in: [0, null] } }); // observed 0 (or absent) matches both
    expect(Object.keys(writes[0].update).sort()).toEqual(['$inc', '$set', '$unset']);
    expect(writes[0].update.$set.pushSubscriptions).toEqual([]);
    expect(users.get(A)!.resetPasswordTokenHash).toBeUndefined();
    expect(users.get(A)!.resetPasswordExpiresAt).toBeUndefined();
    expect(users.get(A)!.pushSubscriptions).toEqual([]);
    expect((writes[0].options as { new: boolean }).new).toBe(true); // the token's generation comes from the written document
  });

  it('keeps the saved time zone in the answer', async () => {
    users.get(A)!.timeZone = 'Asia/Kolkata';
    const res = await change(A, ok);
    expect(res.body.user.timeZone).toBe('Asia/Kolkata');
  });
});

describe('races', () => {
  it('two changes racing from the same state: exactly one wins, the other is 409 and writes nothing', async () => {
    let arrived = 0;
    let release!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate.beforeWrite = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await open;
    };
    const [one, two] = await Promise.all([
      change(A, { currentPassword: OLD, newPassword: 'first-new-pass' }),
      change(A, { currentPassword: OLD, newPassword: 'second-new-pass' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body.code).toBe('PASSWORD_CHANGED_ELSEWHERE');
    expect(users.get(A)!.tokenVersion).toBe(1); // one bump
    expect(sent).toHaveLength(1); // one notice
  });

  it('a tokenVersion that moved between the read and the write WITHOUT the hash changing also loses: the change is 409 and writes nothing (D3 pins both)', async () => {
    gate.beforeWrite = () => {
      users.get(A)!.tokenVersion = (users.get(A)!.tokenVersion ?? 0) + 1; // some other operation revoked the sessions; the hash is untouched
    };
    const res = await change(A, ok);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSWORD_CHANGED_ELSEWHERE');
    expect(users.get(A)!.passwordHash).toBe(HASH);
    expect(users.get(A)!.tokenVersion).toBe(1); // only the other operation's bump
    expect(sent).toHaveLength(0);
  });

  it('a reset that commits between the verification and the write wins: the change is 409', async () => {
    gate.beforeWrite = async () => {
      users.get(A)!.passwordHash = await bcrypt.hash('set-by-the-reset', 4);
      users.get(A)!.tokenVersion = 1;
    };
    const res = await change(A, ok);
    expect(res.status).toBe(409);
    expect(await bcrypt.compare('set-by-the-reset', users.get(A)!.passwordHash)).toBe(true);
    expect(users.get(A)!.tokenVersion).toBe(1);
  });
});

describe('the notice', () => {
  it('is sent once to the account address with the at-most-once policy, and carries no secret', async () => {
    await change(A, ok);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.to).toBe(users.get(A)!.email);
    expect(sent[0].policy).toBe('definite-only');
    const body = `${sent[0].message.subject}\n${sent[0].message.text}`;
    expect(body).not.toContain(OLD);
    expect(body).not.toContain(NEW);
    expect(body).not.toMatch(/\$2[aby]\$/);
  });

  it.each([['a thrown provider error', 'throw' as const], ['a failed delivery', { status: 'failed', provider: 'smtp', definite: true } as unknown as SendResult]])('%s does not change the answer, and nothing secret is logged', async (_name, result) => {
    outcome = result;
    const res = await change(A, ok);
    await flush();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const log = consoleLines.join('\n');
    expect(log).not.toContain(OLD);
    expect(log).not.toContain(NEW);
    expect(log).not.toContain(res.body.token);
  });

  it('no notice for any refused attempt', async () => {
    await change(A, { currentPassword: 'wrong-wrong', newPassword: NEW });
    await change(A, { currentPassword: OLD, newPassword: OLD });
    await change(A, { currentPassword: OLD, newPassword: '1' });
    await flush();
    expect(sent).toHaveLength(0);
  });
});

describe('rate limit', () => {
  it('counts only failures per user (5 per window); a success does not use a slot', async () => {
    for (let i = 0; i < 5; i += 1) expect((await change(A, { currentPassword: 'wrong-wrong', newPassword: NEW })).status).toBe(403);
    const blocked = await change(A, { currentPassword: 'wrong-wrong', newPassword: NEW });
    expect(blocked.status).toBe(429);
    expect(writes).toHaveLength(0);
    // another account is not affected by A's failures
    expect((await change(B, ok)).status).toBe(200);
  });

  it('successful changes never exhaust the budget', async () => {
    let current = OLD;
    let tv = 0;
    let token = sign(A, 0);
    for (let i = 0; i < 8; i += 1) {
      const next = `rotating-password-${i}`;
      const res = await request(app).put('/api/user/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: current, newPassword: next });
      expect(res.status).toBe(200);
      current = next;
      tv += 1;
      token = res.body.token;
    }
    expect(tv).toBe(8);
  });

  it('is applied before the password is checked: the 429 never reaches bcrypt or the database write', async () => {
    for (let i = 0; i < 5; i += 1) await change(A, { currentPassword: 'wrong-wrong', newPassword: NEW });
    const blocked = await change(A, ok); // even the CORRECT password is refused while limited
    expect(blocked.status).toBe(429);
    expect(writes).toHaveLength(0);
  });
});

describe('database trouble', () => {
  it('fails closed: a failing read is a 500 and nothing is written', async () => {
    fault.down = true;
    const res = await change(A, ok);
    expect(res.status).toBe(500);
    expect(writes).toHaveLength(0);
  });
});
