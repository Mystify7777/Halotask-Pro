// ── Rate-limit policy (Issue #23) ───────────────────────────────────────────────
//
// Every limit lives here so it can be reviewed and changed in one place. A rule counts requests per
// key inside a FIXED window; the (max + 1)th request in a window gets 429. See middleware/rateLimit.ts
// for the mechanism and docs/context.md ("Rate Limiting") for the reasoning and known limitations.
//
// State is PROCESS-LOCAL (see the deployment note in docs/context.md): each server process keeps its
// own counters and they reset when the process restarts.

const MINUTE = 60 * 1000;

export type RateLimitRule = { windowMs: number; max: number };

export const RATE_LIMITS = {
  // login: IP bucket stops one source spraying many accounts; (IP + account) stops one source
  // hammering one account without locking the real owner out from elsewhere; the account-wide
  // bucket caps a distributed guess against one account (deliberately high — it can also lock the
  // real owner out while an attack is running, which is the unavoidable cost of that defence).
  loginIp: { windowMs: 15 * MINUTE, max: 30 },
  loginAccountIp: { windowMs: 15 * MINUTE, max: 5 },
  loginAccount: { windowMs: 60 * MINUTE, max: 30 },

  // register creates accounts and runs bcrypt: IP only. There is no secret to guess, and an
  // account-keyed bucket would add nothing but a way to block someone else's address.
  registerIp: { windowMs: 60 * MINUTE, max: 10 },

  // forgot-password: IP bucket (as before) + per-address bucket so a victim's inbox cannot be
  // flooded from many IPs. The address is counted whether or not an account exists.
  forgotIp: { windowMs: 15 * MINUTE, max: 5 },
  forgotAccount: { windowMs: 60 * MINUTE, max: 3 },

  // reset-password guesses a 6-digit code (1,000,000 possibilities, valid for ~20 minutes), so the
  // per-account bucket is strict: at most ~10 guesses per code lifetime.
  resetIp: { windowMs: 15 * MINUTE, max: 10 },
  resetAccount: { windowMs: 15 * MINUTE, max: 5 },

  // Changing the password while signed in (Issue #46) checks the CURRENT password, so a stolen token could be used to guess
  // it. Per user: only failures count (refundOnSuccess), a handful per window. The IP bucket stops one source working through
  // many stolen tokens. Login's own buckets do not see these guesses, so this is a separate limit.
  changePasswordUser: { windowMs: 15 * MINUTE, max: 5 },
  changePasswordIp: { windowMs: 15 * MINUTE, max: 30 },

  // AI parsing spends a paid provider quota. Per user is the real limit; per IP stops one machine
  // rotating through accounts. Prompt length, max_completion_tokens and the timeout (Issue #22) still apply.
  aiUser: { windowMs: 10 * MINUTE, max: 20 },
  aiIp: { windowMs: 10 * MINUTE, max: 60 },

  // push relay fans one call out to every device a user registered. The client calls it once per
  // due reminder (scheduler tick: 60s), so this leaves room for bursts of due tasks and many devices.
  pushRelayUser: { windowMs: 5 * MINUTE, max: 60 },

  // Batched task sync (Issue #60): one request carries up to 50 mutations, so a request is worth much more than a single task
  // write. The client sends one batch per drain (a drain is triggered by a local change, a reconnect or a manual retry), so one
  // request a second on average is far above real use and well below a loop.
  taskSyncUser: { windowMs: MINUTE, max: 60 },
  // MCP (Issue #66): an AI client can call tools in tight loops. Per user and per IP, counted per request.
  mcpUser: { windowMs: MINUTE, max: 120 },
  mcpIp: { windowMs: MINUTE, max: 300 },

  // The external scheduler's trigger (Issue #29): one call every few minutes from a fixed source. This only blunts
  // guessing of the shared secret; the secret's length and constant-time comparison are the real protection.
  internalRunIp: { windowMs: 15 * MINUTE, max: 30 },
} as const satisfies Record<string, RateLimitRule>;

/** The one response body every limiter uses; it names no limiter, key or counter. */
export const RATE_LIMITED_MESSAGE = 'Too many requests. Please try again later.';

/**
 * Hard cap on distinct keys held per rule. Expired buckets are reclaimed; a LIVE bucket is never evicted. At
 * the cap, requests with a new key get 429 until buckets expire (see createRateLimiter).
 */
export const RATE_LIMIT_MAX_KEYS = 20_000;
