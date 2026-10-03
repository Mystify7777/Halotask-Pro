import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

// SSRF boundary for Web Push delivery.
//
// The relay POSTs to an endpoint the *client* chose. The shape checks in pushValidators.ts cannot see where a
// DNS name points: an attacker-owned name (or a rebinding one) can resolve to 127.0.0.1, 10.x, 169.254.169.254
// (cloud metadata) and so on. The only point that is not racy is the connection itself, so delivery uses an
// https.Agent whose DNS lookup refuses to hand back any non-public address. The address that is validated is the
// address the socket connects to (no second resolution), which is what defeats DNS rebinding. TLS still verifies
// the certificate against the original hostname.
//
// This is deliberately provider-agnostic: push services are many and change (FCM, Mozilla autopush, Apple, WNS,
// ...), so an allowlist would either break users on other browsers or have to be a broad suffix list.

type Family = 4 | 6;

const blocked = new net.BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
for (const [addr, prefix] of v4) blocked.addSubnet(addr, prefix, 'ipv4');
const v6: [string, number][] = [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible
  ['64:ff9b::', 96], // NAT64 (can embed any IPv4)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [addr, prefix] of v6) blocked.addSubnet(addr, prefix, 'ipv6');

/** Expands an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:aabb:ccdd) to its IPv4 form, else null. */
function unmapV4(ip: string): string | null {
  const m = /^(?:0{0,4}:){2,5}ffff:(.+)$/i.exec(ip) ?? /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1];
  if (net.isIPv4(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True only for a syntactically valid, globally routable unicast IP. Anything unparseable is NOT public. */
export function isPublicAddress(ip: unknown): boolean {
  if (typeof ip !== 'string') return false;
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = unmapV4(ip);
    if (mapped !== null) return isPublicAddress(mapped);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

export class PrivateAddressError extends Error {
  code = 'EPUSHPRIVATEADDR';
  constructor() {
    // Never includes the hostname or address: callers log only the host themselves.
    super('Push endpoint resolves to a non-public address');
    this.name = 'PrivateAddressError';
  }
}

type Resolved = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Resolved[]>;

// DNS time budget. `dns.lookup()` (getaddrinfo) cannot be cancelled: a hostile name that stalls it keeps a libuv
// threadpool thread busy (the pool has 4 by default and is shared with fs/crypto/bcrypt) long after the request
// that asked for it has been abandoned. c-ares (`dns.Resolver`) has per-query timeouts and a real cancel(), so the
// default resolver uses it: each attempt is limited by DNS_ATTEMPT_TIMEOUT_MS x DNS_TRIES, and DNS_DEADLINE_MS is
// a hard upper bound after which every outstanding query is cancelled (no work left running).
export const DNS_ATTEMPT_TIMEOUT_MS = 2_000;
export const DNS_TRIES = 2;
export const DNS_DEADLINE_MS = 5_000;

export type BoundedResolverOptions = {
  timeoutMs?: number;
  tries?: number;
  deadlineMs?: number;
  /** DNS servers to use instead of the system's (tests only). */
  servers?: string[];
};

/**
 * Resolves A and AAAA records in parallel with c-ares. Never returns an address it did not get from DNS, and
 * the caller validates exactly what is returned. Differences from getaddrinfo: /etc/hosts and nsswitch are not
 * consulted (so `localhost` is simply not found, which is a refusal too).
 */
export function createBoundedResolver(opts: BoundedResolverOptions = {}): Resolver {
  const { timeoutMs = DNS_ATTEMPT_TIMEOUT_MS, tries = DNS_TRIES, deadlineMs = DNS_DEADLINE_MS, servers } = opts;
  return async (hostname) => {
    const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries });
    if (servers) resolver.setServers(servers);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      resolver.cancel(); // outstanding queries reject with ECANCELLED; nothing keeps running
    }, deadlineMs);
    try {
      const [a, aaaa] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      const out: Resolved[] = [];
      if (a.status === 'fulfilled') for (const address of a.value) out.push({ address, family: 4 });
      if (aaaa.status === 'fulfilled') for (const address of aaaa.value) out.push({ address, family: 6 });
      if (out.length > 0) return out;
      if (expired) throw Object.assign(new Error('DNS resolution timed out'), { code: 'ETIMEOUT' });
      const reason = (a.status === 'rejected' ? a.reason : aaaa.status === 'rejected' ? aaaa.reason : null) as NodeJS.ErrnoException | null;
      throw reason ?? Object.assign(new Error('No address found'), { code: 'ENOTFOUND' });
    } finally {
      clearTimeout(timer);
    }
  };
}

const systemResolver: Resolver = createBoundedResolver();

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | Resolved[], family?: number) => void;

/**
 * A dns.lookup-compatible function for https.Agent / net.connect. Every address the name resolves to must be
 * public; if ANY is not, the whole lookup fails (a mixed answer is how rebinding/dual-answer tricks work).
 */
export function createGuardedLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: unknown, callback?: LookupCb): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCb;
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: number };
    resolver(hostname).then(
      (addrs) => {
        const wanted = opts.family === 4 || opts.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
        if (wanted.length === 0) {
          const e: NodeJS.ErrnoException = new Error('No address found');
          e.code = 'ENOTFOUND';
          return cb(e);
        }
        if (!wanted.every((a) => isPublicAddress(a.address))) return cb(new PrivateAddressError());
        if (opts.all) return cb(null, wanted.map((a) => ({ address: a.address, family: a.family as Family })));
        return cb(null, wanted[0].address, wanted[0].family);
      },
      (err: NodeJS.ErrnoException) => cb(err),
    );
  };
}

/** Agent used for every push delivery. No keep-alive: one connection per request, validated at connect time. */
export function createPushAgent(resolver?: Resolver): https.Agent {
  return new https.Agent({
    keepAlive: false,
    lookup: createGuardedLookup(resolver) as unknown as net.LookupFunction,
  });
}
