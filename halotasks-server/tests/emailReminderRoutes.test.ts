import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { createEmailDeliveryDouble, createEmailServiceDouble } from './helpers/emailDoubles';

// Issue #29, section S5 — POST /api/internal/email-reminders/run against the REAL app. The User/Task/EmailDelivery models are
// in-memory doubles and the email service is a scripted stand-in, so this proves authentication, replay safety, concurrency
// and what the response and the logs contain. It does not prove a real provider delivers or that MongoDB's index holds.

const CRON = 'cron-secret-for-tests-0123456789abcdef-NOT-REAL';
const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';
const NOW = Date.parse('2026-10-05T09:00:00Z');
const day = (d: string) => new Date(`${d}T00:00:00Z`);

type UserRow = Record<string, unknown> & { _id: string; email: string };
const world = vi.hoisted(() => ({ users: [] as Array<Record<string, unknown>>, tasks: {} as Record<string, unknown[]>, taskWrites: 0 }));

let store = createEmailDeliveryDouble();
let mail = createEmailServiceDouble();

const userToken = (id: string) => jwt.sign({ userId: id, email: 'x@x.test', name: 'N', tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

async function loadApp(env: Record<string, string | undefined> = { EMAIL_REMINDER_CRON_SECRET: CRON }): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.EMAIL_REMINDER_CRON_SECRET;
  delete process.env.EMAIL_REMINDER_DAILY_CAP;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findById: (id: string) => ({
        select: () => ({ lean: async () => (world.users.find((u) => u._id === id) ? { tokenVersion: 0, timeZone: null, emailReminders: undefined } : null) }),
      }),
      find: () => ({
        select: () => ({
          sort: () => ({
            lean: () => ({
              cursor: async function* () {
                for (const u of world.users) if ((u.emailReminders as { enabled?: boolean } | undefined)?.enabled === true) yield u;
              },
            }),
          }),
        }),
      }),
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({
    default: {
      find: (filter: { userId: string }) => ({
        select: () => ({ sort: () => ({ limit: () => ({ lean: async () => world.tasks[filter.userId] ?? [] }) }) }),
      }),
      create: () => { world.taskWrites += 1; },
      updateOne: () => { world.taskWrites += 1; },
      findOneAndUpdate: () => { world.taskWrites += 1; },
    },
  }));
  vi.doMock('../src/models/EmailDelivery.model', () => ({ default: store.model, EMAIL_DELIVERY_RETENTION_DAYS: 30 }));
  vi.doMock('../src/models/CompletionRecord.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined } }));

  const app = ((await import('../src/app.js')) as unknown as { default: Express }).default;
  (await import('../src/services/emailService.js')).setEmailService(mail.service);
  return app;
}

const dueSoon = (id: string): Record<string, unknown> => ({ _id: id, title: `Task ${id}`, completed: false, priority: 'medium', dueDate: day('2026-10-05'), dueTime: '15:00', startTime: null, estimatedMinutes: 0 });
const account = (id: string, enabled = true): UserRow => ({ _id: id, email: `${id.slice(-2)}@example.test`, timeZone: 'Asia/Kolkata', emailReminders: { enabled } });
const call = (app: Express, secret: string | null = CRON) => {
  const req = request(app).post('/api/internal/email-reminders/run');
  return secret === null ? req : req.set('Authorization', `Bearer ${secret}`);
};

let output: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  world.users = [];
  world.tasks = {};
  world.taskWrites = 0;
  store = createEmailDeliveryDouble();
  mail = createEmailServiceDouble();
  output = [];
  for (const m of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void output.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const m of ['User', 'Task', 'EmailDelivery', 'CompletionRecord', 'DayHistory']) vi.doUnmock(`../src/models/${m}.model`);
  vi.doUnmock('web-push');
});

describe('authentication of the trigger', () => {
  it('without EMAIL_REMINDER_CRON_SECRET the route does not exist (404) and nothing runs', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    const app = await loadApp({});
    expect((await call(app, CRON)).status).toBe(404);
    expect((await call(app, null)).status).toBe(404);
    expect(mail.sent).toHaveLength(0);
  });

  it.each([
    ['no header', null],
    ['an empty bearer', ''],
    ['a wrong secret', 'definitely-not-the-secret-0123456789abcdef'],
    ['the secret with a character changed', `${CRON.slice(0, -1)}X`],
    ['a prefix of the secret', CRON.slice(0, 20)],
  ])('401 for %s, and nothing is sent', async (_name, secret) => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    const app = await loadApp();
    const res = await call(app, secret);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(mail.sent).toHaveLength(0);
    expect(store.docs).toHaveLength(0);
  });

  it('a normal USER token is not accepted, and Basic/other schemes are not either', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    const app = await loadApp();
    expect((await call(app, userToken(A))).status).toBe(401);
    expect((await request(app).post('/api/internal/email-reminders/run').set('Authorization', `Basic ${CRON}`)).status).toBe(401);
    expect((await request(app).post('/api/internal/email-reminders/run').set('Authorization', CRON)).status).toBe(401);
    expect(mail.sent).toHaveLength(0);
  });

  it('only POST: GET is not a trigger', async () => {
    const app = await loadApp();
    expect((await request(app).get('/api/internal/email-reminders/run').set('Authorization', `Bearer ${CRON}`)).status).toBe(404);
  });

  it('repeated wrong guesses from one source are rate limited (429)', async () => {
    const app = await loadApp();
    let last = 0;
    for (let i = 0; i < 40; i += 1) last = (await call(app, `wrong-guess-${i}-0123456789abcdef0123456789`)).status;
    expect(last).toBe(429);
  });
});

describe('a run through the route', () => {
  it('delivers once, answers counts only, and never returns the secret, an address or a title', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    const app = await loadApp();
    const res = await call(app);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ status: 'ok', users: 1, events: 1, sent: 1, failed: 0, unknown: 0, duplicates: 0, quiet: 0, capped: 0, errors: 0, truncated: false });
    const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
    for (const leak of [CRON, 'example.test', 'Task t1']) expect(text).not.toContain(leak);
    expect(mail.sent).toHaveLength(1);
  });

  it('REPLAY: the same trigger called again (retry, double fire, restart) sends nothing more', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    const app = await loadApp();
    await call(app);
    const again = await call(app);
    expect(again.body).toMatchObject({ sent: 0, duplicates: 1 });
    expect(mail.sent).toHaveLength(1);

    const app2 = await loadApp(); // "restart": a new app over the same persisted ledger
    const afterRestart = await call(app2);
    expect(afterRestart.body).toMatchObject({ sent: 0, duplicates: 1 });
    expect(mail.sent).toHaveLength(1);
  });

  it('the caller cannot choose the time, a user or a recipient: query and body are ignored', async () => {
    world.users = [account(A), account(B)];
    world.tasks[A] = [dueSoon('t1')];
    world.tasks[B] = [];
    const app = await loadApp();
    const res = await request(app)
      .post('/api/internal/email-reminders/run?now=2030-01-01T00:00:00Z&userId=' + B)
      .set('Authorization', `Bearer ${CRON}`)
      .send({ now: '2030-01-01T00:00:00Z', to: 'attacker@evil.test', userId: B, email: 'attacker@evil.test' });
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].message.to).toBe('a1@example.test');
  });

  it('503 when no email provider is configured, with nothing claimed (so nothing is lost)', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    mail = createEmailServiceDouble(false);
    const app = await loadApp();
    const res = await call(app);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unconfigured');
    expect(store.docs).toHaveLength(0);
  });

  it('a second call while a run is in flight gets 409 and does no work', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalSend = mail.service.send;
    mail.service.send = async (m, p) => { await gate; return originalSend(m, p); };
    const app = await loadApp();

    const first = call(app).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    const second = await call(app);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(mail.sent).toHaveLength(1);
  });

  it('after a run ends (even a failing one) the next call is accepted', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    mail.script.push('throw');
    const app = await loadApp();
    expect((await call(app)).status).toBe(200);
    expect((await call(app)).status).toBe(200);
  });

  it('a malformed EMAIL_REMINDER_DAILY_CAP is refused by the config check, and a too-short secret too', async () => {
    const { getEmailReminderCronSecret, getEmailReminderDailyCap } = await import('../src/config/env.js');
    expect(() => getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: 'short' })).toThrow('at least 32');
    expect(() => getEmailReminderDailyCap({ EMAIL_REMINDER_DAILY_CAP: '0' })).toThrow();
  });
});

describe('failure isolation from ordinary requests', () => {
  it('provider failures leave tasks untouched: the run performed no task write', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    mail.script.push('throw');
    const app = await loadApp();
    await call(app);
    expect(world.taskWrites).toBe(0);
  });

  it('while a run is stuck on a slow provider, authenticated user requests are still served', async () => {
    world.users = [account(A)];
    world.tasks[A] = [dueSoon('t1')];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalSend = mail.service.send;
    mail.service.send = async (m, p) => { await gate; return originalSend(m, p); };
    const app = await loadApp();

    const stuck = call(app);
    await new Promise((r) => setTimeout(r, 20));
    const other = await request(app).get('/api/user/email-reminders').set({ Authorization: `Bearer ${userToken(A)}` });
    expect(other.status).toBe(200);
    release();
    await stuck;
  });
});

describe('logs', () => {
  it('a run with a failing provider logs counts only: no address, no task title, no secret, no provider text', async () => {
    world.users = [account(A)];
    world.tasks[A] = [{ ...dueSoon('t1'), title: 'Secret Plan' }];
    mail.script.push({ status: 'failed', codes: ['smtp:EAUTH'] });
    const app = await loadApp();
    await call(app);
    const logged = output.join('\n');
    expect(logged).toContain('[EmailReminders] run done');
    for (const leak of ['Secret Plan', 'example.test', CRON, A]) expect(logged).not.toContain(leak);
  });

  it('a wrong secret is not logged', async () => {
    const app = await loadApp();
    await call(app, 'a-wrong-secret-that-must-not-appear-in-logs-xyz');
    expect(output.join('\n')).not.toContain('a-wrong-secret-that-must-not-appear');
  });
});

describe('opted-out and cross-user data', () => {
  it('a user who never opted in is not even read, and user A\'s tasks never mail user B', async () => {
    world.users = [account(A, true), account(B, false)];
    world.tasks[A] = [dueSoon('mine')];
    world.tasks[B] = [dueSoon('theirs')];
    const app = await loadApp();
    await call(app);
    expect(mail.sent.map((m) => m.message.to)).toEqual(['a1@example.test']);
  });
});
