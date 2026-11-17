import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREVO_ENDPOINT,
  classifyBrevoFailure,
  classifySmtpError,
  createBrevoProvider,
  createEnvEmailService,
  parseSender,
  createSmtpProvider,
  deliver,
  maskEmail,
  type EmailProvider,
  type EmailMessage,
  type ProviderResult,
} from '../src/services/emailService';

// Issue #29, section S1 — the shared delivery service. Everything here is Mongo-free and uses stand-in providers: it
// proves the FALLBACK RULES and the classification of provider errors, not that a real SMTP server or Brevo accepts mail.
// That needs staging (see docs/context.md "Email delivery").

const MESSAGE: EmailMessage = { to: 'alice@example.test', subject: 'Subject', text: 'Body text SECRET-BODY' };

const provider = (name: 'smtp' | 'brevo', outcome: ProviderResult | 'throw'): EmailProvider & { send: ReturnType<typeof vi.fn> } => ({
  name,
  send: vi.fn(async () => {
    if (outcome === 'throw') throw new Error('provider blew up with SECRET-PROVIDER-TEXT');
    return outcome;
  }),
});

const OK: ProviderResult = { accepted: true };
const DEFINITE: ProviderResult = { accepted: false, definite: true, code: 'EAUTH' };
const AMBIGUOUS: ProviderResult = { accepted: false, definite: false, code: 'ETIMEDOUT' };

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const logged = (log: ReturnType<typeof logger>) => [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n');

describe('deliver: provider order and fallback', () => {
  it('uses SMTP first and does not touch Brevo when SMTP accepts', async () => {
    const smtp = provider('smtp', OK);
    const brevo = provider('brevo', OK);
    const result = await deliver([smtp, brevo], MESSAGE, 'from@x.test', 'definite-only', logger());
    expect(result).toEqual({ status: 'sent', provider: 'smtp' });
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(brevo.send).not.toHaveBeenCalled();
  });

  it('falls back to Brevo after a DEFINITE SMTP failure under both policies', async () => {
    for (const policy of ['definite-only', 'any-failure'] as const) {
      const smtp = provider('smtp', DEFINITE);
      const brevo = provider('brevo', OK);
      const result = await deliver([smtp, brevo], MESSAGE, 'f@x.test', policy, logger());
      expect(result, policy).toEqual({ status: 'sent', provider: 'brevo' });
      expect(brevo.send).toHaveBeenCalledTimes(1);
    }
  });

  it('AMBIGUOUS SMTP failure: definite-only stops (unknown, Brevo never called); any-failure still falls back', async () => {
    const strictBrevo = provider('brevo', OK);
    const strict = await deliver([provider('smtp', AMBIGUOUS), strictBrevo], MESSAGE, 'f@x.test', 'definite-only', logger());
    expect(strict).toEqual({ status: 'unknown', codes: ['smtp:ETIMEDOUT'] });
    expect(strictBrevo.send).not.toHaveBeenCalled();

    const looseBrevo = provider('brevo', OK);
    const loose = await deliver([provider('smtp', AMBIGUOUS), looseBrevo], MESSAGE, 'f@x.test', 'any-failure', logger());
    expect(loose).toEqual({ status: 'sent', provider: 'brevo' });
    expect(looseBrevo.send).toHaveBeenCalledTimes(1);
  });

  it('a provider that THROWS is an ambiguous failure, never an exception', async () => {
    const brevo = provider('brevo', OK);
    const strict = await deliver([provider('smtp', 'throw'), brevo], MESSAGE, 'f@x.test', 'definite-only', logger());
    expect(strict).toEqual({ status: 'unknown', codes: ['smtp:PROVIDER_THREW'] });
    expect(brevo.send).not.toHaveBeenCalled();
    await expect(deliver([provider('smtp', 'throw')], MESSAGE, 'f@x.test', 'any-failure', logger())).resolves.toEqual({
      status: 'unknown',
      codes: ['smtp:PROVIDER_THREW'],
    });
  });

  it('both providers down: failed when both were definite, unknown when either was ambiguous', async () => {
    const bothDefinite = await deliver([provider('smtp', DEFINITE), provider('brevo', { accepted: false, definite: true, code: 'HTTP_422' })], MESSAGE, 'f', 'definite-only', logger());
    expect(bothDefinite).toEqual({ status: 'failed', codes: ['smtp:EAUTH', 'brevo:HTTP_422'] });

    const brevoAmbiguous = await deliver([provider('smtp', DEFINITE), provider('brevo', AMBIGUOUS)], MESSAGE, 'f', 'definite-only', logger());
    expect(brevoAmbiguous.status).toBe('unknown');

    const anyFailureAmbiguousFirst = await deliver([provider('smtp', AMBIGUOUS), provider('brevo', DEFINITE)], MESSAGE, 'f', 'any-failure', logger());
    expect(anyFailureAmbiguousFirst.status).toBe('unknown'); // SMTP may have delivered: it is not reported as plainly failed
  });

  it('a Brevo-only or SMTP-only deployment works; nothing configured is "unconfigured"', async () => {
    expect(await deliver([provider('brevo', OK)], MESSAGE, 'f', 'definite-only', logger())).toEqual({ status: 'sent', provider: 'brevo' });
    expect(await deliver([provider('smtp', DEFINITE)], MESSAGE, 'f', 'definite-only', logger())).toEqual({ status: 'failed', codes: ['smtp:EAUTH'] });
    expect(await deliver([], MESSAGE, 'f', 'definite-only', logger())).toEqual({ status: 'unconfigured' });
  });

  it('passes the sender and the message unchanged to the provider', async () => {
    const smtp = provider('smtp', OK);
    await deliver([smtp], MESSAGE, 'HaloTask <no-reply@x.test>', 'definite-only', logger());
    expect(smtp.send).toHaveBeenCalledWith(MESSAGE, 'HaloTask <no-reply@x.test>');
  });
});

describe('deliver: what reaches the logs', () => {
  it('logs only the masked recipient and a short code: never the body, the subject or provider error text', async () => {
    const log = logger();
    await deliver([provider('smtp', 'throw'), provider('brevo', DEFINITE)], MESSAGE, 'f', 'any-failure', log);
    await deliver([provider('smtp', OK)], MESSAGE, 'f', 'any-failure', log);
    const text = logged(log);
    expect(text).toContain('al***@example.test');
    expect(text).not.toContain('alice@example.test');
    expect(text).not.toContain('SECRET-BODY');
    expect(text).not.toContain('SECRET-PROVIDER-TEXT');
    expect(text).not.toContain('Subject');
  });
});

describe('classifySmtpError', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['connection refused', { code: 'ECONNREFUSED', command: 'CONN' }, true],
    ['never connected (timeout during CONN)', { code: 'ETIMEDOUT', command: 'CONN' }, true],
    ['bad login', { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, true],
    ['recipient rejected', { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }, true],
    ['4xx reply to the finished message', { code: 'EMESSAGE', command: 'DATA', responseCode: 452 }, true],
    ['5xx reply to the finished message', { code: 'EMESSAGE', command: 'DATA', responseCode: 554 }, true],
    ['DNS failure', { code: 'EDNS' }, true],
    ['socket dropped while sending the body', { code: 'ESOCKET', command: 'DATA' }, false],
    ['timeout while sending the body', { code: 'ETIMEDOUT', command: 'DATA' }, false],
    ['connection reset, step unknown', { code: 'ECONNECTION' }, false],
    ['an Error with no details', new Error('boom'), false],
    ['a thrown string', 'boom', false],
    ['null', null, false],
    ['a non-numeric response code', { command: 'DATA', responseCode: '250' }, false],
  ];
  it.each(cases)('%s', (_name, error, definite) => {
    expect(classifySmtpError(error).definite).toBe(definite);
  });

  it('keeps only a short safe code', () => {
    expect(classifySmtpError({ code: 'EAUTH' }).code).toBe('EAUTH');
    expect(classifySmtpError({ code: 'has spaces and a password hunter2' }).code).toBe('SMTP_ERROR');
    expect(classifySmtpError({ code: 42 }).code).toBe('SMTP_ERROR');
  });
});

describe('classifyBrevoFailure', () => {
  it('only an HTTP 4xx is definite; 5xx is ambiguous', () => {
    expect(classifyBrevoFailure({ status: 400 })).toEqual({ definite: true, code: 'HTTP_400' });
    expect(classifyBrevoFailure({ status: 401 }).definite).toBe(true);
    expect(classifyBrevoFailure({ status: 429 }).definite).toBe(true);
    expect(classifyBrevoFailure({ status: 500 })).toEqual({ definite: false, code: 'HTTP_500' });
    expect(classifyBrevoFailure({ status: 503 }).definite).toBe(false);
  });
  it('could not reach the host = definite; a timeout or an unknown network error = ambiguous', () => {
    expect(classifyBrevoFailure({ error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })).toEqual({ definite: true, code: 'ECONNREFUSED' });
    expect(classifyBrevoFailure({ error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }).definite).toBe(true);
    expect(classifyBrevoFailure({ error: Object.assign(new Error('t'), { name: 'TimeoutError' }) })).toEqual({ definite: false, code: 'BREVO_TIMEOUT' });
    expect(classifyBrevoFailure({ error: Object.assign(new Error('a'), { name: 'AbortError' }) }).code).toBe('BREVO_TIMEOUT');
    expect(classifyBrevoFailure({ error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }).definite).toBe(false);
    expect(classifyBrevoFailure({ error: 'x' })).toEqual({ definite: false, code: 'BREVO_ERROR' });
  });
});

describe('parseSender', () => {
  it('reads "Name <a@b>" and a bare address, and refuses anything else', () => {
    expect(parseSender('HaloTask <no-reply@x.test>')).toEqual({ email: 'no-reply@x.test', name: 'HaloTask' });
    expect(parseSender('"HaloTask Pro" <no-reply@x.test>')).toEqual({ email: 'no-reply@x.test', name: 'HaloTask Pro' });
    expect(parseSender('<no-reply@x.test>')).toEqual({ email: 'no-reply@x.test' });
    expect(parseSender('noreply@halotaskpro.com')).toEqual({ email: 'noreply@halotaskpro.com' });
    for (const bad of ['', 'not an address', 'a@', 'Name <>']) expect(parseSender(bad)).toBeNull();
  });
});

describe('createBrevoProvider (the HTTP request is a stand-in; this proves the request shape and the classification)', () => {
  const reply = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }));

  it('POSTs the documented request: api-key header, sender, recipient, subject and both bodies', async () => {
    const fetchImpl = reply(201, { messageId: '<abc@smtp-relay.brevo.com>' });
    const provider = createBrevoProvider('BREVO-KEY-SECRET', fetchImpl);
    expect(await provider.send({ ...MESSAGE, html: '<b>hi</b>' }, 'HaloTask <no-reply@x.test>')).toEqual({ accepted: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }];
    expect(url).toBe(BREVO_ENDPOINT);
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('BREVO-KEY-SECRET');
    expect(JSON.parse(init.body)).toEqual({
      sender: { email: 'no-reply@x.test', name: 'HaloTask' },
      to: [{ email: 'alice@example.test' }],
      subject: 'Subject',
      textContent: MESSAGE.text,
      htmlContent: '<b>hi</b>',
    });
    expect(init.body).not.toContain('BREVO-KEY-SECRET'); // the key is a header, never in the body
    expect(init.signal).toBeInstanceOf(AbortSignal); // there is a timeout
  });

  it('a text-only message is sent with its text, escaped, as the required HTML body', async () => {
    const fetchImpl = reply(201, { messageId: 'm' });
    await createBrevoProvider('k', fetchImpl).send({ to: 'a@x.test', subject: 's', text: 'a <b> & c\nline 2' }, 'f@x.test');
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.htmlContent).toBe('<p>a &lt;b&gt; &amp; c<br>line 2</p>');
  });

  it('201 with a message id is acceptance; 201 without one is ambiguous (never retried)', async () => {
    expect(await createBrevoProvider('k', reply(201, {})).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: false, code: 'BREVO_NO_ID' });
    expect(await createBrevoProvider('k', reply(201, { messageId: '' })).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: false, code: 'BREVO_NO_ID' });
    const unreadable = vi.fn(async () => ({ status: 201, json: async () => { throw new Error('bad json'); } }));
    expect((await createBrevoProvider('k', unreadable).send(MESSAGE, 'f@x.test')).accepted).toBe(false);
  });

  it('HTTP 4xx = definite, 5xx = ambiguous, and neither leaks the response body', async () => {
    expect(await createBrevoProvider('k', reply(401, { message: 'Key not found: k' })).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: true, code: 'HTTP_401' });
    expect(await createBrevoProvider('k', reply(502)).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: false, code: 'HTTP_502' });
  });

  it('a network failure or timeout never throws out of the provider', async () => {
    const refused = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    expect(await createBrevoProvider('k', refused).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: true, code: 'ECONNREFUSED' });
    const timeout = vi.fn(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    expect(await createBrevoProvider('k', timeout).send(MESSAGE, 'f@x.test')).toEqual({ accepted: false, definite: false, code: 'BREVO_TIMEOUT' });
  });

  it('an unusable EMAIL_FROM sends nothing and is reported as a definite misconfiguration', async () => {
    const fetchImpl = reply(201, { messageId: 'm' });
    expect(await createBrevoProvider('k', fetchImpl).send(MESSAGE, 'garbage')).toEqual({ accepted: false, definite: true, code: 'BREVO_BAD_SENDER' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('maskEmail', () => {
  it('masks the local part', () => {
    expect(maskEmail('alice@example.test')).toBe('al***@example.test');
    expect(maskEmail('al@example.test')).toBe('**@example.test');
    expect(maskEmail('nonsense')).toBe('[invalid-email]');
  });
});

// ── The environment-backed service, with the real nodemailer and the network replaced ─────────────────────────────

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: unknown) => {
      mocks.createTransport(options);
      return { sendMail: mocks.sendMail };
    },
  },
}));

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'BREVO_API_KEY', 'EMAIL_FROM'];
const brevoOk = () => ({ status: 201, json: async () => ({ messageId: 'm1' }) });

describe('createEnvEmailService', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    mocks.sendMail.mockReset();
    mocks.createTransport.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.unstubAllGlobals();
  });

  const configureSmtp = () => Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'smtp-user', SMTP_PASS: 'smtp-pass-SECRET' });
  const brevoCall = () => JSON.parse((mocks.fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);

  it('is unconfigured with no variables, and a partial SMTP configuration (three of four) is not used', async () => {
    const service = createEnvEmailService(logger());
    expect(service.isConfigured()).toBe(false);
    expect(await service.send(MESSAGE, 'definite-only')).toEqual({ status: 'unconfigured' });

    Object.assign(process.env, { SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_USER: 'u' });
    expect(service.isConfigured()).toBe(false);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('SMTP is primary: it sends with the configured sender, secure only on port 465, and Brevo is untouched', async () => {
    configureSmtp();
    Object.assign(process.env, { BREVO_API_KEY: 'brevo_key', EMAIL_FROM: 'HaloTask <no-reply@x.test>' });
    mocks.sendMail.mockResolvedValue({ messageId: '<1@x>' });
    const service = createEnvEmailService(logger());

    expect(await service.send(MESSAGE, 'definite-only')).toEqual({ status: 'sent', provider: 'smtp' });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'HaloTask <no-reply@x.test>', to: MESSAGE.to, subject: 'Subject' }));
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', port: 587, secure: false }));
    expect(mocks.fetch).not.toHaveBeenCalled();

    process.env.SMTP_PORT = '465';
    await service.send(MESSAGE, 'definite-only');
    expect(mocks.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });

  it('falls back to Brevo with the default sender after a definite SMTP failure', async () => {
    configureSmtp();
    process.env.BREVO_API_KEY = 'brevo_key';
    mocks.sendMail.mockRejectedValue(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    mocks.fetch.mockResolvedValue(brevoOk());
    const result = await createEnvEmailService(logger()).send(MESSAGE, 'definite-only');
    expect(result).toEqual({ status: 'sent', provider: 'brevo' });
    expect(brevoCall().sender).toEqual({ email: 'noreply@halotaskpro.com' });
  });

  it('a Brevo-only deployment sends through Brevo', async () => {
    process.env.BREVO_API_KEY = 'brevo_key';
    mocks.fetch.mockResolvedValue(brevoOk());
    expect(await createEnvEmailService(logger()).send(MESSAGE, 'definite-only')).toEqual({ status: 'sent', provider: 'brevo' });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('an ambiguous SMTP failure never reaches Brevo under definite-only', async () => {
    configureSmtp();
    process.env.BREVO_API_KEY = 'brevo_key';
    mocks.sendMail.mockRejectedValue(Object.assign(new Error('socket closed'), { code: 'ESOCKET', command: 'DATA' }));
    const result = await createEnvEmailService(logger()).send(MESSAGE, 'definite-only');
    expect(result.status).toBe('unknown');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('...but password reset\'s any-failure policy still falls back (compatibility with the established behaviour)', async () => {
    configureSmtp();
    process.env.BREVO_API_KEY = 'brevo_key';
    mocks.sendMail.mockRejectedValue(Object.assign(new Error('socket closed'), { code: 'ESOCKET', command: 'DATA' }));
    mocks.fetch.mockResolvedValue(brevoOk());
    expect(await createEnvEmailService(logger()).send(MESSAGE, 'any-failure')).toEqual({ status: 'sent', provider: 'brevo' });
  });

  it('never logs or returns a credential, even when the provider error text contains one', async () => {
    configureSmtp();
    process.env.BREVO_API_KEY = 'brevo_key_SECRET';
    const log = logger();
    mocks.sendMail.mockRejectedValue(Object.assign(new Error('535 bad login smtp-user smtp-pass-SECRET brevo_key_SECRET'), { code: 'EAUTH' }));
    mocks.fetch.mockResolvedValue({ status: 401, json: async () => ({ message: 'Key not found: brevo_key_SECRET' }) });
    const result = await createEnvEmailService(log).send(MESSAGE, 'any-failure');
    const everything = logged(log) + JSON.stringify(result);
    for (const secret of ['smtp-pass-SECRET', 'brevo_key_SECRET', 'smtp-user']) expect(everything).not.toContain(secret);
  });

  it('reads the environment at call time: configuration added later is picked up without a reload', async () => {
    const service = createEnvEmailService(logger());
    expect(service.isConfigured()).toBe(false);
    process.env.BREVO_API_KEY = 'brevo_key';
    expect(service.isConfigured()).toBe(true);
    delete process.env.BREVO_API_KEY;
    expect(service.isConfigured()).toBe(false);
  });

  it('the old RESEND_API_KEY is ignored: it no longer configures anything', () => {
    process.env.RESEND_API_KEY = 're_old';
    expect(createEnvEmailService(logger()).isConfigured()).toBe(false);
    delete process.env.RESEND_API_KEY;
  });
});
