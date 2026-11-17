import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';

// Issue #29, section S2 — GET/PUT /api/user/email-reminders against the REAL app with an in-memory User double. The
// double records every update and THROWS on anything but $set / $unset of `emailReminders.*` paths, so a regression that
// writes another field (an address, the password hash, the id from the body) fails here. What it cannot prove is
// MongoDB's own operator semantics: tests/emailReminderPrefs.realmongo.test.ts covers that (needs a database).

type Row = Record<string, unknown> & { _id: string; email: string; tokenVersion: number };

const db = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; update: Record<string, unknown> }>,
  failNextUpdate: false,
}));
const users = db.users as unknown as Map<string, Row>;

const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';
const GONE = '665f1c2e9b1e8a00000000c3';

const seed = (id: string, extra: Record<string, unknown> = {}) => {
  users.set(id, { _id: id, name: 'U', email: `${id.slice(-2)}@x.test`, passwordHash: 'h', tokenVersion: 0, ...extra } as Row);
};
const tokenFor = (id: string) => jwt.sign({ userId: id, email: `${id.slice(-2)}@x.test`, name: 'N', tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (id: string) => ({ Authorization: `Bearer ${tokenFor(id)}` });

const setPath = (row: Record<string, unknown>, path: string, value: unknown) => {
  const [head, leaf] = path.split('.');
  const bag = (row[head] ?? {}) as Record<string, unknown>;
  bag[leaf] = value;
  row[head] = bag;
};

async function loadApp(opts: { smtp?: boolean } = {}): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;
  if (opts.smtp) Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'SMTP-PASS-SECRET' });

  const project = (row: Row | undefined, fields: string[]) => {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const field of fields) if (field in row) out[field] = row[field];
    return out;
  };

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: (id: string) => ({
        select: (fields: string) => ({ lean: async () => project(users.get(String(id)), fields.split(' ')) }),
      }),
      findByIdAndUpdate: (id: string, update: Record<string, unknown>, options: Record<string, unknown>) => ({
        select: (fields: string) => ({
          lean: async () => {
            if (db.failNextUpdate) {
              db.failNextUpdate = false;
              throw new Error('simulated write failure');
            }
            const set = (update.$set ?? {}) as Record<string, unknown>;
            const unset = (update.$unset ?? {}) as Record<string, unknown>;
            const operators = Object.keys(update).filter((k) => k !== '$set' && k !== '$unset');
            const paths = [...Object.keys(set), ...Object.keys(unset)];
            if (operators.length > 0 || paths.length === 0 || paths.some((p) => !p.startsWith('emailReminders.'))) {
              throw new Error(`unexpected update shape ${JSON.stringify(update)}`);
            }
            if (options.new !== true || options.runValidators !== true) throw new Error('expected new + runValidators');
            db.updates.push({ id: String(id), update });
            const row = users.get(String(id));
            if (!row) return null;
            for (const [p, v] of Object.entries(set)) setPath(row, p, v);
            for (const p of Object.keys(unset)) {
              const bag = (row.emailReminders ?? {}) as Record<string, unknown>;
              delete bag[p.split('.')[1]];
            }
            return project(row, fields.split(' '));
          },
        }),
      }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: {} }));
  vi.doMock('../src/models/CompletionRecord.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));

  return ((await import('../src/app.js')) as unknown as { default: Express }).default;
}

const DEFAULTS = {
  enabled: false,
  dueSoonEnabled: true,
  overdueEnabled: true,
  workSessionSoonEnabled: true,
  startNowEnabled: true,
  bufferMinutes: 60,
  quietHoursStart: '22:30',
  quietHoursEnd: '07:00',
  digestEnabled: false,
  digestTime: '07:30',
  timeZone: null,
};

beforeEach(() => {
  users.clear();
  db.updates.length = 0;
  db.failNextUpdate = false;
  for (const m of ['info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const m of ['User', 'Task', 'CompletionRecord', 'DayHistory']) vi.doUnmock(`../src/models/${m}.model`);
  vi.doUnmock('web-push');
});

describe('GET /api/user/email-reminders', () => {
  it('a legacy account reads as email OFF with every default, and nothing is written', async () => {
    seed(A);
    const app = await loadApp();
    const res = await request(app).get('/api/user/email-reminders').set(as(A));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULTS, accountTimeZone: null, effectiveTimeZone: 'UTC', available: false });
    expect(db.updates).toEqual([]);
  });

  it('reports the effective zone: the account zone until an override is saved', async () => {
    seed(A, { timeZone: 'Asia/Kolkata' });
    const app = await loadApp();
    const followed = await request(app).get('/api/user/email-reminders').set(as(A));
    expect(followed.body).toMatchObject({ timeZone: null, accountTimeZone: 'Asia/Kolkata', effectiveTimeZone: 'Asia/Kolkata' });

    await request(app).put('/api/user/email-reminders').set(as(A)).send({ timeZone: 'Europe/Berlin' });
    users.get(A)!.timeZone = 'America/Los_Angeles'; // the account zone changes later
    const fixed = await request(app).get('/api/user/email-reminders').set(as(A));
    expect(fixed.body).toMatchObject({ timeZone: 'Europe/Berlin', accountTimeZone: 'America/Los_Angeles', effectiveTimeZone: 'Europe/Berlin' });
  });

  it('`available` is a plain boolean and no provider detail or credential is ever in the response', async () => {
    seed(A);
    const app = await loadApp({ smtp: true });
    const res = await request(app).get('/api/user/email-reminders').set(as(A));
    expect(res.body.available).toBe(true);
    const text = JSON.stringify(res.body);
    for (const leak of ['SMTP-PASS-SECRET', 'smtp.example.test', 'BREVO', 'passwordHash']) expect(text).not.toContain(leak);
  });

  it('401 without a token, with a bad token', async () => {
    const app = await loadApp();
    expect((await request(app).get('/api/user/email-reminders')).status).toBe(401);
    expect((await request(app).put('/api/user/email-reminders').send({ enabled: true })).status).toBe(401);
    expect((await request(app).get('/api/user/email-reminders').set({ Authorization: 'Bearer junk' })).status).toBe(401);
    expect(db.updates).toEqual([]);
  });
});

describe('PUT /api/user/email-reminders', () => {
  it('enables email and writes only the emailReminders.* paths that were sent', async () => {
    seed(A);
    const app = await loadApp();
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).send({ enabled: true, digestEnabled: true, digestTime: '06:45' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, digestEnabled: true, digestTime: '06:45', dueSoonEnabled: true });
    expect(db.updates).toEqual([
      { id: A, update: { $set: { 'emailReminders.enabled': true, 'emailReminders.digestEnabled': true, 'emailReminders.digestTime': '06:45' } } },
    ]);
  });

  it('disables email again; the rest of the settings survive', async () => {
    seed(A);
    const app = await loadApp();
    await request(app).put('/api/user/email-reminders').set(as(A)).send({ enabled: true, bufferMinutes: 30 });
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).send({ enabled: false });
    expect(res.body).toMatchObject({ enabled: false, bufferMinutes: 30 });
  });

  it('timeZone: null removes the override ($unset)', async () => {
    seed(A, { timeZone: 'Asia/Kolkata', emailReminders: { timeZone: 'Europe/Berlin' } });
    const app = await loadApp();
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).send({ timeZone: null });
    expect(res.body).toMatchObject({ timeZone: null, effectiveTimeZone: 'Asia/Kolkata' });
    expect(db.updates[0].update).toEqual({ $unset: { 'emailReminders.timeZone': '' } });
  });

  it.each([
    ['empty object', {}],
    ['unknown field', { enabled: true, email: 'victim@x.test' }],
    ['recipient field', { to: 'victim@x.test' }],
    ['bad toggle', { enabled: 'yes' }],
    ['bad time', { quietHoursStart: '9pm' }],
    ['bad buffer', { bufferMinutes: 10 }],
    ['bad zone', { timeZone: 'Not/AZone' }],
  ])('400 for %s, and nothing is written', async (_name, body) => {
    seed(A);
    const app = await loadApp();
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).send(body);
    expect(res.status).toBe(400);
    expect(db.updates).toEqual([]);
  });

  it('400 for a non-object body', async () => {
    seed(A);
    const app = await loadApp();
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).set('Content-Type', 'application/json').send('[1]');
    expect(res.status).toBe(400);
    expect(db.updates).toEqual([]);
  });

  it('a database failure is a 5xx and changes nothing', async () => {
    seed(A);
    const app = await loadApp();
    db.failNextUpdate = true;
    const res = await request(app).put('/api/user/email-reminders').set(as(A)).send({ enabled: true });
    expect(res.status).toBe(500);
    expect(users.get(A)!.emailReminders).toBeUndefined();
  });

  it('404 for a deleted account that still holds a valid token', async () => {
    seed(GONE);
    const app = await loadApp();
    const token = as(GONE);
    users.delete(GONE);
    // requireAuth reads the account first, so a missing account is refused before the controller.
    const res = await request(app).put('/api/user/email-reminders').set(token).send({ enabled: true });
    expect([401, 404]).toContain(res.status);
  });
});

describe('user isolation', () => {
  it("one user's change never touches another, and the id comes from the token, not the body", async () => {
    seed(A);
    seed(B);
    const app = await loadApp();
    await request(app).put('/api/user/email-reminders').set(as(A)).send({ enabled: true, quietHoursStart: '21:00' });
    expect(users.get(B)!.emailReminders).toBeUndefined();
    const forB = await request(app).get('/api/user/email-reminders').set(as(B));
    expect(forB.body).toMatchObject({ enabled: false, quietHoursStart: '22:30' });

    const forged = await request(app).put('/api/user/email-reminders').set(as(B)).send({ enabled: true, userId: A, _id: A });
    expect(forged.status).toBe(400);
    expect(db.updates.every((u) => u.id === A)).toBe(true);
  });
});
