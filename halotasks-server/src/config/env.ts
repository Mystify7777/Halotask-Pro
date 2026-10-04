import { isIP, isIPv4, isIPv6 } from 'node:net';

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

// ── MongoDB connection settings (Issue #20) ─────────────────────────────────────────────────────

export const DEFAULT_MONGO_DNS_FALLBACK_SERVERS: readonly string[] = ['8.8.8.8', '1.1.1.1'];
export const DEFAULT_MONGO_SERVER_SELECTION_TIMEOUT_MS = 15_000;
const MIN_SERVER_SELECTION_TIMEOUT_MS = 1_000;
const MAX_SERVER_SELECTION_TIMEOUT_MS = 120_000;

export type MongoConfig = {
  /** The connection string. Never log or interpolate this into an error: it carries credentials. */
  uri: string;
  /** true for `mongodb+srv://` (the only form the DNS fallback applies to). */
  srv: boolean;
  serverSelectionTimeoutMS: number;
  /** Resolvers used by the one-shot SRV fallback. Empty = fallback disabled. */
  dnsFallbackServers: string[];
};

const isPort = (text: string | undefined): boolean =>
  text === undefined || (/^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535);

/** What dns.setServers() accepts, restricted to literal IPs: `ip`, `ipv4:port`, `[ipv6]:port`. */
function isValidDnsServer(entry: string): boolean {
  if (isIP(entry)) return true;

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return isIPv6(bracketed[1]) && isPort(bracketed[2]);

  const colon = entry.indexOf(':');
  if (colon > 0 && colon === entry.lastIndexOf(':')) {
    return isIPv4(entry.slice(0, colon)) && isPort(entry.slice(colon + 1));
  }

  return false;
}

/**
 * Parses and validates every MongoDB setting in one place, BEFORE any DNS or network work, so a bad
 * deploy fails fast with a clear message instead of surfacing later as a driver or resolver error.
 *
 *   MONGO_URI                          required; must be a `mongodb://` or `mongodb+srv://` string.
 *   MONGO_DNS_SERVERS                  optional; comma-separated resolvers for the SRV fallback.
 *                                      Unset, empty or whitespace-only → 8.8.8.8,1.1.1.1. A value with a
 *                                      separator but no entries (e.g. "," or " , ")
 *                                      disables the fallback. Entries must be literal IPs (`ip`,
 *                                      `ipv4:port`, `[ipv6]:port`) — anything else would make
 *                                      dns.setServers() throw in the middle of the fallback.
 *   MONGO_SERVER_SELECTION_TIMEOUT_MS  optional; whole milliseconds, 1000–120000, default 15000.
 *
 * Error messages never contain MONGO_URI or its credentials. (The timeout and DNS-server errors do quote
 * the offending value — a number or an IP-shaped string, never a secret.)
 */
export function getMongoConfig(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  const uri = env.MONGO_URI;

  if (!uri || uri.trim() === '') {
    throw new Error('MONGO_URI is not configured');
  }

  const srv = uri.startsWith('mongodb+srv://');
  if (!srv && !uri.startsWith('mongodb://')) {
    throw new Error('MONGO_URI must start with "mongodb://" or "mongodb+srv://"');
  }

  const rawTimeout = env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
  let serverSelectionTimeoutMS = DEFAULT_MONGO_SERVER_SELECTION_TIMEOUT_MS;

  if (rawTimeout !== undefined && rawTimeout.trim() !== '') {
    const parsed = Number(rawTimeout);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_SERVER_SELECTION_TIMEOUT_MS ||
      parsed > MAX_SERVER_SELECTION_TIMEOUT_MS
    ) {
      throw new Error(
        `MONGO_SERVER_SELECTION_TIMEOUT_MS must be a whole number of milliseconds between ` +
          `${MIN_SERVER_SELECTION_TIMEOUT_MS} and ${MAX_SERVER_SELECTION_TIMEOUT_MS} (got "${rawTimeout}")`,
      );
    }
    serverSelectionTimeoutMS = parsed;
  }

  // Unset, empty and whitespace-only all mean "not configured" → defaults. Only a value that actually
  // contains a separator but no entries (",", " , ") is the explicit way to disable the fallback.
  const rawServers = env.MONGO_DNS_SERVERS;
  const dnsFallbackServers = rawServers !== undefined && rawServers.trim() !== ''
    ? rawServers
        .split(',')
        .map((server) => server.trim())
        .filter((server) => server.length > 0)
    : [...DEFAULT_MONGO_DNS_FALLBACK_SERVERS];

  for (const server of dnsFallbackServers) {
    if (!isValidDnsServer(server)) {
      throw new Error(
        `MONGO_DNS_SERVERS must be a comma-separated list of IP addresses (optionally with a port) (got "${server}")`,
      );
    }
  }

  return { uri, srv, serverSelectionTimeoutMS, dnsFallbackServers };
}
