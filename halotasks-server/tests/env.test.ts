import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTokenTtlMinutes } from '../src/config/env';

const ORIGINAL_VALUE = process.env.RESET_TOKEN_TTL_MINUTES;

describe('getResetTokenTtlMinutes', () => {
  beforeEach(() => {
    delete process.env.RESET_TOKEN_TTL_MINUTES;
  });

  afterEach(() => {
    if (ORIGINAL_VALUE === undefined) {
      delete process.env.RESET_TOKEN_TTL_MINUTES;
    } else {
      process.env.RESET_TOKEN_TTL_MINUTES = ORIGINAL_VALUE;
    }
  });

  it('defaults to 20 minutes when unset', () => {
    expect(getResetTokenTtlMinutes()).toBe(20);
  });

  it('defaults to 20 minutes when set to an empty string', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = '   ';
    expect(getResetTokenTtlMinutes()).toBe(20);
  });

  it('accepts a valid positive integer', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = '45';
    expect(getResetTokenTtlMinutes()).toBe(45);
  });

  it('rejects a non-numeric value instead of silently producing NaN', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = 'not-a-number';
    expect(() => getResetTokenTtlMinutes()).toThrow(/positive whole number/);
  });

  it('rejects zero', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = '0';
    expect(() => getResetTokenTtlMinutes()).toThrow();
  });

  it('rejects a negative value', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = '-5';
    expect(() => getResetTokenTtlMinutes()).toThrow();
  });

  it('rejects a non-integer value', () => {
    process.env.RESET_TOKEN_TTL_MINUTES = '5.5';
    expect(() => getResetTokenTtlMinutes()).toThrow();
  });
});
