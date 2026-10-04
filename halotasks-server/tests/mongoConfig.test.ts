import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONGO_DNS_FALLBACK_SERVERS,
  DEFAULT_MONGO_SERVER_SELECTION_TIMEOUT_MS,
  getMongoConfig,
} from '../src/config/env';

// Validation of every MongoDB setting, with no DNS and no network. The secret below must never appear
// in any error message.
const SECRET = 'pa55-SECRET-w0rd';
const SRV = `mongodb+srv://alice:${SECRET}@cluster0.abcde.mongodb.net/halotasks`;
const DIRECT = `mongodb://alice:${SECRET}@db1.internal:27017/halotasks`;

const messageOf = (env: NodeJS.ProcessEnv): string => {
  try {
    getMongoConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected getMongoConfig to throw');
};

describe('MONGO_URI', () => {
  it.each([
    ['unset', {}],
    ['empty', { MONGO_URI: '' }],
    ['blank', { MONGO_URI: '   ' }],
  ])('is required (%s)', (_label, env) => {
    expect(messageOf(env)).toBe('MONGO_URI is not configured');
  });

  it.each([
    ['http', `http://alice:${SECRET}@host/db`],
    ['no scheme', `alice:${SECRET}@host/db`],
    ['upper-case scheme', `MONGODB://alice:${SECRET}@host/db`],
    ['leading space', ` ${DIRECT}`],
  ])('must use a mongodb scheme (%s) — and the error never contains the URI or its credentials', (_label, uri) => {
    const message = messageOf({ MONGO_URI: uri });

    expect(message).toBe('MONGO_URI must start with "mongodb://" or "mongodb+srv://"');
    expect(message).not.toContain(SECRET);
  });

  it('detects SRV vs direct and returns the URI untouched', () => {
    expect(getMongoConfig({ MONGO_URI: SRV })).toMatchObject({ uri: SRV, srv: true });
    expect(getMongoConfig({ MONGO_URI: DIRECT })).toMatchObject({ uri: DIRECT, srv: false });
  });
});

describe('MONGO_SERVER_SELECTION_TIMEOUT_MS', () => {
  it('defaults to a bounded 15s (not the driver’s implicit 30s)', () => {
    expect(DEFAULT_MONGO_SERVER_SELECTION_TIMEOUT_MS).toBe(15_000);
    expect(getMongoConfig({ MONGO_URI: SRV }).serverSelectionTimeoutMS).toBe(15_000);
    expect(getMongoConfig({ MONGO_URI: SRV, MONGO_SERVER_SELECTION_TIMEOUT_MS: '  ' }).serverSelectionTimeoutMS).toBe(15_000);
  });

  it('accepts a whole number of ms inside 1000–120000', () => {
    for (const [raw, ms] of [['1000', 1000], ['20000', 20000], ['120000', 120000]] as const) {
      expect(getMongoConfig({ MONGO_URI: SRV, MONGO_SERVER_SELECTION_TIMEOUT_MS: raw }).serverSelectionTimeoutMS).toBe(ms);
    }
  });

  it.each(['0', '999', '120001', '-5', '1.5', 'abc', '15s', 'NaN', 'Infinity'])('rejects %s', (raw) => {
    const message = messageOf({ MONGO_URI: SRV, MONGO_SERVER_SELECTION_TIMEOUT_MS: raw });

    expect(message).toMatch(/MONGO_SERVER_SELECTION_TIMEOUT_MS must be a whole number/);
    expect(message).not.toContain(SECRET);
  });
});

describe('MONGO_DNS_SERVERS', () => {
  it('defaults to the public resolvers when unset or empty', () => {
    expect(DEFAULT_MONGO_DNS_FALLBACK_SERVERS).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(getMongoConfig({ MONGO_URI: SRV }).dnsFallbackServers).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(getMongoConfig({ MONGO_URI: SRV, MONGO_DNS_SERVERS: '' }).dnsFallbackServers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it.each([['spaces', '   '], ['tab and newline', '\t\n'], ['one space', ' ']])(
    'whitespace-only (%s) means "not configured" → defaults, NOT a silent disable',
    (_label, value) => {
      expect(getMongoConfig({ MONGO_URI: SRV, MONGO_DNS_SERVERS: value }).dnsFallbackServers).toEqual(['8.8.8.8', '1.1.1.1']);
    },
  );

  it('does not hand out the shared default array (callers cannot corrupt it)', () => {
    getMongoConfig({ MONGO_URI: SRV }).dnsFallbackServers.push('9.9.9.9');

    expect(getMongoConfig({ MONGO_URI: SRV }).dnsFallbackServers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('parses a comma list, trimming and dropping empty entries', () => {
    expect(getMongoConfig({ MONGO_URI: SRV, MONGO_DNS_SERVERS: ' 9.9.9.9 ,, 8.8.4.4 ' }).dnsFallbackServers).toEqual([
      '9.9.9.9',
      '8.8.4.4',
    ]);
  });

  it.each([[','], [' , '], [',,'], [', ,  ,']])('a separator with no entries (%j) is the explicit disable', (value) => {
    expect(getMongoConfig({ MONGO_URI: SRV, MONGO_DNS_SERVERS: value }).dnsFallbackServers).toEqual([]);
  });

  it.each(['8.8.8.8', '1.1.1.1:5353', '2001:4860:4860::8888', '[2001:4860:4860::8888]:53', '[::1]'])('accepts %s', (entry) => {
    expect(getMongoConfig({ MONGO_URI: SRV, MONGO_DNS_SERVERS: entry }).dnsFallbackServers).toEqual([entry]);
  });

  it.each(['dns.google', 'not-an-ip', '8.8.8', '8.8.8.8:0', '8.8.8.8:99999', '8.8.8.8:abc', '[8.8.8.8]:53', '1.2.3.4:5:6'])(
    'rejects %s before anything is attempted',
    (entry) => {
      const message = messageOf({ MONGO_URI: SRV, MONGO_DNS_SERVERS: `8.8.8.8,${entry}` });

      expect(message).toMatch(/MONGO_DNS_SERVERS must be a comma-separated list of IP addresses/);
      expect(message).not.toContain(SECRET);
    },
  );
});
