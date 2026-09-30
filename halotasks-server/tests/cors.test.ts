import { describe, expect, it, vi } from 'vitest';
import { resolveOrigin } from '../src/config/cors';

describe('resolveOrigin', () => {
  it('returns CLIENT_ORIGIN when set, regardless of NODE_ENV', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOrigin(
      { CLIENT_ORIGIN: 'https://example.com', NODE_ENV: 'production' },
      log,
    );
    expect(result).toBe('https://example.com');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('falls back to localhost origins in development when CLIENT_ORIGIN is missing', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOrigin({ NODE_ENV: 'development' }, log);
    expect(result).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:5173',
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('falls back to localhost origins when NODE_ENV is unset (treated as non-production)', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOrigin({}, log);
    expect(Array.isArray(result)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('fails closed (returns false) in production when CLIENT_ORIGIN is missing', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOrigin({ NODE_ENV: 'production' }, log);
    expect(result).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never returns a wildcard/permissive value in production under any missing-config combination', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOrigin({ NODE_ENV: 'production', CLIENT_ORIGIN: '' }, log);
    expect(result).toBe(false);
    expect(result).not.toBe('*');
    expect(result).not.toBe(true);
  });
});
