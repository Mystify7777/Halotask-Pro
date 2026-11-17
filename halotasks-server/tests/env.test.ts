import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_REMINDER_DAILY_CAP,
  getEmailReminderCronSecret,
  getEmailReminderDailyCap,
  getGroqApiKey,
  getResetTokenTtlMinutes,
} from '../src/config/env';

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

describe('getGroqApiKey', () => {
  it('returns null when unset, empty or blank', () => {
    expect(getGroqApiKey({})).toBeNull();
    expect(getGroqApiKey({ GROQ_API_KEY: '' })).toBeNull();
    expect(getGroqApiKey({ GROQ_API_KEY: '   ' })).toBeNull();
  });

  it('returns the trimmed key when configured', () => {
    expect(getGroqApiKey({ GROQ_API_KEY: '  gsk_abc ' })).toBe('gsk_abc');
  });
});

describe('getEmailReminderCronSecret (Issue #29)', () => {
  it('unset or blank means the trigger is disabled (null)', () => {
    expect(getEmailReminderCronSecret({})).toBeNull();
    expect(getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: '' })).toBeNull();
    expect(getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: '   ' })).toBeNull();
  });
  it('accepts a secret of at least 32 characters (trimmed)', () => {
    const secret = 'a'.repeat(32);
    expect(getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: `  ${secret} ` })).toBe(secret);
  });
  it('refuses a shorter one, and the message never contains the value', () => {
    expect(() => getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: 'hunter2-too-short' })).toThrow('at least 32');
    try {
      getEmailReminderCronSecret({ EMAIL_REMINDER_CRON_SECRET: 'hunter2-too-short' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('hunter2');
    }
  });
});

describe('getEmailReminderDailyCap (Issue #29)', () => {
  it('defaults to 20', () => {
    expect(DEFAULT_EMAIL_REMINDER_DAILY_CAP).toBe(20);
    expect(getEmailReminderDailyCap({})).toBe(20);
    expect(getEmailReminderDailyCap({ EMAIL_REMINDER_DAILY_CAP: ' ' })).toBe(20);
  });
  it('accepts whole numbers from 1 to 200', () => {
    expect(getEmailReminderDailyCap({ EMAIL_REMINDER_DAILY_CAP: '1' })).toBe(1);
    expect(getEmailReminderDailyCap({ EMAIL_REMINDER_DAILY_CAP: '200' })).toBe(200);
  });
  it.each(['0', '-1', '201', '2.5', 'many', 'NaN'])('refuses %s', (value) => {
    expect(() => getEmailReminderDailyCap({ EMAIL_REMINDER_DAILY_CAP: value })).toThrow('EMAIL_REMINDER_DAILY_CAP');
  });
});
