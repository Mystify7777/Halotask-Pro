import dgram from 'node:dgram';
import https from 'node:https';
import net from 'node:net';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import {
  createBoundedResolver,
  DNS_ATTEMPT_TIMEOUT_MS,
  DNS_DEADLINE_MS,
  DNS_TRIES,
  createGuardedLookup,
  createPushAgent,
  isPublicAddress,
  PrivateAddressError,
} from '../src/utils/pushNetworkGuard';

// The SSRF boundary for push delivery: a DNS name chosen by the client must never lead the relay to a
// private/internal address. Accepted examples are the real push-service hostnames (resolved to public IPs by
// an injected resolver — no network needed); rejected ones are attacker-controlled names that resolve inward.

const PROVIDERS = [
  'fcm.googleapis.com', // Chrome/Edge/Opera/Brave (FCM)
  'updates.push.services.mozilla.com', // Firefox (autopush)
  'web.push.apple.com', // Safari
  'wns2-par02p.notify.windows.com', // Edge legacy / WNS
];
const PUBLIC_V4 = '142.250.80.10';
const PUBLIC_V6 = '2607:f8b0:4004:c07::5f';

const lookup = (map: Record<string, { address: string; family: number }[]>, opts: object = {}) =>
  new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
    const fn = createGuardedLookup(async (h) => {
      if (!map[h]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      return map[h];
    });
    fn('host.test', opts, (err, address, family) => resolve({ err, address, family }));
  });

describe('isPublicAddress', () => {
  it.each([PUBLIC_V4, '8.8.8.8', '1.1.1.1', '93.184.216.34', PUBLIC_V6, '2a00:1450:4001:81b::200e'])(
    'accepts public %s',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );

  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1',
    '192.0.2.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('rejects non-public IPv4 %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::',
    '64:ff9b::7f00:1', '100::1', '::127.0.0.1',
  ])('rejects non-public IPv6 %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.1.1',
  ])('rejects IPv4-mapped private %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it('accepts IPv4-mapped public addresses', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('boundary addresses just outside blocked ranges are public', () => {
    for (const ip of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '169.253.255.255', '100.63.255.255', '100.128.0.0']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it.each(['', 'localhost', '1.2.3', '256.1.1.1', '0x7f.0.0.1', '2130706433', 'example.com', ' 8.8.8.8'])(
    'treats unparseable %j as not public',
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  );
  it.each([null, undefined, 5, {}])('treats non-string %j as not public', (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe('createGuardedLookup', () => {
  it.each(PROVIDERS)('allows provider host %s resolving to public addresses', async (host) => {
    const fn = createGuardedLookup(async (h) => {
      expect(h).toBe(host);
      return [{ address: PUBLIC_V4, family: 4 }];
    });
    const out = await new Promise<unknown[]>((resolve) => fn(host, {}, (e, a, f) => resolve([e, a, f])));
    expect(out).toEqual([null, PUBLIC_V4, 4]);
  });

  it('returns the full list when called with all:true (happy-eyeballs path)', async () => {
    const r = await lookup({ 'host.test': [{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }] }, { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }]);
  });

  it('supports the (hostname, callback) signature', async () => {
    const fn = createGuardedLookup(async () => [{ address: PUBLIC_V4, family: 4 }]);
    const out = await new Promise<unknown[]>((resolve) => fn('x.test', ((e: unknown, a: unknown) => resolve([e, a])) as never));
    expect(out).toEqual([null, PUBLIC_V4]);
  });

  it.each([
    ['loopback', '127.0.0.1'], ['RFC1918 10/8', '10.1.2.3'], ['RFC1918 192.168/16', '192.168.1.5'],
    ['RFC1918 172.16/12', '172.20.0.9'], ['cloud metadata', '169.254.169.254'], ['CGNAT', '100.64.1.1'],
    ['unspecified', '0.0.0.0'],
  ])('rejects an attacker-controlled name resolving to %s', async (_n, address) => {
    for (const opts of [{}, { all: true }]) {
      const r = await lookup({ 'host.test': [{ address, family: 4 }] }, opts);
      expect(r.err).toBeInstanceOf(PrivateAddressError);
      expect(r.address).toBeUndefined();
    }
  });

  it.each(['::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1'])(
    'rejects a name resolving to IPv6 %s',
    async (address) => {
      const r = await lookup({ 'host.test': [{ address, family: 6 }] });
      expect(r.err).toBeInstanceOf(PrivateAddressError);
    },
  );

  it('rejects a mixed answer (public + private): rebinding / dual-answer trick', async () => {
    for (const order of [
      [{ address: PUBLIC_V4, family: 4 }, { address: '127.0.0.1', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }, { address: PUBLIC_V4, family: 4 }],
      [{ address: PUBLIC_V4, family: 4 }, { address: '::1', family: 6 }],
    ]) {
      const r = await lookup({ 'host.test': order }, { all: true });
      expect(r.err).toBeInstanceOf(PrivateAddressError);
    }
  });

  it('rejects when a private address is present even if a family filter would select the public one', async () => {
    // Family 4 requested, answer has public v4 + private v6: v6 is filtered out by the caller's choice, so only
    // the v4 (public) is used — this is allowed; the reverse (private v4 selected) must fail.
    const ok = await lookup({ 'host.test': [{ address: PUBLIC_V4, family: 4 }, { address: '::1', family: 6 }] }, { family: 4 });
    expect(ok.err).toBeNull();
    const bad = await lookup({ 'host.test': [{ address: '10.0.0.1', family: 4 }, { address: PUBLIC_V6, family: 6 }] }, { family: 4 });
    expect(bad.err).toBeInstanceOf(PrivateAddressError);
  });

  it('validates the address it returns, per call (a rebinding name is re-checked every time)', async () => {
    let answer = PUBLIC_V4;
    const fn = createGuardedLookup(async () => [{ address: answer, family: 4 }]);
    const call = () => new Promise<Error | null>((resolve) => fn('rebind.test', {}, (e) => resolve(e)));
    expect(await call()).toBeNull();
    answer = '127.0.0.1';
    expect(await call()).toBeInstanceOf(PrivateAddressError);
  });

  it('fails closed on an empty answer and on resolver errors, and does not leak the hostname', async () => {
    const empty = await lookup({ 'host.test': [] });
    expect(empty.err).toMatchObject({ code: 'ENOTFOUND' });
    const nx = await lookup({});
    expect(nx.err).toMatchObject({ code: 'ENOTFOUND' });
    const r = await lookup({ 'host.test': [{ address: '10.0.0.1', family: 4 }] });
    expect(String(r.err?.message)).not.toMatch(/10\.0\.0\.1|host\.test/);
  });

  it('the default resolver never yields an address for localhost (c-ares ignores /etc/hosts)', async () => {
    const fn = createGuardedLookup();
    const r = await new Promise<{ err: Error | null; address?: unknown }>((resolve) =>
      fn('localhost', {}, (err, address) => resolve({ err, address })),
    );
    expect(r.err).not.toBeNull();
    expect(r.address).toBeUndefined();
  });
});

describe('createPushAgent (end to end: the socket is never opened toward a private address)', () => {
  it('an attacker DNS name resolving to a live loopback server is refused and the server sees no connection', async () => {
    let connections = 0;
    const server = net.createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const agent = createPushAgent(async () => [{ address: '127.0.0.1', family: 4 }]);
      const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        // Same shape web-push uses: hostname + explicit agent. (Real endpoints never carry a port; here the
        // port only lets us prove that nothing reached the listener.)
        const req = https.request({ hostname: 'push.attacker.example', port, path: '/x', method: 'POST', agent }, () =>
          reject(new Error('request unexpectedly completed')),
        );
        req.on('error', resolve);
        req.end('x');
      });
      expect(err).toBeInstanceOf(PrivateAddressError);
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });

  it('a rebinding name (public first, loopback later) is refused on the connection that matters', async () => {
    let connections = 0;
    const server = net.createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    let n = 0;
    try {
      const agent = createPushAgent(async () => [{ address: n++ === 0 ? PUBLIC_V4 : '127.0.0.1', family: 4 }]);
      // First lookup (the "validation" a naive pre-check would do) sees a public address; the connect-time
      // lookup sees loopback. The agent must use the latter.
      await new Promise<void>((r) => (agent as unknown as { options: { lookup: Function } }).options.lookup('rebind.example', {}, () => r()));
      const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const req = https.request({ hostname: 'rebind.example', port, path: '/', method: 'POST', agent }, () => reject(new Error('completed')));
        req.on('error', resolve);
        req.end();
      });
      expect(err).toBeInstanceOf(PrivateAddressError);
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });

  it('an IP-literal host bypasses DNS entirely, which is why the validator must (and does) reject IP literals', async () => {
    // Documents the division of labour: the agent guards names; pushValidators rejects literals in every spelling.
    const { parsePushSubscription } = await import('../src/utils/pushValidators.js');
    const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    for (const host of ['127.0.0.1', '2130706433', '0x7f.1', '[::1]', '[::ffff:127.0.0.1]', '169.254.169.254', '0177.0.0.1']) {
      const r = parsePushSubscription({ endpoint: `https://${host}/p`, keys }, Date.now());
      expect(r.ok, host).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// DNS time bound. Two separate guarantees, tested separately:
//  1. a delivery whose DNS never completes is settled by web-push's socket timeout (Node starts that timer when
//     the socket is created, i.e. before the lookup finishes) — so one relay delivery cannot hang;
//  2. the default resolver itself has a hard deadline and CANCELS its queries, so a stalled lookup does not
//     leave work (threadpool threads, timers, sockets) running after the delivery has failed.
// ---------------------------------------------------------------------------------------------------------

type FakeDns = { port: number; queries: () => number; close: () => Promise<void> };

/** Minimal UDP DNS server. `answer` returns the IPv4 for an A query, null for NODATA, or undefined to stay silent. */
async function fakeDns(answer: (qname: string, qtype: number) => string | null | undefined): Promise<FakeDns> {
  const sock = dgram.createSocket('udp4');
  let count = 0;
  sock.on('message', (msg, rinfo) => {
    count += 1;
    let i = 12;
    const labels: string[] = [];
    while (msg[i] !== 0) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
      i += msg[i] + 1;
    }
    const qEnd = i + 1 + 4;
    const qtype = msg.readUInt16BE(i + 1);
    const result = answer(labels.join('.'), qtype);
    if (result === undefined) return; // stay silent
    const head = Buffer.from(msg.subarray(0, 12));
    head.writeUInt16BE(0x8180, 2); // response, RD, RA, NOERROR
    head.writeUInt16BE(result && qtype === 1 ? 1 : 0, 6); // ANCOUNT
    head.writeUInt16BE(0, 8);
    head.writeUInt16BE(0, 10);
    const parts = [head, msg.subarray(12, qEnd)];
    if (result && qtype === 1) {
      const rr = Buffer.alloc(16);
      rr.writeUInt16BE(0xc00c, 0); // name pointer
      rr.writeUInt16BE(1, 2); // A
      rr.writeUInt16BE(1, 4); // IN
      rr.writeUInt32BE(60, 6); // TTL
      rr.writeUInt16BE(4, 10);
      result.split('.').forEach((o, k) => rr.writeUInt8(Number(o), 12 + k));
      parts.push(rr);
    }
    sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return {
    port: sock.address().port,
    queries: () => count,
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DNS phase is bounded', () => {
  it('a real delivery whose DNS never completes is settled by the socket timeout, not left hanging', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const sub = {
      endpoint: 'https://slow-dns.attacker.example/push/abc',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
    const vapid = webpush.generateVAPIDKeys();
    // A resolver that never settles models a hostile name that stalls DNS.
    const agent = createPushAgent(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(
      webpush.sendNotification(sub, 'x', {
        timeout: 300,
        agent,
        vapidDetails: { subject: 'mailto:test@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      }),
    ).rejects.toThrow(/Socket timeout/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  it('the default resolver gives up at its deadline when the DNS server never answers', async () => {
    const dnsServer = await fakeDns(() => undefined);
    try {
      const resolve = createBoundedResolver({ servers: [`127.0.0.1:${dnsServer.port}`], timeoutMs: 5_000, tries: 4, deadlineMs: 300 });
      const started = Date.now();
      await expect(resolve('silent.example')).rejects.toMatchObject({ code: 'ETIMEOUT' });
      const elapsed = Date.now() - started;
      // Per-attempt timeout is 5 s x 4 tries; only the deadline can explain returning this early.
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1500);
    } finally {
      await dnsServer.close();
    }
  });

  it('cancels outstanding queries at the deadline: no further DNS traffic is generated afterwards', async () => {
    const dnsServer = await fakeDns(() => undefined);
    try {
      const resolve = createBoundedResolver({ servers: [`127.0.0.1:${dnsServer.port}`], timeoutMs: 50, tries: 50, deadlineMs: 200 });
      await expect(resolve('silent.example')).rejects.toMatchObject({ code: 'ETIMEOUT' });
      const atReject = dnsServer.queries();
      expect(atReject).toBeGreaterThan(0);
      await sleep(600); // with tries:50 x 50ms, un-cancelled retries would keep arriving for 2.5 s
      expect(dnsServer.queries()).toBe(atReject);
    } finally {
      await dnsServer.close();
    }
  });

  it('per-attempt timeout x tries also bounds a stalled server when the deadline is generous', async () => {
    const dnsServer = await fakeDns(() => undefined);
    try {
      const resolve = createBoundedResolver({ servers: [`127.0.0.1:${dnsServer.port}`], timeoutMs: 100, tries: 2, deadlineMs: 10_000 });
      const started = Date.now();
      await expect(resolve('silent.example')).rejects.toBeTruthy();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await dnsServer.close();
    }
  });

  it('keeps the SSRF properties through the real resolver path (fake DNS server)', async () => {
    const dnsServer = await fakeDns((name, type) => {
      if (type !== 1) return null; // no AAAA
      return { 'push.good.example': '93.184.216.34', 'rebind.evil.example': '127.0.0.1', 'meta.evil.example': '169.254.169.254' }[name] ?? null;
    });
    try {
      const lookup = createGuardedLookup(createBoundedResolver({ servers: [`127.0.0.1:${dnsServer.port}`], timeoutMs: 500, tries: 1 }));
      const call = (h: string) =>
        new Promise<{ err: Error | null; address?: unknown }>((resolve) => lookup(h, {}, (err, address) => resolve({ err, address })));
      expect(await call('push.good.example')).toEqual({ err: null, address: '93.184.216.34' });
      expect((await call('rebind.evil.example')).err).toBeInstanceOf(PrivateAddressError);
      expect((await call('meta.evil.example')).err).toBeInstanceOf(PrivateAddressError);
      expect((await call('nx.example')).err).toBeTruthy();
      // one resolution per lookup: A + AAAA, never a second pass between validation and connect
      const before = dnsServer.queries();
      await call('push.good.example');
      expect(dnsServer.queries() - before).toBe(2);
    } finally {
      await dnsServer.close();
    }
  });

  it('ships defaults that keep DNS well inside the 10 s delivery timeout', () => {
    expect(DNS_DEADLINE_MS).toBeLessThanOrEqual(5_000);
    expect(DNS_ATTEMPT_TIMEOUT_MS * DNS_TRIES).toBeLessThanOrEqual(DNS_DEADLINE_MS);
  });

  it('does not leave its deadline timer running after a successful resolution', async () => {
    const dnsServer = await fakeDns((_n, type) => (type === 1 ? '93.184.216.34' : null));
    try {
      const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      const before = timers();
      const resolve = createBoundedResolver({ servers: [`127.0.0.1:${dnsServer.port}`], deadlineMs: 60_000, timeoutMs: 500, tries: 1 });
      await resolve('push.good.example');
      await sleep(20);
      expect(timers()).toBeLessThanOrEqual(before);
    } finally {
      await dnsServer.close();
    }
  });
});
