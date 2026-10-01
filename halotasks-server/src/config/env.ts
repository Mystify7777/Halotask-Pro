const DEFAULT_RESET_TOKEN_TTL_MINUTES = 20;

/**
 * Parses and validates RESET_TOKEN_TTL_MINUTES from the environment.
 *
 * Throws (rather than silently falling back or producing NaN) when the
 * value is present but not a positive integer, so a misconfigured deploy
 * fails fast at startup instead of quietly issuing reset tokens that
 * expire immediately (or never).
 *
 * Called fresh each time rather than cached, since it's cheap and this
 * keeps a single source of truth for both the startup check and the
 * request-handling code that actually uses the value.
 */
export function getResetTokenTtlMinutes(): number {
  const raw = process.env.RESET_TOKEN_TTL_MINUTES;

  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_RESET_TOKEN_TTL_MINUTES;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `RESET_TOKEN_TTL_MINUTES must be a positive whole number of minutes (got "${raw}")`,
    );
  }

  return parsed;
}

/**
 * Server-only Groq credentials for AI task parsing (POST /api/ai/parse-tasks).
 *
 * The key lives ONLY in the server environment (GROQ_API_KEY) — never in a VITE_* variable, a
 * response body, a log line, or an error message. Returns null when it is not configured so the
 * endpoint can answer with a generic 503 instead of crashing or leaking configuration details.
 */
export function getGroqApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GROQ_API_KEY;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}
