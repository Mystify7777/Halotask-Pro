import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import aiRoutes from '../src/routes/ai.routes';
import { GROQ_MODEL, GROQ_TIMEOUT_MS, GROQ_URL } from '../src/utils/groqClient';
import { AI_MAX_TASKS, AI_PROMPT_MAX_LENGTH } from '../src/utils/aiTaskParser';

// Mongo-independent: the real router, auth middleware, controller, validators and Groq client run;
// only the network (global fetch) is replaced, so no test ever contacts the real provider.

const SECRET = 'test-jwt-secret-1234567890';
const GROQ_KEY = 'gsk_test_SUPER_SECRET_provider_key_0123456789';
const URL_PATH = '/api/ai/parse-tasks';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/ai', aiRoutes);

const token = jwt.sign({ userId: 'u1', email: 'u1@x.test', name: 'U1' }, SECRET);
const authed = () => request(app).post(URL_PATH).set('Authorization', `Bearer ${token}`);

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const fetchMock = vi.fn();
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

const logged = () =>
  [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.GROQ_API_KEY = GROQ_KEY;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.GROQ_API_KEY;
});

describe('authentication', () => {
  it('rejects a request with no token and never calls the provider', async () => {
    const res = await request(app).post(URL_PATH).send({ prompt: 'buy milk' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid token and never calls the provider', async () => {
    const res = await request(app).post(URL_PATH).set('Authorization', 'Bearer not-a-jwt').send({ prompt: 'buy milk' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ userId: 'u1', email: 'a@b.c', name: 'x' }, 'other-secret');
    const res = await request(app).post(URL_PATH).set('Authorization', `Bearer ${forged}`).send({ prompt: 'x' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('valid request', () => {
  it('reaches the provider with server-side config and returns validated drafts', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(
        '```json\n[{"title":"Book dentist","priority":"high","dueDate":"2026-10-06","estimatedMinutes":30,"tags":["health"],"description":"Call first"}]\n```',
      ),
    );

    const res = await authed().send({ prompt: '  Book dentist next Tuesday, high priority  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tasks: [
        {
          title: 'Book dentist',
          priority: 'high',
          dueDate: '2026-10-06',
          estimatedMinutes: 30,
          tags: ['health'],
          description: 'Call first',
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GROQ_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${GROQ_KEY}`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(GROQ_MODEL);
    expect(sent.max_tokens).toBe(1024);
    expect(sent.messages[0].content).toContain('Book dentist next Tuesday, high priority');
    expect(sent.messages[0].content).not.toContain('  Book dentist'); // trimmed
  });

  it('returns an empty list (not an error) when the model finds no tasks', async () => {
    fetchMock.mockResolvedValueOnce(completion('[]'));
    const res = await authed().send({ prompt: 'hello there' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: [] });
  });

  it('ignores provider, model and URL fields supplied by the client', async () => {
    fetchMock.mockResolvedValueOnce(completion('[]'));
    await authed().send({
      prompt: 'buy milk',
      model: 'evil-model',
      provider: 'openai',
      url: 'https://evil.example/steal',
      baseURL: 'https://evil.example',
      apiKey: 'client-supplied-key',
      temperature: 2,
      max_tokens: 999999,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GROQ_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${GROQ_KEY}`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(GROQ_MODEL);
    expect(sent.temperature).toBe(0.2);
    expect(sent.max_tokens).toBe(1024);
    expect(init.body).not.toContain('evil');
    expect(init.body).not.toContain('client-supplied-key');
  });

  it('escapes quotes in the prompt exactly as the browser version did', async () => {
    fetchMock.mockResolvedValueOnce(completion('[]'));
    await authed().send({ prompt: 'say "hi"' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[0].content).toContain('Text: "say \\"hi\\""');
  });
});

describe('validation happens before the provider is contacted', () => {
  const invalid: [string, unknown][] = [
    ['missing prompt', {}],
    ['null prompt', { prompt: null }],
    ['numeric prompt', { prompt: 42 }],
    ['array prompt', { prompt: ['a'] }],
    ['object prompt', { prompt: { text: 'a' } }],
    ['empty prompt', { prompt: '' }],
    ['whitespace-only prompt', { prompt: '   \n\t ' }],
    ['prompt over the limit', { prompt: 'a'.repeat(AI_PROMPT_MAX_LENGTH + 1) }],
    ['prompt over the limit even when padded with whitespace', { prompt: ` ${'a'.repeat(AI_PROMPT_MAX_LENGTH + 1)} ` }],
    ['array body', ['buy milk']],
  ];

  it.each(invalid)('rejects %s with 400', async (_name, body) => {
    const res = await authed().send(body as object);
    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 and no provider call', async () => {
    const res = await authed().set('Content-Type', 'application/json').send('{"prompt": ');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a 1-character prompt and a prompt of exactly the maximum length', async () => {
    fetchMock.mockImplementation(async () => completion('[]'));
    expect((await authed().send({ prompt: 'a' })).status).toBe(200);
    expect((await authed().send({ prompt: 'a'.repeat(AI_PROMPT_MAX_LENGTH) })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('counts the limit after trimming, not before', async () => {
    fetchMock.mockImplementation(async () => completion('[]'));
    const res = await authed().send({ prompt: `   ${'a'.repeat(AI_PROMPT_MAX_LENGTH)}   ` });
    expect(res.status).toBe(200);
  });
});

describe('provider failures become safe API errors', () => {
  const upstreamBody = JSON.stringify({
    error: { message: `Invalid API Key ${GROQ_KEY} for request "buy secret milk"` },
  });

  const cases: [string, () => void, number][] = [
    ['upstream 401 (our key is bad)', () => fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 401 })), 502],
    ['upstream 403', () => fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 403 })), 502],
    ['upstream 429', () => fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 429 })), 429],
    ['upstream 500', () => fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 500 })), 502],
    ['upstream 503', () => fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 503 })), 502],
    ['network error that mentions the key', () => fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${GROQ_KEY}`)), 502],
    ['200 with non-JSON body', () => fetchMock.mockResolvedValueOnce(new Response('<html>nope</html>', { status: 200 })), 502],
    ['200 without choices', () => fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 })), 502],
    ['model text that is not JSON', () => fetchMock.mockResolvedValueOnce(completion('Sure! Here are your tasks')), 502],
    ['model JSON that is not an array', () => fetchMock.mockResolvedValueOnce(completion('{"title":"x"}')), 502],
  ];

  it.each(cases)('%s → safe error', async (_name, arrange, expectedStatus) => {
    arrange();
    const res = await authed().send({ prompt: 'buy secret milk' });

    expect(res.status).toBe(expectedStatus);
    expect(res.status).not.toBe(401); // would make the client log the user out
    expect(typeof res.body.message).toBe('string');
    const wire = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(wire).not.toContain(GROQ_KEY);
    expect(wire).not.toContain('gsk_');
    expect(wire).not.toContain('Invalid API Key');
    expect(wire).not.toContain('secret milk');
    expect(wire).not.toContain('groq.com');
  });

  it('times out a hung provider with 504 and aborts the request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );

    const pending = authed().send({ prompt: 'buy milk' }).then((r) => r);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(GROQ_TIMEOUT_MS + 1);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('never logs the key, the prompt, upstream text or generated content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 500 }));
    await authed().send({ prompt: 'buy secret milk' });
    fetchMock.mockResolvedValueOnce(completion('["generated secret content that is not an object"] oops {'));
    await authed().send({ prompt: 'buy secret milk' });
    fetchMock.mockRejectedValueOnce(new Error(`boom ${GROQ_KEY}`));
    await authed().send({ prompt: 'buy secret milk' });
    fetchMock.mockResolvedValueOnce(completion('[{"title":"generated secret title"}]'));
    await authed().send({ prompt: 'buy secret milk' });

    const output = logged();
    expect(output).toContain('[AI]'); // failures ARE logged, just safely
    expect(output).not.toContain(GROQ_KEY);
    expect(output).not.toContain('gsk_');
    expect(output).not.toContain('secret milk');
    expect(output).not.toContain('generated secret');
    expect(output).not.toContain('Invalid API Key');
  });
});

describe('server-side configuration', () => {
  it.each([undefined, '', '   '])('answers 503 and never calls the provider when GROQ_API_KEY is %j', async (value) => {
    if (value === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = value;

    const res = await authed().send({ prompt: 'buy milk' });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/GROQ|env|key/i);
  });

  it('still validates input first when the key is missing (400 beats 503)', async () => {
    delete process.env.GROQ_API_KEY;
    const res = await authed().send({ prompt: '' });
    expect(res.status).toBe(400);
  });
});

describe('model output sanitising', () => {
  it('drops malformed fields instead of failing, and caps the number of tasks', async () => {
    const many = Array.from({ length: AI_MAX_TASKS + 5 }, (_, i) => ({ title: `t${i}` }));
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(many)));
    const res = await authed().send({ prompt: 'lots' });
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(AI_MAX_TASKS);
  });

  it('defaults priority, title and description, and drops invalid dates and minutes', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(
        JSON.stringify([
          { title: '   ', priority: 'urgent', dueDate: '2026-02-30', estimatedMinutes: -5, tags: [1, 'ok', ''], description: 7 },
          'not an object',
          null,
          { title: 'Real', dueDate: 'tomorrow', estimatedMinutes: 'ten' },
        ]),
      ),
    );
    const res = await authed().send({ prompt: 'x' });
    expect(res.body.tasks).toEqual([
      { title: 'Untitled task', priority: 'medium', tags: ['ok'], description: '' },
      { title: 'Real', priority: 'medium', tags: [], description: '' },
    ]);
  });

  it('bounds title, description and tags', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(
        JSON.stringify([
          {
            title: 'a'.repeat(500),
            description: 'd'.repeat(5000),
            tags: Array.from({ length: 50 }, (_, i) => `tag${i}`.padEnd(80, 'x')),
          },
        ]),
      ),
    );
    const res = await authed().send({ prompt: 'x' });
    const [task] = res.body.tasks;
    expect(task.title).toHaveLength(200);
    expect(task.description).toHaveLength(2000);
    expect(task.tags).toHaveLength(20);
    expect(task.tags.every((t: string) => t.length <= 50)).toBe(true);
  });
});
