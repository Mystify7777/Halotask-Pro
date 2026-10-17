import { describe, expect, it } from 'vitest';
import { ApiBaseUrlError, DEV_API_BASE_URL, resolveApiBaseUrl } from './apiBaseUrl';

// Issue #36: production must never silently fall back to http://localhost:5000.
// The helper is pure (value + mode in, origin out), so every case here is deterministic and touches no Vite env.

const dev = (value: string | undefined) => resolveApiBaseUrl({ value, isProduction: false });
const prod = (value: string | undefined) => resolveApiBaseUrl({ value, isProduction: true });

const rejection = (run: () => unknown): ApiBaseUrlError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiBaseUrlError);
    return error as ApiBaseUrlError;
  }
  throw new Error('expected the value to be rejected');
};

describe('development', () => {
  it('uses the localhost default when the variable is absent', () => {
    expect(dev(undefined)).toBe('http://localhost:5000');
    expect(DEV_API_BASE_URL).toBe('http://localhost:5000');
  });

  it.each(['', '   ', '\t\n'])('treats a blank value (%j) as absent', (blank) => {
    expect(dev(blank)).toBe(DEV_API_BASE_URL);
  });

  it('uses a valid configured URL instead of the default', () => {
    expect(dev('http://localhost:8080')).toBe('http://localhost:8080');
    expect(dev('https://staging-api.example.com')).toBe('https://staging-api.example.com');
  });
});

describe('production', () => {
  it('accepts a valid absolute HTTP URL', () => {
    expect(prod('http://api.example.com')).toBe('http://api.example.com');
    expect(prod('http://192.168.1.20:5000')).toBe('http://192.168.1.20:5000');
  });

  it('accepts a valid absolute HTTPS URL', () => {
    expect(prod('https://api.example.com')).toBe('https://api.example.com');
    expect(prod('https://halotask-api.onrender.com')).toBe('https://halotask-api.onrender.com');
    expect(prod('https://api.example.com:8443')).toBe('https://api.example.com:8443');
  });

  it('normalises to the origin: trims whitespace and the trailing slash, lowercases scheme and host', () => {
    expect(prod('  https://api.example.com/  ')).toBe('https://api.example.com');
    expect(prod('HTTPS://API.Example.COM')).toBe('https://api.example.com');
    expect(prod('https://api.example.com:443')).toBe('https://api.example.com');
  });

  it('does not forbid a local API origin (a local production-mode build is legitimate)', () => {
    expect(prod('http://localhost:5000')).toBe('http://localhost:5000');
  });

  it.each([undefined, '', '   '])('fails clearly when the variable is missing (%j)', (missing) => {
    const error = rejection(() => prod(missing));
    expect(error.code).toBe('INVALID_API_BASE_URL');
    expect(error.name).toBe('ApiBaseUrlError');
    expect(error.message).toContain('VITE_API_BASE_URL');
    expect(error.message).toContain('required for production');
    expect(error.message).toContain('Vercel');
  });

  it('never returns the localhost default', () => {
    expect(() => prod(undefined)).toThrow();
    expect(() => prod('')).toThrow();
  });
});

// Invalid values are rejected in both modes: a typo should fail loudly in development too.
describe.each([
  ['development', dev],
  ['production', prod],
] as const)('invalid values in %s', (_mode, resolve) => {
  it.each([
    ['plain text', 'not a url'],
    ['no host', 'http://'],
    ['no host, empty authority', 'http:///api'],
    ['missing slashes', 'https:api.example.com'],
    ['space in host', 'https://exa mple.com'],
    ['empty host before port', 'http://:5000'],
    ['port out of range', 'https://api.example.com:99999'],
    ['non-numeric port', 'https://api.example.com:abc'],
  ])('rejects a malformed URL: %s', (_label, value) => {
    const error = rejection(() => resolve(value));
    expect(error.message).toMatch(/^VITE_API_BASE_URL /);
  });

  it.each([
    ['absolute path', '/api'],
    ['relative path', './api'],
    ['protocol-relative', '//api.example.com'],
    ['bare hostname', 'api.example.com'],
    ['hostname and port', 'localhost:5000'],
  ])('rejects a relative URL: %s', (_label, value) => {
    expect(rejection(() => resolve(value)).message).toContain('absolute URL');
  });

  it.each([
    ['ftp', 'ftp://api.example.com'],
    ['ws', 'ws://api.example.com'],
    ['wss', 'wss://api.example.com'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/plain,hello'],
    ['mailto', 'mailto:ops@example.com'],
  ])('rejects an unsupported protocol: %s', (_label, value) => {
    expect(rejection(() => resolve(value)).message).toContain('http:// or https://');
  });

  it.each([
    ['username and password', 'https://user:pass@api.example.com'],
    ['username only', 'https://user@api.example.com'],
    ['path', 'https://api.example.com/api'],
    ['query string', 'https://api.example.com?x=1'],
    ['empty query string', 'https://api.example.com?'],
    ['fragment', 'https://api.example.com#top'],
    ['empty fragment', 'https://api.example.com#'],
    ['backslash path', 'https://api.example.com\\api'],
  ])('rejects an invalid origin: %s', (_label, value) => {
    expect(() => resolve(value)).toThrow(ApiBaseUrlError);
  });
});

describe('diagnostics do not expose secrets', () => {
  // Every value below carries a marker that must never appear in the message, whatever the reason for rejection.
  const MARKER = 'S3CR3T-MARKER';
  const values = [
    `https://user:${MARKER}@api.example.com`,
    `https://${MARKER}@api.example.com`,
    `${MARKER}`,
    `${MARKER}://api.example.com`,
    `ftp://${MARKER}.example.com`,
    `https://api.example.com/${MARKER}`,
    `https://api.example.com?token=${MARKER}`,
    `https://api.example.com#${MARKER}`,
    `https://${MARKER} .example.com`,
    `https://api.example.com:${MARKER}`,
    `/${MARKER}`,
  ];

  it.each(values)('does not echo the rejected value: %s', (value) => {
    for (const isProduction of [false, true]) {
      const error = rejection(() => resolveApiBaseUrl({ value, isProduction }));
      expect(error.message).not.toContain(MARKER);
      expect(String(error)).not.toContain(MARKER);
    }
  });

  it('the missing-value message names only the setting, no other environment values', () => {
    const error = rejection(() => prod(undefined));
    expect(error.message).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
  });
});
