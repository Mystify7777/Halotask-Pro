import crypto from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RATE_LIMITED_MESSAGE, RATE_LIMIT_MAX_KEYS, type RateLimitRule } from '../config/rateLimits';
import { normalizeEmail } from '../utils/validators';

// Small fixed-window limiter for the handful of abuse-sensitive endpoints (Issue #23). Process-local
// by design — see docs/context.md. It is a middleware, not a framework: a limiter is a list of rules,
// each with its own counters, and a request is refused (429) if ANY rule is exhausted.

export type KeyFn = (req: Request) => string | null;

export type NamedRule = RateLimitRule & {
  /** Returns the bucket key for this request, or null to skip the rule (e.g. no usable e-mail). */
  key: KeyFn;
  /**
   * Count the attempt up front (so parallel requests cannot all slip under the limit), then give it
   * back when the response is a success. Used for login/reset so only failures consume the budget.
   */
  refundOnSuccess?: boolean;
};

type Bucket = { count: number; resetAt: number };

type Store = {
  rule: NamedRule;
  buckets: Map<string, Bucket>;
  lastSweep: number;
  /** Earliest expiry among live buckets as of the last sweep (Infinity if none): when capacity can next free up. */
  earliestReset: number;
};

/** While a store is full, expired buckets are reclaimed at most this often (bounds the cost of a flood). */
const FULL_SWEEP_INTERVAL_MS = 1000;

export type RateLimiter = RequestHandler & { reset: () => void };

const registry = new Set<RateLimiter>();

/** Clears every limiter's counters (tests only). */
export function resetAllRateLimiters(): void {
  for (const limiter of registry) limiter.reset();
}

// A per-process random salt: e-mail keys are hashed so the in-memory counters never hold an address,
// and the hashes are meaningless outside this process.
const SALT = crypto.randomBytes(16);
const hashKey = (value: string) => crypto.createHmac('sha256', SALT).update(value).digest('hex').slice(0, 32);

/**
 * Bucket key for an address (normally `req.ip`, which is the socket address or the entry a trusted proxy
 * appended). Uses Node's own `net` parsers — no dependency:
 *   - IPv4 is used as-is; any form of IPv4-mapped IPv6 (`::ffff:1.2.3.4`, `::ffff:102:304`, long form)
 *     collapses to the IPv4 address so one client is one bucket whichever way it is spelled.
 *   - A full IPv6 address collapses to its /64 prefix (compressed, uncompressed, leading zeros and
 *     upper/lower case all give the same key): one customer routinely owns a whole /64, so keying on the
 *     full address would let one machine mint unlimited buckets. An IPv6 zone id (`%eth0`) is ignored.
 *   - Anything that is not a valid IP (missing, malformed, `host:port`, `[::1]`) maps to the single shared
 *     'unknown' bucket — failing closed rather than letting arbitrary strings mint their own buckets.
 */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (isIPv4(ip)) return ip;

  const zone = ip.indexOf('%');
  let text = zone === -1 ? ip : ip.slice(0, zone);
  if (!isIPv6(text)) return 'unknown';

  // Embedded dotted IPv4 tail (e.g. "::ffff:1.2.3.4") becomes two hextets so every form is 8 groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, rest = ''] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const restParts = text.includes('::') && rest ? rest.split(':') : [];
  const missing = text.includes('::') ? 8 - headParts.length - restParts.length : 0;
  const groups = [...headParts, ...Array<string>(Math.max(missing, 0)).fill('0'), ...restParts].map((g) =>
    parseInt(g, 16),
  );
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return 'unknown';

  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** Key by client IP (`req.ip`, which honours TRUST_PROXY_HOPS and nothing else). */
export const ipKey: KeyFn = (req) => normalizeIp(req.ip);

/** Key by the authenticated user (requireAuth must run first); null when there is none. */
export const userKey: KeyFn = (req) => (req.user?.id ? `user:${req.user.id}` : null);

const MAX_EMAIL_KEY_LENGTH = 320;

/** The submitted e-mail, normalised and hashed — counted whether or not an account exists. */
export const emailKey: KeyFn = (req) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== 'string') return null;
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_KEY_LENGTH) return null;
  return `email:${hashKey(normalized)}`;
};

/** The submitted e-mail AND the client IP together. */
export const emailAndIpKey: KeyFn = (req) => {
  const email = emailKey(req);
  return email === null ? null : `${email}|${ipKey(req)}`;
};

export type LimiterOptions = {
  /** Clock override for tests. */
  now?: () => number;
  /** Per-rule cap on distinct keys (tests only; defaults to RATE_LIMIT_MAX_KEYS). */
  maxKeys?: number;
};

/**
 * Capacity policy (the memory bound): each rule holds at most `maxKeys` distinct buckets.
 *   - Expired buckets are reclaimed lazily (once per window normally; at most once per second while full).
 *   - A LIVE bucket is never evicted to make room. Evicting one would let anybody who can mint many
 *     unique keys (e.g. random e-mail addresses) reset another client's active limit.
 *   - When the store is full of live buckets, a request whose key has NO bucket is refused with the
 *     normal 429 (Retry-After = when the earliest live bucket expires). Requests for keys that already
 *     have a bucket are unaffected and keep accumulating and enforcing their limits.
 * Trade-off: filling a store is a denial of service against *new* keys until buckets expire (up to one
 * window), instead of a bypass of existing limits. Failing open for new keys would be a bypass too, since
 * an attacker could fill the store and then guess against a victim whose bucket does not exist yet.
 */
export function createRateLimiter(rules: NamedRule[], options: LimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? RATE_LIMIT_MAX_KEYS;
  const stores: Store[] = rules.map((rule) => ({ rule, buckets: new Map(), lastSweep: 0, earliestReset: Infinity }));

  const sweep = (store: Store, at: number) => {
    const interval = store.buckets.size >= maxKeys ? FULL_SWEEP_INTERVAL_MS : store.rule.windowMs;
    if (at - store.lastSweep < interval) return;
    store.lastSweep = at;
    let earliest = Infinity;
    for (const [key, bucket] of store.buckets) {
      if (bucket.resetAt <= at) store.buckets.delete(key);
      else earliest = Math.min(earliest, bucket.resetAt);
    }
    store.earliestReset = earliest;
  };

  /** Milliseconds until a request for `key` may be admitted by this store; 0 if it may be admitted now. */
  const blockedFor = (store: Store, key: string, at: number): number => {
    const bucket = store.buckets.get(key);
    if (bucket) {
      // An expired bucket that has not been swept yet counts as empty (and is reused in place, so it
      // needs no extra capacity).
      return bucket.resetAt > at && bucket.count >= store.rule.max ? bucket.resetAt - at : 0;
    }
    if (store.buckets.size < maxKeys) return 0;
    // Full of live buckets and this key has none: refuse until capacity can free up. The sweep estimate
    // can be up to FULL_SWEEP_INTERVAL_MS stale, hence the floor.
    return store.earliestReset > at ? store.earliestReset - at : FULL_SWEEP_INTERVAL_MS;
  };

  const limiter: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const at = now();
    const keyed: { store: Store; key: string }[] = [];

    for (const store of stores) {
      const key = store.rule.key(req);
      if (key === null) continue;
      sweep(store, at);
      keyed.push({ store, key });
    }

    // Phase 1 — check every rule WITHOUT consuming, so a refused request never uses up budget on the
    // rules that would have allowed it (and cannot be used to drain someone else's other buckets).
    let retryAfterMs = 0;
    for (const { store, key } of keyed) {
      retryAfterMs = Math.max(retryAfterMs, blockedFor(store, key, at));
    }

    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({ message: RATE_LIMITED_MESSAGE });
      return;
    }

    // Phase 2 — consume.
    const consumed: { bucket: Bucket; refundable: boolean }[] = [];
    for (const { store, key } of keyed) {
      let bucket = store.buckets.get(key);
      if (!bucket || bucket.resetAt <= at) {
        bucket = { count: 0, resetAt: at + store.rule.windowMs };
        store.buckets.set(key, bucket);
      }
      bucket.count += 1;
      consumed.push({ bucket, refundable: store.rule.refundOnSuccess === true });
    }

    if (consumed.some((c) => c.refundable)) {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        for (const { bucket, refundable } of consumed) {
          if (refundable && bucket.count > 0) bucket.count -= 1;
        }
      });
    }

    next();
  };

  const rateLimiter = Object.assign(limiter, {
    reset: () => {
      for (const store of stores) {
        store.buckets.clear();
        store.lastSweep = 0;
        store.earliestReset = Infinity;
      }
    },
  }) as RateLimiter;

  registry.add(rateLimiter);
  return rateLimiter;
}
