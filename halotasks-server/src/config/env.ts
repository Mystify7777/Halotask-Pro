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

const MAX_TRUST_PROXY_HOPS = 5;

/**
 * Number of reverse-proxy hops in front of this server whose X-Forwarded-For entry may be trusted
 * (TRUST_PROXY_HOPS). It decides what `req.ip` is, and therefore every IP-keyed rate limit:
 *   0 (default) — no proxy: forwarded headers are ignored entirely and the socket address is used.
 *   N          — the N nearest hops are trusted; the client is the entry just beyond them, so
 *                anything a caller prepends to X-Forwarded-For is never believed.
 * Behind a platform proxy (Render, Railway) leaving this at 0 would put every user in one bucket,
 * and setting it higher than the real hop count would let callers choose their own bucket — so it is
 * explicit configuration, and a malformed value fails fast at startup instead of being guessed.
 */
export function getTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;

  if (raw === undefined || raw.trim() === '') {
    return 0;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TRUST_PROXY_HOPS) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a whole number between 0 and ${MAX_TRUST_PROXY_HOPS} (got "${raw}")`,
    );
  }

  return parsed;
}
