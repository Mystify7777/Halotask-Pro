import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDB, resetConnectDBStateForTests, type ConnectDeps } from '../src/config/db';

// connectDB with the driver and the resolver replaced by in-memory doubles: no Atlas, no DNS, no network.
// The doubles record the order of events so DNS mutation and restoration can be asserted precisely.

const SECRET = 'pa55-SECRET-w0rd';
const USER = 'alice-the-user';
const HOST = 'cluster0.abcde.mongodb.net';
const SRV_URI = `mongodb+srv://${USER}:${SECRET}@${HOST}/halotasks`;
const DIRECT_URI = `mongodb://${USER}:${SECRET}@db1.internal:27017/halotasks`;
const ORIGINAL = ['10.0.0.2', '10.0.0.3'];
const FALLBACK = ['8.8.8.8', '1.1.1.1'];

const srvRefused = () =>
  Object.assign(new Error(`querySrv ECONNREFUSED _mongodb._tcp.${HOST}`), { code: 'ECONNREFUSED', syscall: 'querySrv' });
const withCode = (code: string, syscall: string) =>
  Object.assign(new Error(`${syscall} ${code} _mongodb._tcp.${HOST}`), { code, syscall });

type Harness = ReturnType<typeof harness>;

function harness(connectImpl: (call: number, servers: string[]) => Promise<void>, env: NodeJS.ProcessEnv = { MONGO_URI: SRV_URI }) {
  const dnsState = { servers: [...ORIGINAL] };
  const events: string[] = [];
  const connects: Array<{ uri: string; options: { serverSelectionTimeoutMS: number }; servers: string[] }> = [];
  const lines: Array<{ level: string; text: string }> = [];
  let readyState = 0;

  const deps: ConnectDeps = {
    env,
    getReadyState: () => readyState,
    getDnsServers: () => [...dnsState.servers],
    setDnsServers: (servers) => {
      dnsState.servers = [...servers];
      events.push(`setServers:${servers.join('|')}`);
    },
    connect: async (uri, options) => {
      connects.push({ uri, options, servers: [...dnsState.servers] });
      events.push(`connect#${connects.length}`);
      await connectImpl(connects.length, [...dnsState.servers]);
      readyState = 1;
    },
    log: {
      info: (text) => lines.push({ level: 'info', text }),
      warn: (text) => lines.push({ level: 'warn', text }),
      error: (text) => lines.push({ level: 'error', text }),
    },
  };

  return { deps, dnsState, events, connects, lines, setReadyState: (n: number) => (readyState = n) };
}

const allText = (h: Harness) => h.lines.map((l) => l.text).join('\n');
const expectNoSecrets = (text: string) => {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(USER);
  expect(text).not.toContain('mongodb+srv://');
  expect(text).not.toContain('mongodb://');
  expect(text).not.toContain(HOST);
};

beforeEach(() => resetConnectDBStateForTests());
afterEach(() => resetConnectDBStateForTests());

describe('normal connection', () => {
  it('connects once with a bounded server-selection timeout and never touches DNS', async () => {
    const h = harness(async () => undefined);

    await connectDB(h.deps);

    expect(h.connects).toHaveLength(1);
    expect(h.connects[0].uri).toBe(SRV_URI);
    expect(h.connects[0].options).toEqual({ serverSelectionTimeoutMS: 15_000 });
    expect(h.events).toEqual(['connect#1']);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });

  it('passes MONGO_SERVER_SELECTION_TIMEOUT_MS through', async () => {
    const h = harness(async () => undefined, { MONGO_URI: SRV_URI, MONGO_SERVER_SELECTION_TIMEOUT_MS: '8000' });

    await connectDB(h.deps);

    expect(h.connects[0].options).toEqual({ serverSelectionTimeoutMS: 8000 });
  });

  it('logs the path and timeout, and nothing sensitive', async () => {
    const h = harness(async () => undefined);

    await connectDB(h.deps);

    expect(allText(h)).toContain('SRV connection string, server selection timeout 15000ms');
    expect(allText(h)).toContain('MongoDB connected (SRV)');
    expectNoSecrets(allText(h));
  });

  it('is a no-op when already connected', async () => {
    const h = harness(async () => undefined);
    h.setReadyState(1);

    await connectDB(h.deps);

    expect(h.connects).toHaveLength(0);
    expect(h.lines).toEqual([]);
  });
});

describe('configuration is validated before any connection or DNS work', () => {
  it.each([
    ['missing URI', {}],
    ['bad scheme', { MONGO_URI: `http://${USER}:${SECRET}@host/db` }],
    ['bad DNS server', { MONGO_URI: SRV_URI, MONGO_DNS_SERVERS: 'not-an-ip' }],
    ['bad timeout', { MONGO_URI: SRV_URI, MONGO_SERVER_SELECTION_TIMEOUT_MS: '0' }],
  ])('%s → rejects, touching neither the driver nor the resolver', async (_label, env) => {
    const h = harness(async () => undefined, env);

    const error = await connectDB(h.deps).catch((e) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(SECRET);
    expect(h.connects).toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });

  it('a bad config rejects (never throws synchronously) and does not wedge later calls', async () => {
    const bad = harness(async () => undefined, { MONGO_URI: 'nope' });
    await expect(connectDB(bad.deps)).rejects.toThrow(/mongodb/);

    const good = harness(async () => undefined);
    await expect(connectDB(good.deps)).resolves.toBeUndefined();
  });
});

describe('fallback selection', () => {
  it('SRV + querySrv ECONNREFUSED → one retry with the fallback servers, then restores the originals', async () => {
    const h = harness(async (call) => {
      if (call === 1) throw srvRefused();
    });

    await connectDB(h.deps);

    expect(h.events).toEqual(['connect#1', `setServers:${FALLBACK.join('|')}`, 'connect#2', `setServers:${ORIGINAL.join('|')}`]);
    expect(h.connects[0].servers).toEqual(ORIGINAL); // first attempt: untouched DNS
    expect(h.connects[1].servers).toEqual(FALLBACK); // retry: fallback resolvers installed
    expect(h.connects[1].uri).toBe(SRV_URI);
    expect(h.connects[1].options).toEqual(h.connects[0].options);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
    expect(allText(h)).toContain('MongoDB connected (SRV, via fallback DNS servers)');
  });

  it('uses MONGO_DNS_SERVERS when set', async () => {
    const h = harness(
      async (call) => {
        if (call === 1) throw srvRefused();
      },
      { MONGO_URI: SRV_URI, MONGO_DNS_SERVERS: '9.9.9.9, 149.112.112.112' },
    );

    await connectDB(h.deps);

    expect(h.connects[1].servers).toEqual(['9.9.9.9', '149.112.112.112']);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });

  it('a configured empty list disables the fallback: the original error is rethrown, DNS untouched', async () => {
    const original = srvRefused();
    const h = harness(
      async () => {
        throw original;
      },
      { MONGO_URI: SRV_URI, MONGO_DNS_SERVERS: ',' },
    );

    await expect(connectDB(h.deps)).rejects.toBe(original);
    expect(h.events).toEqual(['connect#1']);
  });

  it('a direct (non-SRV) URI never falls back, even for an SRV-looking error', async () => {
    const original = srvRefused();
    const h = harness(
      async () => {
        throw original;
      },
      { MONGO_URI: DIRECT_URI },
    );

    await expect(connectDB(h.deps)).rejects.toBe(original);
    expect(h.events).toEqual(['connect#1']);
    expect(allText(h)).toContain('direct connection string');
  });

  it.each([
    ['ENOTFOUND on querySrv', withCode('ENOTFOUND', 'querySrv')],
    ['ETIMEOUT on querySrv', withCode('ETIMEOUT', 'querySrv')],
    ['ECONNREFUSED on a different syscall', withCode('ECONNREFUSED', 'queryTxt')],
    ['a server-selection failure', Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' })],
    ['a non-Error value', 'boom'],
  ])('%s is NOT a DNS refusal: rethrown as is, no DNS change', async (_label, thrown) => {
    const h = harness(async () => {
      throw thrown;
    });

    await expect(connectDB(h.deps)).rejects.toBe(thrown);
    expect(h.events).toEqual(['connect#1']);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });
});

describe('fallback failure', () => {
  it('restores the original DNS servers and rethrows the fallback attempt’s error', async () => {
    const second = Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' });
    const h = harness(async (call) => {
      throw call === 1 ? srvRefused() : second;
    });

    await expect(connectDB(h.deps)).rejects.toBe(second);

    expect(h.events).toEqual(['connect#1', `setServers:${FALLBACK.join('|')}`, 'connect#2', `setServers:${ORIGINAL.join('|')}`]);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
    expect(h.lines.filter((l) => l.level === 'error').map((l) => l.text)).toEqual([
      '[DB] Fallback DNS attempt failed (MongoServerSelectionError); original DNS servers restored.',
    ]);
    expectNoSecrets(allText(h));
  });

  it('restores even if installing the fallback servers itself throws', async () => {
    const h = harness(async (call) => {
      if (call === 1) throw srvRefused();
    });
    const real = h.deps.setDnsServers!;
    let calls = 0;
    h.deps.setDnsServers = (servers) => {
      calls += 1;
      if (calls === 1) throw new Error('ERR_INVALID_IP_ADDRESS');
      real(servers);
    };

    await expect(connectDB(h.deps)).rejects.toThrow('ERR_INVALID_IP_ADDRESS');

    expect(h.dnsState.servers).toEqual(ORIGINAL);
    expect(h.connects).toHaveLength(1);
  });

  it('if the restore itself fails, says so loudly and still surfaces the connection error (not the restore error)', async () => {
    const second = new Error('Server selection timed out');
    const h = harness(async (call) => {
      throw call === 1 ? srvRefused() : second;
    });
    const real = h.deps.setDnsServers!;
    let calls = 0;
    h.deps.setDnsServers = (servers) => {
      calls += 1;
      if (calls === 2) throw new Error('restore blew up');
      real(servers);
    };

    await expect(connectDB(h.deps)).rejects.toBe(second);

    expect(allText(h)).toContain('CRITICAL: could not restore the original DNS servers');
    expectNoSecrets(allText(h));
  });

  it('a second failure leaves state clean for the next attempt (no wedged in-flight)', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt += 1;
      if (attempt <= 2) throw attempt === 1 ? srvRefused() : new Error('timed out');
    });

    await expect(connectDB(h.deps)).rejects.toThrow('timed out');
    await expect(connectDB(h.deps)).resolves.toBeUndefined();
  });
});

describe('repeated and concurrent attempts', () => {
  it('many failing startups in a row never compound or overwrite the DNS state', async () => {
    const h = harness(async (call) => {
      throw call % 2 === 1 ? srvRefused() : new Error('timed out');
    });

    for (let i = 0; i < 6; i += 1) {
      await expect(connectDB(h.deps)).rejects.toThrow('timed out');
      expect(h.dnsState.servers).toEqual(ORIGINAL);
    }

    // Every fallback saw the TRUE original servers as "previous": install, restore, install, restore…
    const sets = h.events.filter((e) => e.startsWith('setServers:'));
    expect(sets).toEqual(Array.from({ length: 6 }, () => [`setServers:${FALLBACK.join('|')}`, `setServers:${ORIGINAL.join('|')}`]).flat());
  });

  it('concurrent callers share ONE attempt: one fallback, one restore, same outcome', async () => {
    const h = harness(async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (call === 1) throw srvRefused();
    });

    const results = await Promise.all([connectDB(h.deps), connectDB(h.deps), connectDB(h.deps)]);

    expect(results).toEqual([undefined, undefined, undefined]);
    expect(h.connects).toHaveLength(2); // the failing first attempt + its single fallback
    expect(h.events.filter((e) => e.startsWith('setServers:'))).toEqual([
      `setServers:${FALLBACK.join('|')}`,
      `setServers:${ORIGINAL.join('|')}`,
    ]);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });

  it('concurrent callers all see the same failure — none reports a false success', async () => {
    const h = harness(async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw call === 1 ? srvRefused() : new Error('timed out');
    });

    const results = await Promise.allSettled([connectDB(h.deps), connectDB(h.deps)]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(h.dnsState.servers).toEqual(ORIGINAL);
  });
});

describe('success is confirmed from the connection state', () => {
  it('connect() resolving without a ready connection is a failure, not "connected"', async () => {
    const h = harness(async () => undefined);
    const connect = h.deps.connect!;
    h.deps.connect = async (uri, options) => {
      await connect(uri, options);
      h.setReadyState(0); // resolved, but not actually connected
    };

    await expect(connectDB(h.deps)).rejects.toThrow('connection is not ready');
    expect(allText(h)).not.toContain('MongoDB connected');
  });
});

describe('with the real process resolver (no network involved)', () => {
  it('really installs the fallback servers for the retry and really restores the originals', async () => {
    const realBefore = dns.getServers();
    const seen: string[][] = [];
    const h = harness(async (call) => {
      seen.push(dns.getServers());
      if (call === 1) throw srvRefused();
    });
    h.deps.getDnsServers = undefined; // use node:dns for real
    h.deps.setDnsServers = undefined;

    try {
      await connectDB(h.deps);

      expect(seen[0]).toEqual(realBefore);
      expect(seen[1]).toEqual(FALLBACK);
      expect(dns.getServers()).toEqual(realBefore);
    } finally {
      dns.setServers(realBefore);
    }
  });
});

describe('default wiring', () => {
  it('uses the real console and mongoose when no dependencies are injected (smoke, failing fast on bad config)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prev = process.env.MONGO_URI;
    process.env.MONGO_URI = 'definitely-not-a-mongo-uri';

    try {
      await expect(connectDB()).rejects.toThrow('MONGO_URI must start with');
    } finally {
      if (prev === undefined) delete process.env.MONGO_URI;
      else process.env.MONGO_URI = prev;
      warn.mockRestore();
    }
  });
});
