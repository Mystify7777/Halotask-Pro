// Server-side Groq chat-completions call. The endpoint, model and sampling settings are constants
// here — nothing about the provider is ever taken from a request.

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const GROQ_TIMEOUT_MS = 20_000;

export type AiProviderErrorKind = 'rate_limited' | 'unavailable' | 'timeout' | 'bad_response';

/**
 * A provider failure reduced to a safe category. It deliberately carries no upstream message or
 * body: provider error text can echo request content or credentials, so it never leaves this module.
 */
export class AiProviderError extends Error {
  constructor(
    public readonly kind: AiProviderErrorKind,
    public readonly upstreamStatus?: number,
  ) {
    super(`AI provider failure: ${kind}`);
    this.name = 'AiProviderError';
  }
}

export async function requestGroqCompletion(
  apiKey: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 429 is the only status a caller can usefully retry; 401/403 mean OUR key is wrong, which is
      // a server problem, not something to surface (or to pass through as a 401 to the user).
      throw new AiProviderError(response.status === 429 ? 'rate_limited' : 'unavailable', response.status);
    }

    const data = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new AiProviderError('bad_response');
    }
    return text;
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiProviderError('timeout');
    throw new AiProviderError('unavailable');
  } finally {
    clearTimeout(timer);
  }
}
