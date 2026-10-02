import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITED_MESSAGE, RATE_LIMIT_MAX_KEYS } from '../src/config/rateLimits';
import { getTrustProxyHops } from '../src/config/env';
import {
  createRateLimiter,
  emailAndIpKey,
  emailKey,
  ipKey,
  normalizeIp,
  type KeyFn,
  type NamedRule,
} from '../src/middleware/rateLimit';

// Unit tests for the limiter mechanism with an injected clock (no sleeping, no real timers).

let clock = 1_000_000;
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

const WINDOW = 60_000;

const build = (rules: NamedRule[], hops = 0, status: () => number = () => 200, maxKeys?: number) => {
  const app = express();
  app.set('trust proxy', hops);
  app.use(express.json());
  app.post('/x', createRateLimiter(rules, { now, maxKeys }), (_req, res) => {
    res.status(status()).json({ ok: true });
  });
  return app;
};

const headerKey: KeyFn = (req) => (typeof req.headers['x-k'] === 'string' ? req.headers['x-k'] : null);
const hit = (app: express.Express, k = 'a', extra: Record<string, string> = {}) =>
  request(app).post('/x').set('x-k', k).set(extra).send({});

beforeEach(() => {
  clock = 1_000_000;
});

describe('fixed-window boundary', () => {
  it('allows exactly max requests and rejects the next one', async () => {
    const app = build([{ windowMs: WINDOW, max: 3, key: headerKey }]);
    for (let i = 0; i < 3; i += 1) expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(429);
    expect((await hit(app)).status).toBe(429);
  });

  it('allows again exactly when the window has elapsed, and not a millisecond before', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(429);
    advance(WINDOW - 1);
    expect((await hit(app)).status).toBe(429);
    advance(1);
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(429);
  });

  it('treats an expired bucket as empty even when the lazy sweep has not removed it yet', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    await hit(app, 'x'); // t0: first sweep happens here
    advance(1);
    await hit(app, 'a'); // t0+1: 'a' bucket created, expires at t0+1+WINDOW
    advance(WINDOW - 1);
    await hit(app, 'c'); // t0+WINDOW: a sweep runs now ('a' is still live, so it survives it)
    advance(2); // t0+WINDOW+2: 'a' expired, but the next sweep is a whole window away
    expect((await hit(app, 'a')).status).toBe(200);
  });

  it('does not extend the window when refusing requests', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    await hit(app);
    for (let i = 0; i < 5; i += 1) {
      advance(WINDOW / 10);
      await hit(app); // refused
    }
    advance(WINDOW / 2); // total elapsed = 1.0 window since the FIRST request
    expect((await hit(app)).status).toBe(200);
  });
});

describe('429 contract', () => {
  it('returns { message } only, with an integer Retry-After that counts down', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    await hit(app);
    const first = await hit(app);
    expect(first.status).toBe(429);
    expect(first.body).toEqual({ message: RATE_LIMITED_MESSAGE });
    expect(first.headers['retry-after']).toBe('60');

    advance(30_500);
    const later = await hit(app);
    expect(later.headers['retry-after']).toBe('30'); // 29.5s left, rounded up
    expect(Object.keys(later.body)).toEqual(['message']);
  });

  it('never exposes limiter internals (rule, key, counts) in body or headers', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    await hit(app, 'secret-key-value');
    const res = await hit(app, 'secret-key-value');
    const wire = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(wire).not.toContain('secret-key-value');
    expect(Object.keys(res.headers).filter((h) => /ratelimit|x-rate/i.test(h))).toEqual([]);
  });

  it('reports the longest wait when several rules are exhausted', async () => {
    const app = build([
      { windowMs: 10_000, max: 1, key: headerKey },
      { windowMs: 50_000, max: 1, key: headerKey },
    ]);
    await hit(app);
    const res = await hit(app);
    expect(res.headers['retry-after']).toBe('50');
  });
});

describe('bucketing', () => {
  it('keeps different keys in separate buckets', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    expect((await hit(app, 'a')).status).toBe(200);
    expect((await hit(app, 'b')).status).toBe(200);
    expect((await hit(app, 'a')).status).toBe(429);
    expect((await hit(app, 'b')).status).toBe(429);
    expect((await hit(app, 'c')).status).toBe(200);
  });

  it('skips a rule whose key is null (no bucket is shared by "missing")', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/x').send({});
      expect(res.status).toBe(200);
    }
  });

  it('refuses a request if ANY rule is exhausted', async () => {
    const app = build([
      { windowMs: WINDOW, max: 100, key: () => 'shared' },
      { windowMs: WINDOW, max: 1, key: headerKey },
    ]);
    expect((await hit(app, 'a')).status).toBe(200);
    expect((await hit(app, 'a')).status).toBe(429);
    expect((await hit(app, 'b')).status).toBe(200);
  });

  it('does not charge the other rules for a request that was refused', async () => {
    // Rule 1 (per-key, max 1) refuses 'a'. Rule 2 (shared, max 3) must only have been charged by
    // the requests that were actually allowed — otherwise 'a' could drain everyone's shared budget.
    const app = build([
      { windowMs: WINDOW, max: 3, key: () => 'shared' },
      { windowMs: WINDOW, max: 1, key: headerKey },
    ]);
    await hit(app, 'a');
    for (let i = 0; i < 10; i += 1) expect((await hit(app, 'a')).status).toBe(429);
    expect((await hit(app, 'b')).status).toBe(200);
    expect((await hit(app, 'c')).status).toBe(200);
    expect((await hit(app, 'd')).status).toBe(429); // 'a','b','c' used the 3 shared slots
  });
});

describe('refundOnSuccess', () => {
  it('lets successes through indefinitely but counts failures', async () => {
    let status = 200;
    const app = build([{ windowMs: WINDOW, max: 2, key: headerKey, refundOnSuccess: true }], 0, () => status);
    for (let i = 0; i < 10; i += 1) expect((await hit(app)).status).toBe(200);
    status = 401;
    expect((await hit(app)).status).toBe(401);
    expect((await hit(app)).status).toBe(401);
    expect((await hit(app)).status).toBe(429);
  });

  it('counts a burst of parallel failures up front (cannot slip under the limit)', async () => {
    const app = build([{ windowMs: WINDOW, max: 3, key: headerKey, refundOnSuccess: true }], 0, () => 401);
    const results = await Promise.all(Array.from({ length: 10 }, () => hit(app)));
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it('does not refund 4xx responses', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey, refundOnSuccess: true }], 0, () => 400);
    expect((await hit(app)).status).toBe(400);
    expect((await hit(app)).status).toBe(429);
  });
});

describe('capacity (memory bound): live buckets are never evicted', () => {
  const rule: NamedRule = { windowMs: WINDOW, max: 1, key: headerKey };
  const CAP = 3;
  const capped = (maxKeys = CAP, rules: NamedRule[] = [rule]) => build(rules, 0, () => 200, maxKeys);

  it('behaves exactly as before while below capacity', async () => {
    const app = capped();
    expect((await hit(app, 'a')).status).toBe(200);
    expect((await hit(app, 'b')).status).toBe(200);
    expect((await hit(app, 'a')).status).toBe(429);
    expect((await hit(app, 'b')).status).toBe(429);
    expect((await hit(app, 'c')).status).toBe(200); // the last free slot
  });

  it('cannot evict a live bucket by introducing another unique key', async () => {
    const app = capped();
    for (const k of ['a', 'b', 'c']) expect((await hit(app, k)).status).toBe(200);

    // A flood of unique keys. If any of them evicted a live bucket, that bucket's owner would be able
    // to send again (the regression this guards against).
    for (let i = 0; i < 50; i += 1) expect((await hit(app, `new${i}`)).status).toBe(429);

    for (const k of ['a', 'b', 'c']) expect((await hit(app, k)).status).toBe(429);
  });

  it('keeps the oldest live bucket enforced even though it is first in insertion order', async () => {
    const app = capped(1);
    expect((await hit(app, 'first')).status).toBe(200);
    expect((await hit(app, 'attacker1')).status).toBe(429);
    expect((await hit(app, 'attacker2')).status).toBe(429);
    expect((await hit(app, 'first')).status).toBe(429);
  });

  it('refuses a new key at capacity with the normal 429 contract and a deterministic Retry-After', async () => {
    const app = capped();
    await hit(app, 'a'); // expires at t0 + 60s
    advance(10_000);
    await hit(app, 'b'); // t0 + 70s
    advance(10_000);
    await hit(app, 'c'); // t0 + 80s
    advance(5_000); // t0 + 25s

    const res = await hit(app, 'd');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: RATE_LIMITED_MESSAGE });
    expect(res.headers['retry-after']).toBe('35'); // earliest live bucket ('a') expires in 35s

    // Same inputs, same answer.
    const again = await hit(app, 'e');
    expect([again.status, again.headers['retry-after']]).toEqual([429, '35']);
  });

  it('reclaims expired buckets: capacity returns as they expire, one slot at a time', async () => {
    const app = capped();
    await hit(app, 'a'); // t0, expires t0+60s
    advance(10_000);
    await hit(app, 'b'); // expires t0+70s
    advance(10_000);
    await hit(app, 'c'); // expires t0+80s
    expect((await hit(app, 'd')).status).toBe(429);

    advance(40_000); // t0+60s: only 'a' has expired
    expect((await hit(app, 'd')).status).toBe(200); // took the freed slot
    expect((await hit(app, 'e')).status).toBe(429); // store is full of live buckets again
    expect((await hit(app, 'b')).status).toBe(429); // b, c untouched
    expect((await hit(app, 'c')).status).toBe(429);

    advance(WINDOW); // everything has expired
    for (const k of ['e', 'f', 'g']) expect((await hit(app, k)).status).toBe(200);
  });

  it('sees freed capacity within one second of expiry (the full-store sweep is throttled)', async () => {
    const app = capped(1);
    await hit(app, 'a'); // expires t0 + 60s
    advance(WINDOW - 100);
    const stillFull = await hit(app, 'b'); // sweep runs here: 'a' is still live
    expect(stillFull.status).toBe(429);
    advance(100); // 'a' has just expired, but a sweep ran < 1s ago
    expect((await hit(app, 'b')).status).toBe(429); // stale view: documented, at most 1s late
    advance(1_000);
    expect((await hit(app, 'b')).status).toBe(200);
  });

  it('existing buckets keep accumulating and enforcing after capacity pressure', async () => {
    const rule3: NamedRule = { windowMs: WINDOW, max: 3, key: headerKey };
    const app = capped(2, [rule3]);
    expect((await hit(app, 'a')).status).toBe(200); // a: 1
    expect((await hit(app, 'b')).status).toBe(200); // b: 1
    for (let i = 0; i < 20; i += 1) expect((await hit(app, `x${i}`)).status).toBe(429); // pressure
    expect((await hit(app, 'a')).status).toBe(200); // a: 2 (count was not reset)
    expect((await hit(app, 'a')).status).toBe(200); // a: 3
    expect((await hit(app, 'a')).status).toBe(429); // exactly max, enforced
    expect((await hit(app, 'b')).status).toBe(200); // b: 2
    expect((await hit(app, 'b')).status).toBe(200); // b: 3
    expect((await hit(app, 'b')).status).toBe(429);
  });

  it('a key whose bucket expired but was not swept reuses its slot instead of needing capacity', async () => {
    const app = capped(1);
    await hit(app, 'a');
    advance(WINDOW + 1);
    // Store is "full" (the expired entry is still present) but 'a' already owns that entry.
    expect((await hit(app, 'a')).status).toBe(200);
    expect((await hit(app, 'a')).status).toBe(429);
  });

  it('refuses a request when ANY rule is full for its key, without charging the other rules', async () => {
    const shared: NamedRule = { windowMs: WINDOW, max: 2, key: () => 'shared' };
    const perKey: NamedRule = { windowMs: WINDOW, max: 5, key: headerKey };
    const app = capped(1, [shared, perKey]);
    expect((await hit(app, 'a')).status).toBe(200); // shared: 1, perKey full
    for (let i = 0; i < 10; i += 1) expect((await hit(app, `new${i}`)).status).toBe(429);
    // The ten refused requests must not have used the shared rule's remaining slot.
    expect((await hit(app, 'a')).status).toBe(200); // shared: 2
    expect((await hit(app, 'a')).status).toBe(429); // shared exhausted
  });

  it('at the real default capacity: never exceeds it, never evicts, refuses new keys', async () => {
    const limiter = createRateLimiter([{ windowMs: WINDOW, max: 1, key: headerKey }], { now });

    // Drive the handler directly: 20k supertest requests would be slow.
    const call = (k: string) =>
      new Promise<number>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader: () => undefined,
          on: () => undefined,
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          json() {
            resolve(this.statusCode);
          },
        };
        limiter({ headers: { 'x-k': k } } as never, res as never, () => resolve(200));
      });

    for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i += 1) expect(await call(`k${i}`)).toBe(200);
    expect(await call('one-too-many')).toBe(429);
    expect(await call('k0')).toBe(429); // the oldest key is still enforced
    expect(await call(`k${RATE_LIMIT_MAX_KEYS - 1}`)).toBe(429);
    advance(WINDOW);
    expect(await call('one-too-many')).toBe(200); // everything expired, capacity is back
  });
});

describe('lazy expiry', () => {
  it('forgets expired buckets', async () => {
    const app = build([{ windowMs: WINDOW, max: 1, key: headerKey }]);
    await hit(app, 'a');
    advance(WINDOW);
    expect((await hit(app, 'a')).status).toBe(200);
  });
});

describe('IP keying and trust proxy', () => {
  const ipRule: NamedRule = { windowMs: WINDOW, max: 1, key: ipKey };

  it('with 0 hops ignores X-Forwarded-For entirely (cannot be used to dodge or to frame)', async () => {
    const app = build([ipRule], 0);
    expect((await request(app).post('/x').set('X-Forwarded-For', '1.1.1.1').send({})).status).toBe(200);
    expect((await request(app).post('/x').set('X-Forwarded-For', '2.2.2.2').send({})).status).toBe(429);
    expect((await request(app).post('/x').send({})).status).toBe(429);
  });

  it('with 1 hop buckets by the entry the trusted proxy appended, ignoring what the caller prepended', async () => {
    const app = build([ipRule], 1);
    const send = (xff: string) => request(app).post('/x').set('X-Forwarded-For', xff).send({});
    // Same real client (9.9.9.9), different spoofed prefixes → same bucket.
    expect((await send('1.1.1.1, 9.9.9.9')).status).toBe(200);
    expect((await send('2.2.2.2, 9.9.9.9')).status).toBe(429);
    expect((await send('3.3.3.3, 4.4.4.4, 9.9.9.9')).status).toBe(429);
    // A different real client has its own bucket.
    expect((await send('1.1.1.1, 8.8.8.8')).status).toBe(200);
  });

  it('with 2 hops skips the second trusted proxy too', async () => {
    const app = build([ipRule], 2);
    const send = (xff: string) => request(app).post('/x').set('X-Forwarded-For', xff).send({});
    expect((await send('spoof, 9.9.9.9, 10.0.0.1')).status).toBe(200);
    expect((await send('other, 9.9.9.9, 10.0.0.1')).status).toBe(429);
    expect((await send('other, 7.7.7.7, 10.0.0.1')).status).toBe(200);
  });

  it('does not trust other forwarding headers (X-Real-IP, Forwarded, True-Client-IP, CF-Connecting-IP)', async () => {
    const app = build([ipRule], 1);
    const base = () => request(app).post('/x').set('X-Forwarded-For', '9.9.9.9');
    expect((await base().send({})).status).toBe(200);
    for (const [h, v] of [
      ['X-Real-IP', '5.5.5.5'],
      ['Forwarded', 'for=6.6.6.6'],
      ['True-Client-IP', '7.7.7.7'],
      ['CF-Connecting-IP', '8.8.8.8'],
    ]) {
      expect((await base().set(h, v).send({})).status).toBe(429);
    }
  });
});

describe('normalizeIp', () => {
  it.each([
    // missing → shared 'unknown'
    [undefined, 'unknown'],
    ['', 'unknown'],
    // IPv4
    ['203.0.113.7', '203.0.113.7'],
    // IPv4-mapped IPv6, every spelling → the IPv4 address
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['0:0:0:0:0:ffff:203.0.113.7', '203.0.113.7'],
    ['0000:0000:0000:0000:0000:ffff:cb00:7107', '203.0.113.7'],
    // uncompressed
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    // compressed (every position of "::")
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8:0:0:1::', '2001:db8:0:0::/64'],
    ['::2001:db8', '0:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    // leading zeros and case
    ['2001:0db8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0::/64'],
    ['2001:DB8::A', '2001:db8:0:0::/64'],
    // zone identifiers are ignored
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['FE80::1%eth1', 'fe80:0:0:0::/64'],
    // malformed → shared 'unknown' (fail closed; arbitrary strings cannot mint buckets)
    ['garbage', 'unknown'],
    ['1:2:3', 'unknown'],
    [':::', 'unknown'],
    ['1::2::3', 'unknown'],
    ['zzzz::1', 'unknown'],
    ['1:2:3:4:5:6:7:8:9', 'unknown'],
    ['::ffff:999.1.1.1', 'unknown'],
    ['1.2.3.4:80', 'unknown'],
    ['[::1]', 'unknown'],
    ['999.1.1.1', 'unknown'],
    ['2001:db8::1 ', 'unknown'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it('puts every spelling of one address, and every address in one /64, into one bucket', () => {
    expect(normalizeIp('2001:db8:aaaa:1::1')).toBe(normalizeIp('2001:0DB8:AAAA:0001:dead:beef:0:2'));
    expect(normalizeIp('fe80::1%eth0')).toBe(normalizeIp('fe80::2%eth1'));
  });

  it('keeps different /64 prefixes (and IPv4 vs IPv6) apart', () => {
    expect(normalizeIp('2001:db8:aaaa:1::1')).not.toBe(normalizeIp('2001:db8:aaaa:2::1'));
    expect(normalizeIp('1.2.3.4')).not.toBe(normalizeIp('2001:db8::1'));
  });

  it('never throws', () => {
    for (const x of ['\u0000', '%', '::%', 'fe80::1%', ':'.repeat(50), 'a'.repeat(1000), '1.2.3', '::ffff:1.2.3', '０：：１']) {
      expect(() => normalizeIp(x)).not.toThrow();
    }
  });
});

describe('identity keys', () => {
  const req = (body: unknown, ip = '1.2.3.4') => ({ body, ip }) as never;

  it('hashes the e-mail: the key contains no part of the address', () => {
    const key = emailKey(req({ email: 'Victim@Example.com' }));
    expect(key).toMatch(/^email:[0-9a-f]{32}$/);
    expect(key).not.toMatch(/victim|example/i);
  });

  it('normalises case and whitespace so variants share one bucket', () => {
    expect(emailKey(req({ email: ' VICTIM@example.COM ' }))).toBe(emailKey(req({ email: 'victim@example.com' })));
  });

  it('returns null for missing, non-string, empty or oversized e-mails', () => {
    for (const body of [undefined, null, {}, { email: 5 }, { email: ['a@b.c'] }, { email: '   ' }, { email: `${'a'.repeat(400)}@x.io` }]) {
      expect(emailKey(req(body))).toBeNull();
    }
  });

  it('combined key separates the same e-mail from different IPs', () => {
    const a = emailAndIpKey(req({ email: 'x@y.zz' }, '1.1.1.1'));
    const b = emailAndIpKey(req({ email: 'x@y.zz' }, '2.2.2.2'));
    expect(a).not.toBe(b);
    expect(emailAndIpKey(req({}, '1.1.1.1'))).toBeNull();
  });
});

describe('getTrustProxyHops', () => {
  it('defaults to 0 when unset or blank', () => {
    expect(getTrustProxyHops({})).toBe(0);
    expect(getTrustProxyHops({ TRUST_PROXY_HOPS: '  ' })).toBe(0);
  });

  it('accepts whole numbers 0..5', () => {
    expect(getTrustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(getTrustProxyHops({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(getTrustProxyHops({ TRUST_PROXY_HOPS: '5' })).toBe(5);
  });

  it.each(['-1', '6', '1.5', 'abc', 'true', '1e1', 'Infinity'])('rejects %j (never guesses)', (value) => {
    expect(() => getTrustProxyHops({ TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
