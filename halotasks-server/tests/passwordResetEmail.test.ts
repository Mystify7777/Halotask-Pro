import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import type { EmailMessage, EmailService, FallbackPolicy, SendResult } from '../src/services/emailService';

// Issue #29, section S1 — password reset on top of the shared email service. Regression coverage: the same neutral
// answer, the same code handling, the same demo mode, and a reset code that never reaches a log when delivery fails.
// The real app with an in-memory User double; the email service is replaced by a recording stand-in.

type Doc = {
  email: string;
  tokenVersion: number;
  resetPasswordTokenHash?: string;
  resetPasswordExpiresAt?: Date;
  save: () => Promise<void>;
};

const db = vi.hoisted(() => ({ users: new Map<string, Record<string, unknown>>() }));
const users = db.users as unknown as Map<string, Doc>;
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const sent: Array<{ message: EmailMessage; policy: FallbackPolicy }> = [];
let outcome: SendResult = { status: 'sent', provider: 'smtp' };

async function loadApp(): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;

  const live = (q: { email: string; resetPasswordTokenHash?: string }) => {
    const u = users.get(q.email);
    return u && u.resetPasswordTokenHash === q.resetPasswordTokenHash && u.resetPasswordExpiresAt && u.resetPasswordExpiresAt > new Date() ? u : null;
  };

  vi.doMock('../src/models/User.model', () => ({
    default: {
      findOne: async (q: { email: string }) => users.get(q.email) ?? null,
      exists: async (q: { email: string; resetPasswordTokenHash?: string }) => (live(q) ? { _id: 'x' } : null),
      updateOne: async (q: { email: string; resetPasswordTokenHash?: string }, update: { $unset: Record<string, unknown>; $inc: { tokenVersion: number } }) => {
        const u = live(q);
        if (!u) return { matchedCount: 0 };
        for (const key of Object.keys(update.$unset)) delete (u as unknown as Record<string, unknown>)[key];
        u.tokenVersion += update.$inc.tokenVersion;
        return { matchedCount: 1 };
      },
    },
  }));
  vi.doMock('../src/models/Task.model', () => ({ default: {} }));
  vi.doMock('../src/models/CompletionRecord.model', () => ({ default: {} }));
  vi.doMock('../src/models/DayHistory.model', () => ({ default: {} }));

  const app = ((await import('../src/app.js')) as unknown as { default: Express }).default;
  const emailModule = await import('../src/services/emailService.js');
  const stub: EmailService = {
    isConfigured: () => true,
    send: async (message, policy) => {
      sent.push({ message, policy });
      return outcome;
    },
  };
  emailModule.setEmailService(stub);
  return app;
}

const seed = (email: string) => {
  const doc: Doc = { email, tokenVersion: 0, save: async () => undefined };
  users.set(email, doc);
  return doc;
};

const forgot = (app: Express, email: string) => request(app).post('/api/auth/forgot-password').send({ email });
const NEUTRAL = 'If an account exists for this email, a reset link has been sent.';
const codeOf = (message: EmailMessage) => /Code: (\d{6})/.exec(message.text)?.[1] ?? '';

let consoleLines: string[];
beforeEach(() => {
  users.clear();
  sent.length = 0;
  outcome = { status: 'sent', provider: 'smtp' };
  consoleLines = [];
  for (const method of ['info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe('password reset through the shared email service', () => {
  it('sends one message to the normalised address with the fallback policy reset has always had', async () => {
    const app = await loadApp();
    const doc = seed('a@x.test');
    const res = await forgot(app, '  A@X.test ');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: NEUTRAL });
    expect(sent).toHaveLength(1);
    expect(sent[0].policy).toBe('any-failure');
    expect(sent[0].message.to).toBe('a@x.test');
    expect(sent[0].message.subject).toBe('Reset your HaloTaskPro password');
    expect(sent[0].message.html).toContain(codeOf(sent[0].message));
    // Only the hash of the emailed code is stored.
    expect(doc.resetPasswordTokenHash).toBe(sha256(codeOf(sent[0].message)));
    expect(JSON.stringify(doc)).not.toContain(codeOf(sent[0].message));
    expect(doc.resetPasswordExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('the emailed code completes the reset, once', async () => {
    const app = await loadApp();
    const doc = seed('a@x.test');
    await forgot(app, 'a@x.test');
    const code = codeOf(sent[0].message);

    const reset = (token: string) => request(app).post('/api/auth/reset-password').send({ email: 'a@x.test', token, password: 'a-new-password' });
    expect((await reset(code)).status).toBe(200);
    expect(doc.tokenVersion).toBe(1);
    expect((await reset(code)).status).toBe(400);
  });

  it('an unknown address sends nothing and answers exactly the same (no account enumeration)', async () => {
    const app = await loadApp();
    seed('a@x.test');
    const known = await forgot(app, 'a@x.test');
    const unknown = await forgot(app, 'nobody@x.test');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['failed', { status: 'failed', codes: ['smtp:EAUTH', 'brevo:HTTP_401'] }],
    ['unknown', { status: 'unknown', codes: ['smtp:ETIMEDOUT'] }],
  ] as Array<[string, SendResult]>)('delivery %s: same neutral answer and the reset code is NOT logged', async (_name, result) => {
    outcome = result;
    const app = await loadApp();
    seed('a@x.test');
    const res = await forgot(app, 'a@x.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: NEUTRAL });
    const code = codeOf(sent[0].message);
    expect(code).toMatch(/^\d{6}$/);
    expect(consoleLines.join('\n')).not.toContain(code);
    expect(consoleLines.join('\n')).toContain('All email transports failed');
    expect(consoleLines.join('\n')).not.toContain('a@x.test');
  });

  it('no transport configured: the established demo mode logs the code with a masked address', async () => {
    outcome = { status: 'unconfigured' };
    const app = await loadApp();
    seed('alice@x.test');
    await forgot(app, 'alice@x.test');
    const code = codeOf(sent[0].message);
    const demo = consoleLines.find((line) => line.includes('DEMO MODE'));
    expect(demo).toContain(code);
    expect(demo).toContain('al***@x.test');
    expect(demo).not.toContain('alice@x.test');
  });

  it('a successful delivery logs nothing about the code', async () => {
    const app = await loadApp();
    seed('a@x.test');
    await forgot(app, 'a@x.test');
    expect(consoleLines.join('\n')).not.toContain(codeOf(sent[0].message));
  });
});
