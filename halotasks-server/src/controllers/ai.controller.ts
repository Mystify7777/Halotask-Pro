import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getGroqApiKey } from '../config/env';
import { AiProviderError, requestGroqCompletion } from '../utils/groqClient';
import { buildTaskParsingPrompt, parseAiPromptBody, parseModelOutput } from '../utils/aiTaskParser';

/**
 * POST /api/ai/parse-tasks  (requireAuth)
 *
 * Order matters: validate the caller's input FIRST so malformed requests never reach the provider,
 * then check configuration, then call Groq. Failures are mapped to generic messages; the provider's
 * response text, the prompt, the generated content and the API key are never logged or returned
 * (only a failure category and HTTP status are logged).
 *
 * Rate limiting: no reusable limiter exists yet — broader limiting is Issue #23. Until then the
 * endpoint is bounded by authentication, the prompt length cap, max_completion_tokens and a request timeout.
 */
export const parseTasks = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = parseAiPromptBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const apiKey = getGroqApiKey();
  if (!apiKey) {
    console.error('[AI] GROQ_API_KEY is not configured; AI task parsing is unavailable.');
    res.status(503).json({ message: 'AI task creation is not available right now.' });
    return;
  }

  try {
    const raw = await requestGroqCompletion(apiKey, buildTaskParsingPrompt(parsed.prompt));
    const tasks = parseModelOutput(raw);

    if (tasks === null) {
      console.error('[AI] Provider returned a non-array response.');
      res.status(502).json({ message: 'The AI service returned an unexpected response. Please try again.' });
      return;
    }

    res.json({ tasks });
  } catch (error) {
    const kind = error instanceof AiProviderError ? error.kind : 'unavailable';
    const status = error instanceof AiProviderError ? error.upstreamStatus : undefined;
    console.error(`[AI] Provider request failed (${kind}${status ? `, upstream ${status}` : ''}).`);

    if (kind === 'rate_limited') {
      res.status(429).json({ message: 'The AI service is busy. Please try again in a moment.' });
    } else if (kind === 'timeout') {
      res.status(504).json({ message: 'The AI service took too long to respond. Please try again.' });
    } else if (kind === 'bad_response') {
      res.status(502).json({ message: 'The AI service returned an unexpected response. Please try again.' });
    } else {
      res.status(502).json({ message: 'The AI service is currently unavailable. Please try again later.' });
    }
  }
};
